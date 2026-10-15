// Chaves do motor do Disparador na tela Controles (GET/PUT /api/disparador/engine; permissão campaigns.rate_limit). Contrato:
//   GET → { account: {batch_claim, tick_chain}, effective: {…: {enabled, source}}, env: {…} }   (account: null = segue o servidor)
//   PUT → { batch_claim?: boolean|null, tick_chain?: boolean|null } (null = volta ao padrão do servidor) e devolve o mesmo formato do GET.
// source: 'account' (decisão de uma conta), 'env' (configuração do servidor), 'default' (nada definido: desligado).
// O motor é COMPARTILHADO: "ligar" de qualquer conta liga para todas; por isso o valor efetivo pode vir de OUTRA conta ou do servidor.
import { apiFetch } from "@/lib/api-fetch";

export type EngineFlagKey = "batch_claim" | "tick_chain";
export type EngineSource = "account" | "env" | "default";

export interface EngineView {
  account: Record<EngineFlagKey, boolean | null>;
  effective: Record<EngineFlagKey, { enabled: boolean; source: EngineSource }>;
  env: Record<EngineFlagKey, boolean>;
}

export const ENGINE_KEYS: readonly EngineFlagKey[] = ["batch_claim", "tick_chain"];

export interface EngineCopy {
  title: string;
  what: string;
  advice: string;
}

/** Textos em português simples: o que a chave faz e quando mexer. */
export const ENGINE_COPY: Record<EngineFlagKey, EngineCopy> = {
  batch_claim: {
    title: "Envio em lote",
    what: "Em vez de pegar as mensagens da fila uma por uma, o motor pega várias de uma vez. Isso acelera o envio quando há muitas mensagens para sair, sem mudar quem recebe o quê.",
    advice: "Pensado para volumes altos. Se o envio já está bom como está, deixe desligado.",
  },
  tick_chain: {
    title: "Disparo contínuo",
    what: "Quando o motor termina um ciclo e ainda há mensagens para enviar, ele já começa o próximo, sem esperar o relógio de 1 minuto. O envio fica mais contínuo e rápido.",
    advice: "Pensado para volumes altos. Se o envio já está bom como está, deixe desligado.",
  },
};

export const ENGINE_WARNING =
  "Estas chaves valem para o motor inteiro: mudar afeta todas as campanhas em andamento, de todas as contas, no próximo ciclo (em até cerca de 10 segundos).";

const isKey = (k: string): k is EngineFlagKey => (ENGINE_KEYS as readonly string[]).includes(k);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const triBool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

export function parseEngineView(raw: unknown): EngineView {
  const o = rec(raw);
  const account = rec(o.account);
  const effective = rec(o.effective);
  const env = rec(o.env);
  const eff = (k: EngineFlagKey) => {
    const e = rec(effective[k]);
    const source: EngineSource = e.source === "account" || e.source === "env" ? e.source : "default";
    return { enabled: e.enabled === true, source };
  };
  const out: EngineView = {
    account: { batch_claim: triBool(account.batch_claim), tick_chain: triBool(account.tick_chain) },
    effective: { batch_claim: eff("batch_claim"), tick_chain: eff("tick_chain") },
    env: { batch_claim: env.batch_claim === true, tick_chain: env.tick_chain === true },
  };
  return out;
}

/** De onde vem o valor que o motor usa agora, em palavras. */
export function describeSource(key: EngineFlagKey, view: EngineView): { label: string; detail: string } {
  const eff = view.effective[key];
  const mine = view.account[key];
  const state = eff.enabled ? "ligado" : "desligado";
  if (eff.source === "account") {
    if (mine !== null && mine === eff.enabled) return { label: "Decisão desta conta", detail: `Esta conta deixou ${state}.` };
    return { label: "Decisão de outra conta", detail: `Outra conta deixou ${state}. O motor é compartilhado: vale para todas as contas.` };
  }
  if (eff.source === "env") return { label: "Configuração do servidor", detail: `Nenhuma conta decidiu; o servidor está ${state}.` };
  return { label: "Padrão do sistema", detail: "Nenhuma conta nem o servidor definiu: fica desligado." };
}

/** Decisão desta conta, em palavras (separada do valor que o motor usa). */
export function describeAccount(key: EngineFlagKey, view: EngineView): string {
  const v = view.account[key];
  if (v === null) return "Esta conta ainda não decidiu: segue o servidor.";
  return v ? "Esta conta pediu para ligar." : "Esta conta pediu para desligar.";
}

/** Ligar/voltar ao padrão passa a ligar o motor? (pede confirmação). */
export function wouldTurnOn(key: EngineFlagKey, view: EngineView, next: boolean | null): boolean {
  if (view.effective[key].enabled) return false;
  if (next === true) return true;
  return next === null && view.env[key] === true;
}

/** Depois de desligar: se o motor continua ligado, explica por quê (ligar de qualquer conta vence). */
export function stillOnMessage(key: EngineFlagKey, view: EngineView): string | null {
  if (!view.effective[key].enabled) return null;
  const s = describeSource(key, view);
  return `${ENGINE_COPY[key].title} continua ligado: ${s.label.toLowerCase()}. Para desligar de vez, desligue também lá.`;
}

export class EngineApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request(init?: RequestInit): Promise<EngineView> {
  let res: Response;
  try {
    res = await apiFetch("/api/disparador/engine", init);
  } catch {
    throw new EngineApiError(0, "Não foi possível falar com o servidor. Tente de novo.");
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = typeof rec(body).error === "string" ? (rec(body).error as string) : null;
    throw new EngineApiError(res.status, msg ?? (res.status === 403 ? "Você não tem permissão para ver estas chaves." : "Não foi possível carregar agora."));
  }
  return parseEngineView(body);
}

export const fetchEngine = () => request();

export function saveEngine(patch: Partial<Record<EngineFlagKey, boolean | null>>): Promise<EngineView> {
  const body: Record<string, boolean | null> = {};
  for (const [k, v] of Object.entries(patch)) if (isKey(k) && v !== undefined) body[k] = v;
  return request({ method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
