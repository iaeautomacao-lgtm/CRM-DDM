import { NextResponse, after } from "next/server";

import { clientIp } from "@/lib/audit/context";
import { ddmAllowance, fetchDdmSituation } from "@/lib/billing/ddm-source";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { readCappedBody } from "@/lib/security/webhook-body";
import { loadUtmpayConfig } from "@/lib/utmpay/config";
import { parseUtmpayEvent, peekTid, UTMPAY_MAX_BODY_BYTES } from "@/lib/utmpay/events";
import { enrichFromEvent, loadLinkByTid, recordUtmpayEvent } from "@/lib/utmpay/ingest";
import { verifyUtmpaySignature } from "@/lib/utmpay/signature";

export const dynamic = "force-dynamic";

// POST /api/integrations/utmpay/events — webhook do UTMpay (PÚBLICO e assinado; contrato de 14/10).
//   Headers: X-UTMpay-Timestamp (unix s), X-UTMpay-Signature: sha256=hex(HMAC_SHA256(secret, timestamp + "." + corpo)).
//   Corpo: { event_id (uuid), tid, etapa: click|cpf_view|cpf_submit|payment_view|payment_start|paid, occurred_at (ISO 8601), codigo, campanha, canal } — sem CPF.
// Segurança: o segredo é o da CONTA dona do tid (webhook_secret cifrado em utmpay_config); assinatura inválida, tid desconhecido e conta sem
// segredo respondem igual (401, sem dizer o motivo). Relógio fora de ±5 min = 401 (anti-replay). Idempotente por event_id: o reenvio
// responde 200 sem gravar de novo. Responde rápido: a atribuição pela conversa e a conferência na API DDM rodam DEPOIS da resposta (after).
const unauthorized = () => NextResponse.json({ error: "Unauthorized" }, { status: 401 });

export async function POST(request: Request) {
  const ip = clientIp(request.headers) ?? "unknown";
  const limit = await checkRateLimit(`utmpay-events:${ip}`, RATE_LIMITS.utmpayEvents);
  if (!limit.success) return new NextResponse(null, { status: 429 });

  const body = await readCappedBody(request, UTMPAY_MAX_BODY_BYTES);
  if (!body.ok) return new NextResponse(null, { status: body.status });

  const tid = peekTid(body.text);
  if (!tid) return NextResponse.json({ error: "Evento inválido" }, { status: 400 });

  const db = supabaseAdmin();
  let link;
  try {
    link = await loadLinkByTid(db, tid);
  } catch {
    return NextResponse.json({ error: "Serviço indisponível" }, { status: 503 }); // migration 356 ausente ou banco fora
  }
  if (!link) return unauthorized();

  const config = await loadUtmpayConfig(db, link.account_id);
  if (!config?.webhookSecret) return unauthorized();
  const check = verifyUtmpaySignature({
    secret: config.webhookSecret,
    timestamp: request.headers.get("x-utmpay-timestamp"),
    signature: request.headers.get("x-utmpay-signature"),
    body: body.text,
  });
  if (!check.ok) return unauthorized();

  const parsed = parseUtmpayEvent(body.text);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  if (parsed.event.tid !== link.tid) return NextResponse.json({ error: "Evento inválido" }, { status: 400 });

  try {
    const result = await recordUtmpayEvent(db, link, parsed.event, config.janelaDias);
    if (result.duplicate) return NextResponse.json({ status: "duplicate" });
    if (parsed.event.etapa === "payment_start" || parsed.event.etapa === "paid") {
      after(async () => {
        try {
          await enrichFromEvent(db, link, parsed.event, result.inWindow, {
            situation: (cpf) => fetchDdmSituation(cpf, { allow: ddmAllowance(link.account_id) }),
          });
        } catch (err) {
          console.error("[utmpay] enriquecimento do evento falhou:", err instanceof Error ? err.message.slice(0, 120) : "erro");
        }
      });
    }
    return NextResponse.json({ status: "ok" });
  } catch (err) {
    console.error("[utmpay] gravação do evento falhou:", err instanceof Error ? err.message.slice(0, 120) : "erro");
    return NextResponse.json({ error: "Falha ao gravar o evento" }, { status: 500 }); // o UTMpay tenta de novo com o MESMO event_id
  }
}
