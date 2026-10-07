// Monta a requisição HTTP de uma ferramenta do catálogo para a rota "Testar
// ferramenta": mesma ordem do responder (segredos ANTES dos argumentos do
// modelo; host checado na URL FINAL). Puro.

import { collectSecretValues, hostCheckUrl, resolveToolSecrets, type AccountSecretsContext } from "@/lib/ai/tool-secrets";
import type { AiAgentTool } from "@/lib/flows/types";

export interface BuiltToolRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  /** Marcadores sem valor (var.X, cred.X, host não permitido). */
  missing: string[];
  /** A requisição carrega credencial (redirect cross-origin deve falhar). */
  credentialInjected: boolean;
  /** Valores secretos usados — para REMOVER da resposta antes de devolver ao cliente. */
  secretValues: string[];
}

export function buildToolRequest(
  tool: Pick<AiAgentTool, "http">,
  args: Record<string, unknown>,
  account: AccountSecretsContext | null,
  env: Record<string, string | undefined> = process.env,
): BuiltToolRequest {
  const interpolate = (str: string) =>
    str.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => (args[key] !== undefined ? String(args[key]) : ""));
  const destination = hostCheckUrl(tool.http.url, account, interpolate);
  const missing: string[] = [];
  const secretValues: string[] = [];
  let credentialInjected = false;

  const resolve = (text: string, encode: boolean) => {
    const r = resolveToolSecrets(text, destination, env, { encode, account });
    missing.push(...r.missing);
    if (r.usedSecrets) credentialInjected = true;
    return r.value;
  };

  const url = interpolate(resolve(tool.http.url, true));
  const body = tool.http.body ? interpolate(resolve(tool.http.body, false)) : undefined;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(tool.http.headers ?? {})) headers[k] = interpolate(resolve(v, false));

  secretValues.push(...collectSecretValues(account, env));

  return { url, method: tool.http.method, headers, body, missing: [...new Set(missing)], credentialInjected, secretValues };
}

/**
 * Corpo da resposta para devolver ao cliente: sem nenhum valor secreto usado,
 * até `max` bytes. Nunca inclui URL/headers resolvidos.
 */
export function sanitizeResponseBody(text: string, secretValues: readonly string[], max = 2048): string {
  let out = text;
  for (const secret of [...secretValues].sort((a, b) => b.length - a.length)) {
    if (secret.length >= 6) out = out.split(secret).join("***");
    const enc = encodeURIComponent(secret);
    if (enc !== secret && enc.length >= 6) out = out.split(enc).join("***");
  }
  return out.length > max ? `${out.slice(0, max)}…[truncado]` : out;
}

/** Argumentos de exemplo pelos tipos dos parâmetros (para testar sem digitar tudo). */
export function exampleArguments(parameters: AiAgentTool["parameters"]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(parameters.properties ?? {})) {
    const d = def as { type?: string; enum?: string[] };
    out[key] = d.enum?.[0] ?? (d.type === "number" || d.type === "integer" ? 1 : d.type === "boolean" ? true : "exemplo");
  }
  return out;
}
