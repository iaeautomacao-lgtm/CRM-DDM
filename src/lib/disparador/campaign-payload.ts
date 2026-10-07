// Campos de wacrm.campaigns que o cliente pode gravar — fonte única para a
// criação (POST /api/disparador/campaigns) e a edição (PATCH
// /api/disparador/campaigns/[id]). Status, account_id, created_by e
// import_draft_id NUNCA vêm daqui: o servidor decide/preenche.

export const CAMPAIGN_WRITABLE_FIELDS = [
  "nome",
  "descricao",
  "session_ids",
  "tags_filtro",
  "mensagens",
  "intervalo_min",
  "intervalo_max",
  "janela_inicio",
  "janela_fim",
  "dias_envio",
  "agendamento",
  // Migration 162 — data/hora final escolhida no assistente (referência:
  // se a base não terminar, o envio continua no próximo dia útil).
  "agendamento_fim",
  "batch_size",
  "batch_pause_seconds",
  // Migration 114 — modo de disparo "Segmentado".
  "batch_percent",
  // Coluna jsonb legada reaproveitada para o modo de templates
  // ("sequencia" | "rotacao" | "aleatorio") — ver campaign-validation.ts.
  "dias_permitidos",
  // Migration 132 — origem do público ("csv" | "tags" | "account").
  "audience_mode",
  // Migration 127 — "Ao responder, enviar para o Webchat".
  "webchat_enabled",
  "webchat_flow_id",
  "webchat_message",
  "webchat_button_text",
] as const;

export type CampaignWritableField = (typeof CAMPAIGN_WRITABLE_FIELDS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** "08:00:00" (coluna time) → "08:00"; outros valores passam como estão. */
export function normalizeHHMM(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const m = /^(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(value.trim());
  return m ? `${m[1]}:${m[2]}` : value.trim();
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim()))];
}

/**
 * Só os campos graváveis presentes no corpo, já normalizados. Tipos
 * errados viram undefined (campo ignorado) ou ficam para a validação
 * (números/datas inválidos) — nunca chegam crus ao banco.
 */
export function pickCampaignFields(body: unknown): Partial<Record<CampaignWritableField, unknown>> {
  const out: Partial<Record<CampaignWritableField, unknown>> = {};
  if (!body || typeof body !== "object") return out;
  const src = body as Record<string, unknown>;
  for (const field of CAMPAIGN_WRITABLE_FIELDS) {
    if (!(field in src)) continue;
    const value = src[field];
    switch (field) {
      case "nome":
      case "descricao":
        out[field] = typeof value === "string" ? value.trim() : "";
        break;
      case "session_ids":
      case "tags_filtro": {
        const arr = stringArray(value);
        if (arr) out[field] = arr;
        break;
      }
      case "mensagens":
        if (Array.isArray(value)) out[field] = value.filter((m) => m && typeof m === "object");
        break;
      case "janela_inicio":
      case "janela_fim":
        out[field] = normalizeHHMM(value);
        break;
      case "agendamento":
      case "agendamento_fim":
        out[field] = typeof value === "string" && value.trim() ? value.trim() : null;
        break;
      case "dias_envio":
        out[field] = Array.isArray(value) ? [...new Set(value)].sort() : value === null ? null : value;
        break;
      default:
        out[field] = value;
    }
  }
  return out;
}

/** Erro do PostgREST/Postgres de coluna inexistente (migration não aplicada). */
export function isMissingColumnError(error: { code?: string; message?: string } | null, column: string): boolean {
  if (!error) return false;
  const msg = error.message ?? "";
  return (error.code === "42703" || error.code === "PGRST204") && msg.includes(column);
}
