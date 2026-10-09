// Lado do navegador da importação em segundo plano (contrato em docs/disparador-importacao-assincrona.md).
// Funções puras: montar as linhas dos blocos a partir da tabela lida do arquivo, dividir em blocos dentro
// dos limites do servidor e descrever o estado do job para a tela. Sem I/O (as chamadas ficam no componente).

import { chunkImportRows, IMPORT_CHUNK_MAX_BYTES, IMPORT_SERVER_MAX_ROWS } from "@/lib/disparador/import-chunks";
import type { ImportColumnMap } from "@/lib/disparador/import-mapping";
import type { ParsedImportTable } from "@/lib/disparador/import-parse";

/** Teto de blocos por job no servidor (IMPORT_JOB_MAX_BLOCKS em import-jobs.ts, módulo só de servidor). */
export const IMPORT_MAX_BLOCKS = 100;

export type ImportJobState = "receiving" | "pending" | "running" | "done" | "failed" | "cancelled";

/** Formato público do job (toPublicImportJob). */
export interface PublicImportJob {
  id: string;
  campaign_id: string | null;
  draft_id: string | null;
  name: string | null;
  state: ImportJobState;
  blocks_received: number;
  blocks_total: number | null;
  next_block: number;
  rows_total: number;
  rows_done: number;
  progress: number | null;
  totals: { importados: number; duplicados: number; invalidos: number; blacklisted: number; variaveis_falhas: number };
  linked: number;
  errors: string[];
  created_at: string;
  finished_at: string | null;
  error: string | null;
}

/** Formato público da lista reutilizável (toPublicImportList). */
export interface PublicImportList {
  id: string;
  name: string | null;
  state: ImportJobState;
  created_at: string;
  finished_at: string | null;
  rows_total: number;
  totals: PublicImportJob["totals"];
  linked: number;
  source: "draft" | "campaign" | null;
}

/**
 * Linhas da tabela como objetos cabeçalho → valor (o que o PUT /blocks espera). Linhas sem nenhuma
 * célula preenchida já foram descartadas por tableFromMatrix.
 */
export function tableToRowObjects(table: ParsedImportTable): Record<string, string>[] {
  return table.rows.map((row) => Object.fromEntries(table.headers.map((h, i) => [h, row[i] ?? ""])));
}

/** Divide as linhas em blocos aceitos pelo servidor (≤ 10.000 linhas e ~6 MB de JSON cada). */
export function planImportBlocks<T>(rows: readonly T[]): T[][] {
  return chunkImportRows(rows, IMPORT_SERVER_MAX_ROWS, IMPORT_CHUNK_MAX_BYTES);
}

/** O mapeamento mínimo: coluna de contato escolhida e existente na tabela. */
export function mappingIsValid(map: ImportColumnMap, headers: readonly string[]): boolean {
  if (!map.phone || !headers.includes(map.phone)) return false;
  return Object.values(map).every((col) => !col || headers.includes(col));
}

export function isActiveImport(state: ImportJobState): boolean {
  return state === "receiving" || state === "pending" || state === "running";
}

export const IMPORT_STATE_LABEL: Record<ImportJobState, string> = {
  receiving: "Enviando arquivo",
  pending: "Na fila",
  running: "Importando",
  done: "Concluída",
  failed: "Falhou",
  cancelled: "Cancelada",
};

/** Percentual 0–100 do job: processamento quando há linhas; recebimento de blocos antes disso. */
export function importPercent(job: Pick<PublicImportJob, "state" | "progress" | "blocks_received" | "blocks_total">): number {
  if (job.state === "done") return 100;
  if (job.progress != null) return Math.round(job.progress * 100);
  if (job.blocks_total && job.blocks_total > 0) return Math.round((job.blocks_received / job.blocks_total) * 100);
  return 0;
}

/** Nome exibido da lista: o nome dado ou "Lista de <data>". */
export function importListLabel(item: { name: string | null; created_at: string }): string {
  if (item.name) return item.name;
  const d = new Date(item.created_at);
  return Number.isNaN(d.getTime())
    ? "Lista sem nome"
    : `Lista de ${d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" })}`;
}

export type ExportJobState = "pending" | "running" | "done" | "failed" | "expired" | "cancelled";

/** Formato público do job de exportação (toPublicExportJob). */
export interface PublicExportJob {
  id: string;
  campaign_id: string;
  status_key: string;
  format: "csv";
  state: ExportJobState;
  rows_done: number;
  total_rows: number | null;
  progress: number | null;
  truncated: boolean;
  file_size: number | null;
  created_at: string;
  finished_at: string | null;
  expires_at: string | null;
  error: string | null;
}

export const EXPORT_STATE_LABEL: Record<ExportJobState, string> = {
  pending: "Na fila",
  running: "Gerando arquivo",
  done: "Pronto",
  failed: "Falhou",
  expired: "Expirado",
  cancelled: "Cancelado",
};

export function isActiveExport(state: ExportJobState): boolean {
  return state === "pending" || state === "running";
}

/** Pronto e ainda dentro da validade (o servidor confirma no download). */
export function exportDownloadable(job: Pick<PublicExportJob, "state" | "expires_at">, nowMs: number = Date.now()): boolean {
  return job.state === "done" && (!job.expires_at || Date.parse(job.expires_at) > nowMs);
}

/** Métricas exportáveis (as mesmas chaves do detalhamento por contato). */
export const EXPORT_STATUS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "total", label: "Todos os contatos" },
  { value: "agendado", label: "A enviar" },
  { value: "enviado", label: "Enviados" },
  { value: "aguardando_confirmacao", label: "Aguardando confirmação" },
  { value: "entregue", label: "Entregues" },
  { value: "lido", label: "Lidos" },
  { value: "respondido", label: "Respostas" },
  { value: "bloqueado", label: "Blacklist" },
  { value: "erro", label: "Erros" },
];

export function exportStatusLabel(key: string): string {
  return EXPORT_STATUS_OPTIONS.find((o) => o.value === key)?.label ?? key;
}

/** Tamanho legível ("850 KB", "1,4 MB"). */
export function formatBytes(bytes: number | null): string {
  if (bytes == null || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024).toLocaleString("pt-BR")} KB`;
  return `${(bytes / (1024 * 1024)).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`;
}

// ── import_token (PRD 11 A15, contrato do Âncora) ─────────────────────────────
// Só na importação SÍNCRONA em blocos (POST /api/disparador/contacts/import, corpo JSON). O front gera UM token por
// arquivo escolhido e manda o MESMO em todos os blocos, inclusive no reenvio do bloco 0 (assim o reenvio não apaga
// os vínculos já feitos). Arquivo novo = token novo. Ligado (A15 + migration 295 na v2; decisão do dono: reenviar o bloco 0
// não apaga vínculos). Sem a migration 295 o servidor apenas ignora o campo.
export const IMPORT_TOKEN_ENABLED = true;

/** Formato aceito pelo servidor: [A-Za-z0-9_-]{8,64} (um UUID serve). */
export const IMPORT_TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Campo extra do corpo do bloco: `{ import_token }` quando ligado e válido; senão nada (fluxo legado). */
export function importTokenField(token: string | null, enabled: boolean = IMPORT_TOKEN_ENABLED): { import_token?: string } {
  return enabled && token && IMPORT_TOKEN_RE.test(token) ? { import_token: token } : {};
}

/** Primeiro bloco faltante a partir do erro `blocks_missing` do start ("Faltam blocos: 2, 5."); 0 se não der para ler. */
export function firstMissingBlock(message: string | undefined): number {
  const m = /Faltam blocos:\s*([\d,\s]+)/.exec(message ?? "");
  const nums = (m?.[1] ?? "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n >= 0);
  return nums.length ? Math.min(...nums) : 0;
}

// ── Lista reaproveitada numa campanha nova (POST /imports/[id]/reuse) ─────────────
// A tela de listas chama o reuse (o servidor copia vínculos e VAR1–3 para um rascunho novo) e abre o assistente em
// /disparador/campanhas com estes parâmetros; o assistente usa o draft_id como público "csv" já importado.

export interface ReusedList {
  draftId: string;
  name: string;
  contacts: number;
  variables: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Monta a URL da tela de campanhas que abre o assistente com a lista. */
export function reuseCampaignHref(list: ReusedList): string {
  const qs = new URLSearchParams({
    lista: list.draftId,
    nome: list.name.slice(0, 120),
    contatos: String(Math.max(0, Math.trunc(list.contacts))),
    variaveis: String(Math.max(0, Math.trunc(list.variables))),
  });
  return `/disparador/campanhas?${qs.toString()}`;
}

/** Lê os parâmetros da URL; null quando ausentes ou inválidos (draft_id precisa ser UUID). */
export function parseReusedList(search: string | URLSearchParams): ReusedList | null {
  const p = typeof search === "string" ? new URLSearchParams(search) : search;
  const draftId = p.get("lista") ?? "";
  if (!UUID_RE.test(draftId)) return null;
  const int = (v: string | null) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 ? n : 0;
  };
  const name = (p.get("nome") ?? "").trim().slice(0, 120) || "Lista importada";
  return { draftId, name, contacts: int(p.get("contatos")), variables: int(p.get("variaveis")) };
}
