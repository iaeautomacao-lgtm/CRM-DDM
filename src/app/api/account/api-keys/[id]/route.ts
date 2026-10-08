// ============================================================
// DELETE /api/account/api-keys/[id] — revoke a key.
//
// Soft revoke: sets `revoked_at` rather than deleting the row, so
// the key's name/prefix stay visible in the roster as an audit
// trail ("this key existed and was turned off") and so the auth
// path's liveness check (`findActiveKeyByHash` filters revoked
// rows) starts rejecting it immediately. Admin+, enforced here and
// by the `api_keys_update` RLS policy.
//
// Revocation is effective on the next request: once `revoked_at` is
// set, `findActiveKeyByHash` returns null and the key 401s.
//
// Supervisor (PRD-04 Fase 3): revoga SÓ a própria chave pessoal
// (user_id = ele). Como a RLS de update é admin+, esse caminho usa o
// service role com conta e dono no filtro.
// ============================================================

import { NextResponse } from 'next/server';

import { requirePermission, toErrorResponse } from '@/lib/auth/account';
import { can } from '@/lib/auth/permissions';
import { logAuditEvent } from '@/lib/audit/log-event';
import { apiKeyRevokedEvent } from '@/lib/audit/security-events';
import { isPersonalKeyScopes } from '@/lib/api-keys/personal';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requirePermission('api_keys.view');
    // Gerencia as chaves da conta (api_keys.manage) ou revoga só a pessoal (intelligence.personal_key).
    const isAdmin = can(ctx, 'api_keys.manage');
    if (!isAdmin && !can(ctx, 'intelligence.personal_key')) {
      return NextResponse.json({ error: 'Insufficient role' }, { status: 403 });
    }

    const limit = checkRateLimit(
      `admin:apiKeyRevoke:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;

    // Scope the update by account_id as well as id so an admin can
    // never revoke another account's key by guessing a UUID. (RLS
    // already enforces this; the explicit filter is belt-and-braces
    // and makes the "0 rows updated → 404" path precise.)
    // Supervisor: só a chave pessoal dele (dono no filtro → 404 nas outras).
    let query = (isAdmin ? ctx.supabase : supabaseAdmin())
      .from('api_keys')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .is('revoked_at', null);
    if (!isAdmin) query = query.eq('user_id', ctx.userId);
    const { data, error } = await query.select('id, name, scopes, user_id').maybeSingle();

    if (error) {
      console.error('[DELETE /api/account/api-keys/[id]] error:', error);
      return NextResponse.json(
        { error: 'Failed to revoke API key' },
        { status: 500 }
      );
    }
    if (!data) {
      // Either no such key in this account, or it was already revoked.
      return NextResponse.json(
        { error: 'API key not found or already revoked' },
        { status: 404 }
      );
    }

    // 20.8: revogação auditada (sem segredo/hash).
    const scopes = Array.isArray(data.scopes) ? (data.scopes as string[]) : [];
    await logAuditEvent(
      apiKeyRevokedEvent({
        accountId: ctx.accountId,
        keyId: data.id as string,
        name: (data.name as string | null) ?? 'chave',
        scopes,
        personal: isPersonalKeyScopes(scopes),
        ownerUserId: (data.user_id as string | null) ?? null,
      }),
    );

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
