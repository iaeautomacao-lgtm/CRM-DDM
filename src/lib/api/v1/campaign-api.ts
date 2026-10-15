// API pública v1 — leitura de campanhas (lista, detalhe enriquecido e status por destinatário). Desenho: prd-v2/api-onda1-desenho.md.
// A parte pura (filtros, mapa de status, serialização) não faz I/O; os loaders recebem o cliente do banco. Nunca devolve CPF,
// texto final da mensagem (em campanha de IA é o prompt) nem erro técnico cru.
import type { SupabaseClient } from '@supabase/supabase-js';
import { badRequest } from '@/lib/api/v1/respond';
import { decodeCursor, encodeCursor, parseIso } from '@/lib/api/v1/extract';
import { classificarTipoErro } from '@/lib/disparador/normalize-meta-error';
import { loadChannelIdentities } from '@/lib/disparador/channel-label';
import { phoneKey } from '@/lib/disparador/phone-key';
import { loadCampaignFunnel, loadItemResults, type FunnelView, type ItemResult } from '@/lib/utmpay/stats';

import {
  CAMPAIGN_SOURCES,
  CAMPAIGN_STATUSES,
  RECIPIENT_STATUSES,
  type CampaignStatus,
  type RecipientStatus,
} from '@/lib/api/v1/campaign-api-constants';
export * from '@/lib/api/v1/campaign-api-constants';

type Db = Pick<SupabaseClient, 'from' | 'rpc'>;

// ── Status por destinatário ────────────────────────────────────────────────


/** Status da fila (disp_message_queue.status) → enum da API (estado ATUAL do destinatário, não cumulativo). */
const QUEUE_TO_API: Record<string, RecipientStatus> = {
  agendado: 'queued',
  pendente: 'queued',
  pausado: 'paused',
  enviando: 'sending',
  enviado: 'sent',
  entregue: 'delivered',
  lido: 'read',
  erro: 'error',
  bloqueado: 'blocked',
  cancelado: 'cancelled',
};

/** Enum da API → status reais da fila (para o filtro `status`). */
export const API_TO_QUEUE: Record<RecipientStatus, string[]> = {
  queued: ['agendado', 'pendente'],
  paused: ['pausado'],
  sending: ['enviando'],
  sent: ['enviado'],
  delivered: ['entregue'],
  read: ['lido'],
  error: ['erro'],
  blocked: ['bloqueado'],
  cancelled: ['cancelado'],
  removed: ['cancelado'],
};

/** Prefixo de cancel_reason gravado por remove_campaign_recipients (migration 357). */
export const REMOVED_REASON_PREFIX = 'removed_api:';

export function recipientStatusOf(queueStatus: string, cancelReason?: string | null): RecipientStatus {
  if (queueStatus === 'cancelado' && cancelReason?.startsWith(REMOVED_REASON_PREFIX)) return 'removed';
  return QUEUE_TO_API[queueStatus] ?? 'queued';
}

// ── Filtros ────────────────────────────────────────────────────────────────

export interface CampaignListFilters {
  statuses: CampaignStatus[];
  source: (typeof CAMPAIGN_SOURCES)[number] | null;
  createdFrom: string | null;
  createdTo: string | null;
  externalId: string | null;
}

export function parseCampaignListFilters(p: URLSearchParams): CampaignListFilters {
  const rawStatus = p.get('status');
  const statuses: CampaignStatus[] = [];
  if (rawStatus) {
    for (const part of rawStatus.split(',').map((s) => s.trim()).filter(Boolean)) {
      if (!(CAMPAIGN_STATUSES as readonly string[]).includes(part)) {
        throw badRequest(`'status' inválido: ${part}. Use: ${CAMPAIGN_STATUSES.join(', ')}`);
      }
      if (!statuses.includes(part as CampaignStatus)) statuses.push(part as CampaignStatus);
    }
  }
  const source = p.get('source');
  if (source && !(CAMPAIGN_SOURCES as readonly string[]).includes(source)) {
    throw badRequest(`'source' inválido. Use: ${CAMPAIGN_SOURCES.join(', ')}`);
  }
  const externalId = p.get('external_id')?.trim() || null;
  if (externalId && externalId.length > 128) throw badRequest("'external_id' pode ter no máximo 128 caracteres");
  const createdFrom = parseIso(p.get('created_from'), 'created_from');
  const createdTo = parseIso(p.get('created_to'), 'created_to');
  if (createdFrom && createdTo && createdFrom >= createdTo) throw badRequest("'created_from' deve ser anterior a 'created_to'");
  return { statuses, source: (source as CampaignListFilters['source']) || null, createdFrom, createdTo, externalId };
}

export interface RecipientFilters {
  statuses: RecipientStatus[];
  replied: boolean;
  clicked: boolean;
  closed: boolean;
  paid: boolean;
  phone: string | null;
}

const TRUE_VALUES = new Set(['true', '1']);

function parseBool(p: URLSearchParams, name: string): boolean {
  const raw = p.get(name);
  if (raw === null || raw === '') return false;
  if (TRUE_VALUES.has(raw)) return true;
  if (raw === 'false' || raw === '0') return false;
  throw badRequest(`'${name}' deve ser true ou false`);
}

export function parseRecipientFilters(p: URLSearchParams): RecipientFilters {
  const statuses: RecipientStatus[] = [];
  const rawStatus = p.get('status');
  if (rawStatus) {
    for (const part of rawStatus.split(',').map((s) => s.trim()).filter(Boolean)) {
      if (!(RECIPIENT_STATUSES as readonly string[]).includes(part)) {
        throw badRequest(`'status' inválido: ${part}. Use: ${RECIPIENT_STATUSES.join(', ')}`);
      }
      if (!statuses.includes(part as RecipientStatus)) statuses.push(part as RecipientStatus);
    }
  }
  const rawPhone = p.get('phone');
  const phone = rawPhone ? rawPhone.replace(/\D/g, '') : null;
  if (rawPhone && (!phone || phone.length < 8 || phone.length > 15)) throw badRequest("'phone' inválido (use DDI + DDD + número)");
  return {
    statuses,
    replied: parseBool(p, 'replied'),
    clicked: parseBool(p, 'clicked'),
    closed: parseBool(p, 'closed'),
    paid: parseBool(p, 'paid'),
    phone,
  };
}

export const hasFunnelFilter = (f: RecipientFilters) => f.clicked || f.closed || f.paid;

// ── Lista de campanhas ─────────────────────────────────────────────────────

export interface ApiCampaignSummary {
  campaign_id: string;
  name: string;
  status: string;
  source: string;
  external_id: string | null;
  created_at: string;
  window: { start: string | null; end: string | null };
  provider: 'meta' | 'waha' | null;
  message_type: 'text' | 'image' | 'template' | null;
  metrics: { total_contacts: number; sent: number; delivered: number; read: number; errors: number; pending: number };
  paused_reason: string | null;
}

interface CampaignListRow {
  id: string;
  nome: string;
  status: string;
  source: string | null;
  idempotency_key: string | null;
  created_at: string;
  janela_inicio: string | null;
  janela_fim: string | null;
  session_ids: string[] | null;
  mensagens: Array<{ tipo?: string; template_name?: string }> | null;
  pausa_automatica_motivo: string | null;
  pause_reason?: string | null;
}

export const CAMPAIGN_LIST_COLUMNS_BASE =
  'id, nome, status, source, idempotency_key, created_at, janela_inicio, janela_fim, session_ids, mensagens, pausa_automatica_motivo';
/** Com pause_reason (migration 357). */
export const CAMPAIGN_LIST_COLUMNS = `${CAMPAIGN_LIST_COLUMNS_BASE}, pause_reason`;

const isMissingColumn = (e: { code?: string; message?: string } | null | undefined) =>
  !!e && (e.code === '42703' || /column .* does not exist|schema cache/i.test(e.message ?? ''));

/** Tipo de mensagem da campanha a partir do 1º item de `mensagens` (template Meta, imagem ou texto). */
export function messageTypeOf(mensagens: CampaignListRow['mensagens']): ApiCampaignSummary['message_type'] {
  const first = Array.isArray(mensagens) ? mensagens[0] : null;
  if (!first) return null;
  if (first.template_name) return 'template';
  return first.tipo === 'imagem' ? 'image' : 'text';
}

export interface QueueCounts {
  agendado: number;
  pendente: number;
  pausado: number;
  enviando: number;
  entregue: number;
  lido: number;
  erro: number;
  bloqueado: number;
  cancelado: number;
}

export function emptyQueueCounts(): QueueCounts {
  return { agendado: 0, pendente: 0, pausado: 0, enviando: 0, entregue: 0, lido: 0, erro: 0, bloqueado: 0, cancelado: 0 };
}

export function foldQueueStats(rows: Array<{ campaign_id?: string; status: string; qty: number | string }> | null): QueueCounts {
  const out = emptyQueueCounts();
  for (const row of rows ?? []) {
    if (row.status in out) out[row.status as keyof QueueCounts] += Number(row.qty);
  }
  return out;
}

type MetricsRow = { campaign_id: string; total_contatos: number | null; total_enviados: number | null; total_entregues: number | null; total_lidos: number | null; total_erros: number | null };

export function toMetrics(m: Partial<MetricsRow> | null | undefined, pending: number): ApiCampaignSummary['metrics'] {
  return {
    total_contacts: m?.total_contatos ?? 0,
    sent: m?.total_enviados ?? 0,
    delivered: m?.total_entregues ?? 0,
    read: m?.total_lidos ?? 0,
    errors: m?.total_erros ?? 0,
    pending,
  };
}

async function queryCampaignPage(db: Db, accountId: string, f: CampaignListFilters, cursor: string[] | null, limit: number, columns: string) {
  let q = db.from('campaigns').select(columns).eq('account_id', accountId);
  if (f.statuses.length > 0) q = q.in('status', f.statuses);
  if (f.source) q = q.eq('source', f.source);
  if (f.externalId) q = q.eq('idempotency_key', f.externalId);
  if (f.createdFrom) q = q.gte('created_at', f.createdFrom);
  if (f.createdTo) q = q.lt('created_at', f.createdTo);
  if (cursor) {
    const [at, id] = cursor;
    q = q.or(`created_at.lt."${at}",and(created_at.eq."${at}",id.lt."${id}")`);
  }
  return q.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit + 1);
}

export async function loadCampaignPage(
  db: Db,
  opts: { accountId: string; filters: CampaignListFilters; cursor: string[] | null; limit: number },
): Promise<{ items: ApiCampaignSummary[]; next_cursor: string | null }> {
  const { accountId, filters: f, limit } = opts;
  let res = await queryCampaignPage(db, accountId, f, opts.cursor, limit, CAMPAIGN_LIST_COLUMNS);
  // Sem a coluna pause_reason (migration 357 ainda não aplicada): lê sem ela.
  if (isMissingColumn(res.error)) res = await queryCampaignPage(db, accountId, f, opts.cursor, limit, CAMPAIGN_LIST_COLUMNS_BASE);
  const { data, error } = res;
  if (error) throw error;
  const all = (data ?? []) as unknown as CampaignListRow[];
  const rows = all.slice(0, limit);
  if (rows.length === 0) return { items: [], next_cursor: null };

  const ids = rows.map((r) => r.id);
  const [metricsRes, statsRes, channelRows] = await Promise.all([
    db.from('campaign_metrics_live').select('campaign_id, total_contatos, total_enviados, total_entregues, total_lidos, total_erros').in('campaign_id', ids),
    db.rpc('get_campaign_stats', { p_campaign_ids: ids }),
    loadProviders(db, accountId, rows),
  ]);
  if (metricsRes.error) throw metricsRes.error;
  if (statsRes.error) throw statsRes.error;
  const metrics = new Map(((metricsRes.data ?? []) as MetricsRow[]).map((m) => [m.campaign_id, m]));
  const statsByCampaign = new Map<string, Array<{ status: string; qty: number | string }>>();
  for (const s of (statsRes.data ?? []) as Array<{ campaign_id: string; status: string; qty: number | string }>) {
    const list = statsByCampaign.get(s.campaign_id) ?? [];
    list.push(s);
    statsByCampaign.set(s.campaign_id, list);
  }

  const items: ApiCampaignSummary[] = rows.map((r) => ({
    campaign_id: r.id,
    name: r.nome,
    status: r.status,
    source: r.source ?? 'dashboard',
    external_id: r.idempotency_key,
    created_at: new Date(r.created_at).toISOString(),
    window: { start: r.janela_inicio, end: r.janela_fim },
    provider: channelRows.get(r.session_ids?.[0] ?? '') ?? null,
    message_type: messageTypeOf(r.mensagens),
    metrics: toMetrics(metrics.get(r.id), foldQueueStats(statsByCampaign.get(r.id) ?? []).agendado),
    paused_reason: r.status === 'pausada' ? (r.pause_reason ?? r.pausa_automatica_motivo) : null,
  }));
  const last = rows[rows.length - 1];
  return { items, next_cursor: all.length > limit ? encodeCursor([new Date(last.created_at).toISOString(), last.id]) : null };
}

/** provider (meta|waha) de cada canal usado pelas campanhas da página — uma consulta só. */
async function loadProviders(db: Db, accountId: string, rows: CampaignListRow[]): Promise<Map<string, 'meta' | 'waha'>> {
  const ids = [...new Set(rows.map((r) => r.session_ids?.[0]).filter((id): id is string => !!id))];
  const out = new Map<string, 'meta' | 'waha'>();
  if (ids.length === 0) return out;
  const { data, error } = await db.from('whatsapp_config').select('id, provider').eq('account_id', accountId).in('id', ids);
  if (error) return out; // o provider é informativo: falha de leitura não derruba a lista
  for (const c of (data ?? []) as Array<{ id: string; provider: string | null }>) {
    if (c.provider === 'meta' || c.provider === 'waha') out.set(c.id, c.provider);
  }
  return out;
}

// ── Detalhe enriquecido ────────────────────────────────────────────────────

export interface ApiCampaignFunnel {
  links: number;
  clicked: number;
  closed: number;
  paid: number;
  rates: { clicked: number | null; closed: number | null; paid: number | null };
  by_attribution: { closed: { direct: number; ai: number; human: number }; paid: { direct: number; ai: number; human: number } };
}

/** FunnelView (português) → contrato da API (inglês). Sem UTMpay ativo/disponível ⇒ null (campo omitido). */
export function toApiFunnel(v: FunnelView): ApiCampaignFunnel | null {
  if (!v.available || !v.tracking) return null;
  const a = (x: { direto: number; ia: number; humano: number }) => ({ direct: x.direto, ai: x.ia, human: x.humano });
  return {
    links: v.links,
    clicked: v.clicou,
    closed: v.fechou,
    paid: v.pagou,
    rates: { clicked: v.taxas.clicou, closed: v.taxas.fechou, paid: v.taxas.pagou },
    by_attribution: { closed: a(v.por_atribuicao.fechou), paid: a(v.por_atribuicao.pagou) },
  };
}

export interface CampaignDetailExtras {
  source: string;
  external_id: string | null;
  provider: 'meta' | 'waha' | null;
  message_type: ApiCampaignSummary['message_type'];
  channel: { id: string; label: string; waha_session?: string } | null;
  template: { name: string; language: string | null } | null;
  started_at: string | null;
  callback_configured: boolean;
  pause: { automatic: boolean; reason: string | null; template: { name: string; language: string | null } | null } | null;
  /** Só com a campanha encerrada: concluída ou cancelada (e por quem). */
  ended_reason: 'completed' | 'cancelled' | 'cancelled_api' | null;
  replied: number;
  funnel: ApiCampaignFunnel | null;
}

/** Completo: pausa por template (336) + motivo da pausa, encerramento e ritmo (357). */
export const CAMPAIGN_DETAIL_COLUMNS =
  'id, nome, status, created_at, janela_inicio, janela_fim, source, idempotency_key, session_ids, mensagens, agendamento, callback_url, pausa_automatica_motivo, pausa_template_nome, pausa_template_idioma, pause_reason, encerramento_motivo';
/** Sem as colunas da 357 (mas com as da 336). */
export const CAMPAIGN_DETAIL_COLUMNS_336 =
  'id, nome, status, created_at, janela_inicio, janela_fim, source, idempotency_key, session_ids, mensagens, agendamento, callback_url, pausa_automatica_motivo, pausa_template_nome, pausa_template_idioma';

/** Sem as colunas de pausa por template (migration 336). */
export const CAMPAIGN_DETAIL_COLUMNS_BASE =
  'id, nome, status, created_at, janela_inicio, janela_fim, source, idempotency_key, session_ids, mensagens, agendamento, callback_url, pausa_automatica_motivo';

export interface CampaignDetailRow {
  id: string;
  nome: string;
  status: string;
  created_at: string;
  janela_inicio: string | null;
  janela_fim: string | null;
  source: string | null;
  idempotency_key: string | null;
  session_ids: string[] | null;
  mensagens: Array<{ tipo?: string; template_name?: string; template_language?: string | null }> | null;
  agendamento: string | null;
  callback_url: string | null;
  pausa_automatica_motivo: string | null;
  pausa_template_nome?: string | null;
  pausa_template_idioma?: string | null;
  pause_reason?: string | null;
  encerramento_motivo?: string | null;
}

/** Motivo do encerramento: o gravado (357); sem ele, encerrada com itens cancelados = cancelada, senão concluída. */
export function endedReasonOf(c: Pick<CampaignDetailRow, 'status' | 'encerramento_motivo'>, cancelledItems: number): CampaignDetailExtras['ended_reason'] {
  if (c.status !== 'encerrada') return null;
  if (c.encerramento_motivo === 'cancelled' || c.encerramento_motivo === 'cancelled_api') return c.encerramento_motivo;
  return cancelledItems > 0 ? 'cancelled' : 'completed';
}

export async function loadCampaignDetailExtras(db: Db, accountId: string, c: CampaignDetailRow, delivered: number, cancelledItems = 0): Promise<CampaignDetailExtras> {
  const sessionId = c.session_ids?.[0] ?? null;
  const [channels, repliedRes, funnel] = await Promise.all([
    sessionId ? loadChannelIdentities(db as never, accountId, { sessionId }).catch(() => []) : Promise.resolve([]),
    db.from('disp_message_queue').select('id', { count: 'exact', head: true }).eq('campaign_id', c.id).not('replied_at', 'is', null),
    loadCampaignFunnel(db, accountId, c.id, delivered).catch(() => null),
  ]);
  const channel = channels[0] ?? null;
  const first = Array.isArray(c.mensagens) ? c.mensagens[0] : null;
  const wahaSession = channel?.provider === 'waha' ? await wahaSessionOf(db, accountId, channel.id) : null;
  return {
    source: c.source ?? 'dashboard',
    external_id: c.idempotency_key,
    provider: channel && channel.provider !== 'unknown' ? channel.provider : null,
    message_type: messageTypeOf(c.mensagens),
    channel: channel ? { id: channel.id, label: channel.label, ...(wahaSession ? { waha_session: wahaSession } : {}) } : null,
    template: first?.template_name ? { name: first.template_name, language: first.template_language ?? null } : null,
    started_at: c.agendamento ? new Date(c.agendamento).toISOString() : null,
    callback_configured: !!c.callback_url,
    pause:
      c.status === 'pausada'
        ? {
            automatic: !!c.pausa_automatica_motivo && !c.pause_reason,
            reason: c.pausa_automatica_motivo ?? c.pause_reason ?? null,
            template: c.pausa_template_nome ? { name: c.pausa_template_nome, language: c.pausa_template_idioma ?? null } : null,
          }
        : null,
    ended_reason: endedReasonOf(c, cancelledItems),
    replied: repliedRes.error ? 0 : (repliedRes.count ?? 0),
    funnel: funnel ? toApiFunnel(funnel) : null,
  };
}

async function wahaSessionOf(db: Db, accountId: string, channelId: string): Promise<string | null> {
  const { data } = await db.from('whatsapp_config').select('waha_session').eq('account_id', accountId).eq('id', channelId).limit(1);
  const row = (data?.[0] ?? null) as { waha_session: string | null } | null;
  return row?.waha_session ?? null;
}

// ── Destinatários ──────────────────────────────────────────────────────────

export interface RecipientRow {
  cancel_reason?: string | null;
  reference?: string | null;
  id: string;
  contact_id: string | null;
  mensagem_final: string | null;
  erro: string | null;
  erro_codigo?: number | null;
  status: string;
  scheduled_at: string | null;
  sent_at: string | null;
  replied_at: string | null;
  contacts: { name: string | null; phone: string | null } | null;
}

export const RECIPIENT_COLUMNS_BASE =
  'id, contact_id, mensagem_final, erro, erro_codigo, status, scheduled_at, sent_at, replied_at, contacts!contact_id(name, phone)';
/** Com cancel_reason e reference (migration 357). */
export const RECIPIENT_COLUMNS = `${RECIPIENT_COLUMNS_BASE}, cancel_reason, reference`;

export interface ApiRecipient {
  recipient_id: string;
  phone: string | null;
  contact_id: string | null;
  name: string | null;
  /** Texto opaco que o integrador mandou no create (migration 357); nulo se não houve. */
  reference: string | null;
  status: RecipientStatus;
  status_raw: string;
  scheduled_at: string | null;
  sent_at: string | null;
  replied_at: string | null;
  error: { code: number | null; type: string } | null;
  conversation_id: string | null;
  funnel: {
    clicked: boolean;
    closed: boolean;
    paid: boolean;
    clicked_at: string | null;
    closed_at: string | null;
    paid_at: string | null;
    attribution: 'direct' | 'ai' | 'human' | null;
    attendant_id: string | null;
  } | null;
}

const ATTRIBUTION_EN = { direto: 'direct', ia: 'ai', humano: 'human' } as const;

/** Telefone do item: contato do CRM → contacts.phone; contato externo (API) → o número fica em mensagem_final. */
export function recipientPhone(row: Pick<RecipientRow, 'contact_id' | 'contacts' | 'mensagem_final'>): string | null {
  if (row.contact_id) return row.contacts?.phone ?? null;
  const digits = (row.mensagem_final ?? '').replace(/\D/g, '');
  return digits.length >= 8 ? digits : null;
}

export function toApiRecipient(
  row: RecipientRow,
  extra: { conversationId?: string | null; result?: ItemResult },
): ApiRecipient {
  const r = extra.result;
  return {
    recipient_id: row.id,
    phone: recipientPhone(row),
    contact_id: row.contact_id,
    name: row.contacts?.name ?? null,
    reference: row.reference ?? null,
    status: recipientStatusOf(row.status, row.cancel_reason),
    status_raw: row.status,
    scheduled_at: row.scheduled_at ? new Date(row.scheduled_at).toISOString() : null,
    sent_at: row.sent_at ? new Date(row.sent_at).toISOString() : null,
    replied_at: row.replied_at ? new Date(row.replied_at).toISOString() : null,
    error: row.status === 'erro' ? { code: row.erro_codigo ?? null, type: classificarTipoErro(row.erro) } : null,
    conversation_id: extra.conversationId ?? null,
    funnel: r
      ? {
          clicked: r.clicou,
          closed: r.fechou,
          paid: r.pagou,
          clicked_at: r.rastreio.clicou_em,
          closed_at: r.rastreio.fechou_em,
          paid_at: r.rastreio.pagou_em,
          attribution: r.rastreio.atribuicao ? ATTRIBUTION_EN[r.rastreio.atribuicao] : null,
          attendant_id: r.rastreio.atendente_id,
        }
      : null,
  };
}

/** Cursor da lista de destinatários: [scheduled_at, id] (fila) ou ['f', created_at, tid] (modo funil, dirigido por utmpay_links). */
export function decodeRecipientCursor(raw: string | null, funnelMode: boolean): string[] | null {
  if (raw === null || raw === '') return null;
  const parts = decodeCursorAny(raw);
  if (funnelMode) {
    if (parts.length !== 3 || parts[0] !== 'f') throw badRequest("'cursor' não corresponde aos filtros desta consulta");
  } else if (parts.length !== 2) {
    throw badRequest("'cursor' não corresponde aos filtros desta consulta");
  }
  return parts;
}

function decodeCursorAny(raw: string): string[] {
  for (const arity of [2, 3]) {
    try {
      const v = decodeCursor(raw, arity);
      if (v) return v;
    } catch {
      /* tenta a outra aridade */
    }
  }
  throw badRequest("'cursor' inválido");
}

/**
 * Filtro de status da fila a partir dos status da API. `removed` e `cancelled` compartilham o status `cancelado` e se separam por
 * cancel_reason (migration 357); sem a coluna (`extended` falso) `removed` não existe e `cancelled` é todo `cancelado`.
 */
function applyStatusFilter<Q extends { in: (c: string, v: string[]) => Q; like: (c: string, v: string) => Q; or: (f: string) => Q }>(
  q: Q,
  statuses: readonly RecipientStatus[],
  extended: boolean,
): Q {
  if (statuses.length === 0) return q;
  const raw = [...new Set(statuses.flatMap((s) => API_TO_QUEUE[s]))];
  let out = q.in('status', raw);
  if (!extended) return out;
  const wantsRemoved = statuses.includes('removed');
  const wantsCancelled = statuses.includes('cancelled');
  if (wantsRemoved && !wantsCancelled) out = out.like('cancel_reason', `${REMOVED_REASON_PREFIX}%`);
  if (wantsCancelled && !wantsRemoved) out = out.or(`cancel_reason.is.null,cancel_reason.not.like.${REMOVED_REASON_PREFIX}%`);
  return out;
}

export interface RecipientPage {
  items: ApiRecipient[];
  next_cursor: string | null;
}

/**
 * Uma página de destinatários. Sem filtro de funil: dirigida pela fila (scheduled_at, id). Com clicked/closed/paid: dirigida por
 * utmpay_links (só quem tem link rastreado) e depois busca as linhas da fila da página.
 */
export async function loadRecipientPage(
  db: Db,
  opts: {
    accountId: string;
    campaignId: string;
    filters: RecipientFilters;
    cursor: string[] | null;
    limit: number;
    conversationsFor: (rows: RecipientRow[]) => Promise<Map<string, string>>;
  },
): Promise<RecipientPage> {
  const { accountId, campaignId, filters: f, limit } = opts;
  if (hasFunnelFilter(f)) return loadFunnelDriven(db, opts);

  let phoneKeyFilter: string | null = null;
  let phoneOr: string | null = null;
  if (f.phone) {
    phoneKeyFilter = phoneKey(f.phone);
    const suffix = f.phone.slice(-8);
    const { data: contacts, error: cErr } = await db.from('contacts').select('id').eq('account_id', accountId).like('phone_normalized', `%${suffix}`).limit(200);
    if (cErr) throw cErr;
    const contactIds = ((contacts ?? []) as Array<{ id: string }>).map((c) => c.id);
    const external = `and(contact_id.is.null,mensagem_final.like.%${suffix})`;
    phoneOr = contactIds.length > 0 ? `contact_id.in.(${contactIds.join(',')}),${external}` : external;
  }
  const run = (extended: boolean) => {
    let q = db.from('disp_message_queue').select(extended ? RECIPIENT_COLUMNS : RECIPIENT_COLUMNS_BASE).eq('campaign_id', campaignId);
    q = applyStatusFilter(q, f.statuses, extended);
    if (f.replied) q = q.not('replied_at', 'is', null);
    if (phoneOr) q = q.or(phoneOr);
    if (opts.cursor) {
      const [at, id] = opts.cursor;
      q = q.or(`scheduled_at.gt."${at}",and(scheduled_at.eq."${at}",id.gt."${id}")`);
    }
    return q.order('scheduled_at', { ascending: true }).order('id', { ascending: true }).limit(limit + 1);
  };
  // Sem cancel_reason/reference (migration 357 ainda não aplicada): repete a consulta sem elas.
  let res = await run(true);
  if (isMissingColumn(res.error)) res = await run(false);
  const { data, error } = res;
  if (error) throw error;
  const all = (data ?? []) as unknown as RecipientRow[];
  const pageRows = all.slice(0, limit);
  const hasMore = all.length > limit;
  const last = pageRows[pageRows.length - 1];
  const nextCursor = hasMore && last?.scheduled_at ? encodeCursor([new Date(last.scheduled_at).toISOString(), last.id]) : null;
  // A busca por sufixo é só um pré-filtro: a igualdade exata é por phoneKey (tolera 9º dígito e DDI).
  const rows = phoneKeyFilter ? pageRows.filter((r) => { const p = recipientPhone(r); return p !== null && phoneKey(p) === phoneKeyFilter; }) : pageRows;
  return { items: await enrich(db, accountId, rows, opts.conversationsFor), next_cursor: nextCursor };
}

async function loadFunnelDriven(
  db: Db,
  opts: { accountId: string; campaignId: string; filters: RecipientFilters; cursor: string[] | null; limit: number; conversationsFor: (rows: RecipientRow[]) => Promise<Map<string, string>> },
): Promise<RecipientPage> {
  const { accountId, campaignId, filters: f, limit } = opts;
  let q = db.from('utmpay_links').select('tid, created_at').eq('account_id', accountId).eq('campaign_id', campaignId);
  if (f.clicked) q = q.not('clicou_em', 'is', null);
  if (f.closed) q = q.not('fechou_em', 'is', null);
  if (f.paid) q = q.not('pagou_em', 'is', null);
  if (opts.cursor) {
    const [, at, tid] = opts.cursor;
    q = q.or(`created_at.gt."${at}",and(created_at.eq."${at}",tid.gt."${tid}")`);
  }
  const { data, error } = await q.order('created_at', { ascending: true }).order('tid', { ascending: true }).limit(limit + 1);
  if (error) {
    if (error.code === '42P01' || /does not exist|schema cache/i.test(error.message)) throw badRequest('Rastreio de links (UTMpay) não está disponível nesta conta');
    throw error;
  }
  const links = (data ?? []) as Array<{ tid: string; created_at: string }>;
  const page = links.slice(0, limit);
  if (page.length === 0) return { items: [], next_cursor: null };
  const last = page[page.length - 1];
  const nextCursor = links.length > limit ? encodeCursor(['f', new Date(last.created_at).toISOString(), last.tid]) : null;

  const runRows = (extended: boolean) => {
    let rowsQ = db.from('disp_message_queue').select(extended ? RECIPIENT_COLUMNS : RECIPIENT_COLUMNS_BASE).eq('campaign_id', campaignId).in('id', page.map((l) => l.tid));
    rowsQ = applyStatusFilter(rowsQ, f.statuses, extended);
    if (f.replied) rowsQ = rowsQ.not('replied_at', 'is', null);
    return rowsQ;
  };
  let rowsRes = await runRows(true);
  if (isMissingColumn(rowsRes.error)) rowsRes = await runRows(false);
  const { data: rowData, error: rowErr } = rowsRes;
  if (rowErr) throw rowErr;
  const byId = new Map(((rowData ?? []) as unknown as RecipientRow[]).map((r) => [r.id, r]));
  const rows = page.map((l) => byId.get(l.tid)).filter((r): r is RecipientRow => !!r);
  return { items: await enrich(db, accountId, rows, opts.conversationsFor), next_cursor: nextCursor };
}

async function enrich(db: Db, accountId: string, rows: RecipientRow[], conversationsFor: (rows: RecipientRow[]) => Promise<Map<string, string>>): Promise<ApiRecipient[]> {
  if (rows.length === 0) return [];
  const [results, conversations] = await Promise.all([
    loadItemResults(db, accountId, rows.map((r) => r.id)).catch(() => new Map()),
    conversationsFor(rows).catch(() => new Map<string, string>()),
  ]);
  return rows.map((r) => toApiRecipient(r, { result: results.get(r.id), conversationId: r.contact_id ? (conversations.get(r.contact_id) ?? null) : null }));
}

