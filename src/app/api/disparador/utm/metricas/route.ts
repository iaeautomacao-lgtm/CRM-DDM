import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/auth/account";
import { requireDisparadorAccess } from "@/lib/disparador/route-auth";
import { supabaseAdmin } from "@/lib/disparador/admin-client";

export async function GET(request: Request) {
  let accountId: string;
  try {
    accountId = (await requireDisparadorAccess()).accountId;
  } catch (err) {
    return toErrorResponse(err);
  }

  const { searchParams } = new URL(request.url);
  const campanha = (searchParams.get("campanha") ?? "").trim();
  const canal = searchParams.get("canal") ?? "whatsapp";
  const dataInicio = searchParams.get("data_inicio") ?? "";
  const dataFim = searchParams.get("data_fim") ?? "";

  if (!campanha || campanha.length > 200) {
    return NextResponse.json({ error: "campanha é obrigatória" }, { status: 400 });
  }

  // O serviço de UTM indexa só pelo nome: sem isto, qualquer conta lia as
  // métricas de outra pelo nome da campanha. Só repassa se a campanha é da conta.
  const { data: owned, error: ownErr } = await supabaseAdmin()
    .from("campaigns")
    .select("id")
    .eq("account_id", accountId)
    .eq("nome", campanha)
    .limit(1);
  if (ownErr) {
    console.error("[utm/metricas] posse da campanha:", ownErr.message);
    return NextResponse.json({ error: "Erro ao validar a campanha" }, { status: 500 });
  }
  if (!owned || owned.length === 0) {
    return NextResponse.json({ error: "Campanha não encontrada" }, { status: 404 });
  }

  // Mesmo namespace usado na geração; não consultar o nome global legado.
  const params = new URLSearchParams({ campanha: `${accountId}:${campanha}`, canal });
  if (dataInicio) params.set("data_inicio", dataInicio);
  if (dataFim) params.set("data_fim", dataFim);

  const res = await fetch(
    `https://utmpay.grupoddm.ia.br/api/metricas?${params.toString()}`,
    {
      headers: {
        "X-API-Key": process.env.UTM_API_KEY ?? "",
      },
    }
  );

  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.ok ? 200 : res.status });
}
