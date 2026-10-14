import { NextResponse } from "next/server";
import { guardPermission } from "@/lib/auth/route-guard";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { loadContactBadge } from "@/lib/utmpay/stats";

export const dynamic = "force-dynamic";

// GET /api/contacts/[id]/utmpay — o mesmo selo da conversa (seção 5 do contrato), para a tela de Contatos: { rastreio: {…} | null }.
// Permissão contacts.view; o contato é lido com a sessão do usuário (RLS) e tem de ser da conta.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await guardPermission("contacts.view");
  if (!auth.ok) return auth.response;
  const { supabase, accountId } = auth.ctx;
  const { id } = await params;

  const { data: contact, error } = await supabase.from("contacts").select("id").eq("id", id).eq("account_id", accountId).maybeSingle();
  if (error) return NextResponse.json({ error: "Falha ao carregar o contato" }, { status: 500 });
  if (!contact) return NextResponse.json({ error: "Contato não encontrado" }, { status: 404 });

  return NextResponse.json({ rastreio: await loadContactBadge(supabaseAdmin(), accountId, id) });
}
