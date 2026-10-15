// API pública v1 — adicionar contatos a uma campanha existente (POST /disparador/campaigns/{id}/recipients). Desenho: prd-v2/api-onda1-desenho.md.
// Só campanha criada pela API (source api_v1), em execução ou pausada. Mesmas regras do create: blacklist, dedupe por phoneKey, variáveis do
// template/mensagem, janela e ritmo (o da própria campanha), número vermelho e template aprovado. A inserção é feita pela RPC
// wacrm.add_campaign_recipients (migration 358), em blocos de 1.000, com o lock da campanha: não conclui no meio e deduplica contra a fila.
import type { SupabaseClient } from '@supabase/supabase-js';
import { ApiError, badRequest, notFound } from '@/lib/api/v1/respond';
import {
  INVALID_SAMPLE_LIMIT,
  MAX_CONTACTS_PER_REQUEST,
  normalizeApiContacts,
  resolveWahaMessage,
  scheduleApiContacts,
  type InvalidSample,
} from '@/lib/disparador/api-v1-campaign';
import { loadBlacklistKeySet } from '@/lib/disparador/blacklist-keys';
import { findRedChannels, RED_QUALITY_CODE, redBlockedMessage } from '@/lib/disparador/red-quality-gate';
import { EXTERNAL_WAHA_TEXT_MARKER } from '@/lib/disparador/queue-markers';
import { allTemplatesApproved, templatesOfCampaign } from '@/lib/disparador/template-pause';
import { countBodyVariables } from '@/lib/disparador/template-validation';

type Db = Pick<SupabaseClient, 'from' | 'rpc'>;

export const APPEND_TOTAL_CAP = 50_000;
export const APPEND_BLOCK = 1000;
const DEFAULT_SLOT_SIZE = 1000;
const DEFAULT_SLOT_INTERVAL_MINUTES = 30;

interface CampaignRow {
  id: string;
  status: string;
  source: string | null;
  session_ids: string[] | null;
  mensagens: Array<{ tipo?: string; conteudo?: string; url?: string; template_name?: string; template_language?: string }> | null;
  janela_inicio: string | null;
  janela_fim: string | null;
  dias_envio: number[] | null;
  slot_size?: number | null;
  slot_interval_minutes?: number | null;
}

const BASE_COLUMNS = 'id, status, source, session_ids, mensagens, janela_inicio, janela_fim, dias_envio';
const isMissingColumn = (e: { code?: string; message?: string } | null | undefined) => !!e && (e.code === '42703' || /column .* does not exist/i.test(e.message ?? ''));

export interface AppendResult {
  added: number;
  duplicates: number;
  skipped: number;
  invalid: number;
  invalid_sample: InvalidSample[];
  total_contacts: number;
  estimated_completion_minutes: number;
}

const hhmm = (t: string | null, fallback: string) => (t ?? fallback).slice(0, 5);

/** Parte pura: linhas da fila para os contatos validados (Meta: parâmetros do template; WAHA: texto já resolvido, com o marcador). */
export function buildAppendRows(
  contacts: ReadonlyArray<{ phone: string; variables: string[]; reference: string | null }>,
  times: readonly Date[],
  ctx: {
    provider: 'meta' | 'waha';
    channelId: string;
    message: NonNullable<CampaignRow['mensagens']>[number];
  },
): object[] {
  return contacts.map((c, i) => {
    const base = {
      session_id: ctx.channelId,
      mensagem_final: c.phone,
      scheduled_at: times[i].toISOString(),
      ...(c.reference ? { reference: c.reference } : {}),
    };
    if (ctx.provider === 'meta') {
      return {
        ...base,
        tipo: 'texto',
        media_url: null,
        template_name: ctx.message.template_name,
        template_language: ctx.message.template_language ?? 'pt_BR',
        template_variables: c.variables,
      };
    }
    const text = resolveWahaMessage(ctx.message.conteudo ?? '', c.variables);
    if (text === null) throw new Error('variável sem valor após a validação');
    return {
      ...base,
      tipo: ctx.message.tipo === 'imagem' ? 'imagem' : 'texto',
      media_url: ctx.message.url ?? null,
      template_name: EXTERNAL_WAHA_TEXT_MARKER,
      template_language: null,
      template_variables: [text],
    };
  });
}

export async function appendRecipients(db: Db, input: { accountId: string; campaignId: string; contacts: unknown[]; now?: Date }): Promise<AppendResult> {
  const { accountId, campaignId } = input;
  if (input.contacts.length === 0) throw badRequest("'contacts' é obrigatório e não pode ser vazio");
  if (input.contacts.length > MAX_CONTACTS_PER_REQUEST) {
    throw new ApiError('payload_too_large', `Máximo de ${MAX_CONTACTS_PER_REQUEST} contatos por requisição (recebido: ${input.contacts.length})`, 413);
  }

  const read = (columns: string) => db.from('campaigns').select(columns).eq('id', campaignId).eq('account_id', accountId).limit(1);
  let res = await read(`${BASE_COLUMNS}, slot_size, slot_interval_minutes`);
  if (isMissingColumn(res.error)) res = await read(BASE_COLUMNS);
  if (res.error) throw res.error;
  const campaign = (res.data?.[0] ?? null) as unknown as CampaignRow | null;
  if (!campaign) throw notFound('Campanha não encontrada');
  if (campaign.source !== 'api_v1') {
    throw new ApiError('conflict', 'Só é possível adicionar contatos a campanhas criadas pela API', 409, undefined, undefined, { details: { code: 'not_api_campaign' } });
  }
  if (!['em_execucao', 'pausada'].includes(campaign.status)) {
    throw new ApiError('conflict', 'Só é possível adicionar contatos a uma campanha em execução ou pausada', 409, undefined, undefined, { details: { status: campaign.status } });
  }

  const channelId = campaign.session_ids?.[0];
  const message = campaign.mensagens?.[0];
  if (!channelId || !message) throw new ApiError('conflict', 'Campanha sem canal ou mensagem configurados', 409, undefined, undefined, { details: { status: campaign.status } });
  const { data: channelRows, error: channelError } = await db.from('whatsapp_config').select('provider').eq('id', channelId).eq('account_id', accountId).limit(1);
  if (channelError) throw channelError;
  const provider = (channelRows?.[0] as { provider?: string } | undefined)?.provider;
  if (provider !== 'meta' && provider !== 'waha') throw new ApiError('conflict', 'O canal da campanha não está mais disponível', 409, undefined, undefined, { details: { code: 'channel_unavailable' } });

  let metaBodyVariables = 0;
  if (provider === 'meta') {
    // Número vermelho: só o proprietário confirma, na tela (a API nunca confirma). Template precisa seguir aprovado.
    const red = await findRedChannels(db as SupabaseClient, accountId, [channelId]);
    if (red.length > 0) {
      throw new ApiError('conflict', redBlockedMessage(red), 409, undefined, undefined, { details: { code: RED_QUALITY_CODE, channels: red } });
    }
    const templates = templatesOfCampaign(campaign.mensagens);
    if (!(await allTemplatesApproved(db as SupabaseClient, accountId, templates))) {
      throw new ApiError('conflict', 'O template da campanha não está aprovado na Meta', 409, undefined, undefined, { details: { code: 'template_not_approved', templates } });
    }
    const { data: tpl } = await db
      .from('message_templates')
      .select('body_text')
      .eq('account_id', accountId)
      .eq('name', message.template_name ?? '')
      .eq('status', 'APPROVED')
      .limit(1);
    metaBodyVariables = countBodyVariables((tpl?.[0] as { body_text?: string | null } | undefined)?.body_text);
  }

  const blacklist = await loadBlacklistKeySet(db as SupabaseClient);
  const normalized = normalizeApiContacts(input.contacts, {
    blacklist,
    wahaMessage: provider === 'waha' ? message.conteudo ?? '' : null,
    metaBodyVariables: provider === 'meta' ? metaBodyVariables : 0,
  });
  const valid = normalized.contacts;
  const empty: AppendResult = {
    added: 0,
    duplicates: normalized.duplicates,
    skipped: normalized.skipped,
    invalid: normalized.invalid,
    invalid_sample: normalized.invalidSample.slice(0, INVALID_SAMPLE_LIMIT),
    total_contacts: 0,
    estimated_completion_minutes: 0,
  };
  if (valid.length === 0 && normalized.invalid > 0) {
    throw new ApiError('bad_request', 'Nenhum contato válido para adicionar', 400, undefined, undefined, { invalid_sample: empty.invalid_sample });
  }

  // O ritmo é o da própria campanha (357 guarda; sem a coluna, o padrão do create). Os novos entram depois do último já agendado.
  const slotSize = Math.max(1, campaign.slot_size ?? DEFAULT_SLOT_SIZE);
  const slotIntervalMinutes = Math.max(1, campaign.slot_interval_minutes ?? DEFAULT_SLOT_INTERVAL_MINUTES);
  const { data: lastRows } = await db.from('disp_message_queue').select('scheduled_at').eq('campaign_id', campaignId).order('scheduled_at', { ascending: false }).limit(1);
  const last = (lastRows?.[0] as { scheduled_at?: string | null } | undefined)?.scheduled_at;
  const now = input.now ?? new Date();
  const base = last && Date.parse(last) > now.getTime() ? new Date(last) : now;
  const times = scheduleApiContacts(valid.length, {
    now: base,
    slotSize,
    slotIntervalMs: slotIntervalMinutes * 60_000,
    janela: { inicio: hhmm(campaign.janela_inicio, '08:00'), fim: hhmm(campaign.janela_fim, '18:00'), dias: campaign.dias_envio ?? [1, 2, 3, 4, 5] },
  });
  const rows = buildAppendRows(valid, times, { provider, channelId, message });

  let added = 0;
  let duplicates = normalized.duplicates;
  let total = 0;
  for (let start = 0; start < rows.length; start += APPEND_BLOCK) {
    const block = rows.slice(start, start + APPEND_BLOCK);
    const { data, error } = await db.rpc('add_campaign_recipients', { p_account: accountId, p_campaign: campaignId, p_rows: block, p_cap: APPEND_TOTAL_CAP });
    if (error) {
      if (error.code === '42883' || error.code === 'PGRST202' || /does not exist|schema cache/i.test(error.message)) {
        throw new ApiError('unavailable', 'Adicionar contatos indisponível: aplique as migrations 357 e 358', 503);
      }
      throw failure(added, error.message);
    }
    if (data === null || data === undefined) throw notFound('Campanha não encontrada');
    const r = data as { error?: string; status?: string; total?: number; cap?: number; added?: number; duplicates?: number };
    if (r.error === 'cap') {
      throw new ApiError('payload_too_large', `A campanha passaria de ${APPEND_TOTAL_CAP} contatos (hoje ${r.total}); abra outra campanha`, 413, undefined, undefined, { details: { total: r.total, cap: r.cap, added_before_error: added } });
    }
    if (r.error === 'status') {
      throw new ApiError('conflict', 'A campanha mudou de estado durante a adição; consulte-a e repita a chamada (os contatos já inseridos não duplicam)', 409, undefined, undefined, { details: { status: r.status, added_before_error: added } });
    }
    if (r.error) throw new ApiError('conflict', 'Só é possível adicionar contatos a campanhas criadas pela API', 409, undefined, undefined, { details: { code: r.error, added_before_error: added } });
    added += r.added ?? 0;
    duplicates += r.duplicates ?? 0;
    total = r.total ?? total;
  }

  const slots = Math.ceil(valid.length / slotSize);
  return {
    added,
    duplicates,
    skipped: normalized.skipped,
    invalid: normalized.invalid,
    invalid_sample: normalized.invalidSample.slice(0, INVALID_SAMPLE_LIMIT),
    total_contacts: total,
    estimated_completion_minutes: Math.max(0, slots - 1) * slotIntervalMinutes,
  };
}

function failure(addedBefore: number, message: string): ApiError {
  console.error('[v1/append] falha ao inserir bloco:', message);
  return new ApiError('internal', 'Falha ao adicionar os contatos; repita a chamada (os já inseridos não duplicam)', 500, undefined, undefined, { details: { added_before_error: addedBefore } });
}
