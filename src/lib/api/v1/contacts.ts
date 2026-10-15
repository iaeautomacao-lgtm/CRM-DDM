// Contatos na API pública (bloco C da Onda 1): validação dos corpos, filtros da listagem e serialização. PURO (sem banco), para testar sem mocks.
// O CPF NUNCA sai em claro: só `cpf_masked` e `has_cpf` (mesma regra de serializeContact do painel). O banco chama o campo de
// `instituicao`; a API chama de `institution`.
import { badRequest } from '@/lib/api/v1/respond';
import { decodeCursor, encodeCursor, parseIso, parseLimit } from '@/lib/api/v1/extract';
import { AUTO_MANAGED_TAG_NAMES, NAME_MAX, parseCpf, parseEmail, parseName, parsePhone } from '@/lib/contacts/contact-api';
import { maskCpf } from '@/lib/privacy/mask';

export const CONTACT_TEXT_MAX = 200;
export const MAX_ALT_PHONES = 5;
export const MAX_TAGS_PER_CALL = 20;
export const TAG_NAME_MAX = 100;
export const MAX_CUSTOM_FIELDS_PER_CALL = 50;
export const CUSTOM_FIELD_NAME_MAX = 100;
export const CUSTOM_VALUE_MAX = 1000;
export const Q_MIN_CHARS = 3;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isContactId = (v: string) => UUID_RE.test(v);

export interface ContactWrite {
  phone?: string;
  /** undefined = não veio; null = veio vazio (no PATCH o nome nunca é limpo). */
  name?: string | null;
  email?: string | null;
  company?: string | null;
  institution?: string | null;
  cpf?: string | null;
  /** Telefones alternativos (só dígitos com DDI). */
  phones?: string[];
  tagsAdd?: string[];
  tagsRemove?: string[];
  /** nome → valor (null = apagar; só no PATCH). */
  customFields?: Record<string, string | null>;
}

const ALLOWED_UPSERT = ['phone', 'name', 'email', 'company', 'institution', 'cpf', 'phones', 'tags', 'custom_fields'] as const;
const ALLOWED_PATCH = ['phone', 'name', 'email', 'company', 'institution', 'cpf', 'phones', 'tags', 'custom_fields'] as const;

function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!r.ok) throw badRequest(r.error);
  return r.value;
}

function optionalText(raw: unknown, label: string): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') throw badRequest(`'${label}' deve ser um texto`);
  const v = raw.trim();
  if (v.length > CONTACT_TEXT_MAX) throw badRequest(`'${label}' aceita no máximo ${CONTACT_TEXT_MAX} caracteres`);
  return v === '' ? null : v;
}

export function parseTagNames(raw: unknown, label: string): string[] {
  if (!Array.isArray(raw)) throw badRequest(`'${label}' deve ser uma lista de nomes de etiqueta`);
  if (raw.length > MAX_TAGS_PER_CALL) throw badRequest(`'${label}' aceita no máximo ${MAX_TAGS_PER_CALL} etiquetas por chamada`);
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || item.trim() === '') throw badRequest(`'${label}' deve conter só nomes de etiqueta (texto não vazio)`);
    const name = item.trim();
    if (name.length > TAG_NAME_MAX) throw badRequest(`Nome de etiqueta acima de ${TAG_NAME_MAX} caracteres`);
    if (AUTO_MANAGED_TAG_NAMES.has(name)) throw badRequest(`A etiqueta '${name}' é gerenciada automaticamente pela conversa e não pode ser alterada pela API`);
    if (!out.some((n) => n.toLowerCase() === name.toLowerCase())) out.push(name);
  }
  return out;
}

function parseAltPhones(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw badRequest("'phones' deve ser uma lista de telefones (DDI + DDD + número)");
  if (raw.length > MAX_ALT_PHONES) throw badRequest(`'phones' aceita no máximo ${MAX_ALT_PHONES} telefones alternativos`);
  const out: string[] = [];
  for (const item of raw) {
    const phone = unwrap(parsePhone(item));
    if (!out.includes(phone)) out.push(phone);
  }
  return out;
}

/** Valor de campo personalizado: texto/número/boolean viram texto; null ou vazio = sem valor. */
export function parseCustomValue(raw: unknown, field: string): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'boolean' || typeof raw === 'number') return String(raw);
  if (typeof raw !== 'string') throw badRequest(`O valor de '${field}' deve ser texto, número ou booleano`);
  const v = raw.trim();
  if (v.length > CUSTOM_VALUE_MAX) throw badRequest(`O valor de '${field}' aceita no máximo ${CUSTOM_VALUE_MAX} caracteres`);
  return v === '' ? null : v;
}

function parseCustomFields(raw: unknown): Record<string, string | null> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw badRequest("'custom_fields' deve ser um objeto { nome_do_campo: valor }");
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_CUSTOM_FIELDS_PER_CALL) throw badRequest(`'custom_fields' aceita no máximo ${MAX_CUSTOM_FIELDS_PER_CALL} campos por chamada`);
  const out: Record<string, string | null> = {};
  for (const [key, value] of entries) {
    const name = key.trim();
    if (!name || name.length > CUSTOM_FIELD_NAME_MAX) throw badRequest(`Nome de campo personalizado inválido (1 a ${CUSTOM_FIELD_NAME_MAX} caracteres)`);
    out[name] = parseCustomValue(value, name);
  }
  return out;
}

/** Valida o corpo do POST (upsert, `phone` obrigatório) ou do PATCH. Campo desconhecido = 400 (evita erro de digitação silencioso). */
export function parseContactWrite(body: Record<string, unknown>, mode: 'upsert' | 'patch'): ContactWrite {
  const allowed: readonly string[] = mode === 'upsert' ? ALLOWED_UPSERT : ALLOWED_PATCH;
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) throw badRequest(`Campo(s) desconhecido(s): ${unknown.join(', ')}. Aceitos: ${allowed.join(', ')}`);

  const out: ContactWrite = {};
  if (mode === 'upsert' || body.phone !== undefined) {
    if (body.phone === undefined || body.phone === null || body.phone === '') throw badRequest("'phone' é obrigatório");
    out.phone = unwrap(parsePhone(body.phone));
  }
  if ('name' in body) out.name = unwrap(parseName(body.name));
  if ('email' in body) out.email = unwrap(parseEmail(body.email));
  if ('company' in body) out.company = optionalText(body.company, 'company');
  if ('institution' in body) out.institution = optionalText(body.institution, 'institution');
  if ('cpf' in body) out.cpf = unwrap(parseCpf(body.cpf));
  if ('phones' in body) out.phones = parseAltPhones(body.phones);
  if ('tags' in body) {
    if (mode === 'upsert') out.tagsAdd = parseTagNames(body.tags, 'tags');
    else {
      const t = body.tags;
      if (!t || typeof t !== 'object' || Array.isArray(t)) throw badRequest("'tags' deve ser { add: [...], remove: [...] }");
      const obj = t as Record<string, unknown>;
      const extra = Object.keys(obj).filter((k) => k !== 'add' && k !== 'remove');
      if (extra.length > 0) throw badRequest("'tags' aceita só 'add' e 'remove'");
      if ('add' in obj) out.tagsAdd = parseTagNames(obj.add, 'tags.add');
      if ('remove' in obj) out.tagsRemove = parseTagNames(obj.remove, 'tags.remove');
    }
  }
  if ('custom_fields' in body) out.customFields = parseCustomFields(body.custom_fields);
  if (mode === 'patch' && Object.keys(out).length === 0) throw badRequest('Envie ao menos um campo para alterar');
  return out;
}

/** Nome que na verdade é um telefone (ou o nome padrão de lead da API): conta como "vazio" no upsert. */
export function looksLikePlaceholderName(name: string | null | undefined): boolean {
  const v = (name ?? '').trim();
  if (v === '') return true;
  if (v.toLowerCase() === 'api lead') return true;
  return /^[+\d\s().-]+$/.test(v) && v.replace(/\D/g, '').length >= 8;
}

export const isBlank = (v: string | null | undefined): boolean => (v ?? '').trim() === '';

// ── Listagem ─────────────────────────────────────────────────────────────────

export interface ContactsQuery {
  phone: string | null;
  cpf: string | null;
  email: string | null;
  q: string | null;
  tag: string | null;
  updatedFrom: string | null;
  updatedTo: string | null;
  limit: number;
  cursor: [string, string] | null;
}

export const CONTACTS_DEFAULT_LIMIT = 50;
export const CONTACTS_MAX_LIMIT = 200;

export function parseContactsQuery(params: URLSearchParams): ContactsQuery {
  const get = (k: string) => params.get(k)?.trim() || null;
  const phoneRaw = get('phone');
  const phone = phoneRaw ? unwrap(parsePhone(phoneRaw)) : null;
  const cpfRaw = get('cpf');
  const cpf = cpfRaw ? unwrap(parseCpf(cpfRaw)) : null;
  const emailRaw = get('email');
  const email = emailRaw ? unwrap(parseEmail(emailRaw)) : null;
  const q = get('q');
  if (q && q.replace(/\s/g, '').length < Q_MIN_CHARS) throw badRequest(`'q' precisa de ao menos ${Q_MIN_CHARS} letras`);
  if (q && q.length > NAME_MAX) throw badRequest("'q' muito longo");
  const tag = get('tag');
  if (tag && tag.length > TAG_NAME_MAX) throw badRequest("'tag' muito longo");
  const updatedFrom = parseIso(params.get('updated_from'), 'updated_from');
  const updatedTo = parseIso(params.get('updated_to'), 'updated_to');
  if (!phone && !cpf && !email && !q && !tag && !updatedFrom && !updatedTo) {
    throw badRequest('Informe ao menos um filtro: phone, cpf, email, q, tag, updated_from ou updated_to');
  }
  const cursor = decodeCursor(params.get('cursor'), 2);
  return {
    phone, cpf, email, q, tag, updatedFrom, updatedTo,
    limit: parseLimit(params.get('limit'), CONTACTS_DEFAULT_LIMIT, CONTACTS_MAX_LIMIT),
    cursor: cursor ? [cursor[0], cursor[1]] : null,
  };
}

/** Escapa curingas do LIKE para um prefixo/igualdade literal. */
export const likeEscape = (v: string) => v.replace(/[\\%_]/g, (c) => `\\${c}`);

export const contactsCursor = (row: { updated_at: string | null; id: string }) => encodeCursor([row.updated_at ?? '', row.id]);

// ── Serialização ─────────────────────────────────────────────────────────────

export interface ContactDbRow {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  company: string | null;
  instituicao: string | null;
  cpf: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export const CONTACT_SELECT = 'id, phone, name, email, company, instituicao, cpf, created_at, updated_at';

export interface ContactExtras {
  phones: Array<{ phone: string; status: string | null; label: string | null }>;
  tags: string[];
  customFields: Record<string, string>;
}

export function serializeApiContact(row: ContactDbRow, extras: ContactExtras) {
  const digits = (row.cpf ?? '').replace(/\D/g, '');
  return {
    id: row.id,
    phone: row.phone,
    phones: extras.phones,
    name: row.name,
    email: row.email,
    company: row.company,
    institution: row.instituicao,
    cpf_masked: digits ? maskCpf(digits) : null,
    has_cpf: digits !== '',
    tags: extras.tags,
    custom_fields: extras.customFields,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export const EMPTY_EXTRAS: ContactExtras = { phones: [], tags: [], customFields: {} };
