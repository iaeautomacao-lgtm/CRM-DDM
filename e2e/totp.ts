// TOTP (RFC 6238, SHA-1, 6 dígitos, passo de 30 s) sem dependência: o Supabase Auth gera o fator com esses parâmetros.
import { createHmac } from "node:crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s=-]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("Segredo TOTP inválido: use o texto em base32 mostrado ao cadastrar o autenticador.");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const TOTP_STEP_SECONDS = 30;

export function totp(secret: string, nowMs: number = Date.now(), digits = 6): string {
  const counter = Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", base32Decode(secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** Segundos até o código atual expirar. */
export function secondsLeft(nowMs: number = Date.now()): number {
  return TOTP_STEP_SECONDS - (Math.floor(nowMs / 1000) % TOTP_STEP_SECONDS);
}
