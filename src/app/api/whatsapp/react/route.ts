import { NextResponse } from 'next/server';
import { fetchChannelConfigs } from '@/lib/whatsapp/channel-config'
import { guardPermission } from '@/lib/auth/route-guard';
import { sendReactionMessage } from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';
import { sendWahaReaction } from '@/lib/whatsapp/waha-api';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

/**
 * POST /api/whatsapp/react
 *
 * Body: { message_id: <internal UUID>, emoji: <single emoji or "" to remove> }
 *
 * Sends the reaction to Meta and mirrors it into `message_reactions`
 * (delete on empty emoji). Customer-side reactions are handled by the
 * webhook — this route only writes `actor_type = 'agent'` rows.
 */
export async function POST(request: Request) {
  try {
    const auth = await guardPermission('inbox.reply');
    if (!auth.ok) return auth.response;
    const { supabase, accountId, userId } = auth.ctx;

    const limit = checkRateLimit(`react:${userId}`, RATE_LIMITS.react);
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json();
    const { message_id, emoji } = body as {
      message_id?: string;
      emoji?: string;
    };

    if (!message_id || typeof emoji !== 'string') {
      return NextResponse.json(
        { error: 'message_id and emoji are required' },
        { status: 400 },
      );
    }

    // Resolve target message + its conversation; verify ownership.
    const { data: targetMessage, error: msgError } = await supabase
      .from('messages')
      .select('id, message_id, conversation_id')
      .eq('id', message_id)
      .maybeSingle();

    if (msgError || !targetMessage) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 });
    }

    if (!targetMessage.message_id) {
      // No Meta ID yet — usually a sending/failed agent message. We can't
      // tell Meta to react to a message it never received.
      return NextResponse.json(
        { error: 'Cannot react to a message that has not been sent to WhatsApp' },
        { status: 400 },
      );
    }

    const { data: conversation, error: convError } = await supabase
      .from('conversations')
      .select('id, account_id, contact:contacts(phone)')
      .eq('id', targetMessage.conversation_id)
      .eq('account_id', accountId)
      .maybeSingle();

    if (convError || !conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 },
      );
    }

    const contact = Array.isArray(conversation.contact)
      ? conversation.contact[0]
      : conversation.contact;
    if (!contact?.phone) {
      return NextResponse.json(
        { error: 'Contact phone number not found' },
        { status: 400 },
      );
    }

    // WhatsApp config + access token. Account-scoped post-multi-user.
    // Segredos só pelo servidor (migration 200b); visibilidade = RLS do usuário.
    // Exatamente 1 canal, como o .single() anterior (vários = erro, nunca "o primeiro").
    const { data: configRows, error: configError } = await fetchChannelConfigs(
      supabase,
      accountId,
      (q) => q.eq('account_id', accountId),
      'phone_number_id, access_token, provider, waha_url, waha_session, waha_api_key',
    );
    const config = configRows?.length === 1 ? (configRows[0] as any) : null;

    if (configError || !config) {
      return NextResponse.json(
        { error: 'WhatsApp not configured.' },
        { status: 400 },
      );
    }

    if (config.provider === 'waha') {
      const wahaConfig = {
        waha_url: config.waha_url,
        waha_session: config.waha_session,
        waha_api_key: config.waha_api_key ? decrypt(config.waha_api_key) : null,
      };

      try {
        await sendWahaReaction(
          wahaConfig,
          targetMessage.message_id,
          emoji
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown WAHA API error';
        console.error('[whatsapp/react] WAHA reaction failed:', message);
        return NextResponse.json(
          { error: `WAHA API error: ${message}` },
          { status: 502 },
        );
      }
    } else {
      const accessToken = decrypt(config.access_token);
      const sanitizedPhone = sanitizePhoneForMeta(contact.phone);

      try {
        await sendReactionMessage({
          phoneNumberId: config.phone_number_id,
          accessToken,
          to: sanitizedPhone,
          targetMessageId: targetMessage.message_id,
          emoji,
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Unknown Meta API error';
        console.error('[whatsapp/react] Meta send failed:', message);
        return NextResponse.json(
          { error: `Meta API error: ${message}` },
          { status: 502 },
        );
      }
    }

    // Mirror into DB. Empty emoji = removal.
    if (emoji === '') {
      const { error: delError } = await supabase
        .from('message_reactions')
        .delete()
        .eq('message_id', targetMessage.id)
        .eq('actor_type', 'agent')
        .eq('actor_id', userId);

      if (delError) {
        console.error('[whatsapp/react] DB delete failed:', delError.message);
        return NextResponse.json(
          { error: 'Reaction sent to Meta but DB delete failed' },
          { status: 500 },
        );
      }
    } else {
      // Upsert. The unique constraint (message_id, actor_type, actor_id)
      // lets us swap emoji in a single statement.
      const { error: upsertError } = await supabase.from('message_reactions').upsert(
        {
          message_id: targetMessage.id,
          conversation_id: targetMessage.conversation_id,
          actor_type: 'agent',
          actor_id: userId,
          emoji,
        },
        { onConflict: 'message_id,actor_type,actor_id' },
      );

      if (upsertError) {
        console.error('[whatsapp/react] DB upsert failed:', upsertError.message);
        return NextResponse.json(
          { error: 'Reaction sent to Meta but DB upsert failed' },
          { status: 500 },
        );
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error in WhatsApp react POST:', error);
    return NextResponse.json(
      { error: 'Failed to react to message' },
      { status: 500 },
    );
  }
}
