import type { SupabaseClient } from "@supabase/supabase-js";
import type { QueueItem } from "@/lib/disparador/processQueue";

export const CANDIDATE_PAGE_SIZE = 1000;

// Candidatos vencidos de uma campanha, na ordem (scheduled_at, id), em páginas de até 1.000 (o PostgREST corta cada resposta no
// max-rows, 1.000 por padrão no Supabase). Nada é reservado aqui: o claim decide.
// D-09: paginação por KEYSET (scheduled_at, id) em vez de OFFSET — cada página começa no índice, sem reler o que já passou — e só as
// colunas que o envio usa (antes: select("*"), que trazia a linha inteira de 700+ itens por campanha a cada tick, a maioria nunca enviada
// no tick). Banco sem alguma dessas colunas (migrations 070/077 ausentes): volta ao select("*") sozinho.
const DUE_CANDIDATE_COLUMNS =
  "id, campaign_id, contact_id, session_id, tipo, mensagem_final, media_url, tentativas, template_name, template_language, template_variables, phone_attempt_order, scheduled_at, contacts(name, phone, company)";
const DUE_CANDIDATE_ALL_COLUMNS = "*, contacts(name, phone, company)";
let dueExplicitColumnsUnavailable = false;

function isMissingColumnError(error: { code?: string; message?: string }): boolean {
  return error.code === "42703" || error.code === "PGRST204" || /column .* does not exist/i.test(error.message ?? "");
}

export async function fetchDueCandidates(db: Pick<SupabaseClient, "from">, campaignId: string, limit: number): Promise<QueueItem[]> {
  const items: QueueItem[] = [];
  const now = new Date().toISOString();
  let cursor: { at: string; id: string } | null = null;
  while (items.length < limit) {
    const pageSize = Math.min(CANDIDATE_PAGE_SIZE, limit - items.length);
    let query = db
      .from("disp_message_queue")
      .select(dueExplicitColumnsUnavailable ? DUE_CANDIDATE_ALL_COLUMNS : DUE_CANDIDATE_COLUMNS)
      .eq("campaign_id", campaignId)
      .eq("status", "agendado")
      .lte("scheduled_at", now);
    // Desempate por id: a rodada inteira vence em < 2 s (roundSpreadOffsetMs), então muitos itens dividem o scheduled_at.
    if (cursor) query = query.or(`scheduled_at.gt."${cursor.at}",and(scheduled_at.eq."${cursor.at}",id.gt."${cursor.id}")`);
    const { data, error } = await query.order("scheduled_at", { ascending: true }).order("id", { ascending: true }).limit(pageSize);
    if (error) {
      if (!dueExplicitColumnsUnavailable && isMissingColumnError(error)) {
        dueExplicitColumnsUnavailable = true;
        console.warn("[Cron] Coluna ausente no select explícito dos candidatos; usando select(*):", error.message);
        continue;
      }
      throw error;
    }
    const page = (data ?? []) as unknown as QueueItem[];
    items.push(...page);
    const last: QueueItem | undefined = page[page.length - 1];
    if (page.length < pageSize || !last?.scheduled_at) break;
    cursor = { at: last.scheduled_at, id: last.id };
  }
  return items;
}


/** Só para testes. */
export function resetDueCandidateColumns(): void {
  dueExplicitColumnsUnavailable = false;
}
