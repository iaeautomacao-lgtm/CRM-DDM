// POST /api/v1/conversations — abrir (ou reaproveitar) o atendimento de um contato num canal, com atendente OU equipe, mensagem inicial opcional e
// force_transfer. Reaproveita: contato por telefone (findExistingContact, inclui telefones alternativos), canal (Meta/WAHA), transferência com
// pausa (conversations-control.ts), template Meta (templates.ts: catálogo da WABA, aprovado, variáveis, componentes, qualidade vermelha),
// janela de 24h da Meta para texto livre e blacklist/opt-out (fail-closed). A bifurcação Meta × WAHA NÃO é unificada: cada caminho envia do seu jeito.
import type { SupabaseClient } from '@supabase/supabase-js';
import { ApiError, badRequest, notFound, unprocessable } from '@/lib/api/v1/respond';
import {
  CONVERSATION_COLUMNS,
  guardPausedAssignee,
  loadConversation,
  toConversationView,
  transferConversation,
  validateAssignee,
  validateTeam,
  type ConversationRow,
  type ConversationView,
} from '@/lib/api/v1/conversations-control';
import type { InitialMessage, OpenInput } from '@/lib/api/v1/conversations-parse';
import { TEMPLATE_SELECT, apiTemplateProblem, checkVariableCount, type TemplateRow } from '@/lib/api/v1/templates';
import { templateRowsForWaba } from '@/lib/disparador/template-validation';
import { renderMetaTemplateBody } from '@/lib/disparador/campaign-message';
import { findRedChannels, RED_QUALITY_CODE, redBlockedMessage } from '@/lib/disparador/red-quality-gate';
import { phoneKey } from '@/lib/disparador/phone-key';
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { isRecipientNotAllowedError, isValidE164, phoneVariants, sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';
import { MetaApiError, sendTemplateMessage, sendTextMessage } from '@/lib/whatsapp/meta-api';
import { sendWahaTextMessage } from '@/lib/whatsapp/waha-api';
import { decrypt, decryptStoredSecret } from '@/lib/whatsapp/encryption';

type Db = SupabaseClient;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const unavailable = (what: string) => new ApiError('unavailable', `Não foi possível ${what}; tente novamente`, 503);
const WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ChannelRow {
  id: string;
  user_id: string;
  provider: 'meta' | 'waha';
  phone_number_id: string | null;
  access_token: string | null;
  waba_id: string | null;
  display_phone_number: string | null;
  waha_session: string | null;
  waha_url: string | null;
  waha_api_key: string | null;
  team_id: string | null;
}

/** Canal pelo id (UUID), número do canal Meta ou sessão WAHA; sem `channel`, o ÚNICO canal ativo (mais de um = 400). */
export async function resolveOpenChannel(db: Db, accountId: string, requested: string | null): Promise<ChannelRow> {
  const { data, error } = await db
    .from('whatsapp_config')
    .select('id, user_id, provider, phone_number_id, access_token, waba_id, display_phone_number, waha_session, waha_url, waha_api_key, team_id')
    .eq('account_id', accountId)
    .eq('habilitado', true)
    .in('provider', ['meta', 'waha']);
  if (error) throw unavailable('consultar os canais');
  const channels = (data ?? []) as ChannelRow[];
  if (channels.length === 0) throw badRequest('Nenhum canal habilitado encontrado nesta conta');
  if (!requested) {
    if (channels.length > 1) throw badRequest("Conta com mais de um canal habilitado — informe 'channel' (id, número do canal Meta ou sessão WAHA)");
    return channels[0];
  }
  let chosen: ChannelRow | undefined;
  if (UUID_RE.test(requested)) chosen = channels.find((c) => c.id.toLowerCase() === requested.toLowerCase());
  else {
    chosen = channels.find((c) => c.provider === 'waha' && c.waha_session === requested);
    if (!chosen) {
      const digits = sanitizePhoneForMeta(requested);
      chosen = channels.find((c) => c.provider === 'meta' && c.display_phone_number && sanitizePhoneForMeta(c.display_phone_number) === digits);
    }
  }
  if (!chosen) throw badRequest('Canal não encontrado ou desabilitado nesta conta');
  return chosen;
}

async function resolveContact(db: Db, accountId: string, actor: string, input: OpenInput): Promise<{ id: string; phone: string }> {
  if (input.contactId) {
    const { data, error } = await db.from('contacts').select('id, phone').eq('id', input.contactId).eq('account_id', accountId).limit(1);
    if (error) throw unavailable('consultar o contato');
    const row = (data ?? [])[0] as { id: string; phone: string } | undefined;
    if (!row) throw notFound('Contato não encontrado');
    return row;
  }
  const phone = sanitizePhoneForMeta(input.phone as string);
  if (!isValidE164(phone)) throw badRequest('Telefone inválido. Use o formato E.164 (ex.: +5527999991212)');
  const existing = (await findExistingContact(db, accountId, phone)) as { id: string; phone: string } | null;
  if (existing) return { id: existing.id, phone: existing.phone };
  const { data, error } = await db.from('contacts').insert({ account_id: accountId, user_id: actor, phone, name: input.name ?? phone }).select('id, phone').limit(1);
  if (error) {
    if (isUniqueViolation(error)) {
      const raced = (await findExistingContact(db, accountId, phone)) as { id: string; phone: string } | null;
      if (raced) return { id: raced.id, phone: raced.phone };
    }
    throw unavailable('criar o contato');
  }
  const created = (data ?? [])[0] as { id: string; phone: string } | undefined;
  if (!created) throw unavailable('criar o contato');
  return created;
}

/** Conversa aberta/pendente do contato NESTE canal (WhatsApp; a de Webchat nunca é reaproveitada). */
async function findOpenConversation(db: Db, accountId: string, contactId: string, channel: ChannelRow): Promise<ConversationRow | null> {
  let q = db.from('conversations').select(CONVERSATION_COLUMNS).eq('account_id', accountId).eq('contact_id', contactId).eq('channel_type', 'whatsapp').in('status', ['open', 'pending']);
  q = channel.provider === 'waha' ? q.eq('waha_session', channel.waha_session as string) : q.is('waha_session', null).eq('config_id', channel.id);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(1);
  if (error) throw unavailable('consultar as conversas do contato');
  return ((data ?? [])[0] as ConversationRow | undefined) ?? null;
}

async function createConversation(db: Db, accountId: string, channel: ChannelRow, contactId: string, assigneeId: string | null, teamId: string | null): Promise<ConversationRow> {
  const insert: Record<string, unknown> = {
    account_id: accountId,
    user_id: channel.user_id,
    contact_id: contactId,
    // Com atendente = em atendimento (open); só equipe ou nada = fila (pending), como no handoff do motor.
    status: assigneeId ? 'open' : 'pending',
    ...(assigneeId ? { assigned_agent_id: assigneeId } : {}),
    ...(teamId ? { team_id: teamId } : {}),
    ...(channel.provider === 'waha' ? { waha_session: channel.waha_session } : { config_id: channel.id }),
  };
  const { data, error } = await db.from('conversations').insert(insert).select(CONVERSATION_COLUMNS).limit(1);
  if (error) throw unavailable('abrir a conversa');
  const row = ((data ?? [])[0] as ConversationRow | undefined) ?? null;
  if (!row) throw unavailable('abrir a conversa');
  return row;
}

// ── mensagem inicial ─────────────────────────────────────────────────────────
async function assertNotBlocked(db: Db, phone: string): Promise<void> {
  const { data, error } = await db.rpc('blacklisted_phone_keys', { p_keys: [phoneKey(phone)] });
  if (error) throw new ApiError('unavailable', 'Não foi possível verificar a lista de bloqueio; tente novamente', 503);
  if (((data ?? []) as Array<{ key: string | null }>).length > 0) {
    throw new ApiError('recipient_blocked', 'O destinatário está na lista de bloqueio (opt-out) e não pode receber mensagens', 422);
  }
}

/** Texto livre na Meta só dentro das 24h da última mensagem do CLIENTE neste canal; fora disso, template. */
async function assertWindowOpen(db: Db, accountId: string, contactId: string, channel: ChannelRow, now: number): Promise<void> {
  const { data: convs } = await db.from('conversations').select('id').eq('account_id', accountId).eq('contact_id', contactId).eq('config_id', channel.id).limit(50);
  const ids = ((convs ?? []) as Array<{ id: string }>).map((c) => c.id);
  if (ids.length > 0) {
    const cutoff = new Date(now - WINDOW_MS).toISOString();
    const { data } = await db.from('messages').select('id').in('conversation_id', ids).eq('sender_type', 'customer').gte('created_at', cutoff).limit(1);
    if ((data ?? []).length > 0) return;
  }
  throw unprocessable('A janela de 24h da Meta está fechada (o cliente não escreveu nas últimas 24h): texto livre não sai. Envie um template em message.template.', { reason: 'window_closed' });
}

export interface SentMessage {
  id: string | null;
  whatsapp_message_id: string;
  kind: 'text' | 'template';
  saved: boolean;
}

async function sendMetaVariants(channel: ChannelRow, phone: string, send: (to: string, token: string) => Promise<{ messageId: string }>): Promise<string> {
  const token = decrypt(channel.access_token as string);
  let lastError: unknown = null;
  try {
    for (const variant of phoneVariants(phone)) {
      try {
        return (await send(variant, token)).messageId;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!isRecipientNotAllowedError(msg)) throw err;
        lastError = err;
      }
    }
    throw lastError;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Erro desconhecido no envio';
    const extra = err instanceof MetaApiError ? { meta_code: err.metaCode, meta_http_status: err.httpStatus } : undefined;
    throw new ApiError('internal', `Falha no envio pela Meta: ${msg}`, 502, undefined, undefined, extra);
  }
}

export async function sendInitialMessage(
  db: Db,
  a: { accountId: string; channel: ChannelRow; contactId: string; phone: string; message: InitialMessage; ensureConversation: () => Promise<string>; onProviderCall: () => void; now?: number },
): Promise<SentMessage> {
  const { channel, message } = a;
  // Tudo que pode recusar o pedido (blacklist, janela, template) roda ANTES de abrir a conversa; só então a conversa é garantida e o provedor chamado.
  let conversationId = '';
  const beforeSend = async () => {
    conversationId = await a.ensureConversation();
    a.onProviderCall();
  };
  const phone = sanitizePhoneForMeta(a.phone);
  if (!isValidE164(phone)) throw badRequest('O contato não tem um telefone válido (E.164) para receber mensagem');
  await assertNotBlocked(db, phone);

  let waMessageId = '';
  let contentText: string;
  let contentType: 'text' | 'template';
  if (channel.provider === 'waha') {
    if (message.kind === 'template') throw unprocessable('Template é exclusivo de canal Meta; para WAHA envie texto em message.text', { reason: 'template_requires_meta' });
    if (!channel.waha_url || !channel.waha_session) throw unprocessable('O canal WAHA não está totalmente configurado');
    await beforeSend();
    try {
      const wahaConfig = {
        waha_url: channel.waha_url,
        waha_session: channel.waha_session,
        waha_api_key: channel.waha_api_key ? decryptStoredSecret(channel.waha_api_key, 'whatsapp_config.waha_api_key') : null,
      };
      waMessageId = (await sendWahaTextMessage(wahaConfig, phone, message.text)).messageId;
    } catch (err) {
      throw new ApiError('internal', `Falha no envio pelo WAHA: ${err instanceof Error ? err.message : 'erro desconhecido'}`, 502);
    }
    contentText = message.text;
    contentType = 'text';
  } else {
    if (!channel.phone_number_id || !channel.access_token) throw unprocessable('O canal Meta não está totalmente configurado (falta o número ou o token)');
    if (message.kind === 'text') {
      await assertWindowOpen(db, a.accountId, a.contactId, channel, a.now ?? Date.now());
      await beforeSend();
      waMessageId = await sendMetaVariants(channel, phone, (to, accessToken) => sendTextMessage({ phoneNumberId: channel.phone_number_id as string, accessToken, to, text: message.text }));
      contentText = message.text;
      contentType = 'text';
    } else {
      if (!channel.waba_id) throw unprocessable('O canal Meta não tem a WABA identificada; sincronize os templates do canal');
      const { data, error } = await db.from('message_templates').select(TEMPLATE_SELECT).eq('account_id', a.accountId).eq('name', message.name).eq('language', message.language).limit(50);
      if (error) throw unavailable('consultar os templates');
      const tpl = templateRowsForWaba((data ?? []) as TemplateRow[], channel.waba_id)[0] ?? null;
      if (!tpl) throw unprocessable(`Template '${message.name}' (${message.language}) não encontrado no catálogo do canal; sincronize os templates`);
      const problem = apiTemplateProblem(tpl);
      if (problem) throw unprocessable(`Template '${message.name}' não pode ser enviado: ${problem}`);
      checkVariableCount(tpl, message.variables);
      const red = await findRedChannels(db, a.accountId, [channel.id]);
      if (red.length > 0) {
        throw new ApiError('conflict', redBlockedMessage(red), 409, undefined, undefined, { reason: RED_QUALITY_CODE, channels: red.map((c) => ({ id: c.id, label: c.display_phone_number })) });
      }
      await beforeSend();
      waMessageId = await sendMetaVariants(channel, phone, (to, accessToken) =>
        sendTemplateMessage({ phoneNumberId: channel.phone_number_id as string, accessToken, to, templateName: message.name, language: message.language, params: message.variables }),
      );
      contentText = tpl.body_text ? renderMetaTemplateBody(tpl.body_text, message.variables) : `[template: ${message.name}]`;
      contentType = 'template';
    }
  }

  // Grava no histórico do CRM (a Meta/WAHA já aceitou: falha aqui NÃO é erro para o integrador — a resposta marca saved:false).
  const { data: saved, error: insertError } = await db
    .from('messages')
    .insert({
      conversation_id: conversationId,
      sender_type: 'bot',
      origin: 'api',
      content_type: contentType,
      content_text: contentText,
      message_id: waMessageId,
      status: 'sent',
      waha_session: channel.provider === 'waha' ? channel.waha_session : null,
    })
    .select('id')
    .limit(1);
  const id = ((saved ?? [])[0] as { id: string } | undefined)?.id ?? null;
  if (insertError || !id) {
    console.error('[API conversations] Provider accepted; local persistence failed:', insertError?.message);
    return { id: null, whatsapp_message_id: waMessageId, kind: contentType, saved: false };
  }
  const now = new Date().toISOString();
  await db.from('conversations').update({ last_message_text: contentText, last_message_at: now, updated_at: now }).eq('id', conversationId);
  return { id, whatsapp_message_id: waMessageId, kind: contentType, saved: true };
}

// ── abrir ────────────────────────────────────────────────────────────────────
export interface OpenResult {
  conversation: ConversationView;
  created: boolean;
  transferred: boolean;
  message: SentMessage | null;
}

export async function openConversation(
  db: Db,
  a: { accountId: string; actorUserId: string; input: OpenInput; onProviderCall: () => void; now?: number },
): Promise<OpenResult> {
  const { input } = a;
  if (input.assigneeId) await validateAssignee(db, a.accountId, input.assigneeId);
  if (input.teamId) await validateTeam(db, a.accountId, input.teamId);

  const channel = await resolveOpenChannel(db, a.accountId, input.channel);
  const contact = await resolveContact(db, a.accountId, a.actorUserId, input);
  const wantsOwner = input.assigneeId !== null || input.teamId !== null;

  let conversation: ConversationRow | null = null;
  let created = false;
  let transferred = false;
  const ensure = async (): Promise<string> => {
    if (conversation) return conversation.id;
    conversation = await findOpenConversation(db, a.accountId, contact.id, channel);
    if (conversation) {
      const sameAssignee = input.assigneeId === null || input.assigneeId === conversation.assigned_agent_id;
      const sameTeam = input.teamId === null || input.teamId === conversation.team_id;
      if (wantsOwner && !(sameAssignee && sameTeam)) {
        if (!input.forceTransfer) {
          throw new ApiError('conflict', 'Já existe um atendimento aberto deste contato neste canal com outro atendente/equipe. Use force_transfer: true para transferir.', 409, undefined, undefined, {
            reason: 'conversation_exists',
            conversation: toConversationView(conversation),
          });
        }
        const result = await transferConversation(db, {
          accountId: a.accountId,
          conversation,
          assigneeId: input.assigneeId ?? undefined,
          teamId: input.teamId ?? undefined,
          confirmPaused: input.confirmPaused,
          actorUserId: a.actorUserId,
          reason: input.reason,
        });
        conversation = result.conversation;
        transferred = result.changed;
      }
    } else {
      if (input.assigneeId) {
        const agent = await validateAssignee(db, a.accountId, input.assigneeId);
        await guardPausedAssignee(db, agent, input.confirmPaused);
      }
      conversation = await createConversation(db, a.accountId, channel, contact.id, input.assigneeId, input.teamId);
      created = true;
    }
    return conversation.id;
  };

  let message: SentMessage | null = null;
  if (input.message) {
    message = await sendInitialMessage(db, {
      accountId: a.accountId,
      channel,
      contactId: contact.id,
      phone: contact.phone,
      message: input.message,
      ensureConversation: ensure,
      onProviderCall: a.onProviderCall,
      now: a.now,
    });
  } else {
    await ensure();
  }
  const final = conversation as ConversationRow | null;
  if (!final) throw unavailable('abrir a conversa');
  return { conversation: toConversationView(final), created, transferred, message };
}

export { loadConversation };
