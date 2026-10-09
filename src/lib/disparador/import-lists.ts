// Listas importadas reutilizáveis (PRD 24, item 8; migration 292). Uma lista = uma importação concluída (job da 197).
import { randomUUID } from "node:crypto";
import type { ImportJob } from "@/lib/disparador/import-jobs";

export type { ImportJob };

type Db = { rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }> };

/** Lista como a API devolve: nome + contagens do próprio job (sem linhas nem erros por linha). */
export function toPublicImportList(job: ImportJob) {
  return {
    id: job.id,
    name: job.name ?? null,
    state: job.state,
    created_at: job.created_at,
    finished_at: job.finished_at,
    rows_total: job.rows_total,
    totals: job.totals,
    linked: job.linked,
    /** Origem do vínculo: rascunho (criação no assistente) ou campanha (edição). */
    source: job.draft_id ? ("draft" as const) : job.campaign_id ? ("campaign" as const) : null,
  };
}

export type ReuseResult =
  | { ok: true; draftId: string; contacts: number; variables: number }
  | { ok: false; status: 404 | 409 | 503; code: "not_found" | "not_reusable" | "unavailable"; message: string };

const isMissingFunction = (e: { code?: string; message?: string } | null) =>
  e?.code === "PGRST202" || e?.code === "42883" || /could not find the function|does not exist/i.test(e?.message ?? "");

/**
 * Copia a lista do job para um rascunho NOVO (a campanha nova usa import_draft_id = draftId, como qualquer importação do assistente).
 * `job` precisa ser da conta e estar concluído; sem vínculo de origem (nem rascunho nem campanha) não há o que reutilizar.
 */
export async function reuseImportList(
  db: Db,
  job: Pick<ImportJob, "account_id" | "state" | "draft_id" | "campaign_id">,
  newDraftId: string = randomUUID(),
): Promise<ReuseResult> {
  if (job.state !== "done") return { ok: false, status: 409, code: "not_reusable", message: "A importação ainda não terminou." };
  if (!job.draft_id && !job.campaign_id) return { ok: false, status: 409, code: "not_reusable", message: "Esta importação não ficou vinculada a uma lista." };
  const { data, error } = await db.rpc("duplicate_import_list", {
    p_account_id: job.account_id,
    p_source_draft: job.draft_id,
    p_source_campaign: job.draft_id ? null : job.campaign_id,
    p_new_draft: newDraftId,
  });
  if (error) {
    if (isMissingFunction(error)) return { ok: false, status: 503, code: "unavailable", message: "Recurso indisponível: aplique a migration 292." };
    throw new Error(`Falha ao reutilizar a lista: ${error.message ?? "erro desconhecido"}`);
  }
  const counts = (data ?? {}) as { contacts?: number; variables?: number };
  return { ok: true, draftId: newDraftId, contacts: Number(counts.contacts ?? 0), variables: Number(counts.variables ?? 0) };
}
