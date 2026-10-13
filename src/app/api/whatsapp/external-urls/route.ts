import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

// Endereços das ferramentas externas (tela do extrator de leads). Exige sessão de membro (revisão de segurança 13/10,
// item 21): antes dependia só do middleware.
export async function GET() {
  try {
    await getCurrentAccount();
  } catch (err) {
    return toErrorResponse(err);
  }
  return NextResponse.json({
    disparadorUrl: process.env.DISPARADOR_URL || "",
    leadExtractorUrl: process.env.LEAD_EXTRACTOR_URL || "https://grupoddmlead.lovable.app",
  });
}
