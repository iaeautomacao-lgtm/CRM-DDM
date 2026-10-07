// Validação e serialização do catálogo de ferramentas (wacrm.ai_tools,
// migration 176). Puro: sem banco.
//
// REGRA CENTRAL: credencial literal NUNCA entra no catálogo. URL, headers e
// body aceitam só marcadores ({{cred.NOME}}, {{var.NOME}}, {{secret.NOME}}) —
// o valor real vive cifrado em Variáveis e credenciais (migration 175).

import { findAccountSecretRefs, findInlineSecrets } from "@/lib/ai/tool-secrets";
import type { AiAgentTool } from "@/lib/flows/types";

export const TOOL_NAME_RE = /^[a-z][a-z0-9_]{1,63}$/;
export const PARAM_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const TOOL_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export const PARAM_TYPES = ["string", "number", "integer", "boolean"] as const;
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

/** Timeout da chamada HTTP de uma ferramenta: padrão 30 s, limitado a 1–60 s. */
export function toolTimeoutMs(configured?: number | null): number {
  if (typeof configured !== "number" || !Number.isFinite(configured)) return DEFAULT_TOOL_TIMEOUT_MS;
  return Math.min(60_000, Math.max(1_000, Math.floor(configured)));
}
const MAX_PARAMS = 20;
const MAX_HEADERS = 20;

export interface ToolRow {
  id: string;
  account_id: string;
  name: string;
  display_name: string;
  description: string;
  parameters: AiAgentTool["parameters"];
  http: AiAgentTool["http"];
  timeout_ms: number;
  enabled: boolean;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PublicTool {
  id: string;
  name: string;
  display_name: string;
  description: string;
  parameters: AiAgentTool["parameters"];
  http: AiAgentTool["http"];
  timeout_ms: number;
  enabled: boolean;
  updated_at: string;
}

export function toPublicTool(row: ToolRow): PublicTool {
  return {
    id: row.id,
    name: row.name,
    display_name: row.display_name,
    description: row.description,
    parameters: row.parameters,
    http: row.http,
    timeout_ms: row.timeout_ms,
    enabled: row.enabled,
    updated_at: row.updated_at,
  };
}

/** Ferramenta do catálogo no shape que o runtime/LLM já usa (AiAgentTool). */
export function toAiAgentTool(row: Pick<ToolRow, "name" | "description" | "parameters" | "http" | "timeout_ms">): AiAgentTool {
  return {
    name: row.name,
    description: row.description,
    parameters: row.parameters,
    http: row.http,
    timeout_ms: row.timeout_ms,
  };
}

// Cabeçalhos que carregam credencial: o valor tem de ser SÓ um marcador
// (opcionalmente precedido de "Bearer "/"Basic "/"Token ").
const CREDENTIAL_HEADERS = /^(authorization|proxy-authorization|x-api-key|api-key|apikey|x-auth-token|x-access-token|x-token|cookie)$/i;
const MARKER_ONLY = /^(?:(?:bearer|basic|token)\s+)?\{\{\s*(?:cred|secret)\.[A-Z0-9_]+\s*\}\}$/i;
const SENSITIVE_BODY_KEY = /"(?:api_?key|apikey|token|access_token|secret|client_secret|password|senha|authorization)"\s*:\s*"([^"]*)"/gi;
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;

const LITERAL_HINT = "Use {{cred.NOME}} (cadastre em Configurações → Variáveis e credenciais).";

/** Detecta credencial em texto na URL, nos headers ou no body. Devolve a mensagem de erro ou null. */
export function findLiteralCredential(http: { url?: string; headers?: Record<string, string>; body?: string }): string | null {
  const url = http.url ?? "";
  const inline = findInlineSecrets(url);
  if (inline.length > 0) return `A URL tem um token em texto (${inline.join(", ")}=…). ${LITERAL_HINT}`;
  try {
    const parsed = new URL(url.replace(/\{\{[^}]*\}\}/g, "x"));
    if (parsed.username || parsed.password) return `A URL não pode ter usuário e senha. ${LITERAL_HINT}`;
  } catch {
    /* URL inválida é tratada por quem chama */
  }
  for (const [name, value] of Object.entries(http.headers ?? {})) {
    if (CREDENTIAL_HEADERS.test(name) && !MARKER_ONLY.test(value.trim())) {
      return `O header ${name} tem um valor em texto. ${LITERAL_HINT}`;
    }
  }
  for (const m of (http.body ?? "").matchAll(SENSITIVE_BODY_KEY)) {
    const value = m[1];
    // Marcador inteiro ou parâmetro {{param}} do modelo: ok. Valor fixo longo: credencial.
    if (value.length >= 8 && !/^\{\{[^}]+\}\}$/.test(value.trim())) {
      return `O body tem um valor fixo em um campo de credencial. ${LITERAL_HINT}`;
    }
  }
  return null;
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

function validateParameters(input: unknown): Result<AiAgentTool["parameters"]> {
  if (input === undefined || input === null) return { ok: true, value: { type: "object", properties: {}, required: [] } };
  if (typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "Parâmetros inválidos." };
  const raw = input as { type?: unknown; properties?: unknown; required?: unknown };
  if (raw.type !== undefined && raw.type !== "object") return { ok: false, error: "Os parâmetros devem ser do tipo object." };
  const props = raw.properties ?? {};
  if (typeof props !== "object" || props === null || Array.isArray(props)) return { ok: false, error: "Parâmetros inválidos." };
  const entries = Object.entries(props as Record<string, unknown>);
  if (entries.length > MAX_PARAMS) return { ok: false, error: `No máximo ${MAX_PARAMS} parâmetros.` };
  const properties: AiAgentTool["parameters"]["properties"] = {};
  for (const [key, val] of entries) {
    if (!PARAM_NAME_RE.test(key)) return { ok: false, error: `Nome de parâmetro inválido: "${key.slice(0, 40)}" (letras, números e _).` };
    const p = (val ?? {}) as { type?: unknown; description?: unknown; enum?: unknown };
    const type = typeof p.type === "string" ? p.type : "string";
    if (!(PARAM_TYPES as readonly string[]).includes(type)) return { ok: false, error: `Tipo de parâmetro inválido em "${key}".` };
    const description = typeof p.description === "string" ? p.description.slice(0, 500) : "";
    const param: { type: string; description: string; enum?: string[] } = { type, description };
    if (Array.isArray(p.enum) && p.enum.length > 0) {
      if (p.enum.length > 50 || p.enum.some((e) => typeof e !== "string" || e.length > 100)) {
        return { ok: false, error: `Valores permitidos inválidos em "${key}".` };
      }
      param.enum = p.enum as string[];
    }
    properties[key] = param;
  }
  const required = Array.isArray(raw.required) ? raw.required : [];
  if (required.some((r) => typeof r !== "string" || !(r in properties))) {
    return { ok: false, error: "Um parâmetro obrigatório não existe na lista de parâmetros." };
  }
  return { ok: true, value: { type: "object", properties, required: required as string[] } };
}

function validateHttp(input: unknown): Result<AiAgentTool["http"]> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, error: "Configuração HTTP inválida." };
  const raw = input as { url?: unknown; method?: unknown; headers?: unknown; body?: unknown };
  if (typeof raw.url !== "string" || raw.url.length > 2000) return { ok: false, error: "Informe a URL (até 2000 caracteres)." };
  const url = raw.url.trim();
  if (!/^https:\/\//i.test(url)) return { ok: false, error: "A URL precisa começar com https://." };
  const method = typeof raw.method === "string" ? raw.method.toUpperCase() : "GET";
  if (!(TOOL_METHODS as readonly string[]).includes(method)) return { ok: false, error: "Método HTTP inválido." };
  const headers: Record<string, string> = {};
  if (raw.headers !== undefined && raw.headers !== null) {
    if (typeof raw.headers !== "object" || Array.isArray(raw.headers)) return { ok: false, error: "Headers inválidos." };
    const hs = Object.entries(raw.headers as Record<string, unknown>);
    if (hs.length > MAX_HEADERS) return { ok: false, error: `No máximo ${MAX_HEADERS} headers.` };
    for (const [k, v] of hs) {
      if (!HEADER_NAME_RE.test(k) || typeof v !== "string" || v.length > 2000) return { ok: false, error: `Header inválido: "${k.slice(0, 40)}".` };
      headers[k] = v;
    }
  }
  let body: string | undefined;
  if (raw.body !== undefined && raw.body !== null && raw.body !== "") {
    if (typeof raw.body !== "string" || raw.body.length > 10_000) return { ok: false, error: "Body inválido (até 10.000 caracteres)." };
    if (["POST", "PUT", "PATCH"].includes(method)) body = raw.body;
  }
  const http: AiAgentTool["http"] = { url, method: method as AiAgentTool["http"]["method"] };
  if (Object.keys(headers).length > 0) http.headers = headers;
  if (body !== undefined) http.body = body;
  const literal = findLiteralCredential(http);
  if (literal) return { ok: false, error: literal };
  return { ok: true, value: http };
}

export interface ToolInput {
  name: string;
  display_name: string;
  description: string;
  parameters: AiAgentTool["parameters"];
  http: AiAgentTool["http"];
  timeout_ms: number;
  enabled: boolean;
}

/** Valida o corpo completo de uma ferramenta (criação ou substituição). */
export function validateToolInput(body: unknown): Result<ToolInput> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "Corpo da requisição inválido." };
  const b = body as Record<string, unknown>;
  if (typeof b.name !== "string" || !TOOL_NAME_RE.test(b.name)) {
    return { ok: false, error: "O nome da função deve ter letras minúsculas, números e _ (2–64 caracteres, começando por letra). Ex.: buscar_cpf." };
  }
  const displayName = typeof b.display_name === "string" && b.display_name.trim() ? b.display_name.trim() : b.name;
  if (displayName.length > 80) return { ok: false, error: "O nome de exibição pode ter no máximo 80 caracteres." };
  if (typeof b.description !== "string" || !b.description.trim()) return { ok: false, error: "Descreva quando o agente deve usar a ferramenta." };
  if (b.description.length > 1000) return { ok: false, error: "A descrição pode ter no máximo 1000 caracteres." };
  const parameters = validateParameters(b.parameters);
  if (!parameters.ok) return parameters;
  const http = validateHttp(b.http);
  if (!http.ok) return http;
  let timeout = DEFAULT_TOOL_TIMEOUT_MS;
  if (b.timeout_ms !== undefined && b.timeout_ms !== null) {
    if (typeof b.timeout_ms !== "number" || !Number.isInteger(b.timeout_ms) || b.timeout_ms < 1000 || b.timeout_ms > 60_000) {
      return { ok: false, error: "O tempo limite deve ficar entre 1.000 e 60.000 ms." };
    }
    timeout = b.timeout_ms;
  }
  if (b.enabled !== undefined && typeof b.enabled !== "boolean") return { ok: false, error: "O campo ligada/desligada é inválido." };
  return {
    ok: true,
    value: {
      name: b.name,
      display_name: displayName,
      description: b.description.trim(),
      parameters: parameters.value,
      http: http.value,
      timeout_ms: timeout,
      enabled: b.enabled !== false,
    },
  };
}

/** Marcadores {{cred.X}}/{{var.X}} da ferramenta que não existem na conta (aviso, não bloqueio). */
export function unknownSecretRefs(
  http: { url?: string; headers?: Record<string, string>; body?: string },
  known: { credentials: string[]; variables: string[] },
): string[] {
  const refs = findAccountSecretRefs([http.url, http.body, ...Object.values(http.headers ?? {})]);
  return [
    ...refs.creds.filter((n) => !known.credentials.includes(n)).map((n) => `{{cred.${n}}}`),
    ...refs.vars.filter((n) => !known.variables.includes(n)).map((n) => `{{var.${n}}}`),
  ];
}

/** Host do template (para a listagem); "" se não der para ler. */
export function toolHost(url: string): string {
  try {
    return new URL(url.replace(/\{\{[^}]*\}\}/g, "x")).hostname;
  } catch {
    return "";
  }
}
