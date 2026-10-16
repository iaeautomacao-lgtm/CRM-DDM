// Lógica pura da tela "Custos de IA" (relatórios). Tipos espelham GET /api/costs/ai e /api/costs/ai/rates.
// O valor é ESTIMATIVA (tarifa configurada × tokens informados pelo provedor), nunca fatura; sem tarifa = "sem tarifa", nunca zero.

export interface AiCostRow {
  sku: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  priced_usd: number;
  unpriced: number;
}

export interface AiCostRate {
  sku: string;
  currency: "USD";
  effective_from: string;
  input_per_million: number | null;
  cached_input_per_million: number | null;
  output_per_million: number | null;
}

export type AiCostFeatureRow = Omit<AiCostRow, "sku"> & { feature: string };
export type AiCostFeatureModelRow = AiCostFeatureRow & { sku: string };

export interface AiCostReport {
  month: string;
  estimate: true;
  currency: "USD";
  ai: AiCostRow[];
  rates: AiCostRate[];
  totals: Omit<AiCostRow, "sku">;
  notice: string;
  /** Por funcionalidade (migration 380). Ausente/vazio numa rota antiga: a tela esconde o seletor. */
  by_feature?: AiCostFeatureRow[];
  /** Detalhe funcionalidade × modelo, ordenado por funcionalidade e depois valor. */
  by_feature_model?: AiCostFeatureModelRow[];
}

export interface AiRateRow extends AiCostRate {
  /** true quando a vigência já começou: não pode mais ser alterada. */
  locked: boolean;
}

export interface AiRatesResponse {
  rates: AiRateRow[];
  skus: string[];
}

export interface AiRateInput {
  sku: string;
  effective_from: string;
  input_per_million: number;
  cached_input_per_million: number | null;
  output_per_million: number;
}

export const AI_COST_ESTIMATE_FALLBACK_NOTICE =
  "Valores estimados: tarifa configurada × tokens informados pelo provedor. Não equivalem à fatura (impostos, câmbio, descontos e cotas gratuitas ficam de fora). Histórico anterior à instrumentação não existe.";

const MONTH_PATTERN = /^20\d{2}-(0[1-9]|1[0-2])$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SKU_PATTERN = /^(openai|gemini|claude|hermes):[^\s:][^\s]{0,109}$/;
export const MAX_RATE_PER_MILLION = 100_000;

export function isValidMonth(value: string): boolean {
  return MONTH_PATTERN.test(value);
}

/** Mês atual (AAAA-MM) no fuso de São Paulo, o mesmo que o servidor usa como padrão. */
export function currentMonthSP(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit" }).formatToParts(now);
  const year = parts.find((p) => p.type === "year")?.value ?? "2026";
  const month = parts.find((p) => p.type === "month")?.value ?? "01";
  return `${year}-${month}`;
}

/** Hoje (AAAA-MM-DD) no fuso de São Paulo. */
export function todaySP(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Meses para o seletor: do atual para trás (padrão 12). */
export function monthOptions(current: string, count = 12): string[] {
  const [y, m] = current.split("-").map(Number);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const idx = y * 12 + (m - 1) - i;
    out.push(`${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`);
  }
  return out;
}

export function monthLabel(month: string): string {
  if (!isValidMonth(month)) return month;
  const [y, m] = month.split("-").map(Number);
  const label = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, 1)));
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function costReportPath(month: string, format?: "csv"): string {
  if (!isValidMonth(month)) throw new Error("Mês inválido");
  return `/api/costs/ai?month=${month}${format ? `&format=${format}` : ""}`;
}

export const AI_RATES_PATH = "/api/costs/ai/rates";

/** USD com 2 a 4 casas (custos de modelo pequeno são frações de centavo). */
export function formatUsd(value: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value);
}

export function formatInt(value: number): string {
  return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 }).format(value);
}

/** Valor estimado de uma linha: "Sem tarifa" quando nada foi precificado (nunca R$/US$ 0 de mentira). */
export function rowAmountLabel(row: Pick<AiCostRow, "priced_usd" | "unpriced" | "requests">): string {
  if (row.requests > 0 && row.unpriced >= row.requests) return "Sem tarifa";
  return formatUsd(row.priced_usd);
}

export type RateStatus = "current" | "previous" | "scheduled";

export const RATE_STATUS_LABEL: Record<RateStatus, string> = {
  current: "Em vigor",
  previous: "Anterior",
  scheduled: "Agendada",
};

/**
 * Situação de cada vigência. A lista vem por vigência (mais nova primeiro); `locked` = já começou.
 * Por modelo, a primeira vigência já iniciada é a "Em vigor"; as seguintes, "Anterior"; as que ainda não começaram, "Agendada".
 */
export function rateStatuses(rates: ReadonlyArray<Pick<AiRateRow, "sku" | "effective_from" | "locked">>): RateStatus[] {
  const ordered = rates
    .map((r, index) => ({ r, index }))
    .sort((a, b) => (a.r.effective_from < b.r.effective_from ? 1 : a.r.effective_from > b.r.effective_from ? -1 : 0));
  const currentSeen = new Set<string>();
  const out: RateStatus[] = new Array(rates.length);
  for (const { r, index } of ordered) {
    if (!r.locked) out[index] = "scheduled";
    else if (!currentSeen.has(r.sku)) {
      currentSeen.add(r.sku);
      out[index] = "current";
    } else out[index] = "previous";
  }
  return out;
}

/** "0,15" ou "0.15" → 0.15; vazio → null; inválido → NaN. */
export function parseRateNumber(raw: string): number | null {
  const text = raw.trim();
  if (text === "") return null;
  if (!/^\d+([.,]\d+)?$/.test(text)) return Number.NaN;
  return Number(text.replace(",", "."));
}

export interface RateFormValues {
  sku: string;
  effective_from: string;
  input: string;
  cached: string;
  output: string;
}

/** Valida o formulário (o servidor continua sendo a palavra final). Devolve o corpo do PUT ou a mensagem de erro. */
export function validateRateForm(
  v: RateFormValues,
  today: string,
): { ok: true; body: AiRateInput } | { ok: false; error: string } {
  const sku = v.sku.trim().toLowerCase();
  if (!SKU_PATTERN.test(sku)) return { ok: false, error: "Modelo inválido: use provedor:modelo, por exemplo openai:gpt-4o-mini." };
  if (!DATE_PATTERN.test(v.effective_from)) return { ok: false, error: "Informe a data de início da vigência." };
  const firstOfMonth = `${today.slice(0, 7)}-01`;
  if (v.effective_from < firstOfMonth) return { ok: false, error: "A vigência não pode começar antes do primeiro dia do mês atual." };
  const input = parseRateNumber(v.input);
  const output = parseRateNumber(v.output);
  const cached = parseRateNumber(v.cached);
  if (input === null || Number.isNaN(input)) return { ok: false, error: "Informe a tarifa de entrada (USD por 1 milhão de tokens)." };
  if (output === null || Number.isNaN(output)) return { ok: false, error: "Informe a tarifa de saída (USD por 1 milhão de tokens)." };
  if (Number.isNaN(cached)) return { ok: false, error: "A tarifa de entrada em cache deve ser um número (ou ficar em branco)." };
  for (const n of [input, output, cached]) {
    if (n !== null && n > MAX_RATE_PER_MILLION) return { ok: false, error: `Cada tarifa deve ser de no máximo ${formatInt(MAX_RATE_PER_MILLION)}.` };
  }
  return { ok: true, body: { sku, effective_from: v.effective_from, input_per_million: input, cached_input_per_million: cached, output_per_million: output } };
}

export type CostGrouping = "modelo" | "funcionalidade";

/** Chaves estáveis gravadas em ai_token_usage.feature (backend 378/380). Chave desconhecida aparece como veio. */
export const FEATURE_LABELS: Record<string, string> = {
  responder: "Respostas automáticas",
  disparador: "Campanhas com IA",
  intelligence: "Acordito (chat)",
  copilot: "Sugestões do Acordito",
  acordo: "Detecção de acordo",
  sentiment: "Sentimento",
  tabulacao: "Tabulação",
  rewrite: "Reescrita",
  analysis: "Outras análises",
};

export function featureLabel(key: string): string {
  return FEATURE_LABELS[key] ?? key;
}

/** A visão por funcionalidade só existe quando a rota devolveu by_feature (e não vazio havendo uso por modelo). */
export function hasFeatureView(report: Pick<AiCostReport, "ai" | "by_feature"> | undefined): boolean {
  if (!report || !Array.isArray(report.by_feature)) return false;
  return report.by_feature.length > 0 || report.ai.length === 0;
}

/** Modelos de uma funcionalidade (by_feature_model), já na ordem recebida. */
export function modelsOfFeature(rows: ReadonlyArray<AiCostFeatureModelRow> | undefined, feature: string): AiCostFeatureModelRow[] {
  return (rows ?? []).filter((r) => r.feature === feature);
}
