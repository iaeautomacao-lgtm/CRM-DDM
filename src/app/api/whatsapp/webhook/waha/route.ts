import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { event, session, payload } = body

    console.log('[waha/webhook] Received webhook event:', event, 'for session:', session)

    if (!event || !session || !payload) {
      return NextResponse.json({ error: 'Invalid WAHA webhook payload' }, { status: 400 })
    }

    const db = supabaseAdmin()

    // Resolve the account config based on the WAHA session name
    const { data: config, error: configError } = await db
      .from('whatsapp_config')
      .select('*')
      .eq('waha_session', session)
      .maybeSingle()

    if (configError || !config) {
      console.error(`[waha/webhook] Config not found for session "${session}":`, configError)
      return NextResponse.json({ error: 'Session configuration not found' }, { status: 404 })
    }

    const accountId = config.account_id

    // ============================================================
    // 1. Message status updates
    // ============================================================
    if (event === 'message.status') {
      const { id: messageId, status: wahaStatus } = payload
      let status: 'sent' | 'delivered' | 'read' | null = null

      if (wahaStatus === 'ACK_SERVER') status = 'sent'
      else if (wahaStatus === 'ACK_DEVICE') status = 'delivered'
      else if (wahaStatus === 'ACK_READ') status = 'read'

      if (status) {
        // Update message status in database
        const { error: updateError } = await db
          .from('messages')
          .update({ status })
          .eq('message_id', messageId)

        if (updateError) {
          console.error('[waha/webhook] Failed to update message status:', updateError)
        }
      }
      return NextResponse.json({ success: true })
    }

    // ============================================================
    // 1.5. Reaction Synchronization
    // ============================================================
    if (event === 'message.reaction') {
      console.log('[waha/webhook] Reaction payload:', JSON.stringify(payload))
      const { reaction, messageKey, fromMe } = payload
      const originalMessageId = messageKey?.id
      const emoji = reaction?.text

      if (!originalMessageId) {
        return NextResponse.json({ success: true, message: 'Ignored reaction without message key' })
      }

      const { data: dbMsg } = await db
        .from('messages')
        .select('id, conversation_id')
        .eq('message_id', originalMessageId)
        .maybeSingle()

      if (!dbMsg) {
        console.warn('[waha/webhook] Could not find message in database for reaction:', originalMessageId)
        return NextResponse.json({ success: true, message: 'Message not found for reaction' })
      }

      const actorType = fromMe ? 'agent' : 'customer'
      
      // Delete any existing reaction from this actor on this message
      await db
        .from('message_reactions')
        .delete()
        .eq('message_id', dbMsg.id)
        .eq('actor_type', actorType)

      // Insert the new reaction if an emoji is provided
      if (emoji) {
        const { error: insertError } = await db
          .from('message_reactions')
          .insert({
            message_id: dbMsg.id,
            conversation_id: dbMsg.conversation_id,
            actor_type: actorType,
            emoji: emoji,
          })

        if (insertError) {
          console.error('[waha/webhook] Failed to insert reaction:', insertError)
        }
      }

      return NextResponse.json({ success: true, message: 'Reaction synchronized' })
    }

    // ============================================================
    // 2. Incoming and outgoing message synchronization
    // ============================================================
    if (event === 'message.any') {
      console.log('[waha/webhook] Message event received. Payload:', JSON.stringify(payload))
      const { id: messageId, timestamp, from, to, body: textBody, fromMe, hasMedia, type, chatId } = payload
      
      let participantJid = fromMe ? to : from

      // Extract real phone JID if WAHA is sending a LID (WhatsApp internal ID)
      const senderAlt = payload._data?.Info?.SenderAlt
      const recipientAlt = payload._data?.Info?.RecipientAlt

      if (!fromMe && senderAlt && (senderAlt.endsWith('@s.whatsapp.net') || senderAlt.endsWith('@c.us'))) {
        participantJid = senderAlt
      } else if (fromMe && recipientAlt && (recipientAlt.endsWith('@s.whatsapp.net') || recipientAlt.endsWith('@c.us'))) {
        participantJid = recipientAlt
      }

      if (!participantJid) {
        console.warn('[waha/webhook] Ignored message due to missing participant JID')
        return NextResponse.json({ success: true, message: 'Ignored message without participant JID' })
      }

      // Determine the contact phone number
      // Inbound: from JID (e.g. 5511999999999@c.us)
      // Outbound: to JID
      const rawPhone = participantJid.split('@')[0].split(':')[0].split('.')[0]
      const phone = `+${rawPhone}` // Normalize to E.164 format with + prefix

      const direction = fromMe ? 'outbound' : 'inbound'

      // Ignore status broadcast updates (WhatsApp Stories), group messages, and channels/newsletters
      if (
        from === 'status@broadcast' || 
        to === 'status@broadcast' ||
        (from && (from.endsWith('@g.us') || from.endsWith('@newsletter'))) ||
        (to && (to.endsWith('@g.us') || to.endsWith('@newsletter'))) ||
        (chatId && (chatId.endsWith('@g.us') || chatId.endsWith('@newsletter')))
      ) {
        return NextResponse.json({ success: true, message: 'Ignored group, status broadcast or newsletter' })
      }
      
      // Check if message already exists in DB to prevent duplicates
      const { data: existingMsg } = await db
        .from('messages')
        .select('id')
        .eq('message_id', messageId)
        .maybeSingle()

      if (existingMsg) {
        return NextResponse.json({ success: true, message: 'Message already synchronized' })
      }

      // 1. Find or create contact
      let contactId: string | null = null
      let avatarUrl: string | null = null
      let contactName = rawPhone

      if (!fromMe) {
        contactName = 
          payload.sender?.name || 
          payload._data?.Info?.PushName || 
          payload.pushName || 
          payload.pushname ||
          payload._data?.notifyName || 
          payload._data?.pushname || 
          payload.sender?.pushName || 
          rawPhone
      }

      if (contactName && contactName.trim() === '.') {
        contactName = rawPhone
      }

      const { data: contactsList, error: contactFetchError } = await db
        .from('contacts')
        .select('id, avatar_url, name')
        .eq('account_id', accountId)
        .eq('phone', phone)

      if (contactFetchError) {
        console.error('[waha/webhook] Error fetching contacts:', contactFetchError)
      }

      const contact = contactsList && contactsList.length > 0 ? contactsList[0] : null

      if (contact) {
        contactId = contact.id
        avatarUrl = contact.avatar_url

        // If the contact name in the DB is just the raw phone (fallback) but we received a better notifyName, update it!
        const isFallbackName = contact.name === rawPhone || contact.name === phone
        if (contactName !== rawPhone && isFallbackName) {
          try {
            await db
              .from('contacts')
              .update({ name: contactName })
              .eq('id', contactId)
          } catch (e) {
            console.error('[waha/webhook] Failed to update contact name:', e)
          }
        }

        // If the contact exists but has no avatar, try to fetch and save it
        if (!avatarUrl) {
          try {
            const { getWahaProfilePicture } = await import('@/lib/whatsapp/waha-api')
            avatarUrl = await getWahaProfilePicture({
              waha_url: config.waha_url,
              waha_session: config.waha_session,
              waha_api_key: config.waha_api_key ? decrypt(config.waha_api_key) : null,
            }, phone)

            if (avatarUrl) {
              await db
                .from('contacts')
                .update({ avatar_url: avatarUrl })
                .eq('id', contactId)
            }
          } catch (e) {
            console.error('[waha/webhook] Failed to update avatar for existing contact:', e)
          }
        }
      } else {
        // Fetch avatar url from WAHA
        try {
          const { getWahaProfilePicture } = await import('@/lib/whatsapp/waha-api')
          avatarUrl = await getWahaProfilePicture({
            waha_url: config.waha_url,
            waha_session: config.waha_session,
            waha_api_key: config.waha_api_key ? decrypt(config.waha_api_key) : null,
          }, phone)
        } catch (e) {
          console.error('[waha/webhook] Failed to fetch avatar for new contact:', e)
        }

        // Create new contact
        const { data: newContact, error: contactCreateError } = await db
          .from('contacts')
          .insert({
            account_id: accountId,
            phone,
            name: contactName, // Save notifyName
            user_id: config.user_id, // link to session creator
            avatar_url: avatarUrl,
          })
          .select('id')
          .single()

        if (contactCreateError) {
          console.error('[waha/webhook] Failed to create contact:', contactCreateError)
          return NextResponse.json({ error: 'Failed to synchronize contact' }, { status: 500 })
        }
        contactId = newContact.id
      }

      // 2. Find or create conversation
      let conversationId: string | null = null
      const { data: convsList, error: convFetchError } = await db
        .from('conversations')
        .select('id, unread_count, assigned_agent_id')
        .eq('account_id', accountId)
        .eq('contact_id', contactId!)
        .eq('waha_session', session)

      if (convFetchError) {
        console.error('[waha/webhook] Error fetching conversations:', convFetchError)
      }

      const conversation = convsList && convsList.length > 0 ? convsList[0] : null

      if (conversation) {
        conversationId = conversation.id
      } else {
        // Create new conversation
        const { data: newConv, error: convCreateError } = await db
          .from('conversations')
          .insert({
            account_id: accountId,
            contact_id: contactId,
            status: 'open',
            unread_count: 0,
            user_id: config.user_id,
            waha_session: session,
          })
          .select('id')
          .single()

        if (convCreateError) {
          console.error('[waha/webhook] Failed to create conversation:', convCreateError)
          return NextResponse.json({ error: 'Failed to synchronize conversation' }, { status: 500 })
        }
        conversationId = newConv.id
      }

      // Extract media URL if present in WAHA payload.
      // We download the media from WAHA and upload it permanently to Supabase Storage (chat-media bucket)
      // to prevent files disappearing when the WAHA server cache is restarted or cleared.
      let mediaUrl: string | null = null
      const mediaInfo = payload.media || payload.sticker
      if (mediaInfo) {
        let fileKey = ''
        if (mediaInfo.url) {
          const parts = mediaInfo.url.split('/api/files/')
          if (parts.length > 1) {
            fileKey = parts[1]
          }
        }
        if (!fileKey && mediaInfo.filename) {
          fileKey = `${config.waha_session}/${mediaInfo.filename}`
        } else if (!fileKey && mediaInfo.id) {
          fileKey = `${config.waha_session}/${mediaInfo.id}.webp`
        }
        if (fileKey) {
          try {
            const apiKey = config.waha_api_key ? decrypt(config.waha_api_key) : null
            const headers: Record<string, string> = {}
            if (apiKey) {
              headers['Authorization'] = `Bearer ${apiKey}`
              headers['X-Api-Key'] = apiKey
            }

            const baseUrl = config.waha_url.replace(/\/$/, '')
            const fileUrl = `${baseUrl}/api/files/${fileKey}`
            console.log('[waha/webhook] Downloading media:', {
              url: fileUrl,
              apiKeyLength: apiKey ? apiKey.length : 0,
              apiKeySample: apiKey ? `${apiKey.substring(0, 8)}...${apiKey.substring(apiKey.length - 4)}` : 'null',
              headersKeys: Object.keys(headers)
            })
            const fileRes = await fetch(fileUrl, { headers })
            if (fileRes.ok) {
              const buffer = await fileRes.arrayBuffer()
              const contentType = fileRes.headers.get('Content-Type') || mediaInfo.mimetype || mediaInfo.mime_type || 'application/octet-stream'
              
              // Build file name and upload to account-scoped path in chat-media bucket
              const filename = fileKey.split('/').pop() || 'file'
              const storagePath = `account-${accountId}/${Date.now()}-${filename}`
              
              const { error: uploadError } = await db.storage
                .from('chat-media')
                .upload(storagePath, new Uint8Array(buffer), {
                  contentType,
                  cacheControl: '31536000',
                  upsert: true,
                })

              if (!uploadError) {
                const { data } = db.storage.from('chat-media').getPublicUrl(storagePath)
                mediaUrl = data.publicUrl
              } else {
                console.error('[waha/webhook] Supabase Storage upload failed:', uploadError.message)
                mediaUrl = `/api/whatsapp/media/waha?file=${fileKey}`
              }
            } else {
              console.error('[waha/webhook] Failed to download media from WAHA, status:', fileRes.status)
              mediaUrl = `/api/whatsapp/media/waha?file=${fileKey}`
            }
          } catch (err) {
            console.error('[waha/webhook] Media upload error:', err)
            mediaUrl = `/api/whatsapp/media/waha?file=${fileKey}`
          }
        }
      }

      // Map WAHA message types to CRM content_type.
      // Use mimetype-based classification if media details are available,
      // fallback to type-based mapping.
      const hasPollStructure = payload._data?.Message?.pollCreationMessage || 
                               payload._data?.Message?.pollCreationMessageV2 || 
                               payload._data?.Message?.pollCreationMessageV3 || 
                               payload.poll

      const hasVcardStructure = payload._data?.Message?.contactMessage || 
                                payload._data?.Message?.contactsArrayMessage || 
                                payload.vcard || 
                                (payload.vCards && payload.vCards.length > 0) ||
                                payload._data?.Info?.MediaType === 'vcard'

      const rawType = type || payload._data?.Info?.Type || ''
      let contentType: 'text' | 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'poll' | 'vcard' | 'revoked' = 'text'

      if (hasPollStructure || rawType === 'poll' || rawType === 'poll_creation' || rawType === 'pollCreation') {
        contentType = 'poll'
      } else if (hasVcardStructure || rawType === 'vcard' || rawType === 'contact') {
        contentType = 'vcard'
      } else if (rawType === 'revoked') {
        contentType = 'revoked'
      } else if (mediaInfo) {
        const mime = mediaInfo.mimetype || mediaInfo.mime_type || ''
        if (mime.startsWith('image/')) {
          contentType = rawType === 'sticker' ? 'sticker' : 'image'
        }
        else if (mime.startsWith('video/')) contentType = 'video'
        else if (mime.startsWith('audio/')) contentType = 'audio'
        else if (rawType === 'sticker') contentType = 'sticker'
        else contentType = 'document'
      } else {
        if (rawType === 'image') contentType = 'image'
        else if (rawType === 'sticker') contentType = 'sticker'
        else if (rawType === 'video') contentType = 'video'
        else if (rawType === 'audio' || rawType === 'ptt') contentType = 'audio'
        else if (rawType === 'document') contentType = 'document'
      }

      let contentText = textBody || ''
      if (contentType === 'poll' && !contentText) {
        const pollMsg = payload._data?.Message?.pollCreationMessage || 
                        payload._data?.Message?.pollCreationMessageV2 || 
                        payload._data?.Message?.pollCreationMessageV3 ||
                        payload.poll
        if (pollMsg?.name) {
          contentText = pollMsg.name
        }
      }
      if (contentType === 'vcard' && !contentText) {
        const contactMsg = payload._data?.Message?.contactMessage || payload.vcard
        if (contactMsg?.displayName) {
          contentText = contactMsg.displayName
        } else if (contactMsg?.name) {
          contentText = contactMsg.name
        } else if (payload._data?.Message?.contactsArrayMessage?.contacts?.[0]?.displayName) {
          contentText = payload._data.Message.contactsArrayMessage.contacts[0].displayName
        } else if (payload.vCards && payload.vCards.length > 0) {
          const fnMatch = payload.vCards[0].match(/FN:(.+)/)
          if (fnMatch) {
            contentText = fnMatch[1].trim()
          }
        }
      }

      const messageDate = new Date(timestamp * 1000).toISOString()

      console.log('[waha/webhook] Attempting to insert message in DB:', {
        conversation_id: conversationId,
        message_id: messageId,
        sender_type: fromMe ? 'agent' : 'customer',
        content_type: contentType,
        media_url: mediaUrl,
        created_at: messageDate,
      })

      // 3. Insert the message record
      const { error: msgInsertError } = await db
        .from('messages')
        .insert({
          conversation_id: conversationId,
          message_id: messageId,
          sender_type: fromMe ? 'agent' : 'customer',
          content_type: contentType,
          content_text: contentText,
          media_url: mediaUrl,
          status: direction === 'inbound' ? 'read' : 'sent',
          created_at: messageDate,
          waha_session: session,
        })

      if (msgInsertError) {
        console.error('[waha/webhook] Failed to insert message database error:', JSON.stringify(msgInsertError))
        return NextResponse.json({ error: 'Failed to insert message', details: msgInsertError.message }, { status: 500 })
      }

      // 4. Update the conversation values
      const updates: Record<string, any> = {
        last_message_text: contentType === 'text' ? (textBody || '') : `[${contentType}]`,
        last_message_at: messageDate,
        updated_at: new Date().toISOString(),
      }

      if (direction === 'inbound') {
        updates.unread_count = (conversation?.unread_count || 0) + 1
      }

      const { error: convUpdateError } = await db
        .from('conversations')
        .update(updates)
        .eq('id', conversationId)

      if (convUpdateError) {
        console.error('[waha/webhook] Failed to update conversation values:', convUpdateError)
      }

      // Trigger AI Auto Response if the message is inbound and conversation is unassigned
      if (direction === 'inbound' && !conversation?.assigned_agent_id && contactId && conversationId) {
        const { handleAiAutoResponse } = await import('@/lib/ai/responder')
        void handleAiAutoResponse(accountId, contactId, conversationId, textBody || '')
      }

      // Trigger Sentiment and Auto-Tagging Analysis
      if (direction === 'inbound' && contactId && conversationId) {
        const { analyzeConversationSentimentAndTags } = await import('@/lib/ai/sentiment')
        void analyzeConversationSentimentAndTags(accountId, contactId, conversationId)
      }

      return NextResponse.json({ success: true })
    }

    return NextResponse.json({ success: true, message: `Ignored event: ${event}` })
  } catch (err: any) {
    console.error('[waha/webhook] handler crashed:', err)
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 })
  }
}
