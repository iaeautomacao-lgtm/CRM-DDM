// Templates na API pública (bloco D da Onda 1): GET /templates e POST /whatsapp/send-template.
// Funções PURAS (parse de query, serialização, validação de variáveis e de componentes) + a resolução do canal Meta. Sem dado pessoal e sem segredo:
// o catálogo só traz texto de template (sample_values são exemplos da Meta, não dados de cliente).
import { ApiError, badRequest, unprocessable } from '@/lib/api/v1/respond';
import { decodeCursor, encodeCursor, parseLimit } from '@/lib/api/v1/extract';
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';
import { countBodyVariables, type LocalTemplateRow } from '@/lib/disparador/template-validation';

export const TEMPLATE_STATUSES = ['APPROVED', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED', 'IN_APPEAL', 'PENDING_DELETION', 'DRAFT'] as const;
export const DEFAULT_TEMPLATE_LANGUAGE = 'pt_BR';
export const MAX_TEMPLATE_VARIABLES = 30;
export const MAX_VARIABLE_CHARS = 1024;
export const WAHA_TEMPLATE_MESSAGE = 'Template é exclusivo de canal Meta; para WAHA use /whatsapp/send com texto';

const NAME_RE = /^[a-z0-9_]{1,512}$/;
const NAME_PREFIX_RE = /^[a-z0-9_]{1,100}$/;
const LANGUAGE_RE = /^[a-z]{2,3}(?:_[A-Za-z]{2,4})?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANNEL_NUMBER_RE = /^\+?[0-9][0-9 ()-]{5,24}$/;

export const TEMPLATE_SELECT =
  'id, name, language, category, status, waba_id, body_text, header_type, header_content, footer_text, buttons, sample_values, quality_score, updated_at';

export interface TemplateRow extends LocalTemplateRow {
  id: string;
  category: string | null;
  footer_text?: string | null;
  sample_values?: { body?: unknown; header?: unknown } | null;
  quality_score?: string | null;
  updated_at?: string | null;
}

export interface ChannelRef {
  id: string;
  label: string | null;
}

export type TemplateCategory = 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';

/** O banco guarda 'Marketing' | 'Utility' | 'Authentication' (e a Meta, em maiúsculas); a API sempre devolve maiúsculas. */
export function normalizeCategory(raw: string | null | undefined): TemplateCategory | null {
  const v = (raw ?? '').trim().toUpperCase();
  return v === 'MARKETING' || v === 'UTILITY' || v === 'AUTHENTICATION' ? v : null;
}

/** Por que o template não pode ser enviado por esta API (null = pode). Só o corpo do template é preenchido pelas variáveis. */
export function apiTemplateProblem(row: LocalTemplateRow): string | null {
  const status = (row.status ?? '').toUpperCase();
  if (status !== 'APPROVED') return `Template ainda não aprovado pela Meta (status ${status || 'desconhecido'}).`;
  const header = (row.header_type ?? '').toLowerCase();
  if (header === 'image' || header === 'video' || header === 'document') {
    return 'Tem cabeçalho de mídia (imagem, vídeo ou documento), que esta rota não preenche.';
  }
  if (header === 'text' && /\{\{\s*\d+\s*\}\}/.test(row.header_content ?? '')) return 'Tem variável no cabeçalho, que esta rota não preenche.';
  for (const button of row.buttons ?? []) {
    const type = String(button?.type ?? '').toUpperCase();
    if (type === 'URL' && /\{\{\s*\d+\s*\}\}/.test(button.url ?? '')) return 'Tem botão de link dinâmico, que esta rota não preenche.';
    if (type === 'COPY_CODE') return 'Tem botão de copiar código, que esta rota não preenche.';
    if (type === 'FLOW') return 'Tem botão de WhatsApp Flow, que esta rota não preenche.';
  }
  return null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function serializeTemplate(row: TemplateRow, channels: ChannelRef[]) {
  const problem = apiTemplateProblem(row);
  const buttons = Array.isArray(row.buttons) ? row.buttons : [];
  return {
    id: row.id,
    name: row.name,
    language: row.language ?? DEFAULT_TEMPLATE_LANGUAGE,
    category: normalizeCategory(row.category),
    status: (row.status ?? '').toUpperCase() || null,
    waba_id: row.waba_id ?? null,
    channels,
    placeholders: { body: countBodyVariables(row.body_text), examples: stringList(row.sample_values?.body) },
    body: row.body_text ?? '',
    header_type: row.header_type ? row.header_type.toLowerCase() : null,
    buttons: buttons.map((b) => String(b?.type ?? '').toUpperCase()).filter(Boolean),
    quality: row.quality_score ?? null,
    sendable_via_api: problem === null,
    unsupported_reason: problem,
    updated_at: row.updated_at ?? null,
  };
}

export interface TemplatesQuery {
  status: string | null; // null = todos
  language: string | null;
  namePrefix: string | null;
  channel: string | null;
  limit: number;
  cursor: [string, string] | null;
}

export function parseTemplatesQuery(params: URLSearchParams): TemplatesQuery {
  const rawStatus = (params.get('status') ?? 'APPROVED').trim();
  const lowered = rawStatus.toLowerCase();
  let status: string | null;
  if (lowered === 'all') status = null;
  else {
    status = rawStatus.toUpperCase();
    if (!(TEMPLATE_STATUSES as readonly string[]).includes(status)) {
      throw badRequest(`'status' inválido. Use ${TEMPLATE_STATUSES.join(', ')} ou all`);
    }
  }
  const language = params.get('language')?.trim() || null;
  if (language && !LANGUAGE_RE.test(language)) throw badRequest("'language' inválido (ex.: pt_BR)");
  const namePrefix = params.get('name')?.trim().toLowerCase() || null;
  if (namePrefix && !NAME_PREFIX_RE.test(namePrefix)) throw badRequest("'name' aceita só letras minúsculas, números e _ (prefixo do nome do template)");
  const channel = params.get('channel')?.trim() || null;
  if (channel && !UUID_RE.test(channel) && !CHANNEL_NUMBER_RE.test(channel)) throw badRequest("'channel' deve ser o id (UUID) ou o número do canal Meta");
  const cursor = decodeCursor(params.get('cursor'), 2);
  return { status, language, namePrefix, channel, limit: parseLimit(params.get('limit'), 50, 200), cursor: cursor ? [cursor[0], cursor[1]] : null };
}

export const templatesCursor = (row: { name: string; id: string }) => encodeCursor([row.name, row.id]);

export interface SendTemplateInput {
  phone: string;
  name: string | null;
  templateName: string;
  language: string;
  variables: string[];
  channel: string | null;
  salvarBd: boolean;
}

/** Valida o corpo do POST /whatsapp/send-template (tudo antes de qualquer chamada à Meta). */
export function parseSendTemplateBody(body: Record<string, unknown>): SendTemplateInput {
  const target = body.to ?? body.phone;
  if (typeof target !== 'string' || !target.trim()) throw badRequest("'to' (ou 'phone') é obrigatório");
  const template = body.template;
  if (!template || typeof template !== 'object' || Array.isArray(template)) throw badRequest("'template' é obrigatório: { name, language? }");
  const t = template as Record<string, unknown>;
  const templateName = typeof t.name === 'string' ? t.name.trim() : '';
  if (!NAME_RE.test(templateName)) throw badRequest("'template.name' é obrigatório (letras minúsculas, números e _)");
  const language = t.language === undefined || t.language === null || t.language === '' ? DEFAULT_TEMPLATE_LANGUAGE : t.language;
  if (typeof language !== 'string' || !LANGUAGE_RE.test(language)) throw badRequest("'template.language' inválido (ex.: pt_BR)");
  const raw = body.variables ?? [];
  if (!Array.isArray(raw)) throw badRequest("'variables' deve ser uma lista de textos");
  if (raw.length > MAX_TEMPLATE_VARIABLES) throw badRequest(`'variables' aceita no máximo ${MAX_TEMPLATE_VARIABLES} itens`);
  const variables = raw.map((v) => (typeof v === 'number' ? String(v) : v));
  if (!variables.every((v): v is string => typeof v === 'string')) throw badRequest("'variables' deve conter só textos");
  if (variables.some((v) => v.length > MAX_VARIABLE_CHARS)) throw badRequest(`Cada variável aceita no máximo ${MAX_VARIABLE_CHARS} caracteres`);
  if (variables.some((v) => v.trim() === '')) throw badRequest('Nenhuma variável pode ser vazia (a Meta recusa)');
  const channel = body.channel === undefined || body.channel === null || body.channel === '' ? null : body.channel;
  if (channel !== null && (typeof channel !== 'string' || (!UUID_RE.test(channel.trim()) && !CHANNEL_NUMBER_RE.test(channel.trim())))) {
    throw badRequest("'channel' deve ser o id (UUID) ou o número do canal Meta");
  }
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 200) : null;
  return { phone: target, name, templateName, language, variables, channel: channel === null ? null : (channel as string).trim(), salvarBd: body.salvar_bd !== false };
}

/** Nº de variáveis enviado × exigido pelo corpo do template. */
export function checkVariableCount(row: Pick<LocalTemplateRow, 'body_text' | 'name'>, variables: readonly string[]): void {
  const expected = countBodyVariables(row.body_text);
  if (variables.length !== expected) {
    throw badRequest(`O template '${row.name}' espera ${expected} variável(is) no corpo e a requisição trouxe ${variables.length}`);
  }
}

export interface ChannelConfig {
  id: string;
  user_id: string;
  provider: string;
  phone_number_id: string | null;
  access_token: string | null;
  waba_id: string | null;
  display_phone_number: string | null;
  waha_session?: string | null;
}

type Db = { from: (table: string) => any };

/**
 * Canal Meta do envio de template. `channel` = UUID ou número do canal Meta; omitido = o único canal Meta ativo da conta.
 * Canal WAHA (por UUID, sessão ou por ser o único canal) → 422: template é exclusivo de canal Meta.
 */
export async function resolveTemplateChannel(db: Db, accountId: string, channel: string | null): Promise<ChannelConfig> {
  const { data, error } = await db
    .from('whatsapp_config')
    .select('id, user_id, provider, phone_number_id, access_token, waba_id, display_phone_number, waha_session')
    .eq('account_id', accountId)
    .eq('habilitado', true)
    .in('provider', ['meta', 'waha']);
  if (error) throw new ApiError('unavailable', 'Não foi possível consultar os canais da conta; tente novamente', 503);
  const channels = (data ?? []) as ChannelConfig[];
  const meta = channels.filter((c) => c.provider === 'meta');

  let chosen: ChannelConfig | undefined;
  if (channel) {
    if (UUID_RE.test(channel)) chosen = channels.find((c) => c.id.toLowerCase() === channel.toLowerCase());
    else {
      const digits = sanitizePhoneForMeta(channel);
      chosen = meta.find((c) => c.display_phone_number && sanitizePhoneForMeta(c.display_phone_number) === digits);
    }
    if (!chosen) throw badRequest('Canal não encontrado ou desabilitado nesta conta');
  } else {
    if (channels.length === 0) throw badRequest('Nenhum canal habilitado encontrado nesta conta');
    if (meta.length === 0) throw unprocessable(WAHA_TEMPLATE_MESSAGE);
    if (meta.length > 1) throw badRequest("Conta com mais de um canal Meta habilitado — informe 'channel' (id ou número do canal)");
    chosen = meta[0];
  }
  if (chosen.provider !== 'meta') throw unprocessable(WAHA_TEMPLATE_MESSAGE);
  if (!chosen.phone_number_id || !chosen.access_token) throw unprocessable('O canal Meta não está totalmente configurado (falta o número ou o token)');
  return chosen;
}

export const isUuid = (v: string) => UUID_RE.test(v);
