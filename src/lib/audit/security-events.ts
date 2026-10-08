// Eventos de auditoria de segurança gravados PELO APP (PRD 20, 20.8 — complemento da migration 248): redefinição de
// senha de membro e criação/revogação de chave de API. Não há linha de tabela do `wacrm` que um trigger enxergue para
// a senha (ela vive em auth.users) e as chaves só mudam por estas rotas, então o app grava, como já faz com
// exportações (logAuditEvent).
//
// Os builders são PUROS e montam o evento só a partir de campos EXPLÍCITOS: nunca recebem a senha, o texto da chave
// (`plaintext`) nem o hash (`key_hash`) — o tipo de entrada nem tem esses campos. Teste: security-events.test.ts.

import type { AuditEventParams } from './log-event'

export interface PasswordResetInput {
  accountId: string
  /** profiles.id do membro (resource_id do evento, como nos demais eventos de membro). */
  memberProfileId: string
  targetUserId: string
  targetName: string | null
  actorUserId: string
}

/** member.password_reset — quem redefiniu a senha de quem. Sem senha, sem hash. */
export function passwordResetEvent(input: PasswordResetInput): AuditEventParams {
  const name = input.targetName?.trim() || 'Membro'
  return {
    accountId: input.accountId,
    eventType: 'action',
    resourceType: 'member',
    resourceId: input.memberProfileId,
    resourceLabel: name,
    action: 'member.password_reset',
    summary: `Senha de ${name} redefinida por um administrador da organização`,
    metadata: { target_user_id: input.targetUserId, reset_by_user_id: input.actorUserId },
  }
}

export interface ApiKeyEventInput {
  accountId: string
  keyId: string
  name: string
  scopes: readonly string[]
  /** Chave pessoal (ligada ao usuário que a criou — escopo intelligence:read). */
  personal: boolean
  /** Dono da chave pessoal (user_id) ou null para chave da conta. */
  ownerUserId: string | null
}

function apiKeyMetadata(input: ApiKeyEventInput, extra: Record<string, unknown>): Record<string, unknown> {
  return { scopes: [...input.scopes], personal: input.personal, owner_user_id: input.ownerUserId, ...extra }
}

/** api_key.created — id, nome, escopos e se é pessoal. NUNCA o segredo nem o hash. */
export function apiKeyCreatedEvent(input: ApiKeyEventInput & { expiresAt: string | null }): AuditEventParams {
  return {
    accountId: input.accountId,
    eventType: 'created',
    resourceType: 'api_key',
    resourceId: input.keyId,
    resourceLabel: input.name,
    action: 'api_key.created',
    summary: `Chave de API ${input.name}${input.personal ? ' (pessoal)' : ''} criada`,
    metadata: apiKeyMetadata(input, { expires_at: input.expiresAt }),
  }
}

/** api_key.revoked — mesmos campos, sem segredo. */
export function apiKeyRevokedEvent(input: ApiKeyEventInput): AuditEventParams {
  return {
    accountId: input.accountId,
    eventType: 'updated',
    resourceType: 'api_key',
    resourceId: input.keyId,
    resourceLabel: input.name,
    action: 'api_key.revoked',
    summary: `Chave de API ${input.name}${input.personal ? ' (pessoal)' : ''} revogada`,
    metadata: apiKeyMetadata(input, {}),
  }
}
