// Linhas do detalhamento da fila (queue-details) — compartilhadas pela rota (página/XLSX pequeno) e pelo job de
// exportação assíncrona (export-jobs.ts). Movido da rota SEM mudar regra.
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { classificarTipoErro } from "@/lib/disparador/normalize-meta-error";

export interface QueueDetailRow {
  id: string;
  contact_name: string | null;
  phone: string | null;
  status: string;
  mensagem_final: string | null;
  erro: string | null;
  tipo_erro: string | null;
  contact_id: string | null;
  /** Conversa do contato para o link "abrir no inbox". */
  conversation_id: string | null;
  // sent_at quando disponível (envio real já aconteceu); cai para
  // scheduled_at pra itens ainda não enviados — disp_message_queue.
  // updated_at nunca é mantido por trigger nem setado manualmente nos
  // caminhos de escrita (ver processQueue.ts), então fica parado no
  // valor de inserção da linha e não serve pra "quando isso aconteceu".
  data_hora: string | null;
}

export type QueueRow = {
  id: string;
  mensagem_final: string | null;
  erro: string | null;
  status: string;
  scheduled_at: string | null;
  sent_at: string | null;
  replied_at?: string | null;
  contact_id: string | null;
  contacts: { name: string | null; phone: string | null } | null;
};

export function toDetailRow(row: QueueRow): QueueDetailRow {
  return {
    id: row.id,
    contact_name: row.contacts?.name ?? null,
    phone: row.contacts?.phone ?? null,
    status: row.status,
    mensagem_final: row.mensagem_final,
    erro: row.erro,
    tipo_erro: row.status === "erro" ? classificarTipoErro(row.erro) : null,
    contact_id: row.contact_id,
    conversation_id: null,
    // Em "Respostas", a hora que importa é a da resposta.
    data_hora: row.replied_at ?? row.sent_at ?? row.scheduled_at,
  };
}

/**
 * Imports antigos podem ter o nome apenas em VAR1, mesmo com contacts.name
 * vazio. O importador atual também trata VAR1 como fallback de nome quando
 * não há uma coluna de nome explícita, então fazemos a mesma recuperação
 * no drilldown para campanhas CSV legadas.
 */
export async function attachLegacyCsvNames(
  rows: QueueDetailRow[],
  campaignId: string,
  draftId: string | null,
): Promise<QueueDetailRow[]> {
  const missingIds = [
    ...new Set(
      rows
        .filter((r) => !r.contact_name?.trim() && r.contact_id)
        .map((r) => r.contact_id as string),
    ),
  ];
  if (missingIds.length === 0) return rows;

  const byContact = new Map<string, string>();
  const load = async (column: "campaign_id" | "draft_id", value: string) => {
    const { data, error } = await supabaseAdmin()
      .from("contact_import_variables")
      .select("contact_id, value")
      .eq(column, value)
      .eq("var_index", 0)
      .in("contact_id", missingIds);
    if (error) throw new Error(`Falha ao recuperar nomes do CSV: ${error.message}`);
    for (const item of data ?? []) {
      if (item.contact_id && item.value?.trim() && !byContact.has(item.contact_id)) {
        byContact.set(item.contact_id, item.value.trim());
      }
    }
  };

  await load("campaign_id", campaignId);
  if (draftId && byContact.size < missingIds.length) {
    await load("draft_id", draftId);
  }

  return rows.map((row) => ({
    ...row,
    contact_name:
      row.contact_name?.trim() ||
      (row.contact_id ? byContact.get(row.contact_id) ?? null : null),
  }));
}


export const SELECT_COLUMNS =
  "id, contact_id, mensagem_final, erro, status, scheduled_at, sent_at, contacts!contact_id(name, phone)";
// Com replied_at (migration 126) só para "Respostas" — as demais métricas
// seguem funcionando mesmo sem a coluna.
export const SELECT_COLUMNS_REPLIED = `${SELECT_COLUMNS}, replied_at`;

