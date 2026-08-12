import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    disparadorUrl: process.env.DISPARADOR_URL || "",
    leadExtractorUrl: process.env.LEAD_EXTRACTOR_URL || "https://grupoddmlead.lovable.app",
  });
}
