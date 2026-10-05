import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { currentAuditInfo } from './context'

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
  /** 'action' = evento que não é CRUD (exportação, união de contatos). */
  eventType: 'created' | 'updated' | 'deleted' | 'action'
  resourceType: string
  resourceId: string
  resourceLabel?: string
  /** Ação específica, ex.: 'contact.merged', 'campaign.exported'. */
  action: string
  /** Frase legível mostrada na tela de auditoria. */
  summary: string
  changes?: Record<string, { before: unknown; after: unknown }>
  metadata?: Record<string, unknown>
}

// Eventos de aplicação que as triggers não enxergam (exportações, união de
// contatos). Mudanças de linha (contatos, conversas, campanhas, fluxos...)
// já são gravadas pelas triggers da migration 131 — não duplicar aqui.
//
// Autor, IP, navegador e origem vêm da requisição atual
// (src/lib/audit/context.ts), o mesmo contexto que as triggers recebem.
// Nunca derruba a ação do usuário: falha só vai para o log.
export async function logAuditEvent(params: AuditEventParams): Promise<void> {
  try {
    const info = await currentAuditInfo()
    let userName: string | null = null
    if (info?.userId) {
      const { data } = await supabaseAdmin()
        .from('profiles')
        .select('full_name')
        .eq('user_id', info.userId)
        .limit(1)
      userName = data?.[0]?.full_name ?? null
    }
    const { error } = await supabaseAdmin()
      .from('audit_logs')
      .insert({
        account_id: params.accountId,
        event_type: params.eventType,
        resource_type: params.resourceType,
        resource_id: params.resourceId,
        resource_label: params.resourceLabel ?? null,
        action: params.action,
        summary: params.summary.slice(0, 500),
        user_id: info?.userId ?? null,
        user_name: userName,
        ip_address: info?.ip ?? null,
        user_agent: info?.userAgent ?? null,
        actor_type: info?.actorType ?? 'system',
        source: info?.source ?? null,
        changes: params.changes ?? null,
        metadata: params.metadata ?? null,
      })
    if (error) console.error('[audit] logAuditEvent error:', error)
  } catch (err) {
    console.error('[audit] logAuditEvent failed:', err)
  }
}
