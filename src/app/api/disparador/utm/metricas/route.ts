import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const campanha = searchParams.get("campanha") ?? "";
  const canal = searchParams.get("canal") ?? "whatsapp";
  const dataInicio = searchParams.get("data_inicio") ?? "";
  const dataFim = searchParams.get("data_fim") ?? "";

  const params = new URLSearchParams({ campanha, canal });
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

  const data = await res.json();
  return NextResponse.json(data, { status: res.ok ? 200 : res.status });
}
