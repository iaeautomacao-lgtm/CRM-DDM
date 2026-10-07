// Validação de template Meta antes de enfileirar uma campanha
// (startCampaign.ts) e no assistente de criação (campanhas/page.tsx).
// Funções puras, sem I/O.
//
// O disparador manda template SÓ com o componente BODY (processQueue.ts →
// sendTemplateMessage com `params`, sem a linha do template). Por isso:
//   - cabeçalho de mídia (imagem/vídeo/documento) ou cabeçalho de texto com
//     variável, botão de URL dinâmica e botão de copiar código exigem
//     parâmetros que o disparador não envia — a Meta recusa TODOS os envios
//     (132000/131008). Melhor falhar antes de enfileirar 5.000 itens.
//   - template não APPROVED também é recusado em todos os envios.
//   - {{n}} no corpo além das variáveis mapeadas = 132000 em todo envio.
//
// A fonte é o catálogo local wacrm.message_templates (sincronizado da Meta e
// atualizado pelo webhook de status). Template ausente do catálogo local da
// WABA da campanha BLOQUEIA: antes passava sem validar e a Meta recusava
// todos os envios (ex.: template de outro número que ficou na mensagem
// depois de trocar o canal).

export interface LocalTemplateButton {
  type: string;
  url?: string | null;
}

/** Colunas de wacrm.message_templates usadas na validação. */
export interface LocalTemplateRow {
  name: string;
  language: string | null;
  status: string | null;
  waba_id?: string | null;
  body_text: string | null;
  header_type?: string | null;
  header_content?: string | null;
  buttons?: LocalTemplateButton[] | null;
}

export const TEMPLATE_VALIDATION_COLUMNS =
  "name, language, status, waba_id, body_text, header_type, header_content, buttons";

const ANY_NUMERIC_PLACEHOLDER = /\{\{\s*(\d+)\s*\}\}/g;
const HAS_PLACEHOLDER = /\{\{\s*\d+\s*\}\}/;

/** Maior {{n}} do corpo (a Meta exige um parâmetro para cada 1..n). */
export function countBodyVariables(body: string | null | undefined): number {
  let max = 0;
  for (const m of (body ?? "").matchAll(ANY_NUMERIC_PLACEHOLDER)) max = Math.max(max, Number(m[1]));
  return max;
}

const STATUS_LABELS: Record<string, string> = {
  PENDING: "em análise",
  REJECTED: "rejeitado",
  PAUSED: "pausado",
  DISABLED: "desativado",
  IN_APPEAL: "em recurso",
  PENDING_DELETION: "em exclusão",
  DRAFT: "rascunho",
};

function label(name: string, language: string): string {
  return `Template "${name}" (${language})`;
}

/**
 * Componentes que o disparador não consegue preencher (só envia o corpo).
 * Null quando o template é compatível.
 */
export function templateComponentProblem(row: LocalTemplateRow): string | null {
  const name = label(row.name, row.language ?? "pt_BR");
  const header = (row.header_type ?? "").toLowerCase();
  if (header === "image" || header === "video" || header === "document") {
    const tipo = header === "image" ? "imagem" : header === "video" ? "vídeo" : "documento";
    return `${name} tem cabeçalho de ${tipo}. O disparador envia só o texto do template e a Meta recusaria todos os envios — escolha um template sem mídia no cabeçalho.`;
  }
  if (header === "text" && HAS_PLACEHOLDER.test(row.header_content ?? "")) {
    return `${name} tem variável no cabeçalho, que o disparador não preenche — a Meta recusaria todos os envios. Escolha um template com cabeçalho fixo.`;
  }
  for (const button of row.buttons ?? []) {
    const type = String(button?.type ?? "").toUpperCase();
    if (type === "URL" && HAS_PLACEHOLDER.test(button.url ?? "")) {
      return `${name} tem botão de link dinâmico ({{1}} na URL), que o disparador não preenche — a Meta recusaria todos os envios. Escolha um template com link fixo.`;
    }
    if (type === "COPY_CODE") {
      return `${name} tem botão de copiar código, que exige um valor por envio que o disparador não preenche — a Meta recusaria todos os envios.`;
    }
  }
  return null;
}

/**
 * Linhas do catálogo que DECIDEM o template para uma WABA, por
 * (name, language): se existe linha dessa WABA, só ela vale (status,
 * componentes); a linha antiga sem waba_id (sincronizada antes da 073) é
 * fallback apenas quando a WABA não tem linha própria. Linhas de outras
 * WABAs nunca valem. Sem `wabaId` (canal sem WABA conhecida), devolve as
 * linhas como vieram.
 *
 * Antes bastava QUALQUER linha aprovada: uma linha da WABA REJEITADA + a
 * linha antiga APROVADA passava, e a campanha começava com um template que
 * a Meta recusa em todos os envios.
 */
export function templateRowsForWaba<T extends { name: string; language?: string | null; waba_id?: string | null }>(
  rows: readonly T[],
  wabaId: string | null | undefined
): T[] {
  if (!wabaId) return [...rows];
  const key = (r: T) => `${r.name}\u0000${r.language ?? ""}`;
  const withSpecific = new Set(rows.filter((r) => r.waba_id === wabaId).map(key));
  return rows.filter((r) => (r.waba_id ? r.waba_id === wabaId : !withSpecific.has(key(r))));
}

export interface TemplateValidationInput {
  templateName: string;
  language: string;
  /** Tamanho do template_variable_map da mensagem (VAR1–3, campos, fixos…). */
  mappedVariables: number;
  /** Linhas do catálogo local com esse nome (qualquer idioma/WABA). */
  rows: readonly LocalTemplateRow[];
  /** waba_id dos canais Meta da campanha (vazio = não filtrar por WABA). */
  wabaIds?: readonly string[];
}

export type TemplateValidationResult = { ok: true } | { ok: false; error: string };

export const TEMPLATE_NOT_IN_CATALOG =
  "Template não encontrado no catálogo deste número — sincronize os templates";

/**
 * Valida um template Meta de uma mensagem da campanha contra o catálogo da
 * WABA da campanha (campanha Meta = uma WABA, ver campaign-validation.ts).
 * Com mais de uma WABA em `wabaIds`, cada uma precisa do template aprovado.
 */
export function validateCampaignTemplate(input: TemplateValidationInput): TemplateValidationResult {
  const name = label(input.templateName, input.language);
  const sameLanguage = input.rows.filter(
    (r) => r.name === input.templateName && (r.language ?? "pt_BR") === input.language
  );
  const notFound = {
    ok: false as const,
    error: `${name}: ${TEMPLATE_NOT_IN_CATALOG} (Configurações → Templates → Sincronizar).`,
  };
  if (sameLanguage.length === 0) return notFound;

  const wabaIds = [...new Set((input.wabaIds ?? []).filter(Boolean))];
  // Campanha Meta com WABA conhecida exige associação explícita àquela
  // WABA. Linhas legadas sem waba_id não podem autorizar uma campanha nova:
  // o canal já é conhecido e o catálogo precisa ser o catálogo daquele canal.
  const groups: Array<{ wabaId: string | null; rows: LocalTemplateRow[] }> =
    wabaIds.length > 0
      ? wabaIds.map((wabaId) => ({
          wabaId,
          rows: sameLanguage.filter((r) => r.waba_id === wabaId),
        }))
      : [{ wabaId: null, rows: sameLanguage }];

  for (const group of groups) {
    // WABA sem a linha local: o template não existe nesse número.
    if (group.rows.length === 0) return notFound;
    const approved = group.rows.filter((r) => (r.status ?? "").toUpperCase() === "APPROVED");
    if (approved.length === 0) {
      const status = (group.rows[0].status ?? "").toUpperCase();
      const statusText = STATUS_LABELS[status] ?? (status || "sem status");
      const where = group.wabaId && wabaIds.length > 1 ? ` na conta WhatsApp ${group.wabaId}` : "";
      return {
        ok: false,
        error: `${name} não está aprovado na Meta${where} (status: ${statusText}). Escolha um template aprovado ou sincronize os templates antes de iniciar.`,
      };
    }
    for (const row of approved) {
      const problem = templateComponentProblem(row);
      if (problem) return { ok: false, error: problem };
      const bodyVars = countBodyVariables(row.body_text);
      if (bodyVars > input.mappedVariables) {
        return {
          ok: false,
          error: `${name} usa ${bodyVars} variáveis no corpo, mas só ${input.mappedVariables} estão mapeadas. Mapeie todas as variáveis ({{1}} a {{${bodyVars}}}) antes de iniciar.`,
        };
      }
    }
  }
  return { ok: true };
}
