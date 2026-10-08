// ============================================================
// /api/account/api-keys
//
//   GET  — list this account's API keys (safe columns only).
//   POST — mint a new key.
//
// These are the *dashboard* endpoints for managing keys, so they
// authenticate the normal way (cookie session) and go through the
// RLS client. Listing is open to any member (viewer+) — the roster
// is not secret; the secret (the key itself) is never in it. Minting
// is admin+ (a key hands out capabilities), enforced by both
// `requirePermission('api_keys.manage')` here and the `api_keys_insert` RLS policy.
//
// IMPORTANT: the plaintext key is returned exactly ONCE, in the POST
// response. We persist only its SHA-256 hash, so neither GET nor any
// future endpoint can resurface it — same one-time-reveal contract
// as invite links. If the admin loses it, they revoke and re-issue.
//
// Chaves pessoais (intelligence:read, MCP — PRD-04 Fase 3, migration
// 154): ligadas ao criador (user_id). Owner/admin criam qualquer chave;
// supervisor cria SÓ a chave pessoal dele (regras em
// src/lib/api-keys/personal.ts). Como a RLS de escrita de api_keys é
// admin+, o insert do supervisor usa o service role com dono, conta e
// escopo fixados aqui no servidor. `GET ?mine=1` lista só as chaves
// pessoais do usuário (seção "Minhas chaves de API" do /inteligencia).
// ============================================================

import { NextResponse } from 'next/server';

import { requirePermission, toErrorResponse } from '@/lib/auth/account';
import { can } from '@/lib/auth/permissions';
import { generateApiKey } from '@/lib/api-keys/keys';
import { planKeyCreation } from '@/lib/api-keys/personal';
import { logAuditEvent } from '@/lib/audit/log-event';
import { apiKeyCreatedEvent } from '@/lib/audit/security-events';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

const MAX_NAME_LEN = 80;
// Hard ceiling on caller-supplied expiry (1 year), mirroring the
// invite-link clamp. NULL/absent = never expires.
const MAX_EXPIRY_DAYS = 365;

// Columns safe to expose. `key_hash` is deliberately excluded — it
// never leaves the server.
const SAFE_COLUMNS =
  'id, name, key_prefix, scopes, user_id, last_used_at, expires_at, revoked_at, created_at';

export async function GET(request: Request) {
  try {
    // Any member can view the roster (RLS allows it); we just need a
    // resolved account context.
    const ctx = await requirePermission('api_keys.view');
    const mine = new URL(request.url).searchParams.get('mine') === '1';

    let query = ctx.supabase
      .from('api_keys')
      .select(SAFE_COLUMNS)
      .eq('account_id', ctx.accountId);
    if (mine) query = query.eq('user_id', ctx.userId);
    const { data, error } = await query.order('created_at', {
      ascending: false,
    });

    if (error) {
      console.error('[GET /api/account/api-keys] fetch error:', error);
      return NextResponse.json(
        { error: 'Failed to load API keys' },
        { status: 500 }
      );
    }

    return NextResponse.json({ keys: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    // Pré-checagem antes do rate limit/corpo: quem gerencia as chaves da conta (api_keys.manage) ou cria a
    // chave pessoal (intelligence.personal_key). O detalhe (o que cada um pode criar) fica em
    // planKeyCreation abaixo. Mesmo resultado de antes: owner/admin/supervisor passam; operador e viewer não.
    const ctx = await requirePermission('api_keys.view');
    const canManage = can(ctx, 'api_keys.manage');
    const canPersonal = can(ctx, 'intelligence.personal_key');
    if (!canManage && !canPersonal) {
      return NextResponse.json({ error: 'Insufficient role' }, { status: 403 });
    }

    const limit = checkRateLimit(
      `admin:apiKeyCreate:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as {
      name?: unknown;
      scopes?: unknown;
      expiresInDays?: unknown;
    } | null;

    const rawName = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!rawName) {
      return NextResponse.json(
        { error: "'name' is required" },
        { status: 400 }
      );
    }
    if (rawName.length > MAX_NAME_LEN) {
      return NextResponse.json(
        { error: `Name must be ${MAX_NAME_LEN} characters or fewer` },
        { status: 400 }
      );
    }

    // Scopes default to none if omitted — that yields a key that can
    // only call the scope-free endpoints (e.g. GET /api/v1/me).
    const plan = planKeyCreation({ canManage, canPersonal }, ctx.userId, body?.scopes ?? []);
    if (!plan.ok) {
      return NextResponse.json({ error: plan.error }, { status: plan.status });
    }

    let expiresAt: string | null = null;
    const rawExpiry = body?.expiresInDays;
    if (
      typeof rawExpiry === 'number' &&
      Number.isFinite(rawExpiry) &&
      rawExpiry > 0
    ) {
      const days = Math.min(Math.floor(rawExpiry), MAX_EXPIRY_DAYS);
      expiresAt = new Date(
        Date.now() + days * 24 * 60 * 60 * 1000
      ).toISOString();
    }

    const { plaintext, hash, prefix } = generateApiKey();

    // Supervisor não passa na RLS de insert (admin+): usa o service role,
    // com conta, dono e escopo já fixados pelo servidor (planKeyCreation
    // só deixa o supervisor criar a chave pessoal dele).
    const writer = canManage ? ctx.supabase : supabaseAdmin();
    const { data, error } = await writer
      .from('api_keys')
      .insert({
        account_id: ctx.accountId,
        created_by: ctx.userId,
        // Omitido na chave da conta: o insert funciona igual a antes.
        ...(plan.userId ? { user_id: plan.userId } : {}),
        name: rawName,
        key_prefix: prefix,
        key_hash: hash,
        scopes: plan.scopes,
        expires_at: expiresAt,
      })
      .select(SAFE_COLUMNS)
      .single();

    if (error || !data) {
      console.error('[POST /api/account/api-keys] insert error:', error);
      return NextResponse.json(
        { error: 'Failed to create API key' },
        { status: 500 }
      );
    }

    // 20.8: criação da chave auditada (id, nome, escopos, pessoal) — nunca o texto da chave nem o hash.
    await logAuditEvent(
      apiKeyCreatedEvent({
        accountId: ctx.accountId,
        keyId: data.id as string,
        name: rawName,
        scopes: plan.scopes,
        personal: plan.personal,
        ownerUserId: plan.userId,
        expiresAt,
      }),
    );

    return NextResponse.json(
      {
        key: data,
        // Plaintext — shown to the admin exactly once.
        plaintext,
      },
      { status: 201 }
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
