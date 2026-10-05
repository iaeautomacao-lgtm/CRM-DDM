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

/** Celular no formato antigo/novo: 8 dígitos começando com 6–9. */
const isMobileLocal8 = (local8: string) => /^[6-9]/.test(local8);

/**
 * Chave de comparação. Iguala "+55 11 99999-8888", "11999998888",
 * "+11999998888" e o mesmo celular sem o 9º dígito — o 9 só é ignorado na
 * faixa de celular (6–9), para um fixo (11 3456-7890) não bater com o
 * celular 11 93456-7890. Números fora do padrão BR: os próprios dígitos.
 */
export function phoneKey(raw: string): string {
  const n = nationalDigits(raw);
  if (!n) return (raw ?? "").replace(/\D/g, "");
  const ddd = n.slice(0, 2);
  const local = n.slice(2);
  if (local.length === 9 && local[0] === "9" && isMobileLocal8(local.slice(1))) return ddd + local.slice(1);
  return ddd + local;
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
  const local = n.slice(2);
  const nationals = [n];
  // Com/sem o 9º dígito só para celular (ver phoneKey).
  if (local.length === 9 && local[0] === "9" && isMobileLocal8(local.slice(1))) nationals.push(ddd + local.slice(1));
  if (local.length === 8 && isMobileLocal8(local)) nationals.push(ddd + "9" + local);
  for (const national of nationals) {
    out.add(`+55${national}`);
    out.add(`55${national}`);
    out.add(`+${national}`);
    out.add(national);
  }
  return [...out];
}
