// ============================================================
// POST /api/v1/whatsapp/send-template — envia UM template aprovado da Meta a um número.
//
// Escopo 'messages:send'. `Idempotency-Key` obrigatória (mesma regra de /whatsapp/send). Só canal Meta: canal WAHA → 422
// (para WAHA use /whatsapp/send com texto). Tudo é validado ANTES de chamar a Meta (template aprovado no catálogo da WABA do
// canal, nº de variáveis, componentes suportados, telefone, blacklist, qualidade vermelha) e a Idempotency-Key só é consumida
// depois da chamada ao provedor. Limite próprio: 60/min por chave (volume vai por campanha). Sem rastreio de link (UTMpay).
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { runIdempotentSend } from '@/lib/disparador/send-ledger';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { ok, badRequest, unprocessable, rateLimited, ApiError, toApiErrorResponse, type ApiCallLogContext } from '@/lib/api/v1/respond';
import {
  TEMPLATE_SELECT,
  apiTemplateProblem,
  checkVariableCount,
  normalizeCategory,
  parseSendTemplateBody,
  resolveTemplateChannel,
  type TemplateRow,
} from '@/lib/api/v1/templates';
import { findOrCreateConversation } from '@/lib/api/v1/conversation-open';
import { templateRowsForWaba } from '@/lib/disparador/template-validation';
import { renderMetaTemplateBody } from '@/lib/disparador/campaign-message';
import { findRedChannels, RED_QUALITY_CODE, redBlockedMessage } from '@/lib/disparador/red-quality-gate';
import { phoneKey } from '@/lib/disparador/phone-key';
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { sanitizePhoneForMeta, isValidE164, phoneVariants, isRecipientNotAllowedError } from '@/lib/whatsapp/phone-utils';
import { sendTemplateMessage, MetaApiError } from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';

export async function POST(request: Request) {
  const logCtx: ApiCallLogContext = { method: 'POST', route: '/api/v1/whatsapp/send-template', startedAt: Date.now() };
  try {
    const ctx = await requireApiKey(request, 'messages:send');
    logCtx.accountId = ctx.accountId;
    logCtx.keyId = ctx.keyId;

    const limit = await checkRateLimit(`apikey-template:${ctx.keyId}`, RATE_LIMITS.apiV1TemplateSend);
    if (!limit.success) throw rateLimited(limit, { accountId: ctx.accountId, keyId: ctx.keyId });

    return await runIdempotentSend(
      ctx.accountId,
      request,
      async (ctl) => {
        const parsed: unknown = await request.json().catch(() => null);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw badRequest('Corpo da requisição deve ser um objeto JSON válido');
        }
        const input = parseSendTemplateBody(parsed as Record<string, unknown>);

        const sanitizedPhone = sanitizePhoneForMeta(input.phone);
        if (!isValidE164(sanitizedPhone)) {
          throw badRequest('Número inválido. Use o formato E.164 (ex.: +5527999991212)');
        }

        // Canal Meta (WAHA → 422).
        const config = await resolveTemplateChannel(ctx.supabase, ctx.accountId, input.channel);
        if (!config.waba_id) throw unprocessable('O canal Meta não tem a WABA identificada; sincronize os templates do canal');

        // Template no catálogo da WABA do canal, aprovado e compatível.
        const { data: tplData, error: tplError } = await ctx.supabase
          .from('message_templates')
          .select(TEMPLATE_SELECT)
          .eq('account_id', ctx.accountId)
          .eq('name', input.templateName)
          .eq('language', input.language)
          .limit(50);
        if (tplError) throw new ApiError('unavailable', 'Não foi possível consultar os templates; tente novamente', 503);
        const rows = templateRowsForWaba((tplData ?? []) as TemplateRow[], config.waba_id);
        const tpl = rows[0] ?? null;
        if (!tpl) {
          throw unprocessable(`Template '${input.templateName}' (${input.language}) não encontrado no catálogo do canal; sincronize os templates`);
        }
        const problem = apiTemplateProblem(tpl);
        if (problem) throw unprocessable(`Template '${input.templateName}' não pode ser enviado: ${problem}`);
        checkVariableCount(tpl, input.variables);

        // Blacklist/opt-out por phoneKey. Falha na checagem fecha (503): melhor não enviar do que enviar a quem pediu para sair.
        const { data: blockedKeys, error: blacklistError } = await ctx.supabase.rpc('blacklisted_phone_keys', {
          p_keys: [phoneKey(sanitizedPhone)],
        });
        if (blacklistError) {
          console.error('[API send-template] Falha ao checar blacklist:', blacklistError.message);
          throw new ApiError('unavailable', 'Não foi possível verificar a lista de bloqueio; tente novamente', 503);
        }
        if (((blockedKeys ?? []) as Array<{ key: string | null }>).length > 0) {
          throw new ApiError('recipient_blocked', 'O destinatário está na lista de bloqueio (opt-out) e não pode receber mensagens', 422);
        }

        // Número com qualidade vermelha: só o owner confirma no painel; chave de API nunca.
        const red = await findRedChannels(ctx.supabase, ctx.accountId, [config.id]);
        if (red.length > 0) {
          throw new ApiError('conflict', redBlockedMessage(red), 409, undefined, undefined, {
            reason: RED_QUALITY_CODE,
            channels: red.map((c) => ({ id: c.id, label: c.display_phone_number })),
          });
        }

        // Contato e conversa (só com salvar_bd: true).
        let contactRow: any = null;
        let conversation: any = null;
        if (input.salvarBd) {
          contactRow = (await findExistingContact(ctx.supabase, ctx.accountId, sanitizedPhone)) as any;
          if (contactRow) {
            if (input.name && input.name !== contactRow.name) {
              await ctx.supabase.from('contacts').update({ name: input.name, updated_at: new Date().toISOString() }).eq('id', contactRow.id);
            }
          } else {
            const { data: created, error: createErr } = await ctx.supabase
              .from('contacts')
              .insert({ account_id: ctx.accountId, user_id: config.user_id, phone: sanitizedPhone, name: input.name || 'API Lead' })
              .select()
              .single();
            if (createErr) {
              if (isUniqueViolation(createErr)) contactRow = await findExistingContact(ctx.supabase, ctx.accountId, sanitizedPhone);
              if (!contactRow) throw new ApiError('internal', 'Não foi possível criar o contato', 500);
            } else {
              contactRow = created;
            }
          }
          conversation = await findOrCreateConversation(ctx.supabase, ctx.accountId, config.user_id, contactRow.id, undefined, config.id);
          if (!conversation) throw new ApiError('internal', 'Não foi possível abrir a conversa deste contato', 500);
        }

        const accessToken = decrypt(config.access_token as string);
        // A partir daqui há chamada à Meta: erros não liberam mais a Idempotency-Key (o resultado pode ser incerto).
        ctl.providerCalled();

        let waMessageId = '';
        try {
          let lastError: unknown = null;
          for (const variant of phoneVariants(sanitizedPhone)) {
            try {
              const result = await sendTemplateMessage({
                phoneNumberId: config.phone_number_id as string,
                accessToken,
                to: variant,
                templateName: input.templateName,
                language: input.language,
                params: input.variables,
              });
              waMessageId = result.messageId;
              lastError = null;
              break;
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              if (!isRecipientNotAllowedError(msg)) throw err;
              lastError = err;
            }
          }
          if (lastError) throw lastError;
        } catch (sendErr) {
          const msg = sendErr instanceof Error ? sendErr.message : 'Erro desconhecido no envio';
          const extra =
            sendErr instanceof MetaApiError ? { meta_code: sendErr.metaCode, meta_http_status: sendErr.httpStatus } : undefined;
          throw new ApiError('internal', `Falha no envio do template pela Meta: ${msg}`, 502, undefined, undefined, extra);
        }

        const category = normalizeCategory(tpl.category);
        const channelOut = { id: config.id, label: config.display_phone_number };
        const templateOut = { name: input.templateName, language: input.language, category };

        if (!input.salvarBd) {
          return ok(
            { whatsapp_message_id: waMessageId, channel: channelOut, template: templateOut, status: 'accepted', saved: false },
            200,
            logCtx
          );
        }

        const contentText = tpl.body_text ? renderMetaTemplateBody(tpl.body_text, input.variables) : `[template: ${input.templateName}]`;
        const { data: message, error: insertErr } = await ctx.supabase
          .from('messages')
          .insert({
            conversation_id: conversation.id,
            sender_type: 'bot',
            origin: 'api',
            content_type: 'template',
            content_text: contentText,
            message_id: waMessageId,
            status: 'sent',
            waha_session: null,
          })
          .select()
          .single();
        if (insertErr || !message) {
          // Meta aceitou, gravação local falhou: 202 + reconciliation_required para o integrador não reenviar.
          console.error('[API send-template] Provider accepted; local persistence failed:', insertErr?.message);
          return ok(
            {
              success: true,
              saved: false,
              reconciliation_required: true,
              whatsapp_message_id: waMessageId,
              warning: 'A Meta aceitou a mensagem. Não reenvie.',
            },
            202,
            logCtx
          );
        }
        const now = new Date().toISOString();
        await ctx.supabase
          .from('conversations')
          .update({ last_message_text: contentText, last_message_at: now, updated_at: now })
          .eq('id', conversation.id);

        return ok(
          {
            message_id: message.id,
            whatsapp_message_id: waMessageId,
            conversation_id: conversation.id,
            contact_id: contactRow.id,
            channel: channelOut,
            template: templateOut,
            status: 'accepted',
            saved: true,
          },
          200,
          logCtx
        );
      },
      { apiEnvelope: true }
    );
  } catch (err) {
    return toApiErrorResponse(err, logCtx);
  }
}
