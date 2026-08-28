import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder'
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard'
import {
  sendWahaTextMessage,
  sendWahaMediaMessage,
} from '@/lib/whatsapp/waha-api'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'

interface BroadcastResult {
  phone: string
  status: 'sent' | 'failed'
  whatsapp_message_id?: string
  error?: string
}

interface NewRecipient {
  phone: string
  params?: string[]
  messageParams?: SendTimeParams
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const limit = checkRateLimit(`broadcast:${user.id}`, RATE_LIMITS.broadcast)
    if (!limit.success) {
      return rateLimitResponse(limit)
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const body = await request.json()
    const {
      recipients: newRecipients,
      phone_numbers,
      template_name,
      template_language,
      template_params,
      configId,
    } = body

    let recipients: NewRecipient[]
    if (Array.isArray(newRecipients) && newRecipients.length > 0) {
      recipients = newRecipients
    } else if (Array.isArray(phone_numbers) && phone_numbers.length > 0) {
      const shared: string[] = Array.isArray(template_params)
        ? template_params
        : []
      recipients = phone_numbers.map((phone: string) => ({
        phone,
        params: shared,
      }))
    } else {
      return NextResponse.json(
        {
          error:
            'Provide either `recipients` (preferred) or `phone_numbers` — must be a non-empty array',
        },
        { status: 400 }
      )
    }

    if (!template_name) {
      return NextResponse.json(
        { error: 'template_name is required' },
        { status: 400 }
      )
    }

    let configQuery = supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)

    if (configId) {
      configQuery = configQuery.eq('id', configId)
    }

    const { data: configList, error: configError } = await configQuery.limit(1)
    const config = configList?.[0]

    if (configError || !config) {
      return NextResponse.json(
        {
          error:
            'WhatsApp not configured. Please set up your WhatsApp integration first.',
        },
        { status: 400 }
      )
    }

    const isWaha = config.provider === 'waha'
    const wahaConfig = isWaha ? {
      waha_url: config.waha_url,
      waha_session: config.waha_session,
      waha_api_key: config.waha_api_key,
    } : null

    const accessToken = isWaha ? '' : decrypt(config.access_token)

    const { data: rawTemplateRow } = await supabase
      .from('message_templates')
      .select('*')
      .eq('account_id', accountId)
      .eq('name', template_name)
      .eq('language', template_language || 'en_US')
      .maybeSingle()
    if (rawTemplateRow && !isMessageTemplate(rawTemplateRow)) {
      return NextResponse.json(
        {
          error:
            'Template row is malformed locally — run "Sync from Meta" in Settings to repair it before broadcasting.',
        },
        { status: 500 },
      )
    }
    const templateRow = rawTemplateRow ?? null

    const results: BroadcastResult[] = []
    let sentCount = 0
    let failedCount = 0

    for (const recipient of recipients) {
      const sanitized = sanitizePhoneForMeta(recipient.phone)

      if (!isValidE164(sanitized)) {
        results.push({
          phone: recipient.phone,
          status: 'failed',
          error: 'Invalid phone number format',
        })
        failedCount++
        continue
      }

      const variants = phoneVariants(sanitized)
      let sentMessageId: string | null = null
      let lastError: string | null = null

      for (const variant of variants) {
        try {
          if (isWaha) {
            let text = `Template: ${template_name}`
            if (templateRow) {
              let bodyText = templateRow.body_text
              const params = recipient.params || []
              params.forEach((param: any, idx: number) => {
                const val = typeof param === 'string' ? param : (param.text || '')
                bodyText = bodyText.replace(new RegExp(`\\{\\{${idx + 1}\\}\\}`, 'g'), val)
              })
              text = bodyText
            }
            const headerMediaUrl = recipient.messageParams?.headerMediaUrl
            if (headerMediaUrl && templateRow?.header_type && ['image', 'video', 'document', 'audio'].includes(templateRow.header_type)) {
              const result = await sendWahaMediaMessage(
                wahaConfig!,
                variant,
                headerMediaUrl,
                templateRow.header_type as any,
                'media',
                text
              )
              sentMessageId = result.messageId
            } else {
              const result = await sendWahaTextMessage(wahaConfig!, variant, text)
              sentMessageId = result.messageId
            }
            lastError = null
            break
          } else {
            const result = await sendTemplateMessage({
              phoneNumberId: config.phone_number_id,
              accessToken,
              to: variant,
              templateName: template_name,
              language: template_language || 'en_US',
              template: templateRow ?? undefined,
              messageParams: recipient.messageParams,
              params: recipient.params ?? [],
            })
            sentMessageId = result.messageId
            lastError = null
            break
          }
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : 'Unknown error'
          if (isWaha) {
            lastError = errorMessage
            break
          }
          if (!isRecipientNotAllowedError(errorMessage)) {
            lastError = errorMessage
            break
          }
          lastError = errorMessage
        }
      }

      if (sentMessageId) {
        results.push({
          phone: recipient.phone,
          status: 'sent',
          whatsapp_message_id: sentMessageId,
        })
        sentCount++
      } else {
        console.error(
          `Failed to send broadcast to ${recipient.phone}:`,
          lastError
        )
        results.push({
          phone: recipient.phone,
          status: 'failed',
          error: lastError || 'Unknown error',
        })
        failedCount++
      }
    }

    return NextResponse.json({
      success: true,
      total: recipients.length,
      sent: sentCount,
      failed: failedCount,
      results,
    })
  } catch (error) {
    console.error('Error in WhatsApp broadcast POST:', error)
    return NextResponse.json(
      { error: 'Failed to process broadcast' },
      { status: 500 }
    )
  }
}
