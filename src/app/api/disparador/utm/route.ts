import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/auth/account";
import { requireDisparadorAccess } from "@/lib/disparador/route-auth";
import { parseUtmBatchBody } from "@/lib/disparador/utm-body";

export async function POST(request: Request) {
  // Mesmo papel das rotas de campanha (a chave UTM_API_KEY é da instância).
  try {
    await requireDisparadorAccess();
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = parseUtmBatchBody(await request.json().catch(() => null));
  if (!body) {
    return NextResponse.json({ error: "Corpo inválido" }, { status: 400 });
  }

  const res = await fetch(
    "https://utmpay.grupoddm.ia.br/api/gerar-links-lote",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": process.env.UTM_API_KEY ?? "",
      },
      body: JSON.stringify(body),
    }
  );

  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.ok ? 200 : res.status });
}
