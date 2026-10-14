import { NextResponse } from "next/server";
import { guardPermission } from "@/lib/auth/route-guard";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { loadContactBadge } from "@/lib/utmpay/stats";

export const dynamic = "force-dynamic";

// GET /api/conversations/[id]/utmpay — selo do funil UTMpay do contato da conversa: o link rastreado MAIS RECENTE
// (clicou → fechou acordo → pagou, atribuição e situação na DDM) ou { rastreio: null }. Permissão inbox.view; a conversa é lida com a sessão
// do usuário (RLS = escopo de equipe do inbox). Contrato: prd-v2/contrato-api-utmpay-crm.md.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await guardPermission("inbox.view");
  if (!auth.ok) return auth.response;
  const { supabase, accountId } = auth.ctx;
  const { id } = await params;

  const { data: conversation, error } = await supabase.from("conversations").select("id, contact_id").eq("id", id).eq("account_id", accountId).maybeSingle();
  if (error) return NextResponse.json({ error: "Falha ao carregar a conversa" }, { status: 500 });
  if (!conversation) return NextResponse.json({ error: "Conversa não encontrada" }, { status: 404 });
  const contactId = (conversation as { contact_id?: string | null }).contact_id;
  if (!contactId) return NextResponse.json({ rastreio: null });

  return NextResponse.json({ rastreio: await loadContactBadge(supabaseAdmin(), accountId, contactId) });
}
