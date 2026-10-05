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
    if (value.length >= 12 && !value.includes("{{")) found.push(m[1]);
  }
  return found;
}
