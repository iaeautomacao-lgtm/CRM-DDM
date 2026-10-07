// ============================================================
// GET /api/v1/openapi.json — especificação OpenAPI 3.1 da API pública.
//
// Pública de propósito (sem chave): descreve só o contrato, nenhum
// segredo. Servidor = NEXT_PUBLIC_APP_URL. A fonte é
// src/lib/api/v1/openapi.ts.
// ============================================================

import { NextResponse } from 'next/server';
import { buildOpenApiSpec } from '@/lib/api/v1/openapi';

export async function GET() {
  return NextResponse.json(buildOpenApiSpec(process.env.NEXT_PUBLIC_APP_URL), {
    headers: { 'Cache-Control': 'public, max-age=300' },
  });
}
