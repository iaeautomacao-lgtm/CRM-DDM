import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Lazy, shared service-role client for audit logging.
// Mirrors the pattern used by src/lib/automations/admin-client.ts and
// src/lib/flows/admin-client.ts.
let _adminClient: SupabaseClient | null = null

function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      {
        db: {
          schema: 'wacrm',
        },
      }
    ) as any
  }
  return _adminClient!
}

export interface AuditEventParams {
  accountId: string
  eventType: 'created' | 'updated' | 'deleted'
  resourceType: string
  resourceId: string
  resourceLabel?: string
  userId?: string
  userName?: string
  ipAddress?: string
  changes?: Record<string, { before: unknown; after: unknown }>
}

// For manual UI actions where we have user/IP context (e.g. an agent
// editing a contact, closing a conversation by hand). System-side
// changes (webhooks, automations) are captured instead by the DB
// triggers in supabase/migrations/050_audit_logs.sql, which have no
// user/IP context and leave those columns NULL.
export async function logAuditEvent(params: AuditEventParams) {
  const { error } = await supabaseAdmin()
    .from('audit_logs')
    .insert({
      account_id: params.accountId,
      event_type: params.eventType,
      resource_type: params.resourceType,
      resource_id: params.resourceId,
      resource_label: params.resourceLabel ?? null,
      user_id: params.userId ?? null,
      user_name: params.userName ?? null,
      ip_address: params.ipAddress ?? null,
      changes: params.changes ?? null,
    })

  if (error) console.error('[audit] logAuditEvent error:', error)
}
