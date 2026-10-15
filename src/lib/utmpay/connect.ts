// Vocabulário (igual nas duas telas): "chave de acesso" (X-API-Key), "avisos para o CRM" (webhook/eventos), "endereço dos avisos", "segredo dos avisos", "código do envio" (tid). O termo técnico só em texto de ajuda.
// "Conectar com um clique" CRM → UTMpay (decisão do dono, 15/10: tudo configurável no front, nada via .env).
//   POST {base_url}/api/integracoes/crm   (X-API-Key)   { url, segredo }   → 200 { status:"ok", url, tem_segredo, atualizado_em }; 401 chave; 400 (url não https / segredo < 16); 503 sem banco
//   GET  {base_url}/api/integracoes/crm   (X-API-Key)                            → { url, tem_segredo, atualizado_em }   (nunca o segredo)
// O CRM chama o POST ao salvar a tela de Rastreamento, no botão "Conectar ao UTMpay" e sempre que o segredo muda. O segredo NUNCA volta ao navegador
// nem vai para log/erro: as mensagens abaixo são genéricas.
import "server-only";
import { safeFetch } from "@/lib/security/ssrf-guard";

export const CONNECT_PATH = "/api/integracoes/crm";
export const CONNECT_TIMEOUT_MS = 10_000;

export type ConnectFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<Response>;

const defaultFetch: ConnectFetch = (url, init) => safeFetch(url, init, { timeoutMs: CONNECT_TIMEOUT_MS, maxBytes: 64 * 1024, failOnCrossOriginRedirect: true });

export interface ConnectInput {
  baseUrl: string;
  apiKey: string | null;
  /** Segredo do webhook em texto (só no servidor). */
  secret: string | null;
  /** Endereço dos eventos do CRM (https). */
  eventsUrl: string | null;
}

export type ConnectReason = "no_base_url" | "no_key" | "no_secret" | "secret_short" | "no_events_url" | "unauthorized" | "rejected" | "unavailable" | "http" | "network" | "bad_response";

/** Tamanho mínimo do segredo dos avisos aceito pelo UTMpay. */
export const MIN_SECRET_CHARS = 16;

export interface ConnectResult {
  /** Tentou falar com o UTMpay? (false = faltava algo: nada foi enviado). */
  tentou: boolean;
  ok: boolean;
  reason: ConnectReason | null;
  /** Texto para a tela (pt-BR, sem segredo, sem URL interna). */
  mensagem: string;
  /** O que o UTMpay devolveu (só quando ok): o endereço guardado e a data. */
  url: string | null;
  atualizado_em: string | null;
}

const MESSAGES: Record<ConnectReason, string> = {
  no_base_url: "Informe o endereço do UTMpay para conectar. Exemplo: https://utmpay.suaempresa.com.br",
  no_key: "Informe a chave de acesso para conectar. Ela aparece no UTMpay, em Configurações.",
  no_secret: "Informe o segredo dos avisos para conectar. Crie um texto longo e guarde: ele protege os avisos do UTMpay para o CRM.",
  secret_short: "O segredo dos avisos é curto demais. Use pelo menos 16 caracteres (uma frase longa serve).",
  no_events_url: "O CRM não sabe o próprio endereço na internet. Peça ao suporte para configurar o endereço do CRM.",
  unauthorized: "Falhou: a chave de acesso está errada. Copie a chave de novo no UTMpay e salve.",
  rejected: "Falhou: o UTMpay não aceitou os dados. O endereço dos avisos precisa começar com https e o segredo dos avisos precisa ter pelo menos 16 caracteres.",
  unavailable: "Falhou: o UTMpay ainda não tem o banco de dados pronto. Peça ao suporte para terminar a instalação do UTMpay.",
  http: "Falhou: o UTMpay deu erro ao conectar. Tente de novo em alguns instantes.",
  network: "Falhou: não foi possível falar com o UTMpay. Confira o endereço e se ele está no ar.",
  bad_response: "Falhou: o UTMpay respondeu algo inesperado. Atualize o UTMpay para a versão nova e tente de novo.",
};

const fail = (reason: ConnectReason, tentou: boolean): ConnectResult => ({ tentou, ok: false, reason, mensagem: MESSAGES[reason], url: null, atualizado_em: null });

function endpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${CONNECT_PATH}`;
}

function parseState(body: unknown): { url: string | null; tem_segredo: boolean | null; atualizado_em: string | null } {
  const o = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return {
    url: typeof o.url === "string" && o.url ? o.url : null,
    tem_segredo: typeof o.tem_segredo === "boolean" ? o.tem_segredo : null,
    atualizado_em: typeof o.atualizado_em === "string" && o.atualizado_em ? o.atualizado_em : null,
  };
}

/** Falta algo para conectar? Devolve o motivo (sem chamar a rede) ou null. */
export function missingForConnect(input: ConnectInput): ConnectReason | null {
  if (!input.baseUrl) return "no_base_url";
  if (!input.apiKey) return "no_key";
  if (!input.secret) return "no_secret";
  if (input.secret.length < MIN_SECRET_CHARS) return "secret_short";
  if (!input.eventsUrl) return "no_events_url";
  return null;
}

/** POST: manda o endereço dos eventos e o segredo ao UTMpay. */
export async function connectUtmpay(input: ConnectInput, fetcher: ConnectFetch = defaultFetch): Promise<ConnectResult> {
  const missing = missingForConnect(input);
  if (missing) return fail(missing, false);
  let res: Response;
  try {
    res = await fetcher(endpoint(input.baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": input.apiKey as string },
      body: JSON.stringify({ url: input.eventsUrl, segredo: input.secret }),
    });
  } catch {
    return fail("network", true);
  }
  if (res.status === 401 || res.status === 403) return fail("unauthorized", true);
  if (res.status === 400 || res.status === 422) return fail("rejected", true);
  if (res.status === 503) return fail("unavailable", true);
  if (!res.ok) return fail("http", true);
  let state: ReturnType<typeof parseState>;
  try {
    state = parseState(await res.json());
  } catch {
    // 2xx sem corpo JSON: o UTMpay aceitou; só não sabemos a data.
    state = { url: null, tem_segredo: null, atualizado_em: null };
  }
  return {
    tentou: true,
    ok: true,
    reason: null,
    mensagem: "Conectado agora há pouco. O UTMpay vai avisar o CRM de cada clique e de cada etapa do cliente.",
    url: state.url ?? input.eventsUrl,
    atualizado_em: state.atualizado_em,
  };
}

export type ConnectionStatus = "conectado" | "divergente" | "nao_conectado" | "erro" | "nao_configurado";

export interface ConnectionState {
  estado: ConnectionStatus;
  /** Endereço que o UTMpay guardou (o segredo nunca vem). */
  url: string | null;
  tem_segredo: boolean;
  /** O UTMpay respondeu (mesmo que com erro)? false = não foi possível falar com ele (rede, endereço errado). */
  alcancavel: boolean;
  atualizado_em: string | null;
  /** Endereço dos eventos que o CRM espera. */
  esperado: string | null;
  mensagem: string;
}

/** GET: o que o UTMpay tem guardado (sem o segredo) comparado com o que o CRM espera. */
async function readInner(input: Pick<ConnectInput, "baseUrl" | "apiKey" | "eventsUrl">, fetcher: ConnectFetch): Promise<Omit<ConnectionState, "alcancavel">> {
  const base = { url: null, tem_segredo: false, atualizado_em: null, esperado: input.eventsUrl };
  if (!input.baseUrl || !input.apiKey) return { ...base, estado: "nao_configurado", mensagem: "Falta informar o endereço do UTMpay e a chave de acesso." };
  let res: Response;
  try {
    res = await fetcher(endpoint(input.baseUrl), { method: "GET", headers: { "X-API-Key": input.apiKey } });
  } catch {
    return { ...base, estado: "erro", mensagem: MESSAGES.network };
  }
  if (res.status === 401 || res.status === 403) return { ...base, estado: "erro", mensagem: MESSAGES.unauthorized };
  if (res.status === 404) return { ...base, estado: "erro", mensagem: "Este UTMpay ainda não sabe se conectar sozinho. Atualize o UTMpay para a versão nova." };
  if (!res.ok) return { ...base, estado: "erro", mensagem: MESSAGES.http };
  let state: ReturnType<typeof parseState>;
  try {
    state = parseState(await res.json());
  } catch {
    return { ...base, estado: "erro", mensagem: MESSAGES.bad_response };
  }
  const hasSecret = state.tem_segredo === true;
  const same = !!state.url && !!input.eventsUrl && state.url.replace(/\/+$/, "") === input.eventsUrl.replace(/\/+$/, "");
  if (!state.url && !hasSecret) return { ...base, estado: "nao_conectado", mensagem: "O UTMpay ainda não manda avisos para o CRM. Clique em Conectar." };
  const when = state.atualizado_em ? ` (segredo configurado em ${state.atualizado_em})` : "";
  if (!same) {
    return { url: state.url, tem_segredo: hasSecret, atualizado_em: state.atualizado_em, esperado: input.eventsUrl, estado: "divergente", mensagem: `O UTMpay está mandando os avisos para outro endereço${when}. Clique em Conectar para corrigir.` };
  }
  if (!hasSecret) return { url: state.url, tem_segredo: false, atualizado_em: state.atualizado_em, esperado: input.eventsUrl, estado: "nao_conectado", mensagem: "O UTMpay tem o endereço, mas ainda não tem o segredo dos avisos. Clique em Conectar." };
  return { url: state.url, tem_segredo: true, atualizado_em: state.atualizado_em, esperado: input.eventsUrl, estado: "conectado", mensagem: `O UTMpay manda os avisos para ${state.url}${when}.` };
}

/** Estado da conexão deduzido do resultado de um POST (evita um GET extra logo depois de conectar). */
function stateFromResult(result: ConnectResult, eventsUrl: string | null): Omit<ConnectionState, "alcancavel"> {
  if (result.ok) {
    return { estado: "conectado", url: result.url, tem_segredo: true, atualizado_em: result.atualizado_em, esperado: eventsUrl, mensagem: result.mensagem };
  }
  if (!result.tentou) {
    return { estado: "nao_configurado", url: null, tem_segredo: false, atualizado_em: null, esperado: eventsUrl, mensagem: result.mensagem };
  }
  return { estado: "erro", url: null, tem_segredo: false, atualizado_em: null, esperado: eventsUrl, mensagem: result.mensagem };
}

/** GET: o que o UTMpay tem guardado (sem o segredo) comparado com o que o CRM espera. */
export async function readUtmpayConnection(input: Pick<ConnectInput, "baseUrl" | "apiKey" | "eventsUrl">, fetcher: ConnectFetch = defaultFetch): Promise<ConnectionState> {
  let reached = false;
  const state = await readInner(input, async (url, init) => {
    const res = await fetcher(url, init);
    reached = true;
    return res;
  });
  return { ...state, alcancavel: reached };
}

/** Estado da conexão deduzido do resultado de um POST (evita um GET extra logo depois de conectar). */
export function connectionFromResult(result: ConnectResult, eventsUrl: string | null): ConnectionState {
  return { ...stateFromResult(result, eventsUrl), alcancavel: result.ok || (result.tentou && result.reason !== "network") };
}
