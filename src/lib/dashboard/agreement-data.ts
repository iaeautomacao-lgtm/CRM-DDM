import type { SupabaseClient } from "@supabase/supabase-js";

import {
  summarizeAgreements,
  type AgreementAudit,
  type AgreementConversation,
  type AgreementDashboardMetrics,
} from "./agreement-metrics";

// The Next.js API route uses a service-role client, but every lookup
// explicitly restricts data to the account derived from the user's
// authenticated session. No contact data is returned to the browser.
//
// Pagination is essential: PostgREST often has a 1000-row response cap.
// A truncated agreement or audit set would silently corrupt KPIs.
const PAGE_SIZE = 500;
const AUDIT_BATCH = 80;
const MAX_AGREEMENTS = 50_000;
const MAX_AUDITS_PER_BATCH = 50_000;
const AGREEMENT_CODE = 142;

interface AgreementTagRow {
  id: string;
  name: string;
}

async function listAccountAgreements(
  db: SupabaseClient,
  accountId: string,
  tagIds: string[],
): Promise<AgreementConversation[]> {
  const all: AgreementConversation[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await db
      .from("conversations")
      .select("id, outcome_tag_id, closed_at")
      .eq("account_id", accountId)
      .in("outcome_tag_id", tagIds)
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) throw new Error("Falha ao consultar conversas com acordo: " + error.message);
    const page = (data ?? []) as AgreementConversation[];
    all.push(...page);
    if (all.length > MAX_AGREEMENTS) {
      throw new Error("Volume de acordos excede o limite do relatório; otimizar com RPC");
    }
    if (page.length < PAGE_SIZE) return all;
  }
}

async function listAgreementAudits(
  db: SupabaseClient,
  accountId: string,
  conversationIds: readonly string[],
): Promise<AgreementAudit[]> {
  const all: AgreementAudit[] = [];
  for (let i = 0; i < conversationIds.length; i += AUDIT_BATCH) {
    const ids = conversationIds.slice(i, i + AUDIT_BATCH);
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const { data, error } = await db
        .from("audit_logs")
        .select("id, resource_id, actor_type, created_at, changes")
        .eq("account_id", accountId)
        .eq("resource_type", "conversation")
        .in("resource_id", ids)
        // Fetch only audited tag changes; assignment/close events
        // without a tag update cannot be used as attribution evidence.
        .contains("changes", { outcome_tag_id: {} })
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(offset, offset + PAGE_SIZE - 1);

      if (error) throw new Error("Falha ao consultar auditoria dos acordos: " + error.message);
      const page = (data ?? []) as AgreementAudit[];
      all.push(...page);
      if (offset + page.length > MAX_AUDITS_PER_BATCH) {
        throw new Error("Auditoria muito extensa para consulta paginada");
      }
      if (page.length < PAGE_SIZE) break;
    }
  }
  return all;
}

/** Read-only and fully tenant-scoped. The agreement count is not a
 * financial payment count: no won/deal value is inferred from tags. */
export async function loadAgreementDashboardMetrics(
  db: SupabaseClient,
  accountId: string,
  now: Date = new Date(),
): Promise<AgreementDashboardMetrics> {
  const { data: tags, error } = await db
    .from("tags")
    .select("id, name")
    .eq("account_id", accountId)
    .eq("kind", "outcome")
    .eq("codigo_tabulacao", AGREEMENT_CODE);

  if (error) throw new Error("Falha ao consultar tabulação de acordo: " + error.message);
  const rows = (tags ?? []) as AgreementTagRow[];
  if (!rows.length) return summarizeAgreements([], [], new Map(), now);

  const agreements = await listAccountAgreements(db, accountId, rows.map((t) => t.id));
  if (!agreements.length) return summarizeAgreements([], [], new Map(), now);

  const audits = await listAgreementAudits(db, accountId, agreements.map((c) => c.id));
  const tagsById = new Map(rows.map((t) => [t.id, t.name]));
  return summarizeAgreements(agreements, audits, tagsById, now);
}
