import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { loadBlacklistKeySet } from "@/lib/disparador/blacklist-keys";
import { phoneKey } from "@/lib/disparador/phone-key";

// POST /api/disparador/audience/blacklist — quais telefones da base que o
// usuário está importando no assistente estão na blacklist (mesma chave do
// envio e do import: phoneKey). Só leitura; devolve os índices recebidos.
// A blacklist em si não sai do servidor.

const MAX_PHONES = 200_000;

export async function POST(request: Request) {
  try {
    await getCurrentAccount();
    const body = (await request.json().catch(() => null)) as { phones?: unknown } | null;
    const phones = Array.isArray(body?.phones) ? body.phones : null;
    if (!phones) return NextResponse.json({ error: "Envie a lista de telefones." }, { status: 400 });
    if (phones.length > MAX_PHONES) {
      return NextResponse.json({ error: `Base grande demais para conferir (máximo ${MAX_PHONES}).` }, { status: 413 });
    }
    const keys = await loadBlacklistKeySet(supabaseAdmin());
    const blacklisted: number[] = [];
    phones.forEach((raw, index) => {
      if (typeof raw === "string" && raw && keys.has(phoneKey(raw))) blacklisted.push(index);
    });
    return NextResponse.json({ blacklisted });
  } catch (err) {
    return toErrorResponse(err);
  }
}
