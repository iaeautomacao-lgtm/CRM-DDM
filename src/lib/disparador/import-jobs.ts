/* eslint-disable @typescript-eslint/no-explicit-any -- cliente admin com schema wacrm */
// Importação de contatos em SEGUNDO PLANO, retomável e em blocos (PRD 11, A12/A13 / migration 197).
//
// Antes: a base de 100 mil linhas só era importada enquanto o navegador (ou uma requisição com o arquivo inteiro, lido e
// parseado no event loop do servidor) seguia viva. Agora o pedido vira um JOB (wacrm.dispatch_import_jobs):
//   1) POST /api/disparador/imports            → cria o job (mapeamento de colunas, campanha/rascunho);
//   2) PUT  /api/disparador/imports/[id]/blocks/[n] → grava as LINHAS do bloco n no Storage (rápido; idempotente);
//   3) POST /api/disparador/imports/[id]/start → confere que todos os blocos chegaram e libera o job;
//   4) o cron stateless (POST /api/disparador/imports/cron) processa os blocos EM ORDEM, cada um pela MESMA função da rota
//      síncrona (importContactBlock): dedupe, blacklist/opt-out, tags, telefones alternativos, VAR1–3 e vínculo idênticos;
//      o próximo bloco só avança depois do atual gravado (queda no meio = retoma do bloco em curso; o bloco é idempotente).
// O parse de CSV/XLSX grande deixa de acontecer no servidor: o navegador lê o arquivo e manda blocos de linhas (como o
// assistente de campanha já fazia). Nada de worker em memória (Passenger): todo o estado está no banco e no Storage.

import { IMPORT_SERVER_MAX_ROWS } from "@/lib/disparador/import-chunks";
import { importContactBlock, resolveField, type ColumnMap, type ImportBlockOutcome } from "@/lib/disparador/import-block";

type Db = any;

/** Bucket de Storage já existente (migration 055): blocos sob `<account_id>/disparador-imports/<job>/blocks/<n>.json`. */
export const IMPORT_BUCKET = "relatorio-exports";
/** Linhas por bloco (o mesmo teto da rota síncrona). */
export const IMPORT_BLOCK_MAX_ROWS = IMPORT_SERVER_MAX_ROWS;
/** Blocos por job (100 × 10.000 = 1 milhão de linhas). */
export const IMPORT_JOB_MAX_BLOCKS = 100;
/** Acima disso a importação por ARQUIVO numa requisição só recusa e manda usar o job. */
export const IMPORT_SYNC_FILE_MAX_ROWS = 20_000;
/** Mensagens de erro guardadas no job (por linha/bloco). */
export const IMPORT_MAX_ERRORS = 200;
/** Job que ficou recebendo blocos e nunca foi liberado: cancelado e apagado depois disto. */
export const IMPORT_RECEIVING_TTL_HOURS = 24;
export const IMPORT_MAX_ATTEMPTS = 3;
const LEASE_SECONDS = 120;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ImportState = "receiving" | "pending" | "running" | "done" | "failed" | "cancelled";

export interface ImportTotals {
  importados: number;
  duplicados: number;
  invalidos: number;
  blacklisted: number;
  variaveis_falhas: number;
}

export interface ImportJob {
  id: string;
  account_id: string;
  requested_by: string | null;
  campaign_id: string | null;
  draft_id: string | null;
  column_map: ColumnMap;
  state: ImportState;
  blocks: Record<string, number>;
  blocks_total: number | null;
  next_block: number;
  rows_total: number;
  rows_done: number;
  totals: ImportTotals;
  linked: number;
  errors: string[];
  attempts: number;
  last_error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export const emptyTotals = (): ImportTotals => ({ importados: 0, duplicados: 0, invalidos: 0, blacklisted: 0, variaveis_falhas: 0 });

const blockPath = (job: Pick<ImportJob, "account_id" | "id">, n: number) =>
  `${job.account_id}/disparador-imports/${job.id}/blocks/${String(n).padStart(5, "0")}.json`;

function isMissingTable(error: { code?: string; message?: string } | null | undefined): boolean {
  return error?.code === "42P01" || error?.code === "PGRST205" || (/dispatch_import_jobs/.test(error?.message ?? "") && /does not exist|schema cache/i.test(error?.message ?? ""));
}
const UNAVAILABLE = "Importação em segundo plano indisponível: aplique a migration 197.";

export type JobResult<T = ImportJob> = { ok: true; job: T } | { ok: false; code: string; message: string; status: number };
const fail = (code: string, message: string, status: number): { ok: false; code: string; message: string; status: number } => ({ ok: false, code, message, status });

// ── Pedido ─────────────────────────────────────────────────────────────────

export async function createImportJob(
  db: Db,
  args: { accountId: string; userId: string | null; campaignId: string | null; draftId: string | null; columnMap: ColumnMap; mappingConfirmed: boolean },
): Promise<JobResult> {
  if ((args.campaignId && !UUID_RE.test(args.campaignId)) || (args.draftId && !UUID_RE.test(args.draftId))) {
    return fail("invalid_id", "Identificador inválido.", 400);
  }
  // Mesma regra da rota síncrona: mapeamento confirmado e coluna de contato escolhida.
  if (!args.mappingConfirmed || !args.columnMap.phone?.trim()) {
    return fail("mapping_required", "Selecione e confirme a coluna de contato antes de importar.", 400);
  }
  if (args.campaignId) {
    const { data } = await db.from("campaigns").select("id").eq("id", args.campaignId).eq("account_id", args.accountId).limit(1);
    if (!data?.length) return fail("campaign_not_found", "Campanha não encontrada", 404);
  }
  const { data, error } = await db
    .from("dispatch_import_jobs")
    .insert({
      account_id: args.accountId,
      requested_by: args.userId,
      campaign_id: args.campaignId,
      draft_id: args.draftId,
      column_map: args.columnMap,
    })
    .select("*")
    .limit(1);
  if (error) {
    if (isMissingTable(error)) return fail("unavailable", UNAVAILABLE, 503);
    throw new Error(`Falha ao criar a importação: ${error.message}`);
  }
  return { ok: true, job: (data as ImportJob[])[0] };
}

/** Linhas do bloco como texto (igual ao que o parse do arquivo daria), só objetos. */
export function normalizeBlockRows(rows: unknown[]): Record<string, string>[] {
  return rows
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && !Array.isArray(r))
    .map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v == null ? "" : String(v)])));
}

/** Grava as linhas do bloco `n` no Storage. Reenvio do mesmo bloco substitui (idempotente). */
export async function putImportBlock(db: Db, job: ImportJob, n: number, rawRows: unknown): Promise<JobResult> {
  if (job.state !== "receiving") return fail("not_receiving", "A importação não aceita mais blocos.", 409);
  if (!Number.isInteger(n) || n < 0 || n >= IMPORT_JOB_MAX_BLOCKS) return fail("invalid_block", `Bloco inválido (0 a ${IMPORT_JOB_MAX_BLOCKS - 1}).`, 400);
  if (!Array.isArray(rawRows) || rawRows.length === 0) return fail("no_rows", "Nenhuma linha enviada", 400);
  if (rawRows.length > IMPORT_BLOCK_MAX_ROWS) return fail("block_too_large", `Bloco grande demais (máximo ${IMPORT_BLOCK_MAX_ROWS} linhas).`, 400);
  const rows = normalizeBlockRows(rawRows);
  // Primeiro bloco: a coluna de contato escolhida precisa existir (mesma checagem da rota síncrona).
  if (n === 0 && !rows.some((row) => resolveField(row, job.column_map.phone, [])?.trim())) {
    return fail("no_phone_column", "A coluna de contato selecionada não contém nenhum telefone válido.", 400);
  }
  const { error: uploadError } = await db.storage.from(IMPORT_BUCKET).upload(blockPath(job, n), Buffer.from(JSON.stringify(rows), "utf8"), { contentType: "application/json", upsert: true });
  if (uploadError) throw new Error(`Falha ao guardar o bloco ${n}: ${uploadError.message}`);
  const blocks = { ...job.blocks, [String(n)]: rows.length };
  const rowsTotal = Object.values(blocks).reduce((a, b) => a + b, 0);
  const { data, error } = await db
    .from("dispatch_import_jobs")
    .update({ blocks, rows_total: rowsTotal })
    .eq("id", job.id)
    .eq("state", "receiving")
    .select("*")
    .limit(1);
  if (error) throw new Error(`Falha ao registrar o bloco: ${error.message}`);
  if (!data?.length) return fail("not_receiving", "A importação não aceita mais blocos.", 409);
  return { ok: true, job: data[0] as ImportJob };
}

/** Libera o job para o cron depois de conferir que os blocos 0..total-1 chegaram. */
export async function startImportJob(db: Db, job: ImportJob, totalBlocks: unknown): Promise<JobResult> {
  if (job.state !== "receiving") return fail("not_receiving", "A importação já foi iniciada.", 409);
  const total = Number(totalBlocks);
  if (!Number.isInteger(total) || total < 1 || total > IMPORT_JOB_MAX_BLOCKS) return fail("invalid_total", "Informe o total de blocos.", 400);
  const missing = Array.from({ length: total }, (_, i) => i).filter((i) => !(String(i) in job.blocks));
  if (missing.length > 0) {
    return fail("blocks_missing", `Faltam blocos: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? "…" : ""}.`, 409);
  }
  const { data, error } = await db
    .from("dispatch_import_jobs")
    .update({ state: "pending", blocks_total: total, next_attempt_at: new Date().toISOString() })
    .eq("id", job.id)
    .eq("state", "receiving")
    .select("*")
    .limit(1);
  if (error) throw new Error(`Falha ao iniciar a importação: ${error.message}`);
  if (!data?.length) return fail("not_receiving", "A importação já foi iniciada.", 409);
  return { ok: true, job: data[0] as ImportJob };
}

// ── Processamento ──────────────────────────────────────────────────────────

export type ProcessBlock = typeof importContactBlock;
export type ImportProcessResult = "done" | "continue" | "failed" | "retry";

async function patch(db: Db, id: string, owner: string, values: Record<string, unknown>) {
  const { error } = await db.from("dispatch_import_jobs").update(values).eq("id", id).eq("owner_id", owner);
  if (error) throw new Error(`Falha ao atualizar o job de importação: ${error.message}`);
}

async function loadBlock(db: Db, job: ImportJob, n: number): Promise<Record<string, string>[]> {
  const { data, error } = await db.storage.from(IMPORT_BUCKET).download(blockPath(job, n));
  if (error || !data) throw new Error(`Falha ao ler o bloco ${n}: ${error?.message ?? "vazio"}`);
  const parsed = JSON.parse(await (data as Blob).text()) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`Bloco ${n} corrompido`);
  return parsed as Record<string, string>[];
}

const addTotals = (a: ImportTotals, b: ImportTotals): ImportTotals => ({
  importados: a.importados + b.importados,
  duplicados: a.duplicados + b.duplicados,
  invalidos: a.invalidos + b.invalidos,
  blacklisted: a.blacklisted + b.blacklisted,
  variaveis_falhas: a.variaveis_falhas + b.variaveis_falhas,
});

async function removeBlocks(db: Db, job: ImportJob): Promise<void> {
  const total = job.blocks_total ?? Object.keys(job.blocks).length;
  const paths = Array.from({ length: Math.max(total, Object.keys(job.blocks).length) }, (_, i) => blockPath(job, i));
  if (paths.length) await db.storage.from(IMPORT_BUCKET).remove(paths).catch(() => undefined);
}

/**
 * Processa um job reservado (claim_dispatch_import_job): os blocos em ordem a partir de `next_block`, até acabar ou até o
 * orçamento de tempo. `continue` = o progresso ficou salvo; o próximo tick segue.
 */
export async function processImportJob(
  db: Db,
  job: ImportJob,
  options: { owner: string; budgetMs?: number; clock?: () => number; now?: () => Date; processBlock?: ProcessBlock } = { owner: "import" },
): Promise<ImportProcessResult> {
  const clock = options.clock ?? Date.now;
  const nowFn = options.now ?? (() => new Date());
  const processBlock = options.processBlock ?? importContactBlock;
  const owner = options.owner;
  const deadline = clock() + (options.budgetMs ?? 45_000);
  const total = job.blocks_total ?? 0;
  try {
    // Quem importa precisa de um usuário "dono" das linhas criadas (user_id NOT NULL em contacts).
    const userId = job.requested_by;
    if (!userId) {
      await patch(db, job.id, owner, { state: "failed", last_error: "Importação sem usuário solicitante", finished_at: nowFn().toISOString(), lease_until: null, owner_id: null });
      return "failed";
    }
    let current = { ...job, errors: [...job.errors], totals: { ...emptyTotals(), ...job.totals } };
    while (current.next_block < total) {
      const n = current.next_block;
      const rows = await loadBlock(db, current, n);
      const outcome: ImportBlockOutcome = await processBlock({
        accountId: current.account_id,
        userId,
        rows,
        columnMap: current.column_map,
        campaignId: current.campaign_id,
        draftId: current.draft_id,
        chunkIndex: n,
      });
      // Falha do bloco (ex.: vínculo com a campanha não gravou): o bloco é idempotente, então tenta de novo (retry/backoff).
      if (outcome.failure) throw new Error(`Bloco ${n}: ${outcome.failure.error}`);
      const errors = [...current.errors, ...outcome.results.erros].slice(0, IMPORT_MAX_ERRORS);
      current = {
        ...current,
        next_block: n + 1,
        rows_done: current.rows_done + rows.length,
        totals: addTotals(current.totals, outcome.results),
        linked: current.linked + outcome.linked,
        errors,
      };
      // Só DEPOIS do bloco gravado o cursor avança (queda entre os dois repete o bloco, que é idempotente).
      await patch(db, job.id, owner, {
        next_block: current.next_block,
        rows_done: current.rows_done,
        totals: current.totals,
        linked: current.linked,
        errors: current.errors,
        lease_until: new Date(nowFn().getTime() + LEASE_SECONDS * 1000).toISOString(),
      });
      if (current.next_block < total && clock() > deadline) return "continue";
    }
    await removeBlocks(db, current);
    await patch(db, job.id, owner, {
      state: "done",
      finished_at: nowFn().toISOString(),
      expires_at: nowFn().toISOString(),
      lease_until: null,
      owner_id: null,
      last_error: null,
    });
    return "done";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const attempts = job.attempts + 1;
    const dead = attempts >= IMPORT_MAX_ATTEMPTS;
    await db
      .from("dispatch_import_jobs")
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

// ── Limpeza ────────────────────────────────────────────────────────────────

/** Jobs que ficaram "recebendo" e nunca foram liberados: cancela e apaga os blocos guardados. */
export async function cancelStaleImportJobs(db: Db, now: Date = new Date(), limit = 20): Promise<number> {
  const cutoff = new Date(now.getTime() - IMPORT_RECEIVING_TTL_HOURS * 3_600_000).toISOString();
  const { data, error } = await db.from("dispatch_import_jobs").select("*").eq("state", "receiving").lt("created_at", cutoff).limit(limit);
  if (error || !data?.length) return 0;
  let cancelled = 0;
  for (const job of data as ImportJob[]) {
    await removeBlocks(db, job);
    const { error: updateError } = await db
      .from("dispatch_import_jobs")
      .update({ state: "cancelled", finished_at: now.toISOString(), last_error: "Importação abandonada (blocos não liberados em 24 h)" })
      .eq("id", job.id)
      .eq("state", "receiving");
    if (!updateError) cancelled++;
  }
  return cancelled;
}

export interface ImportCronSummary {
  processed: number;
  done: number;
  failed: number;
  continued: number;
  cancelled: number;
  unavailable: boolean;
}

export async function runImportCron(
  db: Db,
  options: { owner: string; budgetMs?: number; clock?: () => number; processBlock?: ProcessBlock } = { owner: "import-cron" },
): Promise<ImportCronSummary> {
  const clock = options.clock ?? Date.now;
  const deadline = clock() + (options.budgetMs ?? 80_000);
  const summary: ImportCronSummary = { processed: 0, done: 0, failed: 0, continued: 0, cancelled: 0, unavailable: false };
  while (clock() < deadline) {
    const { data, error } = await db.rpc("claim_dispatch_import_job", { p_owner: options.owner, p_lease_seconds: LEASE_SECONDS });
    if (error) {
      summary.unavailable = error.code === "PGRST202" || error.code === "42883" || isMissingTable(error);
      if (!summary.unavailable) console.error("[import-cron] falha ao reservar job:", error.message);
      break;
    }
    const job = (Array.isArray(data) ? data[0] : data) as ImportJob | undefined;
    if (!job) break;
    const result = await processImportJob(db, job, { owner: options.owner, budgetMs: Math.max(deadline - clock(), 1_000), clock, processBlock: options.processBlock });
    summary.processed++;
    if (result === "done") summary.done++;
    else if (result === "failed") summary.failed++;
    else if (result === "continue") summary.continued++;
  }
  summary.cancelled = await cancelStaleImportJobs(db);
  return summary;
}

/** Formato público (contrato com o front): sem dono/lease/caminhos. */
export function toPublicImportJob(job: ImportJob) {
  return {
    id: job.id,
    campaign_id: job.campaign_id,
    draft_id: job.draft_id,
    state: job.state,
    blocks_received: Object.keys(job.blocks).length,
    blocks_total: job.blocks_total,
    next_block: job.next_block,
    rows_total: job.rows_total,
    rows_done: job.rows_done,
    progress: job.rows_total > 0 ? Math.min(1, job.rows_done / job.rows_total) : null,
    totals: job.totals,
    linked: job.linked,
    errors: job.errors,
    created_at: job.created_at,
    finished_at: job.finished_at,
    error: job.state === "failed" ? job.last_error : null,
  };
}

/** Rascunho novo ainda não tem campanha: aceita UUID não usado, mas nunca o de OUTRA conta (mesma checagem da rota síncrona). */
export async function draftBelongsToOtherAccount(db: Db, draftId: string, accountId: string): Promise<boolean | "error"> {
  const checks = await Promise.all([
    db.from("campaigns").select("id").eq("import_draft_id", draftId).neq("account_id", accountId).limit(1),
    db.from("disp_import_contacts").select("id").eq("draft_id", draftId).neq("account_id", accountId).limit(1),
    db.from("disparador_utm_links").select("id").eq("draft_id", draftId).neq("account_id", accountId).limit(1),
    db.from("contact_import_variables").select("id, contacts!inner(account_id)").eq("draft_id", draftId).neq("contacts.account_id", accountId).limit(1),
  ]);
  if (checks.some((c: any) => c.error)) return "error";
  return checks.some((c: any) => (c.data?.length ?? 0) > 0);
}
