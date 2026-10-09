// Respostas rápidas do Inbox (migration 142): regras puras usadas pelo
// campo de mensagem e pela tela de cadastro.

import { normalizeForSearch } from "@/lib/utils";

export type QuickReplyVisibility = "personal" | "team" | "account";

export interface QuickReply {
  id: string;
  account_id: string;
  shortcut: string;
  title: string;
  content: string;
  /** Quem cadastrou (coluna da 142); a tela usa para o filtro "Minhas". */
  created_by?: string | null;
  /** Migration 301: pessoal (só o dono), equipe (membros de team_id) ou conta (todos). */
  visibility?: QuickReplyVisibility;
  team_id?: string | null;
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

/**
 * Atalho que começa com a busca primeiro; depois atalho/título que contém.
 * Atalho repetido entre escopos aparece uma vez só: pessoal > equipe > conta (dedupeByShortcut).
 */
export function filterQuickReplies(rawList: QuickReply[], query: string, limit = 8): QuickReply[] {
  const list = dedupeByShortcut(rawList);
  const q =normalizeForSearch(query.trim());
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

// ---------- Visibilidade (migration 301) ----------

export const QUICK_REPLY_VISIBILITY_LABEL: Record<QuickReplyVisibility, string> = {
  personal: "Pessoal",
  team: "Equipe",
  account: "Conta",
};

/** Menor número = mais específico: pessoal vence equipe, que vence conta. */
const VISIBILITY_RANK: Record<QuickReplyVisibility, number> = { personal: 0, team: 1, account: 2 };

/** As respostas que já existiam antes da 301 não têm a coluna lida: valem como "conta". */
export function visibilityOf(reply: Pick<QuickReply, "visibility">): QuickReplyVisibility {
  return reply.visibility ?? "account";
}

/**
 * Atalho repetido entre escopos (o mesmo /oi pessoal, de equipe e da conta): fica o mais específico —
 * pessoal > equipe > conta. Em empate (duas equipes do mesmo usuário) vale a primeira da lista.
 * Mantém a ordem original dos que ficam.
 */
export function dedupeByShortcut(list: QuickReply[]): QuickReply[] {
  const best = new Map<string, QuickReply>();
  for (const r of list) {
    const cur = best.get(r.shortcut);
    if (!cur || VISIBILITY_RANK[visibilityOf(r)] < VISIBILITY_RANK[visibilityOf(cur)]) best.set(r.shortcut, r);
  }
  return list.filter((r) => best.get(r.shortcut) === r);
}

/** Quem pode editar/excluir (a RLS é quem decide de verdade): pessoal só o dono; equipe/conta só quem tem manage. */
export function canEditQuickReply(
  reply: Pick<QuickReply, "visibility" | "created_by">,
  ctx: { userId: string | null | undefined; canManage: boolean },
): boolean {
  if (visibilityOf(reply) === "personal") return !!ctx.userId && reply.created_by === ctx.userId;
  return ctx.canManage;
}

/** Visibilidades que o usuário pode escolher ao criar: sem manage, só pessoal. */
export function visibilityOptions(canManage: boolean): QuickReplyVisibility[] {
  return canManage ? ["personal", "team", "account"] : ["personal"];
}

/** O atalho é único por escopo: conta, equipe ou dono (pessoal). Há outra resposta no MESMO escopo com este atalho? */
export function shortcutTaken(
  list: QuickReply[],
  candidate: { shortcut: string; visibility: QuickReplyVisibility; teamId: string | null; ownerId: string | null | undefined },
  ignoreId?: string,
): boolean {
  return list.some((r) => {
    if (r.id === ignoreId || r.shortcut !== candidate.shortcut) return false;
    const v = visibilityOf(r);
    if (v !== candidate.visibility) return false;
    if (v === "team") return (r.team_id ?? null) === candidate.teamId;
    if (v === "personal") return r.created_by === candidate.ownerId;
    return true;
  });
}
