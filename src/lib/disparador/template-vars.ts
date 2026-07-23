export interface TemplateVarsContact {
  name?: string | null;
  company?: string | null;
}

/**
 * Resolves {{variavel}} placeholders in a campaign message at send time
 * (not at creation/enqueue time), so the text always reflects the
 * contact being messaged right now rather than a snapshot from when the
 * campaign was scheduled.
 *
 * Supported: {{nome}}, {{primeiro_nome}}, {{empresa}}, {{data_hoje}}.
 * Unrelated legacy {nome} (single-brace) placeholders are untouched.
 */
export function applyTemplateVars(text: string, contact: TemplateVarsContact | null | undefined): string {
  const name = contact?.name?.trim() || "";
  const firstName = name.split(/\s+/)[0] || "";
  const company = contact?.company?.trim() || "";
  const today = new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });

  let result = text
    .replace(/\{\{\s*nome\s*\}\}/gi, name)
    .replace(/\{\{\s*primeiro_nome\s*\}\}/gi, firstName)
    .replace(/\{\{\s*empresa\s*\}\}/gi, company)
    .replace(/\{\{\s*data_hoje\s*\}\}/gi, today);

  // {{empresa}} resolving to "" is the common case (most contacts have no
  // company on file) and tends to leave doubled spaces behind (e.g. "na
  // {{empresa}} hoje" -> "na  hoje") — collapse those rather than leaving
  // the gap visible in the sent message.
  result = result.replace(/ {2,}/g, " ");

  return result;
}
