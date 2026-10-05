// Comparação de telefones da blacklist.
//
// A blacklist era comparada por igualdade exata de string com
// contacts.phone ("+5511999998888"). Entradas manuais eram gravadas sem o
// 55 ("+11999998888") e números com/sem o 9º dígito nunca batiam — o
// contato bloqueado recebia a campanha mesmo assim. Aqui ficam a
// normalização para gravar e a chave/variações para comparar.

/** Formato canônico gravado em contacts.phone e na blacklist: +55DDDNÚMERO. */
export function formatBrazilianPhone(raw: string): string {
  if (!raw) return "";
  const cleaned = raw.replace(/\D/g, "");
  if (!cleaned) return "";
  if (cleaned.startsWith("55") && cleaned.length >= 12) return `+${cleaned}`;
  return `+55${cleaned}`;
}

/** DDD + número (10 ou 11 dígitos), sem o 55; null se não parece BR. */
function nationalDigits(raw: string): string | null {
  let d = (raw ?? "").replace(/\D/g, "");
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) d = d.slice(2);
  return d.length === 10 || d.length === 11 ? d : null;
}

/**
 * Chave de comparação: DDD + últimos 8 dígitos. Iguala "+55 11 99999-8888",
 * "11999998888", "+11999998888" e o mesmo número sem o 9º dígito.
 * Números fora do padrão BR caem para os próprios dígitos.
 */
export function phoneKey(raw: string): string {
  const n = nationalDigits(raw);
  if (!n) return (raw ?? "").replace(/\D/g, "");
  return n.slice(0, 2) + n.slice(-8);
}

/**
 * Formas em que o mesmo número pode estar gravado na blacklist — para
 * consultas `.in("telefone", …)` no banco sem migration.
 */
export function phoneVariants(raw: string): string[] {
  const out = new Set<string>();
  if (raw) out.add(raw);
  const n = nationalDigits(raw);
  if (!n) return [...out];
  const ddd = n.slice(0, 2);
  const last8 = n.slice(-8);
  for (const national of [ddd + last8, ddd + "9" + last8]) {
    out.add(`+55${national}`);
    out.add(`55${national}`);
    out.add(`+${national}`);
    out.add(national);
  }
  return [...out];
}
