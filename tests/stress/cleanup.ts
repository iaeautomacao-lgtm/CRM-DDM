// Passo 6 — remove todos os dados fictícios criados por esta suite.
// Identifica por prefixo STRESS_TEST em vários lugares (tag, nome de
// campanha, nome de contato criado via webhook) porque nem todo caminho
// de criação passa pela mesma tabela — ver comentários por seção.
//
// Roda em ordem segura para FKs: filas -> campanhas -> mensagens/
// conversas (contatos criados pelo teste de webhook) -> contact_tags ->
// contatos -> tag -> canal de teste do webhook (se sobrou algum).
import { STRESS_PREFIX, supabaseAdmin } from "./config";

async function countWhere(
  table: string,
  build: (q: any) => any
): Promise<number> {
  const db = supabaseAdmin();
  const { count, error } = await build(db.from(table).select("id", { count: "exact", head: true }));
  if (error) {
    console.error(`[cleanup] Erro ao contar ${table}:`, error.message);
    return -1;
  }
  return count ?? 0;
}

// PostgREST tem um cap de resposta por request (1000 linhas, confirmado
// ao vivo neste projeto — ver comentários em startCampaign.ts e
// contacts/import/route.ts). Um .select() sem .range() aqui trunca
// silenciosamente qualquer resultado maior que o cap, o que faria este
// script de limpeza "terminar com sucesso" tendo apagado só a primeira
// página de contatos de teste. Pagina explicitamente até uma página vir
// menor que pageSize.
async function selectAllPaginated<T>(
  table: string,
  columns: string,
  build: (q: any) => any
): Promise<T[]> {
  const db = supabaseAdmin();
  const pageSize = 1000;
  const rows: T[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await build(db.from(table).select(columns).range(from, from + pageSize - 1));
    if (error) {
      console.error(`[cleanup] Erro ao paginar ${table}:`, error.message);
      break;
    }
    rows.push(...((data ?? []) as T[]));
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

async function main() {
  const db = supabaseAdmin();
  console.log(`[cleanup] Limpando dados com prefixo "${STRESS_PREFIX}"...\n`);

  // ---- Contagem ANTES ----
  const before = {
    campaigns: await countWhere("campaigns", (q) => q.ilike("nome", `${STRESS_PREFIX}%`)),
    contactsByTagName: await countWhere("tags", (q) => q.eq("name", STRESS_PREFIX)),
    contactsByName: await countWhere("contacts", (q) => q.ilike("name", `${STRESS_PREFIX}%`)),
    whatsappConfig: await countWhere("whatsapp_config", (q) =>
      q.or(`display_phone_number.ilike.${STRESS_PREFIX}%,phone_number_id.ilike.${STRESS_PREFIX}%`)
    ),
  };
  console.log("[cleanup] Antes:", before);

  // 1. Campanhas de teste (nome prefixado) + fila associada.
  const campaigns = await selectAllPaginated<{ id: string }>("campaigns", "id", (q) =>
    q.ilike("nome", `${STRESS_PREFIX}%`)
  );
  const campaignIds = campaigns.map((c) => c.id);

  if (campaignIds.length > 0) {
    const { error: queueErr, count: queueDeleted } = await db
      .from("disp_message_queue")
      .delete({ count: "exact" })
      .in("campaign_id", campaignIds);
    if (queueErr) console.error("[cleanup] Erro ao apagar disp_message_queue:", queueErr.message);
    else console.log(`[cleanup] disp_message_queue: ${queueDeleted ?? 0} linha(s) removida(s).`);

    const { error: metricsErr } = await db
      .from("campaign_metrics")
      .delete()
      .in("campaign_id", campaignIds);
    if (metricsErr) console.error("[cleanup] Erro ao apagar campaign_metrics:", metricsErr.message);

    const { error: campErr, count: campDeleted } = await db
      .from("campaigns")
      .delete({ count: "exact" })
      .in("id", campaignIds);
    if (campErr) console.error("[cleanup] Erro ao apagar campaigns:", campErr.message);
    else console.log(`[cleanup] campaigns: ${campDeleted ?? 0} linha(s) removida(s).`);
  } else {
    console.log("[cleanup] Nenhuma campanha STRESS_TEST encontrada.");
  }

  // 2. Contatos identificados pela tag STRESS_TEST (import via
  // contacts/import/route.ts) OU pelo nome prefixado (contatos criados
  // pelo teste de webhook via findOrCreateContact, que não usa tags).
  const { data: tagRow } = await db.from("tags").select("id").eq("name", STRESS_PREFIX).maybeSingle();

  const contactIdSet = new Set<string>();

  if (tagRow?.id) {
    const taggedContacts = await selectAllPaginated<{ contact_id: string }>(
      "contact_tags",
      "contact_id",
      (q) => q.eq("tag_id", tagRow.id)
    );
    for (const row of taggedContacts) contactIdSet.add(row.contact_id);
  }

  const namedContacts = await selectAllPaginated<{ id: string }>("contacts", "id", (q) =>
    q.ilike("name", `${STRESS_PREFIX}%`)
  );
  for (const row of namedContacts) contactIdSet.add(row.id);

  const contactIds = Array.from(contactIdSet);
  console.log(`[cleanup] ${contactIds.length} contato(s) identificado(s) para remoção.`);

  if (contactIds.length > 0) {
    // contact_tags/contact_phones/contact_import_variables e
    // conversations->messages têm ON DELETE CASCADE a partir de
    // contacts (ver migrations 001, 077, 079) — apagar o contato já
    // limpa essas linhas. Removido em chunks para não montar um filtro
    // .in() gigante (mesmo motivo documentado em startCampaign.ts).
    const chunkSize = 500;
    let totalDeleted = 0;
    for (let i = 0; i < contactIds.length; i += chunkSize) {
      const chunk = contactIds.slice(i, i + chunkSize);
      const { error, count } = await db
        .from("contacts")
        .delete({ count: "exact" })
        .in("id", chunk);
      if (error) {
        console.error(`[cleanup] Erro ao apagar lote de contatos:`, error.message);
      } else {
        totalDeleted += count ?? 0;
      }
    }
    console.log(`[cleanup] contacts: ${totalDeleted} linha(s) removida(s) (cascata cobre conversations/messages/contact_tags/contact_phones/contact_import_variables).`);
  }

  // 3. Tag STRESS_TEST em si, se não tiver mais nenhum contato vinculado.
  if (tagRow?.id) {
    const { count: remaining } = await db
      .from("contact_tags")
      .select("contact_id", { count: "exact", head: true })
      .eq("tag_id", tagRow.id);
    if ((remaining ?? 0) === 0) {
      const { error } = await db.from("tags").delete().eq("id", tagRow.id);
      if (error) console.error("[cleanup] Erro ao apagar tag STRESS_TEST:", error.message);
      else console.log("[cleanup] Tag STRESS_TEST removida.");
    } else {
      console.log(`[cleanup] Tag STRESS_TEST mantida — ainda vinculada a ${remaining} contato(s) não prefixado(s).`);
    }
  }

  // 4. Canal de teste do webhook (Tier B), se o operador criou um e não
  // removeu manualmente — identificado por display_phone_number ou
  // phone_number_id prefixado, nunca apagado por padrão a menos que
  // tenha sido nomeado seguindo a convenção do README.
  const testChannels = await selectAllPaginated<{ id: string }>(
    "whatsapp_config",
    "id, phone_number_id, display_phone_number",
    (q) => q.or(`display_phone_number.ilike.${STRESS_PREFIX}%,phone_number_id.ilike.${STRESS_PREFIX}%`)
  );
  if (testChannels.length > 0) {
    const ids = testChannels.map((c) => c.id);
    const { error, count } = await db.from("whatsapp_config").delete({ count: "exact" }).in("id", ids);
    if (error) console.error("[cleanup] Erro ao apagar whatsapp_config de teste:", error.message);
    else console.log(`[cleanup] whatsapp_config: ${count ?? 0} canal(is) de teste removido(s).`);
  } else {
    console.log("[cleanup] Nenhum canal de teste (whatsapp_config) com prefixo STRESS_TEST encontrado.");
  }

  // ---- Contagem DEPOIS ----
  const after = {
    campaigns: await countWhere("campaigns", (q) => q.ilike("nome", `${STRESS_PREFIX}%`)),
    contactsByTagName: await countWhere("tags", (q) => q.eq("name", STRESS_PREFIX)),
    contactsByName: await countWhere("contacts", (q) => q.ilike("name", `${STRESS_PREFIX}%`)),
    whatsappConfig: await countWhere("whatsapp_config", (q) =>
      q.or(`display_phone_number.ilike.${STRESS_PREFIX}%,phone_number_id.ilike.${STRESS_PREFIX}%`)
    ),
  };

  console.log("\n[cleanup] Depois:", after);
  console.log("\n[cleanup] Concluído.");
}

main().catch((err) => {
  console.error("[cleanup] Erro fatal:", err.message);
  process.exit(1);
});
