// Carteira fixa, FASE 2 (aprovada pelo dono em 16/10): a distribuição AUTOMÁTICA prefere o atendente-dono do contato
// (wacrm.contacts.owner_user_id, migration 372). É chamada só pelos seletores do motor (selectAgentForTeam / selectAnyAgentForAccount);
// devolve o dono quando ele passa em TODAS as regras abaixo e null caso contrário — null = segue o rodízio de sempre, sem mudança.
//   1. contato da MESMA conta e com dono; 2. dono é Operador (account_role 'agent') da conta e ativo (não desativado);
//   3. se a conversa tem equipe, o dono é membro dela; 4. online (batimento ≤ 75 s, mesma régua dos seletores);
//   5. fora de pausa (critério único src/lib/pausas/availability.ts, fail-closed); 6. abaixo de max_simultaneous_chats (open/pending).
// Qualquer erro de leitura = null (fail-closed para o rodízio, que já filtra pausa). LGPD: só ids em log/auditoria, nunca nome/telefone.
import type { SupabaseClient } from "@supabase/supabase-js";
import { filterAvailableAgents } from "@/lib/pausas/availability";

type Db = Pick<SupabaseClient, "from">;

export interface OwnerPreferenceInput {
  accountId: string;
  contactId?: string | null;
  /** Equipe da conversa; ausente = conversa sem equipe (o dono só precisa ser operador da conta). */
  teamId?: string | null;
  /** Para a auditoria da atribuição (via 'owner'); sem ela a auditoria é pulada. */
  conversationId?: string | null;
}

const PRESENCE_MS = 75_000;

export async function preferredContactOwner(db: Db, input: OwnerPreferenceInput): Promise<string | null> {
  const { accountId, contactId, teamId, conversationId } = input;
  if (!contactId) return null;
  try {
    const { data: contact, error } = await db.from("contacts").select("owner_user_id").eq("id", contactId).eq("account_id", accountId).limit(1);
    if (error) return null; // inclui "sem a migration 372"
    const ownerId = ((contact ?? [])[0] as { owner_user_id?: string | null } | undefined)?.owner_user_id ?? null;
    if (!ownerId) return null;

    // Ordem de prioridade: menção explícita (@operador, conversations.requested_agent_id, migration 376) > dono > rodízio.
    // Conversa com menção preenchida não vai ao dono. Coluna inexistente (376 ainda não na V2) = sem menção; outro erro = rodízio.
    if (conversationId) {
      const { data: conv, error: convErr } = await db.from("conversations").select("requested_agent_id").eq("id", conversationId).eq("account_id", accountId).limit(1);
      if (convErr) {
        if (convErr.code !== "42703" && convErr.code !== "PGRST204") return null;
      } else if (((conv ?? [])[0] as { requested_agent_id?: string | null } | undefined)?.requested_agent_id) {
        return null;
      }
    }

    const { data: prof, error: profErr } = await db
      .from("profiles").select("user_id, max_simultaneous_chats")
      .eq("user_id", ownerId).eq("account_id", accountId).eq("account_role", "agent").is("deactivated_at", null).limit(1);
    if (profErr) return null;
    const profile = (prof ?? [])[0] as { max_simultaneous_chats: number | null } | undefined;
    if (!profile) return null;

    if (teamId) {
      const { data: member, error: memErr } = await db.from("team_members").select("user_id").eq("team_id", teamId).eq("user_id", ownerId).limit(1);
      if (memErr || !(member ?? [])[0]) return null;
    }

    const cutoff = new Date(Date.now() - PRESENCE_MS).toISOString();
    const { data: online, error: presErr } = await db
      .from("member_presence").select("user_id").eq("user_id", ownerId).eq("status", "online").gte("last_seen_at", cutoff).limit(1);
    if (presErr || !(online ?? [])[0]) return null;

    if ((await filterAvailableAgents(db, [ownerId])).length === 0) return null;

    const max = profile.max_simultaneous_chats;
    if (max !== null && max !== undefined) {
      const { count, error: cntErr } = await db
        .from("conversations").select("id", { count: "exact", head: true }).eq("assigned_agent_id", ownerId).in("status", ["open", "pending"]);
      if (cntErr || count === null || count >= max) return null;
    }

    await auditOwnerAssignment(accountId, conversationId, ownerId, teamId ?? null);
    return ownerId;
  } catch {
    return null;
  }
}

async function auditOwnerAssignment(accountId: string, conversationId: string | null | undefined, agentId: string, teamId: string | null): Promise<void> {
  if (!conversationId) return;
  try {
    const { logAuditEvent } = await import("@/lib/audit/log-event"); // import dinâmico: o módulo é server-only e nunca derruba a atribuição
    await logAuditEvent({
      accountId, eventType: "action", resourceType: "conversation", resourceId: conversationId,
      action: "conversation.assigned_via_owner", summary: "Conversa atribuída ao dono do contato (carteira fixa)",
      metadata: { via: "owner", agent_id: agentId, team_id: teamId },
    });
  } catch {
    console.error("[carteira] falha ao auditar a atribuição via dono");
  }
}
