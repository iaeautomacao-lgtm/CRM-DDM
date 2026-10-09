// PRD 15, 15.14 — assinatura dos webhooks de saída.
//
//   X-CRM-Signature: t=<unix>,v1=<hex HMAC_SHA256(secret, t + "." + corpo)>
//
// O receptor recalcula o HMAC sobre o corpo BRUTO recebido, compara em tempo constante e rejeita |agora − t| > 5 min (anti-replay).
// `verifyWebhookSignature` é o mesmo algoritmo que a documentação mostra ao integrador (e que o teste usa).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SIGNATURE_TOLERANCE_SECONDS = 300;

export function computeSignature(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function signatureHeader(secret: string, body: string, nowMs: number = Date.now()): string {
  const t = Math.floor(nowMs / 1000);
  return `t=${t},v1=${computeSignature(secret, t, body)}`;
}

export type SignatureCheck = { ok: true } | { ok: false; reason: "malformed" | "stale" | "mismatch" };

export function verifyWebhookSignature(
  secret: string,
  body: string,
  header: string | null | undefined,
  nowMs: number = Date.now(),
  toleranceSeconds: number = SIGNATURE_TOLERANCE_SECONDS,
): SignatureCheck {
  const parts = Object.fromEntries(String(header ?? "").split(",").map((p) => p.trim().split("=") as [string, string]));
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isInteger(t) || typeof v1 !== "string" || !/^[0-9a-f]{64}$/.test(v1)) return { ok: false, reason: "malformed" };
  if (Math.abs(Math.floor(nowMs / 1000) - t) > toleranceSeconds) return { ok: false, reason: "stale" };
  const expected = Buffer.from(computeSignature(secret, t, body), "hex");
  const given = Buffer.from(v1, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected) ? { ok: true } : { ok: false, reason: "mismatch" };
}

/** Segredo do endpoint: `whsec_` + 32 bytes aleatórios em base64url (devolvido UMA vez; depois só cifrado no banco). */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}
