// Respostas rápidas do Inbox (migration 142): regras puras usadas pelo
// campo de mensagem e pela tela de cadastro.

import { normalizeForSearch } from "@/lib/utils";

export interface QuickReply {
  id: string;
  account_id: string;
  shortcut: string;
  title: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export const QUICK_REPLY_SHORTCUT_MAX = 30;
export const QUICK_REPLY_TITLE_MAX = 80;
export const QUICK_REPLY_CONTENT_MAX = 4000;

/** Variáveis aceitas no texto, com a descrição mostrada na tela. */
export const QUICK_REPLY_VARIABLES = [
  { key: "{nome}", label: "Nome do contato" },
  { key: "{primeiro_nome}", label: "Primeiro nome do contato" },
  { key: "{atendente}", label: "Seu primeiro nome" },
] as const;

/** "Boas Vindas!" → "boas-vindas" (mesma regra do CHECK da 142). */
export function normalizeShortcut(raw: string): string {
  return normalizeForSearch(raw.trim().replace(/^\/+/, ""))
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, QUICK_REPLY_SHORTCUT_MAX);
}

export function isValidShortcut(shortcut: string): boolean {
  return /^[a-z0-9_-]{1,30}$/.test(shortcut);
}

/**
 * "/" digitada no começo do campo ou depois de um espaço, seguida do que
 * já foi escrito do atalho (sem espaço). Recebe o texto ATÉ o cursor.
 * Devolve onde a "/" está e a busca, ou null se não há atalho em curso.
 */
export function matchSlashQuery(beforeCaret: string): { start: number; query: string } | null {
  const m = /(^|\s)\/([^\s/]{0,30})$/.exec(beforeCaret);
  if (!m) return null;
  return { start: m.index + m[1].length, query: m[2] };
}

/** Atalho que começa com a busca primeiro; depois atalho/título que contém. */
export function filterQuickReplies(list: QuickReply[], query: string, limit = 8): QuickReply[] {
  const q = normalizeForSearch(query.trim());
  if (!q) return list.slice(0, limit);
  const prefix: QuickReply[] = [];
  const contains: QuickReply[] = [];
  for (const r of list) {
    const shortcut = normalizeForSearch(r.shortcut);
    if (shortcut.startsWith(q)) prefix.push(r);
    else if (shortcut.includes(q) || normalizeForSearch(r.title).includes(q)) contains.push(r);
  }
  return [...prefix, ...contains].slice(0, limit);
}

export interface QuickReplyVars {
  contactName?: string | null;
  agentName?: string | null;
}

function firstName(name: string | null | undefined): string {
  return (name ?? "").trim().split(/\s+/)[0] ?? "";
}

/**
 * Preenche as variáveis. Sem o dado (contato sem nome), a variável some
 * e o espaço/vírgula que sobraria antes dela também — "Olá, {nome}!"
 * vira "Olá!" em vez de "Olá, !".
 */
export function renderQuickReply(content: string, vars: QuickReplyVars): string {
  const values: Record<string, string> = {
    nome: (vars.contactName ?? "").trim(),
    primeiro_nome: firstName(vars.contactName),
    atendente: firstName(vars.agentName),
  };
  return content
    .replace(/([ \t]*,?[ \t]*)\{(nome|primeiro_nome|atendente)\}/g, (_m, lead: string, key: string) => {
      const value = values[key];
      return value ? `${lead}${value}` : "";
    })
    // Variável vazia no começo: não começa a mensagem com vírgula.
    .replace(/^[,; \t]+/, "")
    .trim();
}
