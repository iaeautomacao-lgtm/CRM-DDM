/* eslint-disable @typescript-eslint/no-explicit-any -- cliente admin com schema wacrm */
// Exportação ASSÍNCRONA da fila do Disparador (PRD 11, A22 / migration 203).
//
// Exportar 100 mil linhas dentro da requisição derrubava o pooler e o processo. Agora o pedido vira um JOB
// (wacrm.dispatch_export_jobs) e um cron stateless (POST /api/disparador/exports/cron) o processa em BLOCOS RETOMÁVEIS:
//   1) lê a fila por KEYSET de id (`id > cursor ORDER BY id LIMIT N` — nunca OFFSET), com os mesmos filtros do detalhamento;
//   2) grava cada bloco como PARTE no Storage (parte n é sobrescrita se o processo cair e repetir — idempotente) e só
//      depois avança o cursor no banco: restart/deploy no meio só continua de onde parou;
//   3) ao terminar a leitura, junta as partes em UM CSV (BOM + `;`, abre direto no Excel pt-BR), apaga as partes e guarda
//      o caminho; o link de download é assinado na hora (curto) e o arquivo expira em 24 h (o cron apaga e marca 'expired').
// Nada vive em memória entre ticks. Meta × WAHA não entram: é só leitura de disp_message_queue.

import {
  attachLegacyCsvNames,
  SELECT_COLUMNS,
  SELECT_COLUMNS_REPLIED,
  toDetailRow,
  type QueueDetailRow,
  type QueueRow,
} from "@/lib/disparador/queue-details-rows";
import {
  PENDING_CONFIRMATION_OR_FILTER,
  PENDING_CONFIRMATION_QUEUE_DETAIL_KEY,
  QUEUE_DETAIL_STATUS_FILTERS,
  REPLIED_QUEUE_DETAIL_KEY,
} from "@/lib/disparador/queue-status-filters";
import { csvCell, csvLine, csvSafe } from "@/lib/security/csv-safe";

type Db = any;

/** Bucket de Storage já existente (migration 055): arquivos sob `<account_id>/…` — só service_role/relatórios acessam. */
export const EXPORT_BUCKET = "relatorio-exports";
/** Linhas por bloco (uma consulta + uma parte). */
export const EXPORT_BLOCK_ROWS = 2000;
/** Teto de linhas de UM job (o mesmo de antes da exportação síncrona). */
export const EXPORT_MAX_ROWS = 100_000;
/** Acima disso a exportação síncrona do detalhamento recusa e manda usar o job. */
export const EXPORT_SYNC_MAX_ROWS = 10_000;
/** Validade do arquivo depois de pronto. */
export const EXPORT_TTL_HOURS = 24;
/** Validade de cada link de download assinado. */
export const EXPORT_SIGNED_URL_SECONDS = 600;
export const EXPORT_MAX_ATTEMPTS = 3;
const LEASE_SECONDS = 120;

export type ExportState = "pending" | "running" | "done" | "failed" | "expired" | "cancelled";

export interface ExportJob {
  id: string;
  account_id: string;
  campaign_id: string;
  requested_by: string | null;
  status_key: string;
  format: "csv";
  state: ExportState;
  rows_done: number;
  total_rows: number | null;
  parts_count: number;
  cursor_id: string | null;
  truncated: boolean;
  file_path: string | null;
  file_size: number | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  expires_at: string | null;
}

/** Métricas aceitas pelo job (as mesmas do detalhamento). */
export function isValidExportStatusKey(key: string): boolean {
  return key === "total" || key in QUEUE_DETAIL_STATUS_FILTERS;
}

// ── CSV ────────────────────────────────────────────────────────────────────

// Helper ÚNICO de CSV seguro (PRD 14, 14.6): src/lib/security/csv-safe.ts. Reexportado aqui só para quem já importava daqui.
export { csvCell, csvLine, csvSafe };

/** Cabeçalho = as colunas do XLSX do detalhamento. */
export function exportColumns(statusKey: string): string[] {
  const cols = ["Contato", "Telefone", "Status", "Mensagem Final"];
  if (statusKey === "erro") cols.push("Tipo de Erro");
  if (statusKey === PENDING_CONFIRMATION_QUEUE_DETAIL_KEY) cols.push("Motivo");
  cols.push("Data/Hora");
  return cols;
}

export function exportCells(row: QueueDetailRow, statusKey: string): string[] {
  const cells = [row.contact_name ?? "-", row.phone ?? "-", row.status, row.mensagem_final ?? ""];
  if (statusKey === "erro") cells.push(row.tipo_erro ?? "Outro");
  if (statusKey === PENDING_CONFIRMATION_QUEUE_DETAIL_KEY) cells.push(row.erro ?? "Aguardando confirmação final");
  cells.push(row.data_hora ? new Date(row.data_hora).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "-");
  return cells;
}

// ── Storage ────────────────────────────────────────────────────────────────

const partPath = (job: Pick<ExportJob, "account_id" | "id">, n: number) =>
  `${job.account_id}/disparador-exports/${job.id}/parts/${String(n).padStart(5, "0")}.csv`;
const finalPath = (job: Pick<ExportJob, "account_id" | "id">) => `${job.account_id}/disparador-exports/${job.id}/export.csv`;

// ── Pedido ─────────────────────────────────────────────────────────────────

export type CreateJobResult = { ok: true; job: ExportJob } | { ok: false; code: "invalid_status" | "unavailable"; message: string };

function isMissingTable(error: { code?: string; message?: string } | null | undefined): boolean {
  return error?.code === "42P01" || error?.code === "PGRST205" || /dispatch_export_jobs/.test(error?.message ?? "") && /does not exist|schema cache/i.test(error?.message ?? "");
}

/** Cria o job (a rota já conferiu que a campanha é da conta). Um pedido igual em andamento é reaproveitado. */
export async function createExportJob(
  db: Db,
  args: { accountId: string; campaignId: string; userId: string | null; statusKey: string; totalRows: number | null },
): Promise<CreateJobResult> {
  if (!isValidExportStatusKey(args.statusKey)) return { ok: false, code: "invalid_status", message: `status inválido: ${args.statusKey}` };

  const existing = await db
    .from("dispatch_export_jobs")
    .select("*")
    .eq("account_id", args.accountId)
    .eq("campaign_id", args.campaignId)
    .eq("status_key", args.statusKey)
    .in("state", ["pending", "running"])
    .limit(1);
  if (existing.error) {
    if (isMissingTable(existing.error)) return { ok: false, code: "unavailable", message: "Exportação em segundo plano indisponível: aplique a migration 203." };
    throw new Error(`Falha ao consultar exportações: ${existing.error.message}`);
  }
  if (existing.data?.[0]) return { ok: true, job: existing.data[0] as ExportJob };

  const { data, error } = await db
    .from("dispatch_export_jobs")
    .insert({
      account_id: args.accountId,
      campaign_id: args.campaignId,
      requested_by: args.userId,
      status_key: args.statusKey,
      total_rows: args.totalRows,
    })
    .select("*")
    .limit(1);
  if (error) {
    if (isMissingTable(error)) return { ok: false, code: "unavailable", message: "Exportação em segundo plano indisponível: aplique a migration 203." };
    throw new Error(`Falha ao criar a exportação: ${error.message}`);
  }
  return { ok: true, job: (data as ExportJob[])[0] };
}

// ── Processamento ──────────────────────────────────────────────────────────

async function fetchBlock(db: Db, job: ExportJob, limit: number): Promise<QueueRow[]> {
  const replied = job.status_key === REPLIED_QUEUE_DETAIL_KEY;
  const pending = job.status_key === PENDING_CONFIRMATION_QUEUE_DETAIL_KEY;
  const statuses = job.status_key === "total" ? null : QUEUE_DETAIL_STATUS_FILTERS[job.status_key];
  let query = db
    .from("disp_message_queue")
    .select(replied ? SELECT_COLUMNS_REPLIED : SELECT_COLUMNS)
    .eq("campaign_id", job.campaign_id);
  if (statuses) query = query.in("status", statuses);
  if (pending) query = query.or(PENDING_CONFIRMATION_OR_FILTER);
  if (replied) query = query.not("replied_at", "is", null);
  if (job.cursor_id) query = query.gt("id", job.cursor_id);
  const { data, error } = await query.order("id", { ascending: true }).limit(limit);
  if (error) throw new Error(`Falha ao ler a fila: ${error.message}`);
  return (data ?? []) as QueueRow[];
}

async function patchJob(db: Db, id: string, owner: string, patch: Record<string, unknown>) {
  const { error } = await db.from("dispatch_export_jobs").update(patch).eq("id", id).eq("owner_id", owner);
  if (error) throw new Error(`Falha ao atualizar o job de exportação: ${error.message}`);
}

async function finalize(db: Db, job: ExportJob, owner: string, now: Date): Promise<void> {
  const bucket = db.storage.from(EXPORT_BUCKET);
  const chunks: Buffer[] = [Buffer.from("﻿" + csvLine(exportColumns(job.status_key)), "utf8")];
  for (let n = 1; n <= job.parts_count; n++) {
    const { data, error } = await bucket.download(partPath(job, n));
    if (error || !data) throw new Error(`Falha ao ler a parte ${n}: ${error?.message ?? "vazia"}`);
    chunks.push(Buffer.from(await (data as Blob).arrayBuffer()));
  }
  const file = Buffer.concat(chunks);
  const path = finalPath(job);
  const { error: uploadError } = await bucket.upload(path, file, { contentType: "text/csv", upsert: true });
  if (uploadError) throw new Error(`Falha ao gravar o arquivo final: ${uploadError.message}`);
  // Partes não servem mais (best-effort: sobra de parte não quebra nada, o cron de expiração limpa o prefixo).
  if (job.parts_count > 0) {
    await bucket.remove(Array.from({ length: job.parts_count }, (_, i) => partPath(job, i + 1))).catch(() => undefined);
  }
  await patchJob(db, job.id, owner, {
    state: "done",
    file_path: path,
    file_size: file.length,
    finished_at: now.toISOString(),
    expires_at: new Date(now.getTime() + EXPORT_TTL_HOURS * 3_600_000).toISOString(),
    lease_until: null,
    owner_id: null,
    last_error: null,
  });
}

export type ProcessResult = "done" | "continue" | "failed" | "retry";

/**
 * Processa um job reservado (claim_dispatch_export_job) até esvaziar ou até o orçamento de tempo acabar.
 * `continue` = o cursor ficou salvo; o próximo tick segue (o lease é renovado a cada bloco).
 */
export async function processExportJob(
  db: Db,
  job: ExportJob,
  options: { owner: string; budgetMs?: number; clock?: () => number; now?: () => Date } = { owner: "export" },
): Promise<ProcessResult> {
  const clock = options.clock ?? Date.now;
  const nowFn = options.now ?? (() => new Date());
  const deadline = clock() + (options.budgetMs ?? 45_000);
  const owner = options.owner;
  try {
    const { data: campaign, error: campaignError } = await db
      .from("campaigns")
      .select("id, account_id, import_draft_id")
      .eq("id", job.campaign_id)
      .maybeSingle();
    if (campaignError) throw new Error(`Falha ao ler a campanha: ${campaignError.message}`);
    // Defesa: o job só lê a campanha da própria conta.
    if (!campaign || campaign.account_id !== job.account_id) {
      await patchJob(db, job.id, owner, { state: "failed", last_error: "Campanha não encontrada", finished_at: nowFn().toISOString(), lease_until: null, owner_id: null });
      return "failed";
    }

    let current = { ...job };
    for (;;) {
      const room = EXPORT_MAX_ROWS - current.rows_done;
      const block = room > 0 ? await fetchBlock(db, current, Math.min(EXPORT_BLOCK_ROWS, room)) : [];
      if (block.length > 0) {
        const rows = await attachLegacyCsvNames(block.map((r) => toDetailRow(r)), job.campaign_id, campaign.import_draft_id ?? null);
        const n = current.parts_count + 1;
        const body = Buffer.from(rows.map((r) => csvLine(exportCells(r, job.status_key))).join(""), "utf8");
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
      const exhausted = block.length < EXPORT_BLOCK_ROWS || current.rows_done >= EXPORT_MAX_ROWS;
      if (exhausted) {
        // Bateu no teto de linhas do job: o arquivo pode estar incompleto (aviso para o usuário).
        if (current.rows_done >= EXPORT_MAX_ROWS) await patchJob(db, job.id, owner, { truncated: true });
        await finalize(db, current, owner, nowFn());
        return "done";
      }
      if (clock() > deadline) return "continue";
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const attempts = job.attempts + 1;
    const dead = attempts >= EXPORT_MAX_ATTEMPTS;
    await db
      .from("dispatch_export_jobs")
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

// ── Expiração ──────────────────────────────────────────────────────────────

/** Apaga arquivos vencidos (e partes que sobraram) e marca 'expired'. Devolve quantos. */
export async function expireExportJobs(db: Db, now: Date = new Date(), limit = 50): Promise<number> {
  const { data, error } = await db
    .from("dispatch_export_jobs")
    .select("id, account_id, file_path, parts_count")
    .eq("state", "done")
    .lt("expires_at", now.toISOString())
    .limit(limit);
  if (error || !data?.length) return 0;
  let expired = 0;
  for (const job of data as Array<{ id: string; account_id: string; file_path: string | null; parts_count: number }>) {
    const paths = [job.file_path, ...Array.from({ length: job.parts_count ?? 0 }, (_, i) => partPath(job, i + 1))].filter((p): p is string => !!p);
    if (paths.length) await db.storage.from(EXPORT_BUCKET).remove(paths).catch(() => undefined);
    const { error: updateError } = await db
      .from("dispatch_export_jobs")
      .update({ state: "expired", file_path: null })
      .eq("id", job.id)
      .eq("state", "done");
    if (!updateError) expired++;
  }
  return expired;
}

export interface ExportCronSummary {
  processed: number;
  done: number;
  failed: number;
  continued: number;
  expired: number;
  unavailable: boolean;
}

/** Um tick do cron: reserva e processa jobs (um por vez) dentro do orçamento; depois limpa os vencidos. */
export async function runExportCron(db: Db, options: { owner: string; budgetMs?: number; clock?: () => number } = { owner: "export-cron" }): Promise<ExportCronSummary> {
  const clock = options.clock ?? Date.now;
  const deadline = clock() + (options.budgetMs ?? 50_000);
  const summary: ExportCronSummary = { processed: 0, done: 0, failed: 0, continued: 0, expired: 0, unavailable: false };
  while (clock() < deadline) {
    const { data, error } = await db.rpc("claim_dispatch_export_job", { p_owner: options.owner, p_lease_seconds: LEASE_SECONDS });
    if (error) {
      summary.unavailable = error.code === "PGRST202" || error.code === "42883" || isMissingTable(error);
      if (!summary.unavailable) console.error("[export-cron] falha ao reservar job:", error.message);
      break;
    }
    const job = (Array.isArray(data) ? data[0] : data) as ExportJob | undefined;
    if (!job) break;
    const result = await processExportJob(db, job, { owner: options.owner, budgetMs: Math.max(deadline - clock(), 1_000), clock });
    summary.processed++;
    if (result === "done") summary.done++;
    else if (result === "failed") summary.failed++;
    else if (result === "continue") summary.continued++;
  }
  summary.expired = await expireExportJobs(db);
  return summary;
}

/** Link de download assinado e curto; só para job concluído e não vencido. */
export async function signedDownloadUrl(db: Db, job: Pick<ExportJob, "state" | "file_path" | "expires_at">, now: Date = new Date()): Promise<{ url: string; expiresInSeconds: number } | null> {
  if (job.state !== "done" || !job.file_path) return null;
  if (job.expires_at && Date.parse(job.expires_at) <= now.getTime()) return null;
  const { data, error } = await db.storage.from(EXPORT_BUCKET).createSignedUrl(job.file_path, EXPORT_SIGNED_URL_SECONDS);
  if (error || !data?.signedUrl) return null;
  return { url: data.signedUrl as string, expiresInSeconds: EXPORT_SIGNED_URL_SECONDS };
}
