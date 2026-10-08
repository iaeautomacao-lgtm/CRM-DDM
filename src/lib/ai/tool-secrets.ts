// Segredos nas ferramentas (tools) do nó de IA.
//
// O token da API DDM ficava gravado em texto na URL das tools
// (flow_nodes.config, ex.: "localiza_dev.php?tk=<token>&cpf={{cpf}}") —
// visível no Flow Builder, no banco e em qualquer export de fluxo. Agora a
// configuração guarda só um marcador, {{secret.DDM_TOKEN}}, resolvido aqui
// na hora da chamada a partir do ambiente do servidor.
//
// Regras:
//   - Só segredos desta lista; cada um só vale para os hosts dele (um
//     marcador numa tool apontando para outro domínio não vaza o token).
//   - Resolvido ANTES dos argumentos do modelo ({{cpf}} etc.): um argumento
//     que contenha "{{secret.X}}" nunca vira segredo.

export interface ToolSecretDef {
  /** Valor no ambiente do servidor (primeiro não vazio). */
  envNames: string[];
  /** Sufixos de host autorizados a receber o segredo. */
  hosts: string[];
}

export const TOOL_SECRETS: Record<string, ToolSecretDef> = {
  DDM_TOKEN: {
    envNames: ["DDM_ACORDOS_API_TOKEN", "DDM_TOKEN", "DDM_API_KEY"],
    hosts: ["ddmacordos.com"],
  },
};

const SECRET_PLACEHOLDER = /\{\{\s*secret\.([A-Z0-9_]+)\s*\}\}/g;

function hostAllowed(url: string, hosts: string[]): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return hosts.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

export interface SecretResolution {
  value: string;
  /** Marcadores que não puderam ser resolvidos (ausente no ambiente, host não autorizado, nome desconhecido). */
  missing: string[];
}

/**
 * Troca os marcadores {{secret.NOME}} em `text`. `requestUrl` é a URL final
 * da chamada (o host decide se o segredo pode ir).
 */
export function resolveToolSecrets(
  text: string,
  requestUrl: string,
  env: Record<string, string | undefined> = process.env,
  opts: { encode?: boolean } = {},
): SecretResolution {
  const missing: string[] = [];
  const value = text.replace(SECRET_PLACEHOLDER, (_m, name: string) => {
    const def = TOOL_SECRETS[name];
    if (!def || !hostAllowed(requestUrl, def.hosts)) {
      missing.push(name);
      return "";
    }
    const secret = def.envNames.map((n) => env[n]?.trim()).find((v) => v);
    if (!secret) {
      missing.push(name);
      return "";
    }
    return opts.encode ? encodeURIComponent(secret) : secret;
  });
  return { value, missing };
}

/**
 * Parâmetros da URL que parecem um token em texto (ex.: tk=abc123…),
 * para o validador do fluxo avisar. Marcadores {{…}} não contam.
 */
export function findInlineSecrets(url: string): string[] {
  const found: string[] = [];
  const re = /[?&](tk|token|api_?key|apikey|key|secret)=([^&#]*)/gi;
  for (const m of url.matchAll(re)) {
    const value = m[2];
    // A valid secret placeholder must occupy the whole parameter value.
    // "{{secret.DDM_TOKEN}}abc..." is malformed: the suffix is still an
    // inline credential fragment and must be rejected by validation.
    const placeholderOnly = /^\{\{\s*secret\.[A-Z0-9_]+\s*\}\}$/i.test(value);
    if (!placeholderOnly && value.length >= 12) found.push(m[1]);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Importação de fluxo (TASK25). Um fluxo exportado carrega o token da DDM em
// texto na URL das tools; a migration 145 só converteu o que existia na época.
// Aqui a conversão roda em cada importação/duplicação. Módulo puro (sem
// imports de servidor): validate.ts, que roda no navegador, importa este arquivo.
// ---------------------------------------------------------------------------

export const DDM_TOKEN_PLACEHOLDER = "{{secret.DDM_TOKEN}}";

// O valor de tk= vai até `&`, `#`, aspas ou espaço — NUNCA para em `{`/`}`: um token com
// chave no meio (limitação da migration 145) deixava o resto colado depois do marcador.
const DDM_TK_PARAM = /(ddmacordos\.com[^\s"'#]*?[?&]tk=)([^&#\s"']*)/gi;
// Variável do fluxo ({{cpf}}) ou marcador completo: não é credencial em texto.
const WHOLE_PLACEHOLDER = /^\{\{\s*[\w.]+\s*\}\}$/;

/** Troca tk=<literal> de URLs ddmacordos.com por {{secret.DDM_TOKEN}} dentro de um texto. */
export function replaceDdmTokenInText(text: string): { text: string; replaced: number } {
  let replaced = 0;
  const out = text.replace(DDM_TK_PARAM, (match, prefix: string, value: string) => {
    if (WHOLE_PLACEHOLDER.test(value) || value === "") return match;
    replaced += 1;
    return `${prefix}${DDM_TOKEN_PLACEHOLDER}`;
  });
  return { text: out, replaced };
}

function mapStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]));
  }
  return value;
}

/** URLs onde uma credencial literal é detectada (tools do nó de IA e URL do http_fetch). */
function credentialUrls(config: Record<string, unknown>): string[] {
  const urls: string[] = [];
  if (typeof config.url === "string") urls.push(config.url);
  if (Array.isArray(config.tools)) {
    for (const tool of config.tools as Array<{ http?: { url?: unknown } }>) {
      if (typeof tool?.http?.url === "string") urls.push(tool.http.url);
    }
  }
  return urls;
}

export interface ImportSecretNode {
  node_key?: string;
  config?: Record<string, unknown>;
}

export interface ImportSecretResult<N extends ImportSecretNode> {
  nodes: N[];
  /** Quantas URLs da DDM tiveram o token trocado pelo marcador. */
  replaced: number;
  /** Credenciais literais que sobraram (outro domínio) — a importação deve ser recusada. */
  rejected: Array<{ node_key: string; param: string }>;
}

export function sanitizeImportedSecrets<N extends ImportSecretNode>(nodes: N[]): ImportSecretResult<N> {
  let replaced = 0;
  const rejected: Array<{ node_key: string; param: string }> = [];
  const clean = nodes.map((node) => {
    if (!node.config || typeof node.config !== "object") return node;
    const config = mapStrings(node.config, (s) => {
      const r = replaceDdmTokenInText(s);
      replaced += r.replaced;
      return r.text;
    }) as Record<string, unknown>;
    for (const url of credentialUrls(config)) {
      for (const param of findInlineSecrets(url)) rejected.push({ node_key: node.node_key ?? "?", param });
    }
    return { ...node, config };
  });
  return { nodes: clean, replaced, rejected };
}

/** A URL aponta para a DDM (domínio com marcador próprio)? */
export function isDdmUrl(url: string): boolean {
  return /^https?:\/\/(?:[^/?#@]*\.)?ddmacordos\.com(?:[:/?#]|$)/i.test(url.trim());
}
