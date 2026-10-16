// Admin-only change of identity on /usuarios.
// Login email belongs to Supabase Auth; display name/email to wacrm.profiles.
// No migrations: we update both stores and attempt compensation if the
// second write fails. The target account check is mandatory: service_role
// bypasses RLS and must never accept an arbitrary userId from another tenant.
import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/account/admin-client';
import { validateMemberIdentity } from '@/lib/account/member-identity';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { writeLog } from '@/lib/logger';

const noStore = { 'Cache-Control': 'private, no-store' };

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(
      `admin:memberIdentity:${ctx.userId}`, RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const origin = request.headers.get('origin');
    if (origin && origin !== new URL(request.url).origin) {
      return NextResponse.json({ error: 'Origem não permitida' }, { status: 403 });
    }

    const { userId } = await params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
      return NextResponse.json({ error: 'Usuário inválido' }, { status: 400 });
    }
    if (userId === ctx.userId) {
      return NextResponse.json({
        error: 'Use suas configurações de perfil para alterar seus próprios dados',
      }, { status: 400 });
    }

    const parsed = validateMemberIdentity(await request.json().catch(() => null));
    if (!parsed.valid) {
      return NextResponse.json({ error: parsed.message }, { status: 400 });
    }
    const { full_name, email } = parsed.data;
    const admin = supabaseAdmin();

    const { data: target, error: lookupError } = await admin.from('profiles')
      .select('user_id,account_role,full_name,email')
      .eq('account_id', ctx.accountId)
      .eq('user_id', userId)
      .maybeSingle();
    if (lookupError) throw lookupError;
    if (!target) return NextResponse.json({ error: 'Usuário não encontrado nesta organização' }, { status: 404 });

    // Don't allow account-owner changes, or admin-to-admin account takeover.
    // Owner may edit regular admins, but not their own identity here.
    if (target.account_role === 'owner' ||
        (target.account_role === 'admin' && ctx.role !== 'owner')) {
      return NextResponse.json({ error: 'Sem permissão para alterar este usuário' }, { status: 403 });
    }

    const { data: authResult, error: authReadError } = await admin.auth.admin.getUserById(userId);
    if (authReadError || !authResult?.user?.email) {
      console.error('[members/identity] Auth user unavailable', authReadError?.code ?? 'missing_email');
      return NextResponse.json({ error: 'Não foi possível validar o e-mail de login' }, { status: 500 });
    }

    const previousEmail = authResult.user.email;
    const emailChanged = previousEmail.toLowerCase() !== email;
    const nameChanged = (target.full_name ?? '') !== full_name;
    if (!emailChanged && !nameChanged && target.email?.toLowerCase() === email) {
      return NextResponse.json({ ok: true, member: { user_id: userId, full_name, email } }, { headers: noStore });
    }

    if (emailChanged) {
      // Admin API updates directly; this does NOT initiate self-service email confirmation.
      // Only owners/admins scoped to the same account can execute it.
      const { error: authWriteError } = await admin.auth.admin.updateUserById(userId, {
        email,
        email_confirm: true,
      });
      if (authWriteError) {
        const message = (authWriteError.message ?? '').toLowerCase();
        const conflict = authWriteError.code === 'email_exists' ||
          message.includes('already') || message.includes('exists') ||
          message.includes('registered');
        return NextResponse.json({
          error: conflict ? 'Este e-mail já pertence a outra conta' : 'Não foi possível atualizar o e-mail de login',
        }, { status: conflict ? 409 : 422 });
      }
    }

    let updated: { user_id: string; full_name: string; email: string } | null = null;
    let profileWriteError: { code?: string } | null = null;
    try {
      const result = await admin.from('profiles')
        .update({ full_name, email })
        .eq('account_id', ctx.accountId)
        .eq('user_id', userId)
        .select('user_id,full_name,email')
        .single();
      updated = result.data;
      profileWriteError = result.error;
    } catch {
      profileWriteError = { code: 'network_error' };
    }

    if (profileWriteError || !updated) {
      // Best-effort compensation: restore the old Auth email if the
      // account profile could not be saved. Never claim success if
      // the databases disagree.
      if (emailChanged) {
        let rollbackFailed = false;
        try {
          const { error: rollbackError } = await admin.auth.admin.updateUserById(userId, {
            email: previousEmail, email_confirm: true,
          });
          if (rollbackError) rollbackFailed = true;
        } catch {
          rollbackFailed = true;
        }
        if (rollbackFailed) {
          console.error('[members/identity] CRITICAL: Auth rollback failed', {
            userId, code: 'auth_rollback_failed',
          });
          return NextResponse.json({
            error: 'A alteração foi parcial. Solicite ao suporte a revisão do e-mail antes de continuar.',
          }, { status: 500 });
        }
      }
      console.error('[members/identity] profile update failed', profileWriteError?.code ?? 'no_row');
      return NextResponse.json({ error: 'Não foi possível salvar os dados do usuário' }, { status: 500 });
    }

    await writeLog({
      account_id: ctx.accountId, level: 'info', source: 'system',
      event: 'member_identity_updated',
      message: 'Dados cadastrais de usuário atualizados por administrador',
      payload: {
        actor_id: ctx.userId, target_user_id: userId,
        name_changed: nameChanged, email_changed: emailChanged,
      },
    });
    return NextResponse.json({
      ok: true,
      member: { user_id: userId, full_name: updated.full_name, email: updated.email },
      email_changed: emailChanged,
    }, { headers: noStore });
  } catch (err) {
    return toErrorResponse(err);
  }
}
