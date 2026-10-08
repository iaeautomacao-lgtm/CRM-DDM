// Tela de Erros do Disparador (P2-1): filtros validados, lista keyset (sem OFFSET e sem count exact),
// resumo por código, detalhe do item e CSV. Só leitura — nada aqui reenvia, cancela ou altera item.
//
// Tenancy: disp_message_queue só é lida JUNTO com campaigns (inner join) filtrando campaigns.account_id
// (a coluna account_id da própria fila é nula em itens legados). Campanha e número vindos da URL só valem
// se pertencerem à conta; telefone vira contact_id da conta antes de tocar a fila.

import { describeMetaError, lookupMetaError, META_ERROR_CATALOG, type MetaErrorClass } from "./meta-error-catalog";
import { loadChannelIdentities } from "./channel-label";
import { phoneKey, phoneVariants } from "./phone-key";

export class ErrosInputError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
  }
}

export const ERROS_PAGE_SIZE = 50;
export const ERROS_MAX_PAGE_SIZE = 100;
/** Teto do CSV (linhas). */
export const ERROS_EXPORT_MAX_ROWS = 10_000;
const EXPORT_PAGE = 1000;
/** Teto de linhas lidas para o resumo quando a função 191 ainda não existe. */
const SUMMARY_FALLBACK_ROWS = 5000;

export type ErrosPeriodo = "1h" | "24h" | "7d" | "30d" | "all";
export const ERROS_PERIODOS: readonly ErrosPeriodo[] = ["1h", "24h", "7d", "30d", "all"];
const PERIODO_MS: Record<Exclude<ErrosPeriodo, "all">, number> = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
};

export type ErrosClasse = MetaErrorClass | "sem_codigo";
const CLASSES: readonly ErrosClasse[] = [
  "destinatario",
  "campanha_template",
  "canal_conta",
  "limite",
  "transitorio",
  "janela24h",
  "desconhecido",
  "sem_codigo",
];

export interface ErrosFilters {
  campaign: string | null;
  session: string | null;
  /** Código da Meta; "sem_codigo" = itens de erro sem código. */
  code: number | "sem_codigo" | null;
  classe: ErrosClasse | null;
  periodo: ErrosPeriodo;
  /** Telefone já normalizado (somente dígitos), busca exata por variações do mesmo número. */
  phone: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseErrosFilters(params: URLSearchParams): ErrosFilters {
  const uuid = (key: string): string | null => {
    const v = params.get(key)?.trim();
    if (!v) return null;
    if (!UUID_RE.test(v)) throw new ErrosInputError(`Parâmetro "${key}" inválido.`);
    return v.toLowerCase();
  };

  let code: ErrosFilters["code"] = null;
  const rawCode = params.get("code")?.trim();
  if (rawCode) {
    if (rawCode === "sem_codigo") code = "sem_codigo";
    else if (/^\d{1,9}$/.test(rawCode)) code = Number(rawCode);
    else throw new ErrosInputError('Parâmetro "code" inválido.');
  }

  let classe: ErrosFilters["classe"] = null;
  const rawClasse = params.get("classe")?.trim();
  if (rawClasse) {
    if (!(CLASSES as readonly string[]).includes(rawClasse)) throw new ErrosInputError('Parâmetro "classe" inválido.');
    classe = rawClasse as ErrosClasse;
  }

  const rawPeriodo = params.get("periodo")?.trim() || "24h";
  if (!(ERROS_PERIODOS as readonly string[]).includes(rawPeriodo)) throw new ErrosInputError('Parâmetro "periodo" inválido.');

  let phone: string | null = null;
  const rawPhone = params.get("phone")?.trim();
  if (rawPhone) {
    const digits = rawPhone.replace(/\D/g, "");
    if (digits.length < 8 || digits.length > 15) throw new ErrosInputError("Informe o telefone completo (DDD + número).");
    phone = digits;
  }

  return { campaign: uuid("campaign"), session: uuid("session"), code, classe, periodo: rawPeriodo as ErrosPeriodo, phone };
}

export function periodoSince(periodo: ErrosPeriodo, now: number = Date.now()): string | null {
  return periodo === "all" ? null : new Date(now - PERIODO_MS[periodo]).toISOString();
}

// ── cursor keyset (updated_at desc, id desc) ─────────────────────────────
const TS_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)?$/;

export interface ErrosCursor {
  u: string;
  i: string;
}
export function encodeCursor(c: ErrosCursor): string {
  return Buffer.from(`${c.u}|${c.i}`, "utf8").toString("base64url");
}
export function decodeCursor(raw: string | null | undefined): ErrosCursor | null {
  if (!raw) return null;
  const [u, i, ...rest] = Buffer.from(raw, "base64url").toString("utf8").split("|");
  // Validado com regex estrita: o valor entra num filtro .or() do PostgREST.
  if (rest.length || !u || !i || !TS_RE.test(u) || !UUID_RE.test(i)) throw new ErrosInputError("Cursor inválido.");
  return { u, i };
}

// ── classes → códigos do catálogo ────────────────────────────────────────
export function codesOfClasse(classe: MetaErrorClass): number[] {
  return META_ERROR_CATALOG.filter((e) => e.classe === classe).map((e) => e.code);
}
export const ALL_CATALOG_CODES: readonly number[] = META_ERROR_CATALOG.map((e) => e.code);

export function classeOfCode(code: number | null): ErrosClasse {
  if (code === null) return "sem_codigo";
  return describeMetaError(code).classe;
}

// ── acesso ao banco (tipos mínimos) ──────────────────────────────────────
interface Q {
  select(cols: string, opts?: Record<string, unknown>): Q;
  eq(col: string, v: unknown): Q;
  in(col: string, v: unknown[]): Q;
  is(col: string, v: null): Q;
  not(col: string, op: string, v: unknown): Q;
  gte(col: string, v: string): Q;
  or(expr: string): Q;
  order(col: string, o?: { ascending?: boolean }): Q;
  limit(n: number): Q;
  then: PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>["then"];
}
export interface ErrosDb {
  from(table: string): Q;
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
}

type DbResult<T> = { data: T | null; error: { message: string; code?: string } | null };
async function run<T>(q: unknown): Promise<DbResult<T>> {
  return (await (q as PromiseLike<DbResult<T>>)) as DbResult<T>;
}

export interface NumberInfo {
  id: string;
  label: string;
  connected?: boolean | null;
}

export async function loadNumbers(db: ErrosDb, accountId: string): Promise<NumberInfo[]> {
  // Nome/telefone iguais à tela Canais (channel-label.ts): habilitados primeiro.
  const identities = await loadChannelIdentities(db, accountId);
  return identities.map((n) => ({ id: n.id, label: n.label, connected: n.connected }));
}

export interface CampaignInfo {
  id: string;
  nome: string;
}
async function loadCampaignOwned(db: ErrosDb, accountId: string, campaignId: string): Promise<CampaignInfo> {
  const { data, error } = await run<CampaignInfo[]>(
    db.from("campaigns").select("id, nome").eq("id", campaignId).eq("account_id", accountId).limit(1),
  );
  if (error) throw new Error(`Falha ao ler campanha: ${error.message}`);
  const row = (data ?? [])[0];
  if (!row) throw new ErrosInputError("Campanha não encontrada.", 404);
  return row;
}

/** Campanhas recentes da conta (opções do filtro). */
export async function loadCampaignOptions(db: ErrosDb, accountId: string, limit = 200): Promise<CampaignInfo[]> {
  const { data, error } = await run<CampaignInfo[]>(
    db.from("campaigns").select("id, nome").eq("account_id", accountId).order("updated_at", { ascending: false }).limit(limit),
  );
  if (error) throw new Error(`Falha ao ler campanhas: ${error.message}`);
  return data ?? [];
}

/** Resolve o telefone (busca exata por variações do mesmo número) em contact_id da conta. */
async function resolveContactIds(db: ErrosDb, accountId: string, phoneDigits: string): Promise<string[]> {
  const variants = phoneVariants(phoneDigits);
  const { data, error } = await run<Array<{ id: string; phone: string | null }>>(
    db.from("contacts").select("id, phone").eq("account_id", accountId).in("phone", variants).limit(200),
  );
  if (error) throw new Error(`Falha ao buscar telefone: ${error.message}`);
  const key = phoneKey(phoneDigits);
  // Mesmo número, nunca LIKE: confere a chave canônica do que voltou.
  return (data ?? []).filter((c) => c.phone && phoneKey(c.phone) === key).map((c) => c.id);
}

export interface ResolvedFilters extends ErrosFilters {
  since: string | null;
  contactIds: string[] | null;
}

export async function resolveFilters(
  db: ErrosDb,
  accountId: string,
  f: ErrosFilters,
  numbers: NumberInfo[],
  now: number = Date.now(),
): Promise<ResolvedFilters> {
  if (f.campaign) await loadCampaignOwned(db, accountId, f.campaign);
  if (f.session && !numbers.some((n) => n.id === f.session)) throw new ErrosInputError("Número não encontrado.", 404);
  const contactIds = f.phone ? await resolveContactIds(db, accountId, f.phone) : null;
  return { ...f, since: periodoSince(f.periodo, now), contactIds };
}

const LIST_COLS =
  "id, campaign_id, session_id, contact_id, erro, erro_codigo, updated_at, scheduled_at, sent_at, tentativas, template_name, entrega_pendente_131026, " +
  "contacts:contact_id ( name, phone ), campaigns!campaign_id!inner ( nome, account_id )";

/** Aplica os filtros comuns (lista, CSV). `withCode` = false deixa código/classe de fora (resumo). */
function applyFilters(q: Q, accountId: string, f: ResolvedFilters, withCode: boolean): Q {
  let out = q.eq("status", "erro").eq("campaigns.account_id", accountId);
  if (f.campaign) out = out.eq("campaign_id", f.campaign);
  if (f.session) out = out.eq("session_id", f.session);
  if (f.since) out = out.gte("updated_at", f.since);
  if (f.contactIds) out = out.in("contact_id", f.contactIds);
  if (withCode) {
    if (f.code === "sem_codigo") out = out.is("erro_codigo", null);
    else if (typeof f.code === "number") out = out.eq("erro_codigo", f.code);
    if (f.classe === "sem_codigo") out = out.is("erro_codigo", null);
    else if (f.classe === "desconhecido") out = out.not("erro_codigo", "in", `(${ALL_CATALOG_CODES.join(",")})`);
    else if (f.classe) out = out.in("erro_codigo", codesOfClasse(f.classe));
  }
  return out;
}

export interface ErroItem {
  id: string;
  campaignId: string;
  campaignNome: string;
  sessionId: string | null;
  numero: string;
  contactName: string | null;
  phone: string | null;
  erro: string | null;
  erroCodigo: number | null;
  classe: ErrosClasse;
  significado: string | null;
  acao: string | null;
  updatedAt: string | null;
  scheduledAt: string | null;
  sentAt: string | null;
  tentativas: number | null;
  templateName: string | null;
  entregaPendente131026: boolean;
}

interface RawRow {
  id: string;
  campaign_id: string;
  session_id: string | null;
  contact_id: string | null;
  erro: string | null;
  erro_codigo: number | null;
  updated_at: string | null;
  scheduled_at: string | null;
  sent_at: string | null;
  tentativas: number | null;
  template_name: string | null;
  entrega_pendente_131026: boolean | null;
  contacts: { name: string | null; phone: string | null } | null;
  campaigns: { nome: string | null } | null;
}

export function toErroItem(r: RawRow, numbers: Map<string, string>): ErroItem {
  const entry = lookupMetaError(r.erro_codigo);
  return {
    id: r.id,
    campaignId: r.campaign_id,
    campaignNome: r.campaigns?.nome ?? "—",
    sessionId: r.session_id,
    numero: (r.session_id && numbers.get(r.session_id)) || "—",
    contactName: r.contacts?.name ?? null,
    phone: r.contacts?.phone ?? null,
    erro: r.erro,
    erroCodigo: r.erro_codigo,
    classe: classeOfCode(r.erro_codigo),
    significado: r.erro_codigo === null ? null : (entry?.significado ?? describeMetaError(r.erro_codigo).significado),
    acao: r.erro_codigo === null ? null : (entry?.acao ?? describeMetaError(r.erro_codigo).acao),
    updatedAt: r.updated_at,
    scheduledAt: r.scheduled_at,
    sentAt: r.sent_at,
    tentativas: r.tentativas,
    templateName: r.template_name,
    entregaPendente131026: r.entrega_pendente_131026 === true,
  };
}

export interface ErrosPage {
  items: ErroItem[];
  nextCursor: string | null;
}

/** Página keyset (updated_at desc, id desc). Lê limit+1 linhas para saber se há próxima página. */
export async function listErros(
  db: ErrosDb,
  accountId: string,
  f: ResolvedFilters,
  numbers: NumberInfo[],
  cursor: ErrosCursor | null,
  limit: number = ERROS_PAGE_SIZE,
): Promise<ErrosPage> {
  const size = Math.min(Math.max(1, Math.floor(limit)), EXPORT_PAGE);
  if (f.contactIds && f.contactIds.length === 0) return { items: [], nextCursor: null };

  let q = applyFilters(db.from("disp_message_queue").select(LIST_COLS), accountId, f, true);
  if (cursor) q = q.or(`updated_at.lt."${cursor.u}",and(updated_at.eq."${cursor.u}",id.lt.${cursor.i})`);
  const { data, error } = await run<RawRow[]>(
    q.order("updated_at", { ascending: false }).order("id", { ascending: false }).limit(size + 1),
  );
  if (error) throw new Error(`Falha ao listar erros: ${error.message}`);

  const rows = data ?? [];
  const page = rows.slice(0, size);
  const map = new Map(numbers.map((n) => [n.id, n.label]));
  const last = page[page.length - 1];
  return {
    items: page.map((r) => toErroItem(r, map)),
    nextCursor: rows.length > size && last?.updated_at ? encodeCursor({ u: last.updated_at, i: last.id }) : null,
  };
}

// ── resumo por código ────────────────────────────────────────────────────
export interface ErrosSummaryRow {
  code: number | null;
  count: number;
  classe: ErrosClasse;
  significado: string | null;
  acao: string | null;
}
export interface ErrosSummary {
  rows: ErrosSummaryRow[];
  total: number;
  /** A contagem foi limitada (função de resumo: 20.000; fallback: 5.000 mais recentes). */
  truncated: boolean;
  source: "rpc" | "amostra";
}

function summaryRows(counts: Array<{ code: number | null; n: number }>): ErrosSummaryRow[] {
  return counts
    .map(({ code, n }) => {
      const e = code === null ? null : describeMetaError(code);
      return { code, count: n, classe: classeOfCode(code), significado: e?.significado ?? null, acao: e?.acao ?? null };
    })
    .sort((a, b) => b.count - a.count || (a.code ?? 0) - (b.code ?? 0));
}

export async function loadErrosSummary(db: ErrosDb, accountId: string, f: ResolvedFilters): Promise<ErrosSummary> {
  if (f.contactIds && f.contactIds.length === 0) return { rows: [], total: 0, truncated: false, source: "rpc" };

  const rpc = await db.rpc("dispatch_errors_summary", {
    p_account_id: accountId,
    p_since: f.since,
    p_campaign: f.campaign,
    p_session: f.session,
    p_contact_ids: f.contactIds,
  });
  if (!rpc.error && rpc.data) {
    const d = rpc.data as { codes?: Array<{ erro_codigo: number | null; n: number }>; total?: number; truncated?: boolean };
    return {
      rows: summaryRows((d.codes ?? []).map((c) => ({ code: c.erro_codigo, n: Number(c.n) }))),
      total: Number(d.total ?? 0),
      truncated: d.truncated === true,
      source: "rpc",
    };
  }
  if (rpc.error && rpc.error.code !== "PGRST202" && rpc.error.code !== "42883") {
    throw new Error(`Falha no resumo de erros: ${rpc.error.message}`);
  }

  // Sem a migration 191: amostra dos itens mais recentes (keyset, só a coluna do código).
  const counts = new Map<number | null, number>();
  let read = 0;
  let cursor: ErrosCursor | null = null;
  while (read < SUMMARY_FALLBACK_ROWS) {
    let q = applyFilters(
      db.from("disp_message_queue").select("id, erro_codigo, updated_at, campaigns!campaign_id!inner ( account_id )"),
      accountId,
      f,
      false,
    );
    if (cursor) q = q.or(`updated_at.lt."${cursor.u}",and(updated_at.eq."${cursor.u}",id.lt.${cursor.i})`);
    const { data, error } = await run<Array<{ id: string; erro_codigo: number | null; updated_at: string | null }>>(
      q.order("updated_at", { ascending: false }).order("id", { ascending: false }).limit(1000),
    );
    if (error) throw new Error(`Falha no resumo de erros: ${error.message}`);
    const rows = data ?? [];
    for (const r of rows) counts.set(r.erro_codigo ?? null, (counts.get(r.erro_codigo ?? null) ?? 0) + 1);
    read += rows.length;
    const last = rows[rows.length - 1];
    if (rows.length < 1000 || !last?.updated_at) return finishSummary(counts, read, false);
    cursor = { u: last.updated_at, i: last.id };
  }
  return finishSummary(counts, read, true);
}

function finishSummary(counts: Map<number | null, number>, total: number, truncated: boolean): ErrosSummary {
  return { rows: summaryRows([...counts].map(([code, n]) => ({ code, n }))), total, truncated, source: "amostra" };
}

// ── detalhe do item ──────────────────────────────────────────────────────
export interface TimelineEvent {
  key: "agendado" | "enviando" | "enviado" | "entregue" | "lido" | "erro";
  label: string;
  at: string | null;
  detail?: string | null;
}
export interface InboxReceipt {
  status: "delivered" | "read" | "failed";
  event_ts: string | null;
  received_at: string | null;
  processed_at: string | null;
  error_text: string | null;
}

const RECEIPT_KEY = { delivered: "entregue", read: "lido", failed: "erro" } as const;
const RECEIPT_LABEL = { delivered: "Entregue (recibo da Meta)", read: "Lido (recibo da Meta)", failed: "Falha informada pela Meta" } as const;

/** Linha do tempo: agendado → enviado → recibos (entregue/lido/falha) → erro final. Ordenada por horário. */
export function buildTimeline(
  item: Pick<ErroItem, "scheduledAt" | "sentAt" | "updatedAt" | "erro" | "erroCodigo">,
  receipts: InboxReceipt[],
): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  if (item.scheduledAt) events.push({ key: "agendado", label: "Agendado", at: item.scheduledAt });
  if (item.sentAt) events.push({ key: "enviado", label: "Enviado ao provedor", at: item.sentAt });
  for (const r of receipts) {
    events.push({
      key: RECEIPT_KEY[r.status],
      label: RECEIPT_LABEL[r.status],
      at: r.event_ts ?? r.received_at,
      detail: r.status === "failed" ? r.error_text : null,
    });
  }
  events.push({
    key: "erro",
    label: item.erroCodigo !== null ? `Erro ${item.erroCodigo}` : "Erro",
    at: item.updatedAt,
    detail: item.erro,
  });
  const t = (e: TimelineEvent) => (e.at ? Date.parse(e.at) : Number.POSITIVE_INFINITY);
  return events.map((e, i) => ({ e, i })).sort((a, b) => t(a.e) - t(b.e) || a.i - b.i).map((x) => x.e);
}

export interface ErroDetail {
  item: ErroItem;
  campaign: { id: string; nome: string; status: string | null };
  template: { name: string | null; language: string | null; variables: string[] | null };
  timeline: TimelineEvent[];
  receipts: InboxReceipt[];
  /** Quantas campanhas distintas da conta já tiveram 131026 para este telefone (regra das 3 campanhas). */
  campanhas131026: number | null;
  receiptsRetentionNote: string;
}

export async function loadErroDetail(db: ErrosDb, accountId: string, itemId: string): Promise<ErroDetail> {
  if (!UUID_RE.test(itemId)) throw new ErrosInputError("Item inválido.", 404);
  const numbers = await loadNumbers(db, accountId);
  const { data, error } = await run<Array<RawRow & { waha_message_id: string | null; template_language: string | null; template_variables: unknown; campaigns: { nome: string | null; status: string | null; account_id: string } | null }>>(
    db
      .from("disp_message_queue")
      .select(
        LIST_COLS.replace("campaigns!campaign_id!inner ( nome, account_id )", "campaigns!campaign_id!inner ( nome, status, account_id )") +
          ", waha_message_id, template_language, template_variables",
      )
      .eq("id", itemId)
      .eq("status", "erro")
      .eq("campaigns.account_id", accountId)
      .limit(1),
  );
  if (error) throw new Error(`Falha ao ler o item: ${error.message}`);
  const row = (data ?? [])[0];
  // Item de outra conta é indistinguível de item inexistente.
  if (!row || row.campaigns?.account_id !== accountId) throw new ErrosInputError("Item não encontrado.", 404);

  const item = toErroItem(row, new Map(numbers.map((n) => [n.id, n.label])));

  let receipts: InboxReceipt[] = [];
  if (row.waha_message_id) {
    const r = await run<Array<InboxReceipt & { account_id: string | null }>>(
      db
        .from("webhook_status_inbox")
        .select("status, event_ts, received_at, processed_at, error_text, account_id")
        .eq("message_id", row.waha_message_id)
        .order("received_at", { ascending: true })
        .limit(10),
    );
    // Sem a tabela (migration 185) ou com erro de leitura: segue sem recibos, o resto do detalhe vale.
    if (!r.error) {
      receipts = (r.data ?? [])
        .filter((x) => x.account_id === null || x.account_id === accountId)
        .map((x) => ({ status: x.status, event_ts: x.event_ts, received_at: x.received_at, processed_at: x.processed_at, error_text: x.error_text }));
    }
  }

  let campanhas131026: number | null = null;
  if (item.phone && (item.erroCodigo === 131026 || item.entregaPendente131026)) {
    const r = await run<Array<{ campaign_id: string }>>(
      db
        .from("dispatch_meta_131026_failures")
        .select("campaign_id")
        .eq("account_id", accountId)
        .in("telefone", phoneVariants(item.phone))
        .limit(50),
    );
    if (!r.error) campanhas131026 = new Set((r.data ?? []).map((x) => x.campaign_id)).size;
  }

  return {
    item,
    campaign: { id: item.campaignId, nome: item.campaignNome, status: row.campaigns?.status ?? null },
    template: {
      name: row.template_name,
      language: row.template_language,
      variables: Array.isArray(row.template_variables) ? (row.template_variables as unknown[]).map(String) : null,
    },
    timeline: buildTimeline(item, receipts),
    receipts,
    campanhas131026,
    receiptsRetentionNote: "Recibos processados há mais de 3 dias são apagados do inbox; itens antigos podem não ter recibos.",
  };
}

// ── CSV ──────────────────────────────────────────────────────────────────
/** Neutraliza fórmula de planilha (=, +, -, @, tab, CR) e escapa aspas/separadores. */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CSV_HEADER = ["Data/hora", "Campanha", "Número", "Contato", "Telefone", "Código", "Classe", "O que significa", "O que fazer", "Erro original", "Tentativas"];

export function errosToCsv(items: ErroItem[]): string {
  const lines = [CSV_HEADER.map(csvCell).join(";")];
  for (const i of items) {
    lines.push(
      [i.updatedAt, i.campaignNome, i.numero, i.contactName, i.phone, i.erroCodigo, i.classe, i.significado, i.acao, i.erro, i.tentativas]
        .map(csvCell)
        .join(";"),
    );
  }
  // BOM: o Excel brasileiro abre UTF-8 com acentos corretamente.
  return `﻿${lines.join("\r\n")}\r\n`;
}

export async function listErrosForExport(
  db: ErrosDb,
  accountId: string,
  f: ResolvedFilters,
  numbers: NumberInfo[],
  maxRows: number = ERROS_EXPORT_MAX_ROWS,
): Promise<{ items: ErroItem[]; truncated: boolean }> {
  const items: ErroItem[] = [];
  let cursor: ErrosCursor | null = null;
  while (items.length < maxRows) {
    const page = await listErros(db, accountId, f, numbers, cursor, EXPORT_PAGE);
    items.push(...page.items);
    if (!page.nextCursor) return { items: items.slice(0, maxRows), truncated: false };
    cursor = decodeCursor(page.nextCursor);
  }
  return { items: items.slice(0, maxRows), truncated: true };
}
