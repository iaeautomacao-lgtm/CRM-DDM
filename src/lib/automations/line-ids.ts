// automations.line_ids (migration 128): linhas em que a automação roda
// (whatsapp_config.id ou channels.id). Vazio = todas. Um id de outra conta
// só nunca casa no filtro do engine (automationAppliesToLine), então aqui
// basta validar o formato.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LINES = 50;

/** null = valor inválido (a rota responde 400). */
export function parseLineIds(value: unknown): string[] | null {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_LINES) return null;
  if (!value.every((v) => typeof v === "string" && UUID_RE.test(v))) return null;
  return [...new Set(value as string[])];
}
