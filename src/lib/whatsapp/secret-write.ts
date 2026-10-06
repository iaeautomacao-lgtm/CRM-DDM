import { encrypt, ensureEncryptedSecret } from './encryption'

/**
 * Regras de escrita dos segredos de canal (whatsapp_config.app_secret,
 * verify_token...) a partir do corpo de uma requisição.
 *
 * O segredo nunca volta para o cliente: o GET devolve só um indicador
 * (`has_app_secret`). Por isso campo vazio/omitido — ou a máscara de
 * bolinhas, caso algum cliente a reenvie — significa "manter o atual",
 * nunca "gravar este valor".
 */

/** True quando o valor enviado significa "manter o segredo atual". */
export function isKeepCurrentSecret(submitted: unknown): boolean {
  if (submitted === undefined || submitted === null) return true
  if (typeof submitted !== 'string') return false
  const trimmed = submitted.trim()
  // Vazio ou só caracteres de máscara (••••, ****) — nunca é um segredo real.
  return trimmed === '' || /^[•*]+$/.test(trimmed)
}

export type SecretWriteResult =
  | { ok: true; value: string | null }
  | { ok: false; error: 'invalid_type' }

/**
 * Resolve o valor a persistir para um segredo:
 * - novo valor → sempre cifrado no servidor (GCM);
 * - "manter" → valor atual, cifrando-o se ainda estiver em texto puro
 *   legado (upgrade no próprio save);
 * - "manter" sem valor atual → null (o chamador decide se é obrigatório).
 *
 * Pode lançar se ENCRYPTION_KEY for inválida — o chamador trata.
 */
export function resolveSecretForWrite(
  submitted: unknown,
  existing: string | null | undefined,
): SecretWriteResult {
  if (submitted !== undefined && submitted !== null && typeof submitted !== 'string') {
    return { ok: false, error: 'invalid_type' }
  }

  if (!isKeepCurrentSecret(submitted)) {
    const trimmed = (submitted as string).trim()
    // Cliente reenviou exatamente o valor armazenado (ex.: leu a linha
    // direto via Supabase) — não cifrar o ciphertext de novo.
    if (existing && trimmed === existing) {
      return { ok: true, value: ensureEncryptedSecret(existing) }
    }
    return { ok: true, value: encrypt(trimmed) }
  }

  return { ok: true, value: existing ? ensureEncryptedSecret(existing) : null }
}
