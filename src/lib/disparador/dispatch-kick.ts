export type DispatchKickOutcome = "triggered" | "busy" | "skipped" | "failed";

export interface DispatchKickResult {
  outcome: DispatchKickOutcome;
  attempts: number;
  cronStatus?: string;
  httpStatus?: number;
  error?: string;
}

interface KickOptions {
  requestUrl: string;
  secret?: string | null;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  retryDelaysMs?: readonly number[];
}

const DEFAULT_RETRY_DELAYS_MS = [0, 1_000, 3_000] as const;

function cronUrlFromRequest(requestUrl: string): string {
  return new URL("/api/disparador/cron", requestUrl).toString();
}

/**
 * Acorda o mesmo motor stateless do cron logo depois que uma campanha
 * iniciada manualmente publica a fila.
 *
 * Segurança:
 * - não envia nada por conta própria; apenas chama o POST oficial do cron;
 * - o cron mantém o lock global + claims atômicos do banco, então um tick
 *   agendado simultâneo continua sem risco de double-send;
 * - se o cron já estiver rodando, faz só duas novas tentativas curtas e
 *   depois devolve "busy"; o cron de 1 minuto segue como fallback.
 */
export async function kickDispatchCron(options: KickOptions): Promise<DispatchKickResult> {
  const secret = options.secret?.trim();
  if (!secret) return { outcome: "skipped", attempts: 0, error: "CRON_SECRET ausente" };

  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const url = cronUrlFromRequest(options.requestUrl);
  let attempts = 0;

  for (const delay of delays) {
    if (delay > 0) await sleep(delay);
    attempts++;

    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "x-cron-secret": secret,
          "x-dispatch-kick": "manual-start",
        },
        cache: "no-store",
      });
      const body = (await response.json().catch(() => ({}))) as { status?: unknown; error?: unknown };
      const cronStatus = typeof body.status === "string" ? body.status : undefined;

      if (!response.ok) {
        return {
          outcome: "failed",
          attempts,
          cronStatus,
          httpStatus: response.status,
          error: typeof body.error === "string" ? body.error : `HTTP ${response.status}`,
        };
      }

      if (cronStatus === "already_running") continue;

      return {
        outcome: "triggered",
        attempts,
        cronStatus: cronStatus ?? "processed",
        httpStatus: response.status,
      };
    } catch (error) {
      return {
        outcome: "failed",
        attempts,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    outcome: "busy",
    attempts,
    cronStatus: "already_running",
  };
}
