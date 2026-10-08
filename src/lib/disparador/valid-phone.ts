/**
 * Telefone discável de um contato: pelo menos 10 dígitos (DDD + número).
 * Nunca usar texto de mensagem como telefone: contato sem número válido vira
 * erro permanente explicado em vez de enviar para um número inventado.
 */
export const MIN_DIALABLE_PHONE_DIGITS = 10;

export function hasDialablePhone(phone: unknown): phone is string {
  return typeof phone === "string" && phone.replace(/\D/g, "").length >= MIN_DIALABLE_PHONE_DIGITS;
}

export const NO_VALID_PHONE_ERROR = "Contato sem telefone válido";
