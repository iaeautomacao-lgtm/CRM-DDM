// Segredos nas ferramentas (tools) do nó de IA.
//
// O token da API DDM ficava gravado em texto na URL das tools
// (flow_nodes.config, ex.: "localiza_dev.php?tk=<token>&cpf={{cpf}}") —
// visível no Flow Builder, no banco e em qualquer export de fluxo. Agora a
// configuração guarda só um marcador, resolvido aqui na hora da chamada:
//
//   {{secret.DDM_TOKEN}}  segredo do ambiente do servidor (TOOL_SECRETS) —
//                         se a CONTA tiver uma credencial com o mesmo nome,
//                         ela tem prioridade sobre o .env.
//   {{cred.NOME}}         credencial da conta (Configurações → Variáveis e
//                         credenciais), cifrada no banco; só vai para hosts
//                         de allowed_hosts.
//   {{var.NOME}}          variável da conta (texto, não secreta).
//
// Regras:
//   - Cada segredo só vale para os hosts dele (um marcador numa tool apontando
//     para outro domínio não vaza o token).
//   - Resolvido ANTES dos argumentos do modelo ({{cpf}} etc.): um argumento
//     que contenha "{{cred.X}}" nunca vira segredo.
//
// Este arquivo é PURO e roda também no navegador (o validador do fluxo o
// importa): nada de banco/Node aqui. O carregamento das credenciais da conta
// fica em account-secrets.ts (servidor).

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

/** Variáveis e credenciais da conta, já carregadas (e decifradas) para UMA chamada. */
export interface AccountSecretsContext {
  vars: ReadonlyMap<string, string>;
  creds: ReadonlyMap<string, { value: string; hosts: readonly string[] }>;
}

const MARKER = /\{\{\s*(secret|cred|var)\.([A-Z0-9_]+)\s*\}\}/g;
const VAR_MARKER = /\{\{\s*var\.([A-Z0-9_]+)\s*\}\}/g;

/** A URL aponta para um dos hosts (ou subdomínios) permitidos? */
export function hostAllowedFor(url: string, hosts: readonly string[]): boolean {
  return hostAllowed(url, hosts);
}

function hostAllowed(url: string, hosts: readonly string[]): boolean {
  try {
    const parsed = new URL(url);
    // Credencial só vai por HTTPS na porta padrão (URL.port é "" para 443).
    if (parsed.protocol !== "https:" || parsed.port !== "") return false;
    const host = parsed.hostname.toLowerCase();
    return hosts.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

export interface SecretResolution {
  value: string;
  /**
   * Marcadores que não puderam ser resolvidos (ausente, host não autorizado,
   * nome desconhecido). Variáveis/credenciais da conta aparecem como
   * "var.NOME"/"cred.NOME"; segredos do ambiente, só o NOME (como antes).
   */
  missing: string[];
  /** true se algum {{cred.X}}/{{secret.X}} virou valor real (a requisição carrega credencial). */
  usedSecrets: boolean;
}

/**
 * URL FINAL usada para decidir se uma credencial pode ir: {{var.X}} resolvido,
 * marcadores de segredo removidos e os argumentos do modelo ({{param}})
 * interpolados — o host que importa é o de DESTINO, não o do template (um
 * argumento ou variável pode montar o host). `interpolate` é a mesma função
 * que o responder aplica à URL real.
 */
export function hostCheckUrl(
  template: string,
  account: AccountSecretsContext | null | undefined,
  interpolate: (text: string) => string = (t) => t,
): string {
  const withVars = account ? template.replace(VAR_MARKER, (_m, n: string) => account.vars.get(n) ?? "") : template;
  return interpolate(withVars.replace(MARKER, ""));
}

/**
 * Troca os marcadores {{secret.NOME}}, {{cred.NOME}} e {{var.NOME}} em
 * `text`. `requestUrl` é a URL da chamada (o host decide se o segredo pode
 * ir); `{{var.X}}` dentro dela é resolvido antes de checar o host, para
 * suportar URL base em variável.
 */
export function resolveToolSecrets(
  text: string,
  requestUrl: string,
  env: Record<string, string | undefined> = process.env,
  opts: { encode?: boolean; account?: AccountSecretsContext | null; mask?: boolean } = {},
): SecretResolution {
  const missing: string[] = [];
  let usedSecrets = false;
  const account = opts.account ?? null;
  const out = (v: string) => (opts.encode ? encodeURIComponent(v) : v);
  // mask: o valor de credencial/segredo NUNCA é lido — vira "***" (simulador e logs).
  // As regras de host/ausência continuam valendo, então a simulação mostra as mesmas falhas.
  const secretOut = (v: string) => (opts.mask ? "***" : out(v));
  const hostUrl = account
    ? requestUrl.replace(VAR_MARKER, (_m, n: string) => account.vars.get(n) ?? "")
    : requestUrl;

  const value = text.replace(MARKER, (_m, kind: string, name: string) => {
    if (kind === "var") {
      const v = account?.vars.get(name);
      if (v === undefined) {
        missing.push(`var.${name}`);
        return "";
      }
      // Variável NÃO é codificada: ela pode montar a URL base ({{var.BASE}}/x) e o host é
      // checado sobre este mesmo valor. Só os argumentos do modelo são codificados.
      return v;
    }
    if (kind === "cred") {
      const cred = account?.creds.get(name);
      if (!cred || !hostAllowed(hostUrl, cred.hosts)) {
        missing.push(`cred.${name}`);
        return "";
      }
      usedSecrets = true;
      return secretOut(cred.value);
    }
    // secret.NOME: credencial da conta com o mesmo nome vence o ambiente.
    const accountCred = account?.creds.get(name);
    if (accountCred) {
      if (!hostAllowed(hostUrl, accountCred.hosts)) {
        missing.push(name);
        return "";
      }
      usedSecrets = true;
      return secretOut(accountCred.value);
    }
    const def = TOOL_SECRETS[name];
    if (!def || !hostAllowed(hostUrl, def.hosts)) {
      missing.push(name);
      return "";
    }
    const secret = def.envNames.map((n) => env[n]?.trim()).find((v) => v);
    if (!secret) {
      missing.push(name);
      return "";
    }
    usedSecrets = true;
    return secretOut(secret);
  });
  return { value, missing, usedSecrets };
}

/**
 * Valores secretos que podem ter sido injetados numa requisição (credenciais da
 * conta + segredos do ambiente da lista fixa) — usados para REMOVER qualquer eco
 * deles de respostas devolvidas ao cliente/ao modelo.
 */
export function collectSecretValues(
  account: AccountSecretsContext | null | undefined,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const out: string[] = [];
  if (account) for (const c of account.creds.values()) out.push(c.value);
  for (const def of Object.values(TOOL_SECRETS)) {
    for (const name of def.envNames) if (env[name]?.trim()) out.push(env[name]!.trim());
  }
  return out;
}

/** Nomes referenciados em `{{cred.X}}` / `{{var.X}}` dentro de textos (URL, headers, body). */
export function findAccountSecretRefs(texts: Array<string | undefined | null>): {
  creds: string[];
  vars: string[];
} {
  const creds = new Set<string>();
  const vars = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const m of text.matchAll(MARKER)) {
      if (m[1] === "cred") creds.add(m[2]);
      else if (m[1] === "var") vars.add(m[2]);
    }
  }
  return { creds: [...creds], vars: [...vars] };
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
    const placeholderOnly = /^\{\{\s*(secret|cred|var)\.[A-Z0-9_]+\s*\}\}$/i.test(value);
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

/** Mensagem do validador de fluxo para token em texto na URL de uma ferramenta. */
export function inlineSecretAdvice(toolName: string, params: string[]): string {
  return `A ferramenta "${toolName}" tem um token em texto na URL (${params.join(", ")}=…). Cadastre o valor em Configurações → Variáveis e credenciais e use {{cred.NOME}} no lugar — o token fica cifrado só no servidor.`;
}
