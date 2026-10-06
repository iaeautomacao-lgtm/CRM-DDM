import { NextResponse } from 'next/server'
import { guardRole } from '@/lib/auth/route-guard'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import type { AutomationTriggerType } from '@/types'

const AUTOMATION_TRIGGER_TYPES = new Set<string>([
  'new_message_received',
  'first_inbound_message',
  'keyword_match',
  'new_contact_created',
  'conversation_assigned',
  'tag_added',
  'time_based',
] satisfies AutomationTriggerType[])

/**
 * Manual trigger for testing or for external integrations that want
 * to fire automations. Owner/admin only — we resolve the caller's
 * account_id and dispatch over the account's automations.
 */
export async function POST(request: Request) {
  // Dispara automações da conta com service role: só owner/admin.
  const auth = await guardRole('admin')
  if (!auth.ok) return auth.response
  const { accountId } = auth.ctx

  const body = await request.json().catch(() => null)
  if (!body?.trigger_type) {
    return NextResponse.json({ error: 'trigger_type required' }, { status: 400 })
  }
  if (!AUTOMATION_TRIGGER_TYPES.has(body.trigger_type)) {
    return NextResponse.json({ error: 'trigger_type inválido' }, { status: 400 })
  }

  await runAutomationsForTrigger({
    accountId,
    triggerType: body.trigger_type as AutomationTriggerType,
    contactId: body.contact_id ?? null,
    context: body.context ?? {},
  })

  return NextResponse.json({ ok: true })
}
