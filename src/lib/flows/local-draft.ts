// Rascunho local do editor de fluxos (puro — o provider do editor decide
// quando gravar, ler e limpar).
//
// Guarda no localStorage do navegador a última versão NÃO salva do fluxo,
// para que fechar a aba, cair a internet ou dar conflito com outra aba não
// faça o usuário perder o que editou. Uma chave por fluxo; o registro leva
// a versão do servidor (`updated_at`) sobre a qual as edições foram feitas.
//
// Todo acesso ao storage fica em try/catch: navegação privada, cota cheia
// ou storage desativado nunca podem quebrar o editor.

export const FLOW_DRAFT_KEY_PREFIX = "wacrm.flowDraft.";
/** Rascunho mais velho que isso é descartado ao abrir (30 dias). */
export const FLOW_DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Espera entre a última edição e a gravação local. */
export const FLOW_DRAFT_DEBOUNCE_MS = 400;

/** Subconjunto de `Storage` usado aqui (facilita testes). */
export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface FlowDraftRecord<T> {
  v: 1;
  flowId: string;
  /** `updated_at` do servidor que o editor conhecia ao gravar. */
  baseVersion: string;
  /** Momento da gravação (relógio do navegador, ms). */
  savedAt: number;
  /** Gravado depois de um conflito com outra aba/usuário. */
  conflict: boolean;
  state: T;
}

export type DraftOfferReason =
  | "none"
  | "expired"
  | "identical"
  | "same-version"
  | "newer"
  | "conflict"
  | "obsolete";

export interface DraftOfferDecision {
  offer: boolean;
  reason: DraftOfferReason;
  /** O rascunho foi feito sobre uma versão do servidor que já mudou. */
  basedOnOlderVersion: boolean;
}

export function flowDraftKey(flowId: string): string {
  return `${FLOW_DRAFT_KEY_PREFIX}${flowId}`;
}

/** localStorage do navegador, ou null (SSR, storage bloqueado). */
export function getBrowserDraftStorage(): DraftStorage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Lê o rascunho do fluxo. Qualquer coisa malformada (JSON quebrado,
 * campos faltando, outro fluxo, estado que não passa no `isState`) vira null.
 */
export function readFlowDraft<T>(
  storage: DraftStorage | null,
  flowId: string,
  isState: (value: unknown) => value is T,
): FlowDraftRecord<T> | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(flowDraftKey(flowId));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<FlowDraftRecord<unknown>> | null;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      parsed.v !== 1 ||
      parsed.flowId !== flowId ||
      typeof parsed.baseVersion !== "string" ||
      typeof parsed.savedAt !== "number" ||
      !Number.isFinite(parsed.savedAt) ||
      !isState(parsed.state)
    ) {
      return null;
    }
    return {
      v: 1,
      flowId,
      baseVersion: parsed.baseVersion,
      savedAt: parsed.savedAt,
      conflict: parsed.conflict === true,
      state: parsed.state,
    };
  } catch {
    return null;
  }
}

/** Grava o rascunho. false = não deu (storage indisponível ou cheio). */
export function writeFlowDraft<T>(
  storage: DraftStorage | null,
  record: FlowDraftRecord<T>,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(flowDraftKey(record.flowId), JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

export function clearFlowDraft(storage: DraftStorage | null, flowId: string): void {
  if (!storage) return;
  try {
    storage.removeItem(flowDraftKey(flowId));
  } catch {
    // storage indisponível: nada a limpar
  }
}

/**
 * JSON com chaves ordenadas, para comparar estados cuja ordem de chaves
 * pode variar (configs montadas com spread em ordens diferentes).
 * `undefined` em objeto some, como no JSON.stringify.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : stableStringify(item))).join(",")}]`;
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(",")}}`;
}

export function draftDiffers(a: unknown, b: unknown): boolean {
  return stableStringify(a) !== stableStringify(b);
}

/**
 * Decide se, ao abrir o editor, oferece "Recuperar" para o rascunho local.
 *
 * Oferece quando o rascunho difere do servidor e:
 *   - foi feito sobre a mesma versão que o servidor tem agora (edições
 *     que não chegaram a ser salvas); ou
 *   - foi gravado depois da última alteração no servidor; ou
 *   - foi gravado depois de um conflito (a versão do servidor mudou por
 *     outra aba, mas o trabalho local continua recuperável).
 * Rascunho vencido ou igual ao servidor não é oferecido (o chamador limpa).
 */
export function decideDraftOffer<T>(input: {
  draft: FlowDraftRecord<T> | null;
  serverVersion: string;
  serverState: T;
  now: number;
  maxAgeMs?: number;
}): DraftOfferDecision {
  const { draft, serverVersion, serverState, now } = input;
  const maxAgeMs = input.maxAgeMs ?? FLOW_DRAFT_MAX_AGE_MS;
  if (!draft) return { offer: false, reason: "none", basedOnOlderVersion: false };
  if (now - draft.savedAt > maxAgeMs) {
    return { offer: false, reason: "expired", basedOnOlderVersion: false };
  }
  if (!draftDiffers(draft.state, serverState)) {
    return { offer: false, reason: "identical", basedOnOlderVersion: false };
  }
  if (draft.baseVersion === serverVersion) {
    return { offer: true, reason: "same-version", basedOnOlderVersion: false };
  }
  if (draft.conflict) {
    return { offer: true, reason: "conflict", basedOnOlderVersion: true };
  }
  const serverTime = Date.parse(serverVersion);
  if (Number.isFinite(serverTime) && draft.savedAt > serverTime) {
    return { offer: true, reason: "newer", basedOnOlderVersion: true };
  }
  return { offer: false, reason: "obsolete", basedOnOlderVersion: true };
}
