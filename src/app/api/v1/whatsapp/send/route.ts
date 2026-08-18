// ============================================================
// POST /api/v1/whatsapp/send — Public API route to send WhatsApp messages.
//
// Authenticates via bearer token (Authorization: Bearer wacrm_live_...)
// using the 'messages:send' scope. Find-or-creates the target contact 
// and conversation, sends the text message using the active channel 
// provider (WAHA or Meta), and records the message in the database.
// ============================================================

import { NextResponse } from 'next/server';
import { requireApiKey } from '@/lib/auth/api-context';
import { sendTextMessage } from '@/lib/whatsapp/meta-api';
import { sendWahaTextMessage } from '@/lib/whatsapp/waha-api';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import { ok, toApiErrorResponse } from '@/lib/api/v1/respond';

export async function POST(request: Request) {
  try {
    // 1. Authenticate API Key with 'messages:send' scope
    const ctx = await requireApiKey(request, 'messages:send');

    // 2. Parse request body
    const body = await request.json();
    const { to, phone, text, message, name } = body;
    
    const targetPhone = phone || to;
    const targetText = message || text;

    if (!targetPhone || !targetText) {
      return NextResponse.json(
        { error: 'Both phone (or to) and text (or message) are required' },
        { status: 400 }
      );
    }

    // 3. Sanitize and validate phone number
    const sanitizedPhone = sanitizePhoneForMeta(targetPhone);
    if (!isValidE164(sanitizedPhone)) {
      return NextResponse.json(
        { error: 'Invalid phone number format. Must be in E.164 format (ex: +5527999991212)' },
        { status: 400 }
      );
    }

    // 4. Fetch WhatsApp config for this account
    const { data: config, error: configError } = await ctx.supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', ctx.accountId)
      .maybeSingle();

    if (configError || !config) {
      return NextResponse.json(
        { error: 'WhatsApp is not configured for this account.' },
        { status: 400 }
      );
    }

    // 5. Find or create Contact
    let { data: contactRow } = await ctx.supabase
      .from('contacts')
      .select('*')
      .eq('phone', sanitizedPhone)
      .eq('account_id', ctx.accountId)
      .maybeSingle();

    if (!contactRow) {
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

      if (createContactErr || !newContact) {
        return NextResponse.json(
          { error: `Failed to create contact: ${createContactErr?.message}` },
          { status: 500 }
        );
      }
      contactRow = newContact;
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
      return NextResponse.json(
        { error: 'Failed to open a conversation for this contact.' },
        { status: 500 }
      );
    }

    // 7. Send the message via active provider (WAHA or Meta API)
    let waMessageId = '';
    let accessToken = '';
    if (config.provider === 'meta') {
      accessToken = decrypt(config.access_token);
    }

    const attemptSend = async (phoneStr: string): Promise<string> => {
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
      return NextResponse.json(
        { error: `WhatsApp sending failed: ${msg}` },
        { status: 502 }
      );
    }

    // 8. Record the sent message in the database
    const { data: messageRecord, error: msgInsertErr } = await ctx.supabase
      .from('messages')
      .insert({
        conversation_id: conversation.id,
        sender_type: 'bot',
        content_type: 'text',
        content_text: targetText,
        message_id: waMessageId,
        status: 'sent',
        waha_session: config.provider === 'waha' ? config.waha_session : null,
      })
      .select()
      .single();

    if (msgInsertErr || !messageRecord) {
      return NextResponse.json(
        { error: `Message sent but failed to save in database: ${msgInsertErr?.message}` },
        { status: 500 }
      );
    }

    // 9. Update last message state in conversation
    await ctx.supabase
      .from('conversations')
      .update({
        last_message_text: targetText,
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', conversation.id);

    return ok({
      success: true,
      message_id: messageRecord.id,
      whatsapp_message_id: waMessageId,
    });

  } catch (err: any) {
    console.error('[api/v1/whatsapp/send] Error:', err);
    return NextResponse.json(
      { 
        error: { 
          code: 'internal_detailed', 
          message: err instanceof Error ? `${err.name}: ${err.message}` : String(err) 
        } 
      },
      { status: 500 }
    );
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
