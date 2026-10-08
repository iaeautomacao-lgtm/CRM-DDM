import { NextResponse } from "next/server";

import { requirePermission, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { suggestOutcomeTag } from "@/lib/ai/tabulacao-suggest";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/conversations/[id]/suggest-tag
 *
 * Sugestão de tabulação pela IA para o OutcomeTagPicker. A conversa, as
 * tags e as mensagens são lidas com o client do usuário (RLS) e filtradas
 * pela conta — ver src/lib/ai/tabulacao-suggest.ts. Falha da IA nunca
 * bloqueia o fechamento: responde `{ suggestion: null }`.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, accountId } = await requirePermission("inbox.ai_assist");
    const { id: conversationId } = await params;
    if (!UUID_RE.test(conversationId)) {
      return NextResponse.json({ error: "Conversa inválida" }, { status: 400 });
    }

    const result = await suggestOutcomeTag({
      userDb: supabase,
      adminDb: supabaseAdmin(),
      accountId,
      conversationId,
    });

    if (result.status === "not_found") {
      return NextResponse.json(
        { error: "Conversa não encontrada ou sem permissão" },
        { status: 404 },
      );
    }
    return NextResponse.json({ suggestion: result.suggestion });
  } catch (err) {
    return toErrorResponse(err);
  }
}
