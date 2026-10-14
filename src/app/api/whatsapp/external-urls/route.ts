import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

// Endereços das ferramentas externas. Exige sessão de membro (revisão de segurança 13/10, item 21): antes dependia só
// do middleware. O Extrator de Leads saiu (14/10): não há mais LEAD_EXTRACTOR_URL.
export async function GET() {
  try {
    await getCurrentAccount();
  } catch (err) {
    return toErrorResponse(err);
  }
  return NextResponse.json({
    disparadorUrl: process.env.DISPARADOR_URL || "",
  });
}
