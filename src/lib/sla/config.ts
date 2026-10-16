// SLA de primeira resposta por equipe (migration 381). Puro: o front lê o mapa pronto de GET /api/sla/config e daqui
// sai o limite de UMA conversa. Conversa sem equipe usa o padrão da conta; sem a migration o servidor devolve mapas
// vazios e tudo cai no padrão (15 min). A validação espelha a do servidor (inteiro de 1 a 1440; vazio = usar padrão).

export const SLA_MIN_MINUTES = 1;
export const SLA_MAX_MINUTES = 1440;
/** Mesmo valor do painel de SLA no servidor quando nada foi configurado. */
export const SLA_FALLBACK_MINUTES = 15;

export const SLA_RANGE_MESSAGE =
  "O SLA da primeira resposta deve ser um número inteiro de 1 a 1440 minutos, ou vazio para usar o padrão da conta.";

/** Resposta de GET /api/sla/config. */
export interface SlaConfigResponse {
  default_min?: number;
  default_source?: "account" | "default";
  fallback_min?: number;
  /** Valor próprio de cada equipe (null = usa o padrão). */
  teams?: Record<string, number | null>;
  /** Já resolvido (próprio ou padrão). */
  effective?: Record<string, number>;
}

export interface SlaConfig {
  defaultMin: number;
  defaultSource: "account" | "default";
  /** Valor próprio da equipe, ou null quando usa o padrão. */
  ownFor: (teamId: string | null | undefined) => number | null;
  /** Limite efetivo de uma conversa da equipe (sem equipe = padrão da conta). */
  limitFor: (teamId: string | null | undefined) => number;
}

function validMinutes(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= SLA_MIN_MINUTES && n <= SLA_MAX_MINUTES;
}

/** Normaliza a resposta (ou a falta dela) num objeto de consulta; qualquer valor fora da faixa cai no padrão. */
export function buildSlaConfig(data: SlaConfigResponse | null | undefined): SlaConfig {
  const defaultMin = validMinutes(data?.default_min) ? data.default_min : SLA_FALLBACK_MINUTES;
  const effective = data?.effective ?? {};
  const own = data?.teams ?? {};
  return {
    defaultMin,
    defaultSource: data?.default_source === "account" ? "account" : "default",
    ownFor: (teamId) => {
      if (!teamId) return null;
      const v = own[teamId];
      return validMinutes(v) ? v : null;
    },
    limitFor: (teamId) => {
      if (!teamId) return defaultMin;
      const v = effective[teamId];
      return validMinutes(v) ? v : defaultMin;
    },
  };
}

export type ParsedSlaMinutes = { ok: true; value: number | null } | { ok: false; message: string };

/** Texto digitado → minutos (vazio = null = usar padrão). Só aceita inteiro de 1 a 1440. */
export function parseSlaMinutes(raw: string): ParsedSlaMinutes {
  const text = raw.trim();
  if (text === "") return { ok: true, value: null };
  if (!/^\d+$/.test(text)) return { ok: false, message: SLA_RANGE_MESSAGE };
  const n = Number(text);
  if (!validMinutes(n)) return { ok: false, message: SLA_RANGE_MESSAGE };
  return { ok: true, value: n };
}
