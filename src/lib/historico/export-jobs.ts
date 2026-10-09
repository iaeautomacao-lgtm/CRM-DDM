/* eslint-disable @typescript-eslint/no-explicit-any -- cliente admin com schema wacrm */
// Exportação ASSÍNCRONA do Histórico (conversas encerradas do período, com filtro opcional por tabulação) — TASK36 item 2.
// Mesma mecânica do export da fila do Disparador (src/lib/disparador/export-jobs.ts, migration 203): job em
// wacrm.history_export_jobs (migration 297), blocos retomáveis por keyset de id, partes no bucket 'relatorio-exports', cursor
// salvo DEPOIS da parte gravada. Ao concluir grava o CSV final e UMA linha em wacrm.export_history: o arquivo passa a viver na
// página Exportações, com a política dela (só exports.manage). Nada fica em memória entre ticks.

import { EXPORT_BUCKET, EXPORT_BLOCK_ROWS, EXPORT_SIGNED_URL_SECONDS, csvLine } from "@/lib/disparador/export-jobs";
import { formatDuration } from "@/lib/historico/format";

type Db = any;

/** Teto de linhas de UM job: o arquivo final precisa caber nos 50 MB do bucket (≈ 300 bytes por linha). */
export const HISTORY_EXPORT_MAX_ROWS = 50_000;
export const HISTORY_EXPORT_MAX_ATTEMPTS = 3;
/** Janela máxima de um pedido (evita exportar a vida inteira por engano; o resto se faz em vários pedidos). */
export const HISTORY_EXPORT_MAX_DAYS = 366;
const LEASE_SECONDS = 120;

export type HistoryExportState = "pending" | "running" | "done" | "failed" | "cancelled";

export interface HistoryExportJob {
  id: string;
  account_id: string;
  requested_by: string | null;
  period_from: string;
  period_to: string;
  tabulacao_id: string | null;
  format: "csv";
  state: HistoryExportState;
  rows_done: number;
  total_rows: number | null;
  parts_count: number;
  cursor_id: string | null;
  truncated: boolean;
  file_path: string | null;
  file_size: number | null;
  export_history_id: string | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

/** Formato público (contrato com o front): sem caminho de arquivo, dono nem lease. */
export function toPublicHistoryExportJob(job: HistoryExportJob) {
  return {
    id: job.id,
    period_from: job.period_from,
    period_to: job.period_to,
    tabulacao_id: job.tabulacao_id,
    format: job.format,
    state: job.state,
    rows_done: job.rows_done,
    total_rows: job.total_rows,
    progress: job.total_rows && job.total_rows > 0 ? Math.min(1, job.rows_done / job.total_rows) : job.state === "done" ? 1 : null,
    truncated: job.truncated,
    file_size: job.file_size,
    export_history_id: job.export_history_id,
    created_at: job.created_at,
    finished_at: job.finished_at,
    error: job.state === "failed" ? job.last_error : null,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ParsedHistoryExportRequest =
  | { ok: true; from: string; to: string; tabulacaoId: string | null }
  | { ok: false; error: string };

/** Valida o corpo do pedido: período obrigatório (ISO, to > from, até 366 dias) e tabulação opcional (uuid). */
export function parseHistoryExportRequest(body: unknown): ParsedHistoryExportRequest {
  const b = (body ?? {}) as { period_from?: unknown; period_to?: unknown; tabulacao_id?: unknown };
  const from = typeof b.period_from === "string" ? Date.parse(b.period_from) : NaN;
  const to = typeof b.period_to === "string" ? Date.parse(b.period_to) : NaN;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return { ok: false, error: "Informe period_from e period_to (datas ISO)." };
  if (to <= from) return { ok: false, error: "period_to deve ser depois de period_from." };
  if (to - from > HISTORY_EXPORT_MAX_DAYS * 86_400_000) return { ok: false, error: `O período máximo é de ${HISTORY_EXPORT_MAX_DAYS} dias por exportação.` };
  let tabulacaoId: string | null = null;
  if (b.tabulacao_id != null && b.tabulacao_id !== "") {
    if (typeof b.tabulacao_id !== "string" || !UUID_RE.test(b.tabulacao_id)) return { ok: false, error: "tabulacao_id inválido." };
    tabulacaoId = b.tabulacao_id;
  }
  return { ok: true, from: new Date(from).toISOString(), to: new Date(to).toISOString(), tabulacaoId };
}

function isMissingTable(error: { code?: string; message?: string } | null | undefined): boolean {
  return error?.code === "42P01" || error?.code === "PGRST205" || (/history_export_jobs/.test(error?.message ?? "") && /does not exist|schema cache/i.test(error?.message ?? ""));
}

const partPath = (job: Pick<HistoryExportJob, "account_id" | "id">, n: number) =>
  `${job.account_id}/historico-exports/${job.id}/parts/${String(n).padStart(5, "0")}.csv`;
const finalPath = (job: Pick<HistoryExportJob, "account_id" | "id">) => `${job.account_id}/historico-exports/${job.id}/historico.csv`;

// ── CSV ────────────────────────────────────────────────────────────────────

export const HISTORY_EXPORT_COLUMNS = ["Contato", "Telefone", "Canal", "Equipe", "Atendente", "Tabulação", "Aberta em", "Encerrada em", "Duração"];

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "-");

export interface HistoryConversationRow {
  id: string;
  created_at: string;
  closed_at: string | null;
  assigned_agent_id: string | null;
  team_id: string | null;
  waha_session: string | null;
  channel_type: string | null;
  outcome_tag: { name: string } | { name: string }[] | null;
  contact: { name: string | null; phone: string | null } | { name: string | null; phone: string | null }[] | null;
}

const one = <T>(v: T | T[] | null): T | null => (Array.isArray(v) ? v[0] ?? null : v);

export function historyExportCells(row: HistoryConversationRow, names: { agents: Map<string, string>; teams: Map<string, string> }): string[] {
  const contact = one(row.contact);
  const tag = one(row.outcome_tag);
  return [
    contact?.name?.trim() || "-",
    contact?.phone ?? "-",
    row.channel_type === "webchat" ? "Webchat" : row.waha_session ? row.waha_session : "WhatsApp",
    (row.team_id && names.teams.get(row.team_id)) || "-",
    (row.assigned_agent_id && names.agents.get(row.assigned_agent_id)) || "-",
    tag?.name ?? "-",
    fmt(row.created_at),
    fmt(row.closed_at),
    formatDuration(row.created_at, row.closed_at) ?? "-",
  ];
}

// ── Pedido ─────────────────────────────────────────────────────────────────

const SELECT = `
  id, created_at, closed_at, assigned_agent_id, team_id, waha_session, channel_type,
  outcome_tag:outcome_tag_id ( name ),
  contact:contacts!contact_id ( name, phone )
`;

/** Filtro ÚNICO do job (contagem e leitura): conversas encerradas da conta no período, com a tabulação se pedida. */
function applyFilters(query: any, job: Pick<HistoryExportJob, "account_id" | "period_from" | "period_to" | "tabulacao_id">) {
  let q = query.eq("account_id", job.account_id).eq("status", "closed").gte("closed_at", job.period_from).lt("closed_at", job.period_to);
  if (job.tabulacao_id) q = q.eq("outcome_tag_id", job.tabulacao_id);
  return q;
}

export type CreateHistoryJobResult =
  | { ok: true; job: HistoryExportJob; reused: boolean }
  | { ok: false; code: "tabulacao_not_found" | "unavailable"; message: string };

/** Cria o job (um pedido igual em andamento é reaproveitado). A rota já conferiu exports.manage. */
export async function createHistoryExportJob(
  db: Db,
  args: { accountId: string; userId: string | null; from: string; to: string; tabulacaoId: string | null },
): Promise<CreateHistoryJobResult> {
  if (args.tabulacaoId) {
    const { data } = await db.from("tags").select("id").eq("id", args.tabulacaoId).eq("account_id", args.accountId).limit(1);
    if (!data?.[0]) return { ok: false, code: "tabulacao_not_found", message: "Tabulação não encontrada." };
  }

  let existing = db
    .from("history_export_jobs")
    .select("*")
    .eq("account_id", args.accountId)
    .eq("period_from", args.from)
    .eq("period_to", args.to)
    .in("state", ["pending", "running"]);
  existing = args.tabulacaoId ? existing.eq("tabulacao_id", args.tabulacaoId) : existing.is("tabulacao_id", null);
  const found = await existing.limit(1);
  if (found.error) {
    if (isMissingTable(found.error)) return { ok: false, code: "unavailable", message: "Exportação do Histórico indisponível: aplique a migration 297." };
    throw new Error(`Falha ao consultar exportações: ${found.error.message}`);
  }
  if (found.data?.[0]) return { ok: true, job: found.data[0] as HistoryExportJob, reused: true };

  let total: number | null = null;
  try {
    const { count } = await applyFilters(
      db.from("conversations").select("id", { count: "exact", head: true }),
      { account_id: args.accountId, period_from: args.from, period_to: args.to, tabulacao_id: args.tabulacaoId },
    );
    total = typeof count === "number" ? count : null;
  } catch {
    total = null;
  }

  const { data, error } = await db
    .from("history_export_jobs")
    .insert({ account_id: args.accountId, requested_by: args.userId, period_from: args.from, period_to: args.to, tabulacao_id: args.tabulacaoId, total_rows: total })
    .select("*")
    .limit(1);
  if (error) {
    if (isMissingTable(error)) return { ok: false, code: "unavailable", message: "Exportação do Histórico indisponível: aplique a migration 297." };
    throw new Error(`Falha ao criar a exportação: ${error.message}`);
  }
  return { ok: true, job: (data as HistoryExportJob[])[0], reused: false };
}

// ── Processamento ──────────────────────────────────────────────────────────

async function fetchBlock(db: Db, job: HistoryExportJob, limit: number): Promise<HistoryConversationRow[]> {
  let query = applyFilters(db.from("conversations").select(SELECT), job);
  if (job.cursor_id) query = query.gt("id", job.cursor_id);
  const { data, error } = await query.order("id", { ascending: true }).limit(limit);
  if (error) throw new Error(`Falha ao ler as conversas: ${error.message}`);
  return (data ?? []) as HistoryConversationRow[];
}

async function namesFor(db: Db, accountId: string, rows: HistoryConversationRow[]) {
  const agents = new Map<string, string>();
  const teams = new Map<string, string>();
  const agentIds = [...new Set(rows.map((r) => r.assigned_agent_id).filter((x): x is string => !!x))];
  const teamIds = [...new Set(rows.map((r) => r.team_id).filter((x): x is string => !!x))];
  if (agentIds.length) {
    const { data } = await db.from("profiles").select("user_id, full_name").in("user_id", agentIds);
    for (const p of (data ?? []) as Array<{ user_id: string; full_name: string }>) agents.set(p.user_id, p.full_name);
  }
  if (teamIds.length) {
    const { data } = await db.from("teams").select("id, name").eq("account_id", accountId).in("id", teamIds);
    for (const t of (data ?? []) as Array<{ id: string; name: string }>) teams.set(t.id, t.name);
  }
  return { agents, teams };
}

async function patchJob(db: Db, id: string, owner: string, patch: Record<string, unknown>) {
  const { error } = await db.from("history_export_jobs").update(patch).eq("id", id).eq("owner_id", owner);
  if (error) throw new Error(`Falha ao atualizar o job de exportação: ${error.message}`);
}

function describePeriod(job: HistoryExportJob): string {
  const d = (iso: string) => new Date(iso).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
  // period_to é exclusivo (início do dia seguinte): mostra o último dia incluído.
  return `${d(job.period_from)} a ${d(new Date(Date.parse(job.period_to) - 1).toISOString())}`;
}

async function finalize(db: Db, job: HistoryExportJob, owner: string, now: Date): Promise<void> {
  const bucket = db.storage.from(EXPORT_BUCKET);
  const chunks: Buffer[] = [Buffer.from("﻿" + csvLine(HISTORY_EXPORT_COLUMNS), "utf8")];
  for (let n = 1; n <= job.parts_count; n++) {
    const { data, error } = await bucket.download(partPath(job, n));
    if (error || !data) throw new Error(`Falha ao ler a parte ${n}: ${error?.message ?? "vazia"}`);
    chunks.push(Buffer.from(await (data as Blob).arrayBuffer()));
  }
  const file = Buffer.concat(chunks);
  const path = finalPath(job);
  const { error: uploadError } = await bucket.upload(path, file, { contentType: "text/csv", upsert: true });
  if (uploadError) throw new Error(`Falha ao gravar o arquivo final: ${uploadError.message}`);
  if (job.parts_count > 0) {
    await bucket.remove(Array.from({ length: job.parts_count }, (_, i) => partPath(job, i + 1))).catch(() => undefined);
  }

  // Registro na página Exportações (idempotente: se o job repetir depois de gravar o histórico, não duplica).
  let historyId = job.export_history_id;
  if (!historyId) {
    let userName: string | null = null;
    if (job.requested_by) {
      const { data } = await db.from("profiles").select("full_name").eq("user_id", job.requested_by).limit(1);
      userName = data?.[0]?.full_name ?? null;
    }
    const { data: hist, error: histError } = await db
      .from("export_history")
      .insert({
        account_id: job.account_id,
        user_id: job.requested_by,
        user_name: userName,
        export_type: "conversas",
        description: `Histórico de conversas encerradas - ${describePeriod(job)}${job.truncated ? " (parcial: limite de linhas)" : ""}`,
        period_from: job.period_from,
        period_to: job.period_to,
        file_name: `historico_${now.toISOString().slice(0, 10)}.csv`,
        storage_path: path,
        file_size: file.length,
      })
      .select("id")
      .limit(1);
    if (histError) throw new Error(`Falha ao registrar a exportação: ${histError.message}`);
    historyId = hist?.[0]?.id ?? null;
  }
  await patchJob(db, job.id, owner, {
    state: "done",
    file_path: path,
    file_size: file.length,
    export_history_id: historyId,
    finished_at: now.toISOString(),
    lease_until: null,
    owner_id: null,
    last_error: null,
  });
}

export type HistoryProcessResult = "done" | "continue" | "failed" | "retry";

export async function processHistoryExportJob(
  db: Db,
  job: HistoryExportJob,
  options: { owner: string; budgetMs?: number; clock?: () => number; now?: () => Date } = { owner: "history-export" },
): Promise<HistoryProcessResult> {
  const clock = options.clock ?? Date.now;
  const nowFn = options.now ?? (() => new Date());
  const deadline = clock() + (options.budgetMs ?? 45_000);
  const owner = options.owner;
  try {
    let current = { ...job };
    for (;;) {
      const room = HISTORY_EXPORT_MAX_ROWS - current.rows_done;
      const block = room > 0 ? await fetchBlock(db, current, Math.min(EXPORT_BLOCK_ROWS, room)) : [];
      if (block.length > 0) {
        const names = await namesFor(db, job.account_id, block);
        const n = current.parts_count + 1;
        const body = Buffer.from(block.map((r) => csvLine(historyExportCells(r, names))).join(""), "utf8");
        const { error: uploadError } = await db.storage.from(EXPORT_BUCKET).upload(partPath(job, n), body, { contentType: "text/csv", upsert: true });
        if (uploadError) throw new Error(`Falha ao gravar a parte ${n}: ${uploadError.message}`);
        // Só DEPOIS da parte gravada o cursor avança (crash entre os dois repete a mesma parte, sobrescrevendo).
        current = { ...current, parts_count: n, rows_done: current.rows_done + block.length, cursor_id: block[block.length - 1].id };
        await patchJob(db, job.id, owner, {
          parts_count: current.parts_count,
          rows_done: current.rows_done,
          cursor_id: current.cursor_id,
          lease_until: new Date(nowFn().getTime() + LEASE_SECONDS * 1000).toISOString(),
        });
      }
      const exhausted = block.length < EXPORT_BLOCK_ROWS || current.rows_done >= HISTORY_EXPORT_MAX_ROWS;
      if (exhausted) {
        if (current.rows_done >= HISTORY_EXPORT_MAX_ROWS && block.length === EXPORT_BLOCK_ROWS) {
          current = { ...current, truncated: true };
          await patchJob(db, job.id, owner, { truncated: true });
        }
        await finalize(db, current, owner, nowFn());
        return "done";
      }
      if (clock() > deadline) return "continue";
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const attempts = job.attempts + 1;
    const dead = attempts >= HISTORY_EXPORT_MAX_ATTEMPTS;
    await db
      .from("history_export_jobs")
      .update({
        state: dead ? "failed" : "pending",
        attempts,
        last_error: message.slice(0, 500),
        next_attempt_at: new Date(nowFn().getTime() + 60_000 * attempts).toISOString(),
        finished_at: dead ? nowFn().toISOString() : null,
        lease_until: null,
        owner_id: null,
      })
      .eq("id", job.id)
      .eq("owner_id", owner);
    return dead ? "failed" : "retry";
  }
}

export interface HistoryExportCronSummary {
  processed: number;
  done: number;
  failed: number;
  continued: number;
  unavailable: boolean;
}

/** Um tick: reserva e processa jobs (um por vez) dentro do orçamento. Sem a migration 297 é no-op (unavailable). */
export async function runHistoryExportCron(db: Db, options: { owner: string; budgetMs?: number; clock?: () => number } = { owner: "history-export-cron" }): Promise<HistoryExportCronSummary> {
  const clock = options.clock ?? Date.now;
  const deadline = clock() + (options.budgetMs ?? 30_000);
  const summary: HistoryExportCronSummary = { processed: 0, done: 0, failed: 0, continued: 0, unavailable: false };
  while (clock() < deadline) {
    const { data, error } = await db.rpc("claim_history_export_job", { p_owner: options.owner, p_lease_seconds: LEASE_SECONDS });
    if (error) {
      summary.unavailable = error.code === "PGRST202" || error.code === "42883" || isMissingTable(error);
      if (!summary.unavailable) console.error("[history-export-cron] falha ao reservar job:", error.message);
      break;
    }
    const job = (Array.isArray(data) ? data[0] : data) as HistoryExportJob | undefined;
    if (!job) break;
    const result = await processHistoryExportJob(db, job, { owner: options.owner, budgetMs: Math.max(deadline - clock(), 1_000), clock });
    summary.processed++;
    if (result === "done") summary.done++;
    else if (result === "failed") summary.failed++;
    else if (result === "continue") summary.continued++;
  }
  return summary;
}

/** Link de download assinado e curto, só de job concluído. */
export async function historyExportDownloadUrl(db: Db, job: Pick<HistoryExportJob, "state" | "file_path">): Promise<{ url: string; expiresInSeconds: number } | null> {
  if (job.state !== "done" || !job.file_path) return null;
  const { data, error } = await db.storage.from(EXPORT_BUCKET).createSignedUrl(job.file_path, EXPORT_SIGNED_URL_SECONDS);
  if (error || !data?.signedUrl) return null;
  return { url: data.signedUrl as string, expiresInSeconds: EXPORT_SIGNED_URL_SECONDS };
}
