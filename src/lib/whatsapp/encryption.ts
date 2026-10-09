import "server-only";
import crypto from 'crypto'

/**
 * WhatsApp token encryption.
 *
 * Format — GCM (current):
 *   `<iv-hex>:<ciphertext-hex>:<authTag-hex>`      (three colons)
 *
 * Format — CBC (legacy, decrypt-only):
 *   `<iv-hex>:<ciphertext-hex>`                    (one colon)
 *
 * Why GCM instead of CBC:
 *   CBC without a MAC is unauthenticated — an attacker who can write
 *   rows to `whatsapp_config` (directly, through a future RLS bug, or
 *   via a DB backup being modified) can flip bits in the ciphertext
 *   without the decrypt throwing. You'd silently get garbled tokens;
 *   worst case, if the mutated bytes happen to form a valid access
 *   token, messages go out under a spoofed account. GCM appends a
 *   16-byte authentication tag; any tampering fails the decrypt hard.
 *
 * Backward compatibility:
 *   `decrypt()` auto-detects the format by counting parts, so legacy
 *   rows keep working. New `encrypt()` output is always GCM.
 *   Existing rows can be upgraded in place by call sites that hold a
 *   Supabase client — see the `isLegacyFormat` / `encrypt` pattern in
 *   `src/app/api/whatsapp/send/route.ts`.
 */

/**
 * Chave AES-256 (64 hex = 32 bytes), validada no PRIMEIRO USO e não no import:
 * este módulo é importado por rotas que o build avalia sem o .env de runtime.
 * Chave ausente/curta/não-hex falha com mensagem clara em vez de um erro obscuro do
 * crypto (ou, pior, cifrar com a chave errada). PRD 14, SG-13.
 */
function getKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      'ENCRYPTION_KEY ausente ou inválida: precisa ter 64 caracteres hexadecimais (32 bytes).',
    )
  }
  return Buffer.from(hex, 'hex')
}
// 12 bytes is the NIST-recommended IV length for GCM — keeps the
// counter block well below 2^32 and matches the default web-crypto
// behaviour, so any future port is straightforward.
const GCM_IV_LENGTH = 12
const CBC_IV_LENGTH = 16
const AUTH_TAG_LENGTH = 16

export function encrypt(text: string): string {
  const iv = crypto.randomBytes(GCM_IV_LENGTH)
  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    getKey(),
    iv,
  )
  let encrypted = cipher.update(text, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  const authTag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${encrypted}:${authTag.toString('hex')}`
}

export function decrypt(encryptedText: string): string {
  const parts = encryptedText.split(':')

  if (parts.length === 3) {
    // GCM — current format.
    const [ivHex, ctHex, tagHex] = parts
    const iv = Buffer.from(ivHex, 'hex')
    if (iv.length !== GCM_IV_LENGTH) {
      throw new Error(
        `Encrypted token has unexpected GCM IV length ${iv.length}`,
      )
    }
    const authTag = Buffer.from(tagHex, 'hex')
    if (authTag.length !== AUTH_TAG_LENGTH) {
      throw new Error(
        `Encrypted token has unexpected GCM auth-tag length ${authTag.length}`,
      )
    }
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      getKey(),
      iv,
    )
    decipher.setAuthTag(authTag)
    let decrypted = decipher.update(ctHex, 'hex', 'utf8')
    decrypted += decipher.final('utf8')
    return decrypted
  }

  if (parts.length === 2) {
    // CBC — legacy. Read-only; `encrypt()` never produces this shape.
    const [ivHex, ctHex] = parts
    const iv = Buffer.from(ivHex, 'hex')
    if (iv.length !== CBC_IV_LENGTH) {
      throw new Error(
        `Encrypted token has unexpected CBC IV length ${iv.length}`,
      )
    }
    const decipher = crypto.createDecipheriv(
      'aes-256-cbc',
      getKey(),
      iv,
    )
    let decrypted = decipher.update(ctHex, 'hex', 'utf8')
    decrypted += decipher.final('utf8')
    return decrypted
  }

  throw new Error(
    `Encrypted token has unrecognised format (expected 1 or 2 colons, got ${
      parts.length - 1
    })`,
  )
}

/**
 * Cheap format detector — call sites use this to decide whether to
 * write a refreshed GCM ciphertext back to the database after a
 * successful legacy decrypt. Does not attempt decryption; purely a
 * structural check.
 */
export function isLegacyFormat(encryptedText: string): boolean {
  return encryptedText.split(':').length === 2
}

// Formato estrito do encrypt() atual: IV de 12 bytes (24 hex), ciphertext
// em bytes inteiros (hex par, pode ser vazio) e authTag de 16 bytes
// (32 hex). Nada de heurística "tem ':'?" — um segredo da Meta em texto
// puro nunca casa com isso.
const GCM_SECRET_RE = /^[0-9a-f]{24}:(?:[0-9a-f]{2})*:[0-9a-f]{32}$/i
// Formato CBC legado: IV de 16 bytes (32 hex) e ciphertext em blocos de
// 16 bytes (múltiplos de 32 hex).
const CBC_SECRET_RE = /^[0-9a-f]{32}:(?:[0-9a-f]{32})+$/i

/**
 * True quando `value` tem exatamente o formato GCM produzido por
 * `encrypt()` (`iv:ciphertext:authTag` em hex, IV 24 hex, tag 32 hex).
 * Checagem puramente estrutural — não tenta decifrar.
 */
export function isEncryptedSecret(value: unknown): value is string {
  return typeof value === 'string' && GCM_SECRET_RE.test(value)
}

/** True quando `value` tem o formato CBC legado (só leitura). */
export function isLegacyCbcSecret(value: unknown): value is string {
  return typeof value === 'string' && CBC_SECRET_RE.test(value)
}

const warnedPlaintextLabels = new Set<string>()

/**
 * Lê um segredo armazenado (app_secret, verify_token, access_token,
 * waha_api_key...).
 *
 * - Formato GCM/CBC válido → decifra (e lança se a chave/authTag não
 *   baterem — ciphertext adulterado nunca vira "texto puro").
 * - Qualquer outra coisa → valor legado gravado em texto puro (ex.:
 *   workaround antigo de salvar direto no banco). Devolve o valor como
 *   está para a produção seguir funcionando até o script
 *   `scripts/encrypt-plaintext-app-secrets.mjs` rodar, e avisa no log uma
 *   vez por processo/coluna — sem nunca logar o valor.
 */
export function decryptStoredSecret(value: string, label: string): string {
  if (isEncryptedSecret(value) || isLegacyCbcSecret(value)) {
    return decrypt(value)
  }
  if (!warnedPlaintextLabels.has(label)) {
    warnedPlaintextLabels.add(label)
    console.warn(
      `[encryption] ${label} armazenado em texto puro (legado) — rode scripts/encrypt-plaintext-app-secrets.mjs --apply para criptografar.`,
    )
  }
  return value
}

/**
 * Garante que um valor já armazenado esteja em formato cifrado antes de
 * ser regravado: GCM/CBC ficam como estão; texto puro legado é cifrado.
 */
export function ensureEncryptedSecret(value: string): string {
  if (isEncryptedSecret(value) || isLegacyCbcSecret(value)) return value
  return encrypt(value)
}

/**
 * Best-effort decrypt for columns being migrated from plaintext to
 * encrypt()'d storage in place (e.g. ai_config.api_key/elevenlabs_api_key
 * — see migration 084). Returns the decrypted plaintext when `value` is
 * in the encrypt() GCM/CBC shape; returns `value` unchanged (assumed to
 * already be plaintext) when decrypt() throws — covers rows written
 * before the column adopted encryption. Never throws.
 */
export function tryDecrypt(value: string): string {
  try {
    return decrypt(value)
  } catch {
    return value
  }
}
