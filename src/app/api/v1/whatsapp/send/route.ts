// ============================================================
// POST /api/v1/whatsapp/send — Public API route to send WhatsApp messages.
//
// Authenticates via bearer token (Authorization: Bearer wacrm_live_...)
// using the 'messages:send' scope. Find-or-creates the target contact
// and conversation, sends the text (optionally with media) using the
// active channel provider (WAHA or Meta), and records the message in
// the database.
//
// Media: pass EITHER media_url (public https:// URL, fetched directly
// by the provider) OR media_base64 (raw base64, no `data:` prefix —
// uploaded to Meta's media endpoint first, or inlined for WAHA). Never
// both. media_base64 sends have no hosted copy of the file, so
// messages.media_url stays NULL for them — the CRM inbox has nothing
// to render a thumbnail from. That's a deliberate scope cut, not an
// oversight: turning this into a real hosted attachment would mean
// also uploading to Supabase Storage, which nothing here asked for.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { sendTextMessage, sendMediaMessage, uploadMedia, type MediaKind } from '@/lib/whatsapp/meta-api';
import {
  sendWahaTextMessage,
  sendWahaMediaMessage,
  sendWahaVoiceMessage,
  sendWahaMediaMessageBase64,
  sendWahaVoiceMessageBase64,
} from '@/lib/whatsapp/waha-api';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import { ok, badRequest, ApiError, toApiErrorResponse, type ApiCallLogContext } from '@/lib/api/v1/respond';
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';

const MEDIA_TYPE_TO_KIND: Record<string, MediaKind> = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
  'image/gif': 'image',
  'video/mp4': 'video',
  'audio/ogg': 'audio',
  'audio/mpeg': 'audio',
  'application/pdf': 'document',
};
const ALLOWED_MEDIA_TYPES = Object.keys(MEDIA_TYPE_TO_KIND);

const MEDIA_TYPE_EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'application/pdf': 'pdf',
};

const MAX_MEDIA_BASE64_BYTES = 16 * 1024 * 1024;
const MAX_CAPTION_LENGTH = 1024; // Meta's own cap — see sendMediaMessage.

/** Best-effort kind from a media_url's extension, for the case where the
 *  caller supplies a URL without media_type (only required for base64).
 *  Mirrors guessMediaKind in src/lib/flows/waha-send.ts. */
function guessMediaKindFromUrl(url: string): MediaKind {
  const ext = (url.split('?')[0].split('.').pop() ?? '').toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'avi', 'webm', 'mkv'].includes(ext)) return 'video';
  if (['mp3', 'ogg', 'oga', 'wav', 'm4a', 'aac'].includes(ext)) return 'audio';
  return 'document';
}

export async function POST(request: Request) {
  const logCtx: ApiCallLogContext = {
    method: 'POST',
    route: '/api/v1/whatsapp/send',
    startedAt: Date.now(),
  };
  try {
    // 1. Authenticate API Key with 'messages:send' scope
    const ctx = await requireApiKey(request, 'messages:send');
    logCtx.accountId = ctx.accountId;
    logCtx.keyId = ctx.keyId;

    // 2. Parse request body
    const body = await request.json();
    const { to, phone, text, message, name, media_url, media_base64, media_type, media_caption } = body;

    const targetPhone = phone || to;
    const targetText = message || text;

    const hasMediaUrl = typeof media_url === 'string' && media_url.length > 0;
    const hasMediaBase64 = typeof media_base64 === 'string' && media_base64.length > 0;
    const hasMedia = hasMediaUrl || hasMediaBase64;

    if (!targetPhone) {
      throw badRequest("'phone' (or 'to') is required");
    }
    if (!targetText && !hasMedia) {
      throw badRequest("'text' (or 'message') is required when no media is provided");
    }
    if (hasMediaUrl && hasMediaBase64) {
      throw badRequest('Envie media_url OU media_base64, não os dois');
    }
    if (hasMediaBase64 && !media_type) {
      throw badRequest('media_type obrigatório com media_base64');
    }
    if (media_type && !ALLOWED_MEDIA_TYPES.includes(media_type)) {
      throw badRequest(`media_type inválido. Aceitos: ${ALLOWED_MEDIA_TYPES.join(', ')}`);
    }
    if (hasMediaUrl && !media_url.startsWith('https://')) {
      throw badRequest("'media_url' deve ser uma URL pública iniciando com https://");
    }
    if (typeof media_caption === 'string' && media_caption.length > MAX_CAPTION_LENGTH) {
      throw badRequest(`'media_caption' excede o limite de ${MAX_CAPTION_LENGTH} caracteres`);
    }

    let mediaBuffer: Buffer | null = null;
    if (hasMediaBase64) {
      mediaBuffer = Buffer.from(media_base64, 'base64');
      if (mediaBuffer.length === 0) {
        throw badRequest("'media_base64' inválido ou vazio");
      }
      if (mediaBuffer.length > MAX_MEDIA_BASE64_BYTES) {
        throw badRequest(
          `Mídia excede o tamanho máximo de 16MB (recebido: ${(mediaBuffer.length / (1024 * 1024)).toFixed(1)}MB)`
        );
      }
    }

    // media_type is only mandatory for base64 (validated above); for
    // media_url it's optional and falls back to guessing from the
    // extension, same as the Flows engine's WAHA media_url sends.
    const mediaKind: MediaKind | null = hasMedia
      ? (media_type as MediaKind | undefined) && MEDIA_TYPE_TO_KIND[media_type]
        ? MEDIA_TYPE_TO_KIND[media_type]
        : guessMediaKindFromUrl(media_url ?? '')
      : null;
    // Caption only applies to image/video per the field's documented
    // scope — silently dropped for audio/document rather than rejected.
    const mediaCaption: string | undefined =
      hasMedia && (mediaKind === 'image' || mediaKind === 'video') && media_caption
        ? media_caption
        : undefined;

    // 3. Sanitize and validate phone number
    const sanitizedPhone = sanitizePhoneForMeta(targetPhone);
    if (!isValidE164(sanitizedPhone)) {
      throw badRequest('Invalid phone number format. Must be in E.164 format (ex: +5527999991212)');
    }

    // 4. Fetch WhatsApp config for this account
    const { data: config, error: configError } = await ctx.supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', ctx.accountId)
      .maybeSingle();

    if (configError || !config) {
      throw badRequest('WhatsApp is not configured for this account.');
    }

    // 5. Find or create Contact
    let contactRow = await findExistingContact(ctx.supabase, ctx.accountId, sanitizedPhone) as any;

    if (contactRow) {
      // Se o contato existe, atualiza o nome dele se tiver sido enviado um novo diferente
      if (name && name !== contactRow.name) {
        await ctx.supabase
          .from('contacts')
          .update({ name, updated_at: new Date().toISOString() })
          .eq('id', contactRow.id);
      }
    } else {
      const { data: newContact, error: createContactErr } = await ctx.supabase
        .from('contacts')
        .insert({
          account_id: ctx.accountId,
          user_id: config.user_id, // Atribui ao criador da configuração do WhatsApp
          phone: sanitizedPhone,
          name: name || 'API Lead',
        })
        .select()
        .single();

      if (createContactErr) {
        // Se ocorreu um erro de chave duplicada (corrida/concorrência), tente buscar o contato existente novamente
        if (isUniqueViolation(createContactErr)) {
          const raced = await findExistingContact(ctx.supabase, ctx.accountId, sanitizedPhone);
          if (raced) {
            contactRow = raced;
          }
        }
        
        if (!contactRow) {
          throw new ApiError('internal', `Failed to create contact: ${createContactErr?.message}`, 500);
        }
      } else {
        contactRow = newContact;
      }
    }

    // 6. Find or create Conversation
    const conversation = await findOrCreateConversation(
      ctx.supabase,
      ctx.accountId,
      config.user_id, // Passa o user_id da config
      contactRow.id,
      config.provider === 'waha' ? config.waha_session : undefined
    );

    if (!conversation) {
      throw new ApiError('internal', 'Failed to open a conversation for this contact.', 500);
    }

    // 7. Send the message via active provider (WAHA or Meta API)
    let waMessageId = '';
    let accessToken = '';
    if (config.provider === 'meta') {
      accessToken = decrypt(config.access_token);
    }

    // Meta media_base64 uploads once, up front — not inside attemptSend,
    // which the phone-variant retry loop below can call more than once
    // (Meta "recipient not in allowed list" retries). Re-uploading the
    // same bytes per retry would waste calls and media ids for no
    // benefit; the id itself is retry-safe to reuse across variants.
    let uploadedMediaId: string | null = null;
    if (hasMediaBase64 && mediaBuffer && config.provider === 'meta' && mediaKind) {
      const ext = MEDIA_TYPE_EXTENSION[media_type] ?? 'bin';
      const uploadResult = await uploadMedia({
        phoneNumberId: config.phone_number_id,
        accessToken,
        buffer: mediaBuffer,
        mimeType: media_type,
        filename: `file_${Date.now()}.${ext}`,
      });
      uploadedMediaId = uploadResult.mediaId;
    }

    const attemptSend = async (phoneStr: string): Promise<string> => {
      if (mediaKind) {
        if (config.provider === 'waha') {
          const wahaConfig = {
            waha_url: config.waha_url,
            waha_session: config.waha_session,
            waha_api_key: config.waha_api_key,
          };
          if (hasMediaUrl) {
            if (mediaKind === 'audio') {
              const result = await sendWahaVoiceMessage(wahaConfig, phoneStr, media_url);
              return result.messageId;
            }
            const filename = media_url.split('?')[0].split('/').pop() || `file_${Date.now()}`;
            const result = await sendWahaMediaMessage(
              wahaConfig,
              phoneStr,
              media_url,
              mediaKind,
              filename,
              mediaCaption
            );
            return result.messageId;
          }
          // media_base64 — WAHA takes the base64 payload inline, no
          // upload step (unlike Meta).
          if (mediaKind === 'audio') {
            const result = await sendWahaVoiceMessageBase64(wahaConfig, phoneStr, {
              data: media_base64,
              mimetype: media_type,
            });
            return result.messageId;
          }
          const ext = MEDIA_TYPE_EXTENSION[media_type] ?? 'bin';
          const result = await sendWahaMediaMessageBase64(
            wahaConfig,
            phoneStr,
            { data: media_base64, mimetype: media_type, filename: `file_${Date.now()}.${ext}` },
            mediaCaption
          );
          return result.messageId;
        }

        // Meta
        if (hasMediaUrl) {
          const filename =
            mediaKind === 'document' ? media_url.split('?')[0].split('/').pop() || 'document' : undefined;
          const result = await sendMediaMessage({
            phoneNumberId: config.phone_number_id,
            accessToken,
            to: phoneStr,
            kind: mediaKind,
            link: media_url,
            caption: mediaCaption,
            filename,
          });
          return result.messageId;
        }
        // media_base64 — already uploaded above, send by id.
        const result = await sendMediaMessage({
          phoneNumberId: config.phone_number_id,
          accessToken,
          to: phoneStr,
          kind: mediaKind,
          id: uploadedMediaId!,
          caption: mediaCaption,
        });
        return result.messageId;
      }

      if (config.provider === 'waha') {
        const wahaConfig = {
          waha_url: config.waha_url,
          waha_session: config.waha_session,
          waha_api_key: config.waha_api_key,
        };
        const result = await sendWahaTextMessage(wahaConfig, phoneStr, targetText);
        return result.messageId;
      } else {
        const result = await sendTextMessage({
          phoneNumberId: config.phone_number_id,
          accessToken,
          to: phoneStr,
          text: targetText,
        });
        return result.messageId;
      }
    };

    // Retry sending with phone variants if Meta sandbox/trunk 0 issues occur
    try {
      const variants = phoneVariants(sanitizedPhone);
      let lastError: unknown = null;

      for (const variant of variants) {
        try {
          waMessageId = await attemptSend(variant);
          lastError = null;
          break;
        } catch (err) {
          if (config.provider === 'waha') {
            throw err; // Re-throw WAHA errors directly
          }
          const msg = err instanceof Error ? err.message : String(err);
          if (!isRecipientNotAllowedError(msg)) {
            throw err;
          }
          lastError = err;
        }
      }
      if (lastError) throw lastError;
    } catch (sendErr: any) {
      const msg = sendErr instanceof Error ? sendErr.message : 'Unknown send error';
      throw new ApiError('internal', `WhatsApp sending failed: ${msg}`, 502);
    }

    // 8. Record the sent message in the database
    const { data: messageRecord, error: msgInsertErr } = await ctx.supabase
      .from('messages')
      .insert({
        conversation_id: conversation.id,
        sender_type: 'bot',
        content_type: mediaKind ?? 'text',
        content_text: mediaKind ? mediaCaption ?? null : targetText,
        // Only hasMediaUrl gives us a fetchable URL to store — a
        // media_base64 send has no hosted copy (see file header comment).
        media_url: hasMediaUrl ? media_url : null,
        message_id: waMessageId,
        status: 'sent',
        waha_session: config.provider === 'waha' ? config.waha_session : null,
      })
      .select()
      .single();

    if (msgInsertErr || !messageRecord) {
      throw new ApiError('internal', `Message sent but failed to save in database: ${msgInsertErr?.message}`, 500);
    }

    // 9. Update last message state in conversation
    await ctx.supabase
      .from('conversations')
      .update({
        last_message_text: mediaKind ? mediaCaption ?? `[${mediaKind}]` : targetText,
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', conversation.id);

    return ok(
      {
        success: true,
        message_id: messageRecord.id,
        whatsapp_message_id: waMessageId,
        ...(uploadedMediaId ? { media_id: uploadedMediaId } : {}),
      },
      200,
      logCtx
    );

  } catch (err) {
    return toApiErrorResponse(err, logCtx);
  }
}

async function findOrCreateConversation(
  supabase: any,
  accountId: string,
  userId: string,
  contactId: string,
  wahaSession?: string
) {
  let query = supabase
    .from('conversations')
    .select('*, contact:contacts(*)')
    .eq('account_id', accountId)
    .eq('contact_id', contactId);

  if (wahaSession) {
    query = query.eq('waha_session', wahaSession);
  } else {
    query = query.is('waha_session', null);
  }

  const { data: existing } = await query.maybeSingle();
  if (existing) return existing;

  const insertObj: any = {
    account_id: accountId,
    user_id: userId,
    contact_id: contactId,
  };
  if (wahaSession) {
    insertObj.waha_session = wahaSession;
  }

  const { data: created, error } = await supabase
    .from('conversations')
    .insert(insertObj)
    .select('*, contact:contacts(*)')
    .single();

  if (error) {
    console.error('Error creating conversation in API send:', error.message);
    return null;
  }

  return created;
}
