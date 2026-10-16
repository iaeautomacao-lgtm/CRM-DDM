// Rascunho do operador no navegador (texto de conversa: pode ter CPF, valor de acordo, telefone). LGPD:
//  - a chave leva conta + usuário + conversa: outro usuário no mesmo navegador nunca vê o rascunho;
//  - validade de 7 dias (varredura ao entrar e leitura de rascunho vencido apaga);
//  - clearAllDrafts() apaga TODOS os rascunhos (inclusive o formato antigo, sem usuário na chave) no logout,
//    na troca de conta/usuário e na sessão expirada; e invalida gravações que ainda estavam pendentes (pagehide).
// Funções puras sobre um `Storage` injetado, para testar sem navegador.

export const DRAFT_PREFIX = "wacrm:draft:";
const CURRENT_PREFIX = `${DRAFT_PREFIX}v2:`;
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface DraftScope {
  accountId: string;
  userId: string;
}

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

let epoch = 0;

/** Muda a cada limpeza total: gravação agendada antes dela (ex.: no pagehide do logout) não pode reescrever o rascunho. */
export function draftEpoch(): number {
  return epoch;
}

export function draftKey(scope: DraftScope, conversationId: string): string {
  return `${CURRENT_PREFIX}${scope.accountId}:${scope.userId}:${conversationId}`;
}

function browserStorage(): DraftStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function allDraftKeys(storage: DraftStorage): string[] {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k?.startsWith(DRAFT_PREFIX)) keys.push(k);
  }
  return keys;
}

/** Grava (texto vazio apaga). `expectedEpoch` descarta a gravação se houve limpeza total depois que ela foi agendada. */
export function writeDraft(
  scope: DraftScope | null,
  conversationId: string,
  text: string,
  opts: { now?: number; expectedEpoch?: number; storage?: DraftStorage | null } = {},
): void {
  if (!scope) return;
  if (opts.expectedEpoch !== undefined && opts.expectedEpoch !== epoch) return;
  const storage = opts.storage === undefined ? browserStorage() : opts.storage;
  if (!storage) return;
  const key = draftKey(scope, conversationId);
  try {
    if (text) storage.setItem(key, JSON.stringify({ t: text, at: opts.now ?? Date.now() }));
    else storage.removeItem(key);
  } catch (err) {
    console.error("[Draft] Failed to save draft:", err);
  }
}

/** Lê o rascunho do usuário atual; vencido ou ilegível é apagado e devolve null. */
export function readDraft(
  scope: DraftScope | null,
  conversationId: string,
  opts: { now?: number; storage?: DraftStorage | null } = {},
): string | null {
  if (!scope) return null;
  const storage = opts.storage === undefined ? browserStorage() : opts.storage;
  if (!storage) return null;
  const key = draftKey(scope, conversationId);
  try {
    const raw = storage.getItem(key);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { t?: unknown; at?: unknown };
    const fresh = typeof parsed.at === "number" && (opts.now ?? Date.now()) - parsed.at < DRAFT_TTL_MS;
    if (typeof parsed.t === "string" && fresh) return parsed.t;
    storage.removeItem(key);
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      /* storage indisponível */
    }
  }
  return null;
}

/** Apaga todos os rascunhos do navegador (logout, troca de conta/usuário, sessão expirada). */
export function clearAllDrafts(storage?: DraftStorage | null): void {
  epoch += 1;
  const target = storage === undefined ? browserStorage() : storage;
  if (!target) return;
  try {
    for (const k of allDraftKeys(target)) target.removeItem(k);
  } catch {
    /* storage indisponível */
  }
}

/** Varredura ao entrar: apaga rascunho vencido, ilegível ou no formato antigo (sem usuário na chave). */
export function purgeExpiredDrafts(opts: { now?: number; storage?: DraftStorage | null } = {}): void {
  const storage = opts.storage === undefined ? browserStorage() : opts.storage;
  if (!storage) return;
  const now = opts.now ?? Date.now();
  try {
    for (const k of allDraftKeys(storage)) {
      let keep = false;
      if (k.startsWith(CURRENT_PREFIX)) {
        try {
          const parsed = JSON.parse(storage.getItem(k) ?? "") as { at?: unknown };
          keep = typeof parsed.at === "number" && now - parsed.at < DRAFT_TTL_MS;
        } catch {
          keep = false;
        }
      }
      if (!keep) storage.removeItem(k);
    }
  } catch {
    /* storage indisponível */
  }
}
