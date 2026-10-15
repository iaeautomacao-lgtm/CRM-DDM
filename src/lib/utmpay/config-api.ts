// UTMpay: validação do corpo do PUT e a visão devolvida pelo GET (PURO; nunca expõe segredo). Contrato: prd-v2/contrato-api-utmpay-crm.md.
export interface UtmpayConfigRow {
  enabled: boolean | null;
  base_url: string | null;
  api_key_enc: string | null;
  webhook_secret_enc: string | null;
  janela_dias: number | null;
  send_without_tracking: boolean | null;
  /** Quando a configuração foi salva pela última vez (para "salvo em …"). */
  updated_at?: string | null;
}

export interface UtmpayConfigView {
  available: boolean;
  configured: boolean;
  enabled: boolean;
  base_url: string | null;
  has_api_key: boolean;
  has_webhook_secret: boolean;
  janela_dias: number;
  send_without_tracking: boolean;
  events_url: string | null;
  /** Última vez que a configuração foi salva (ISO); null se nunca. */
  atualizado_em: string | null;
}

export const DEFAULT_JANELA_DIAS = 7;

/** https, só a origem (sem caminho, query, credenciais). Devolve a origem normalizada ou null. */
export function normalizeUtmpayBaseUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text || text.length > 255) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  return url.origin.toLowerCase();
}

/** Endereço para cadastrar no UTMpay (CRM_EVENTS_URL): o do próprio app. */
export function utmpayEventsUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const base = (env.NEXT_PUBLIC_APP_URL ?? "").trim();
  try {
    const url = new URL(base);
    return url.protocol === "https:" ? `${url.origin}/api/integrations/utmpay/events` : null;
  } catch {
    return null;
  }
}

export function viewUtmpayConfig(row: UtmpayConfigRow | null, available: boolean, eventsUrl: string | null): UtmpayConfigView {
  return {
    available,
    configured: !!row?.base_url,
    enabled: row ? row.enabled !== false : false,
    base_url: row?.base_url ?? null,
    has_api_key: !!row?.api_key_enc,
    has_webhook_secret: !!row?.webhook_secret_enc,
    janela_dias: row?.janela_dias && row.janela_dias > 0 ? row.janela_dias : DEFAULT_JANELA_DIAS,
    send_without_tracking: row?.send_without_tracking === true,
    events_url: eventsUrl,
    atualizado_em: row?.updated_at ?? null,
  };
}

export interface UtmpayConfigBody {
  enabled: boolean;
  base_url: string;
  api_key: unknown;
  webhook_secret: unknown;
  janela_dias: number;
  send_without_tracking: boolean;
}

export type BodyCheck = { ok: true; value: UtmpayConfigBody } | { ok: false; error: string };

/** PUT parcial: o que não vier fica como está (ou o padrão na 1ª gravação). `base_url` é obrigatório se a conta ainda não tem configuração. */
export function validateUtmpayConfigBody(raw: unknown, current: UtmpayConfigRow | null): BodyCheck {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Corpo deve ser um objeto JSON" };
  const b = raw as Record<string, unknown>;

  let baseUrl = current?.base_url ?? null;
  if ("base_url" in b) {
    baseUrl = normalizeUtmpayBaseUrl(b.base_url);
    if (!baseUrl) return { ok: false, error: "base_url deve ser um endereço https sem caminho, ex.: https://utmpay.suaempresa.com.br" };
  }
  if (!baseUrl) return { ok: false, error: "Informe base_url" };

  let enabled = current ? current.enabled !== false : true;
  if ("enabled" in b) {
    if (typeof b.enabled !== "boolean") return { ok: false, error: "enabled deve ser verdadeiro ou falso" };
    enabled = b.enabled;
  }
  let sendWithout = current?.send_without_tracking === true;
  if ("send_without_tracking" in b) {
    if (typeof b.send_without_tracking !== "boolean") return { ok: false, error: "send_without_tracking deve ser verdadeiro ou falso" };
    sendWithout = b.send_without_tracking;
  }
  let janela = current?.janela_dias && current.janela_dias > 0 ? current.janela_dias : DEFAULT_JANELA_DIAS;
  if ("janela_dias" in b) {
    if (typeof b.janela_dias !== "number" || !Number.isInteger(b.janela_dias) || b.janela_dias < 1 || b.janela_dias > 90) {
      return { ok: false, error: "janela_dias deve ser um inteiro de 1 a 90" };
    }
    janela = b.janela_dias;
  }
  return { ok: true, value: { enabled, base_url: baseUrl, api_key: b.api_key, webhook_secret: b.webhook_secret, janela_dias: janela, send_without_tracking: sendWithout } };
}
