// UTMpay → CRM: assinatura dos eventos (decisão do dono, 14/10). PURO (sem I/O).
//   X-UTMpay-Timestamp: unix segundos
//   X-UTMpay-Signature: sha256=<hex(HMAC_SHA256(secret, timestamp + "." + corpo))>
// O CRM rejeita assinatura inválida ou relógio fora de 5 minutos (anti-replay; o event_id garante a idempotência).
import { createHmac, timingSafeEqual } from "node:crypto";

export const UTMPAY_CLOCK_TOLERANCE_S = 300;

export function signUtmpayBody(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export type SignatureCheck = { ok: true } | { ok: false; reason: "missing" | "timestamp" | "signature" };

export function verifyUtmpaySignature(input: {
  secret: string;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  body: string;
  nowMs?: number;
}): SignatureCheck {
  const timestamp = (input.timestamp ?? "").trim();
  const signature = (input.signature ?? "").trim();
  if (!timestamp || !signature || !input.secret) return { ok: false, reason: "missing" };
  if (!/^\d{9,12}$/.test(timestamp)) return { ok: false, reason: "timestamp" };
  const skew = Math.abs((input.nowMs ?? Date.now()) / 1000 - Number(timestamp));
  if (!(skew <= UTMPAY_CLOCK_TOLERANCE_S)) return { ok: false, reason: "timestamp" };
  const expected = Buffer.from(signUtmpayBody(input.secret, timestamp, input.body));
  const received = Buffer.from(signature.toLowerCase());
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return { ok: false, reason: "signature" };
  return { ok: true };
}
