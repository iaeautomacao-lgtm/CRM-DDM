// Validação e serialização das variáveis/credenciais da conta
// (/api/settings/secrets). Puro: sem banco.
//
// REGRA CENTRAL: o valor de uma credencial (nem em texto, nem cifrado) NUNCA
// sai do servidor — `toPublicSecret` é a única porta de saída das linhas.

export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
export const MAX_VARIABLE_LENGTH = 2000;
export const MAX_CREDENTIAL_LENGTH = 4000;
export const MAX_DESCRIPTION_LENGTH = 300;
export const MAX_HOSTS = 20;
/** last4 só é exibido quando o valor é longo o bastante para não se revelar (≥ 12 caracteres). */
export const LAST4_MIN_LENGTH = 12;

export type SecretKind = "variable" | "credential";

export interface SecretRow {
  id: string;
  account_id: string;
  name: string;
  kind: SecretKind;
  value_plain: string | null;
  value_encrypted: string | null;
  last4: string | null;
  allowed_hosts: string[] | null;
  description: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PublicSecret {
  id: string;
  name: string;
  kind: SecretKind;
  /** Só variáveis. Credenciais nunca trazem valor. */
  value?: string;
  /** Só credenciais: últimos 4 caracteres (quando seguro) — a tela mostra "••••1234". */
  last4?: string | null;
  allowed_hosts: string[];
  description: string | null;
  updated_at: string;
}

/** Única saída de uma linha para o cliente: credencial sem value_plain/value_encrypted. */
export function toPublicSecret(row: SecretRow): PublicSecret {
  const base = {
    id: row.id,
    name: row.name,
    kind: row.kind,
    allowed_hosts: row.allowed_hosts ?? [],
    description: row.description,
    updated_at: row.updated_at,
  };
  return row.kind === "variable"
    ? { ...base, value: row.value_plain ?? "" }
    : { ...base, last4: row.last4 };
}

export function last4Of(value: string): string | null {
  return value.length >= LAST4_MIN_LENGTH ? value.slice(-4) : null;
}

const HOST_RE = /^(?=.{3,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Normaliza hosts permitidos: aceita "api.exemplo.com", "https://api.exemplo.com/x",
 * ".exemplo.com", "*.exemplo.com" → sufixo de host em minúsculas, sem esquema,
 * caminho, porta ou curinga. Rejeita IPs, localhost e hosts sem ponto.
 */
export function normalizeAllowedHosts(input: unknown): { hosts: string[] } | { error: string } {
  if (!Array.isArray(input) || input.length === 0) {
    return { error: "Informe pelo menos um host permitido (ex.: api.exemplo.com)." };
  }
  if (input.length > MAX_HOSTS) return { error: `No máximo ${MAX_HOSTS} hosts permitidos.` };
  const hosts: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") return { error: "Host permitido inválido." };
    let h = raw.trim().toLowerCase();
    h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^\*\./, "").replace(/^\./, "");
    h = h.split(/[/?#]/)[0].replace(/:\d+$/, "");
    if (!HOST_RE.test(h) || /^\d+(\.\d+){3}$/.test(h)) {
      return { error: `Host permitido inválido: "${raw.slice(0, 80)}". Use um domínio como api.exemplo.com.` };
    }
    if (!hosts.includes(h)) hosts.push(h);
  }
  return { hosts };
}

export function validateSecretName(name: unknown): string | null {
  if (typeof name !== "string" || !SECRET_NAME_RE.test(name)) {
    return "O nome deve estar em MAIÚSCULAS_COM_SUBLINHADO (2–64 caracteres, começando por letra). Ex.: DDM_TOKEN.";
  }
  return null;
}

export function validateDescription(description: unknown): { value: string | null } | { error: string } {
  if (description === undefined || description === null || description === "") return { value: null };
  if (typeof description !== "string" || description.length > MAX_DESCRIPTION_LENGTH) {
    return { error: `A descrição pode ter no máximo ${MAX_DESCRIPTION_LENGTH} caracteres.` };
  }
  return { value: description.trim() || null };
}

export function validateVariableValue(value: unknown): { value: string } | { error: string } {
  if (typeof value !== "string" || value === "") return { error: "Informe o valor da variável." };
  if (value.length > MAX_VARIABLE_LENGTH) return { error: `O valor pode ter no máximo ${MAX_VARIABLE_LENGTH} caracteres.` };
  return { value };
}

/**
 * Vazio, ausente ou máscara ("••••1234", "****") = manter a credencial atual.
 * Nunca grava a máscara como se fosse o valor.
 */
export function isKeepCredential(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed === "" || /^[•*]/.test(trimmed);
}

export function validateCredentialValue(value: unknown): { value: string } | { error: string } {
  if (typeof value !== "string" || value.trim() === "") return { error: "Informe o valor da credencial." };
  const trimmed = value.trim();
  if (isKeepCredential(trimmed)) return { error: "Informe o valor real da credencial (a máscara não é um valor)." };
  if (trimmed.length > MAX_CREDENTIAL_LENGTH) return { error: `O valor pode ter no máximo ${MAX_CREDENTIAL_LENGTH} caracteres.` };
  return { value: trimmed };
}
