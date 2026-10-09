import "server-only";
// PRD 17, PR 17.2 — sincronização da fonte B: importa a carteira (com vencimento) e confere a dívida na fonte ANTES de cobrar.
//
//   importDebts            carteira → wacrm.billing_debts (upsert por conta+fonte+ref; NUNCA reabre dívida já paga/em acordo)
//   enrollOpenDebts        RPC billing_enroll_open_debts (inscreve na régua o que ainda tem etapa a cumprir)
//   checkDebtBeforeSend    consulta pontual à fonte (com cache por last_checked_at); pago/acordo/cancelado ⇒ PARA a inscrição
//                          (billing_stop_enrollments) e a etapa não sai; fonte fora do ar ⇒ ADIA (nunca "envia por precaução")
//   precheckUpcoming       confere antes, em lote, as dívidas cuja etapa vence nas próximas horas (o tick do motor quase nunca espera a API)
//   recordSyncRun          estado/erro por (conta, fonte) para o alerta "sync sem sucesso há > 1 h"
// O CPF é lido do contato, passado à fonte e descartado: nunca é gravado em billing_*, nunca vai para log ou erro.
// Depende das migrations 270–275 (PR 17.1); sem elas as chamadas falham com erro do banco (o motor só liga na PR 17.3).
import type { SupabaseClient } from "@supabase/supabase-js";

import { DebtSourceError, normalizeDocument, stopReasonFor, type DebtSource } from "./debt-source";

type Db = Pick<SupabaseClient, "from" | "rpc">;

export const IMPORT_CHUNK = 1000;
/** Confiança numa consulta recente: dentro dela não se pergunta de novo à fonte (protege a API da DDM). */
export const DEFAULT_CHECK_TTL_MS = 30 * 60_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DebtImportRow {
  contact_id: string;
  external_ref: string;
  /** YYYY-MM-DD (data civil, sem hora). */
  due_date: string;
  amount_cents?: number | null;
}

export type RejectReason = "invalid_contact" | "invalid_ref" | "invalid_due_date" | "invalid_amount" | "duplicate_in_batch";

export interface ImportResult {
  received: number;
  imported: number;
  rejected: Array<{ index: number; reason: RejectReason }>;
}

export function isValidDateOnly(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function validateImportRow(row: Partial<DebtImportRow>): RejectReason | null {
  if (typeof row.contact_id !== "string" || !UUID_RE.test(row.contact_id)) return "invalid_contact";
  if (typeof row.external_ref !== "string" || row.external_ref.length < 1 || row.external_ref.length > 200) return "invalid_ref";
  if (!isValidDateOnly(row.due_date)) return "invalid_due_date";
  if (row.amount_cents != null && (!Number.isInteger(row.amount_cents) || row.amount_cents < 0)) return "invalid_amount";
  return null;
}

/**
 * Carteira → billing_debts. Linhas inválidas são recusadas com motivo (o resto entra). A mesma (fonte, ref) repetida no lote vale a ÚLTIMA.
 * O upsert não envia `status`: dívida já paga/em acordo/cancelada continua assim (a carteira nunca "reabre" cobrança).
 */
export async function importDebts(db: Db, accountId: string, rows: DebtImportRow[], options: { source?: string; now?: Date } = {}): Promise<ImportResult> {
  const source = options.source ?? "ddm";
  const now = (options.now ?? new Date()).toISOString();
  const rejected: ImportResult["rejected"] = [];
  const byRef = new Map<string, { index: number; row: DebtImportRow }>();

  rows.forEach((row, index) => {
    const reason = validateImportRow(row);
    if (reason) return void rejected.push({ index, reason });
    const previous = byRef.get(row.external_ref);
    if (previous) rejected.push({ index: previous.index, reason: "duplicate_in_batch" });
    byRef.set(row.external_ref, { index, row });
  });

  const payload = [...byRef.values()].map(({ row }) => ({
    account_id: accountId,
    contact_id: row.contact_id,
    source,
    external_ref: row.external_ref,
    due_date: row.due_date,
    amount_cents: row.amount_cents ?? null,
    synced_at: now,
  }));

  let imported = 0;
  for (let i = 0; i < payload.length; i += IMPORT_CHUNK) {
    const chunk = payload.slice(i, i + IMPORT_CHUNK);
    const { error } = await db.from("billing_debts").upsert(chunk, { onConflict: "account_id,source,external_ref" });
    if (error) throw error;
    imported += chunk.length;
  }
  return { received: rows.length, imported, rejected: rejected.sort((a, b) => a.index - b.index) };
}

export async function enrollOpenDebts(db: Db, accountId: string, rulerId: string, now: Date = new Date()): Promise<number> {
  const { data, error } = await db.rpc("billing_enroll_open_debts", { p_account: accountId, p_ruler: rulerId, p_now: now.toISOString() });
  if (error) throw error;
  return Number(data ?? 0);
}

export type CheckDecision =
  | { send: true; reason: "open" | "fresh" }
  | { send: false; reason: "debt_not_found" | "debt_paid" | "debt_agreement" | "debt_cancelled" | "debt_closed" | "paid" | "agreement" | "cancelled" | "unknown_state" | "invalid_document" }
  | { send: false; reason: "source_unavailable"; retryable: boolean };

/** Decide se a etapa desta dívida pode sair AGORA, perguntando à fonte quando o último resultado já é velho. Nunca lança por falha da fonte. */
export async function checkDebtBeforeSend(
  db: Db,
  source: DebtSource,
  input: { accountId: string; debtId: string; cpf: string | null; now?: Date; ttlMs?: number },
): Promise<CheckDecision> {
  const now = input.now ?? new Date();
  const ttl = input.ttlMs ?? DEFAULT_CHECK_TTL_MS;

  const { data, error } = await db
    .from("billing_debts")
    .select("id, status, external_ref, last_checked_at")
    .eq("account_id", input.accountId)
    .eq("id", input.debtId)
    .limit(1);
  if (error) throw error;
  const debt = (data as Array<{ id: string; status: string; external_ref: string; last_checked_at: string | null }> | null)?.[0];
  if (!debt) return { send: false, reason: "debt_not_found" };
  if (debt.status !== "open") {
    return { send: false, reason: (["paid", "agreement", "cancelled"].includes(debt.status) ? `debt_${debt.status}` : "debt_closed") as "debt_paid" };
  }
  if (debt.last_checked_at && now.getTime() - new Date(debt.last_checked_at).getTime() < ttl) return { send: true, reason: "fresh" };

  const cpf = normalizeDocument(input.cpf);
  if (!cpf) return { send: false, reason: "invalid_document" };

  let status;
  try {
    status = await source.getStatus({ cpf, externalRef: debt.external_ref });
  } catch (err) {
    return { send: false, reason: "source_unavailable", retryable: err instanceof DebtSourceError ? err.retryable : true };
  }

  const stop = stopReasonFor(status.state);
  if (stop) {
    const { error: stopError } = await db.rpc("billing_stop_enrollments", { p_account: input.accountId, p_reason: stop, p_debt: input.debtId, p_contact: null });
    if (stopError) throw stopError;
    return { send: false, reason: stop };
  }
  if (status.state !== "open") return { send: false, reason: "unknown_state" };

  const { error: touchError } = await db
    .from("billing_debts")
    .update({ last_checked_at: now.toISOString(), ...(status.amountCents != null ? { amount_cents: status.amountCents } : {}) })
    .eq("account_id", input.accountId)
    .eq("id", input.debtId);
  if (touchError) throw touchError;
  return { send: true, reason: "open" };
}

/** Carrega o CPF do contato da dívida (só em memória) e confere. */
export async function checkDebtById(db: Db, source: DebtSource, accountId: string, debtId: string, options: { now?: Date; ttlMs?: number } = {}): Promise<CheckDecision> {
  const { data, error } = await db.from("billing_debts").select("id, contacts(cpf)").eq("account_id", accountId).eq("id", debtId).limit(1);
  if (error) throw error;
  const row = (data as Array<{ id: string; contacts: { cpf: string | null } | { cpf: string | null }[] | null }> | null)?.[0];
  if (!row) return { send: false, reason: "debt_not_found" };
  const contact = Array.isArray(row.contacts) ? row.contacts[0] : row.contacts;
  return checkDebtBeforeSend(db, source, { accountId, debtId, cpf: contact?.cpf ?? null, ...options });
}

export interface PrecheckSummary {
  candidates: number;
  checked: number;
  stopped: number;
  deferred: number;
  fresh: number;
}

/**
 * Confere em lote as dívidas cuja próxima etapa vence dentro de `withinMs` e cuja última consulta é velha (ou inexistente).
 * Para quando a fonte pede limite (retryable) para não insistir; o resto fica para o próximo ciclo.
 */
export async function precheckUpcoming(
  db: Db,
  source: DebtSource,
  accountId: string,
  options: { withinMs?: number; limit?: number; concurrency?: number; ttlMs?: number; now?: Date } = {},
): Promise<PrecheckSummary> {
  const now = options.now ?? new Date();
  const ttl = options.ttlMs ?? DEFAULT_CHECK_TTL_MS;
  const limit = Math.max(1, Math.min(options.limit ?? 200, 1000));
  const cutoff = new Date(now.getTime() + (options.withinMs ?? 24 * 3_600_000)).toISOString();
  const staleBefore = new Date(now.getTime() - ttl).toISOString();
  const summary: PrecheckSummary = { candidates: 0, checked: 0, stopped: 0, deferred: 0, fresh: 0 };

  const { data: due, error } = await db
    .from("billing_enrollments")
    .select("debt_id")
    .eq("account_id", accountId)
    .eq("status", "active")
    .lte("next_step_at", cutoff)
    .order("next_step_at", { ascending: true })
    .limit(limit * 3);
  if (error) throw error;
  const debtIds = [...new Set(((due ?? []) as Array<{ debt_id: string }>).map((r) => r.debt_id))];
  if (debtIds.length === 0) return summary;

  const { data: stale, error: staleError } = await db
    .from("billing_debts")
    .select("id")
    .eq("account_id", accountId)
    .eq("status", "open")
    .in("id", debtIds)
    .or(`last_checked_at.is.null,last_checked_at.lt.${staleBefore}`)
    .limit(limit);
  if (staleError) throw staleError;
  const queue = ((stale ?? []) as Array<{ id: string }>).map((r) => r.id);
  summary.candidates = queue.length;

  let next = 0;
  let halt = false;
  const worker = async () => {
    while (!halt && next < queue.length) {
      const id = queue[next++];
      const decision = await checkDebtById(db, source, accountId, id, { now, ttlMs: ttl });
      if (decision.send) {
        if (decision.reason === "fresh") summary.fresh++;
        else summary.checked++;
      } else if (decision.reason === "source_unavailable") {
        summary.deferred++;
        if (decision.retryable) halt = true; // limite/queda da fonte: não insiste neste ciclo
      } else if (decision.reason === "paid" || decision.reason === "agreement" || decision.reason === "cancelled") {
        summary.checked++;
        summary.stopped++;
      } else {
        summary.deferred++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 4, 10)) }, worker));
  return summary;
}

export async function recordSyncRun(db: Db, accountId: string, source: string, outcome: { error?: string | null; now?: Date } = {}): Promise<void> {
  const now = (outcome.now ?? new Date()).toISOString();
  const { error } = await db.from("billing_sync_state").upsert(
    {
      account_id: accountId,
      source,
      last_run_at: now,
      ...(outcome.error ? {} : { last_success_at: now }),
      last_error: outcome.error ? outcome.error.slice(0, 300) : null,
      updated_at: now,
    },
    { onConflict: "account_id,source" },
  );
  if (error) throw error;
}
