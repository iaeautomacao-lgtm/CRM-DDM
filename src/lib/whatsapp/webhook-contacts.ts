import { normalizePhone, phonesMatch } from '@/lib/whatsapp/phone-utils'

// WH-04 (PRD 15): `value.contacts[]` e `value.messages[]` da Meta NÃO são paralelos por índice — o POST pode trazer
// mensagens de vários remetentes e uma lista de contatos menor/em outra ordem. O contato de uma mensagem é o que
// tem o mesmo `wa_id` do `from` dela.

export interface WebhookContact {
  profile?: { name?: string | null } | null
  wa_id?: string | null
}

/**
 * Contato da mensagem pelo `wa_id` == `from` (comparação por dígitos; depois pela regra de sufixo de
 * `phonesMatch`, que tolera prefixo/9º dígito). Sem correspondência devolve null — nunca um contato
 * de outro remetente (o nome do cliente A não pode ir para o contato B).
 */
export function contactForMessage(
  contacts: readonly WebhookContact[] | null | undefined,
  from: string | null | undefined,
): WebhookContact | null {
  const sender = normalizePhone(String(from ?? ''))
  if (!sender || !contacts?.length) return null
  const exact = contacts.find((c) => c && normalizePhone(String(c.wa_id ?? '')) === sender)
  if (exact) return exact
  return contacts.find((c) => c && c.wa_id && phonesMatch(String(c.wa_id), sender)) ?? null
}
