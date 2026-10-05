// Chaves de wacrm.disparador_utm_links (migrations 076 + 129) e a busca do
// link de cada contato no envio (startCampaign). Puro — usado no cliente
// (handleGerarUTM, campanhas/page.tsx) e no servidor.
//
// O bug que isto corrige: o link era gravado com o telefone CRU do CSV
// ("11999998888"), mas o import salva o contato com DDI ("5511999998888")
// e o envio procurava pelo telefone do contato — não casava e o {{n}} do
// link saía vazio. Agora a chave principal é o CPF (o mesmo que gera o
// link no utmpay e que o import usa para achar contato existente) e o
// telefone segue a mesma regra do import (formatBrazilianPhone).

/** Mesma regra de formatBrazilianPhone do import, só dígitos. */
export function utmPhoneKey(raw: string | null | undefined): string {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.startsWith("55") ? digits : `55${digits}`;
}

/** Mesma regra de normalizeCpf do import: 11 dígitos ou nada. */
export function utmCpfKey(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  return digits.length === 11 ? digits : null;
}

export interface UtmLinkMaps {
  byCpf: Map<string, string>;
  byPhone: Map<string, string>;
}

/**
 * Link do contato: pelo CPF primeiro; depois pelo telefone (com DDI) e,
 * para linhas gravadas antes da correção, pelo telefone sem o 55.
 */
export function resolveUtmLink(
  maps: UtmLinkMaps,
  contact: { cpf?: string | null; phone_normalized?: string | null },
): string {
  const cpf = utmCpfKey(contact.cpf);
  if (cpf) {
    const byCpf = maps.byCpf.get(cpf);
    if (byCpf) return byCpf;
  }
  const phone = (contact.phone_normalized ?? "").replace(/\D/g, "");
  if (!phone) return "";
  return (
    maps.byPhone.get(phone) ??
    maps.byPhone.get(utmPhoneKey(phone)) ??
    (phone.startsWith("55") ? maps.byPhone.get(phone.slice(2)) : undefined) ??
    ""
  );
}
