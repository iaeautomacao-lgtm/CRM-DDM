import { NextResponse } from "next/server";

import { requirePermission, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { endActiveRunForConversation } from "@/lib/flows/engine";
import { buildHumanClosePatch, suggestionVerdict } from "@/lib/conversations/outcome";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/conversations/[id]/close
 *
 * Closes/tabulates a conversation through the server instead of a direct
 * browser UPDATE. This is important for queue conversations: an agent can
 * SELECT an unassigned open/pending conversation through RLS, but once the
 * same row becomes closed it no longer satisfies the agent SELECT policy.
 * Postgres therefore rejects a direct UPDATE with
 * "new row violates row-level security policy".
 *
 * We first verify that the caller can currently see the conversation using
 * the caller-scoped client, then perform the mutation with service_role.
 * Unassigned conversations are assigned to the closer so ownership/history
 * remain explicit after closure.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, accountId, userId } = await requirePermission("inbox.close");
    const { id: conversationId } = await params;
    if (!UUID_RE.test(conversationId)) {
      return NextResponse.json({ error: "Conversa inválida" }, { status: 400 });
    }

    const body = (await request.json().catch(() => ({}))) as {
      outcome_tag_id?: unknown;
    };
    const outcomeTagId =
      typeof body.outcome_tag_id === "string" ? body.outcome_tag_id : "";
    if (!UUID_RE.test(outcomeTagId)) {
      return NextResponse.json(
        { error: "Selecione uma tag de encerramento válida" },
        { status: 400 },
      );
    }

    const { data: tag, error: tagError } = await supabase
      .from("tags")
      .select("id")
      .eq("id", outcomeTagId)
      .eq("account_id", accountId)
      .eq("kind", "outcome")
      .maybeSingle();
    if (tagError) throw tagError;
    if (!tag) {
      return NextResponse.json(
        { error: "Tag de encerramento inválida" },
        { status: 400 },
      );
    }

    // Permission check uses the caller's RLS-scoped client.
    const { data: visible, error: visibleError } = await supabase
      .from("conversations")
      .select("id,status,assigned_agent_id,suggested_outcome_tag_id")
      .eq("id", conversationId)
      .eq("account_id", accountId)
      .maybeSingle();
    if (visibleError) throw visibleError;
    if (!visible) {
      return NextResponse.json(
        { error: "Conversa não encontrada ou sem permissão" },
        { status: 404 },
      );
    }

    // outcome_source='human' + quem/quando (migration 157). A sugestão
    // (suggested_*) NÃO é apagada: fica para medir aceite x troca.
    const patch = buildHumanClosePatch({
      outcomeTagId,
      userId,
      assignedAgentId: visible.assigned_agent_id,
    });
    const verdict = suggestionVerdict(visible.suggested_outcome_tag_id, outcomeTagId);

    const db = supabaseAdmin();
    const { data: updated, error: updateError } = await db
      .from("conversations")
      .update(patch)
      .eq("id", conversationId)
      .eq("account_id", accountId)
      .select("id,status,outcome_tag_id,assigned_agent_id,closed_at")
      .maybeSingle();

    if (updateError) throw updateError;
    if (!updated) {
      return NextResponse.json(
        { error: "Conversa não encontrada" },
        { status: 404 },
      );
    }

    // Best-effort: closing/tabulating is the strongest signal that any
    // automation/flow for this conversation must stop.
    try {
      await endActiveRunForConversation(conversationId, "conversation_closed");
    } catch (err) {
      console.error("[conversations/close] failed to end active flow:", err);
    }

    return NextResponse.json({ conversation: updated, suggestion: verdict });
  } catch (err) {
    return toErrorResponse(err);
  }
}
