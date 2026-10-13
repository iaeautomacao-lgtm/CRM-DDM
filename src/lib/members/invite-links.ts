// Links de definição de senha do convite (POST /api/account/members/bulk-invite devolve `links`): não existe senha padrão.
// A resposta traz um link por usuário criado, e a tela os mostra UMA vez. Este módulo normaliza a resposta e monta o CSV para baixar.

export interface InviteLink {
  email: string;
  name: string;
  /** null = não foi possível gerar: a pessoa usa "Esqueci minha senha" no login. */
  link: string | null;
}

export const NO_LINK_TEXT = "Sem link: use Esqueci minha senha";

export const INVITE_LINKS_WARNING =
  "Envie a cada pessoa o link dela. Os links vencem no prazo do e-mail de recuperação; depois disso a pessoa usa Esqueci minha senha no login. Este é o único momento em que os links aparecem.";

/** Normaliza o campo `links` da resposta (descarta o que não tem e-mail; link só texto não vazio). */
export function parseInviteLinks(raw: unknown): InviteLink[] {
  if (!Array.isArray(raw)) return [];
  const out: InviteLink[] = [];
  for (const item of raw) {
    const r = (item ?? {}) as Record<string, unknown>;
    if (typeof r.email !== "string" || !r.email) continue;
    out.push({
      email: r.email,
      name: typeof r.name === "string" ? r.name : "",
      link: typeof r.link === "string" && r.link.trim() ? r.link.trim() : null,
    });
  }
  return out;
}

/**
 * Célula do CSV: aspas duplicadas quando preciso e proteção contra injeção de fórmula (Excel/Planilhas executam texto que começa
 * com = + - @ ou tabulação/retorno): o valor ganha um apóstrofo na frente.
 */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[;"\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** CSV com BOM (acentos certos no Excel), separador ';' (Excel em português) e quebra CRLF: Nome;E-mail;Link. */
export function buildInviteLinksCsv(links: readonly InviteLink[]): string {
  const rows = [["Nome", "E-mail", "Link"], ...links.map((l) => [l.name, l.email, l.link ?? NO_LINK_TEXT])];
  return `﻿${rows.map((r) => r.map(csvCell).join(";")).join("\r\n")}\r\n`;
}

/** Nome do arquivo baixado: links-de-acesso-AAAA-MM-DD.csv (data local). */
export function inviteLinksFileName(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `links-de-acesso-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}.csv`;
}
