// 2FA obrigatório (TOTP): a regra, o bloqueio no servidor (wrapper do getUser + getCurrentAccount), o 401 mfa_required
// que o front reconhece e o middleware do passo /login/2fa.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  aalFromAccessToken,
  hasVerifiedTotp,
  isMfaRequired,
  MFA_PATH,
  mfaRedirectUrl,
  normalizeTotpCode,
  verifyErrorMessage,
} from './mfa';

/** JWT só com o payload (a assinatura não é lida aqui; o Supabase já validou o token). */
const jwt = (claims: Record<string, unknown>) =>
  `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;

const VERIFIED = [{ factor_type: 'totp', status: 'verified' }];
const UNVERIFIED = [{ factor_type: 'totp', status: 'unverified' }];

describe('regra', () => {
  it.each([
    ['sem fator → passa', [], 'aal1', false],
    ['fator não verificado (cadastro não concluído) → passa', UNVERIFIED, 'aal1', false],
    ['fator verificado + aal1 → bloqueia', VERIFIED, 'aal1', true],
    ['fator verificado + aal2 → passa', VERIFIED, 'aal2', false],
  ] as const)('%s', (_name, factors, aal, blocked) => {
    expect(isMfaRequired(factors, aal)).toBe(blocked);
  });

  it('aal do token: claim aal2; ausente, ilegível ou nulo conta como aal1 (lado seguro)', () => {
    expect(aalFromAccessToken(jwt({ aal: 'aal2' }))).toBe('aal2');
    expect(aalFromAccessToken(jwt({ aal: 'aal1' }))).toBe('aal1');
    expect(aalFromAccessToken(jwt({}))).toBe('aal1');
    expect(aalFromAccessToken('lixo')).toBe('aal1');
    expect(aalFromAccessToken(null)).toBe('aal1');
    expect(hasVerifiedTotp(null)).toBe(false);
  });

  it('redirect preserva a página e nunca aponta para o próprio passo', () => {
    expect(mfaRedirectUrl('/inbox?x=1')).toBe(`${MFA_PATH}?next=${encodeURIComponent('/inbox?x=1')}`);
    expect(mfaRedirectUrl(`${MFA_PATH}?next=/a`)).toBe(`${MFA_PATH}?next=${encodeURIComponent('/dashboard')}`);
    expect(mfaRedirectUrl('https://fora.example')).toBe(`${MFA_PATH}?next=${encodeURIComponent('/dashboard')}`);
  });

  it('código e mensagens', () => {
    expect(normalizeTotpCode('12 34-5678')).toBe('123456');
    expect(verifyErrorMessage('Invalid TOTP code entered')).toMatch(/inválido/);
    expect(verifyErrorMessage('Too many requests')).toMatch(/Muitas tentativas/);
  });
});

// ── servidor: wrapper do getUser (src/lib/supabase/server.ts) e getCurrentAccount ──────────────────────────────
const fake = vi.hoisted(() => ({
  user: null as null | { id: string; factors?: Array<{ factor_type: string; status: string }> },
  token: null as string | null,
}));

vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => [], set: () => undefined }) }));
vi.mock('@/lib/audit/context', () => ({ auditFetch: fetch, registerAuditActor: vi.fn(async () => undefined) }));
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: fake.user }, error: fake.user ? null : new Error('sem sessão') }),
      getSession: async () => ({ data: { session: fake.token ? { access_token: fake.token } : null } }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { account_id: 'acc', account_role: 'admin' }, error: null }),
          limit: async () => ({ data: [{ id: 'acc', name: 'Conta' }], error: null }),
          single: async () => ({ data: { id: 'acc', name: 'Conta' }, error: null }),
        }),
      }),
    }),
  }),
}));

describe('servidor: getUser e getCurrentAccount', () => {
  beforeEach(() => {
    fake.user = { id: 'u1', factors: [] };
    fake.token = jwt({ aal: 'aal1' });
  });

  it('sem fator → getUser devolve o usuário', async () => {
    const { createClient } = await import('@/lib/supabase/server');
    const { data, error } = await (await createClient()).auth.getUser();
    expect(error).toBeNull();
    expect(data.user?.id).toBe('u1');
  });

  it('fator verificado + aal1 → user null e code mfa_required (vale para toda rota que chama getUser)', async () => {
    fake.user = { id: 'u1', factors: VERIFIED };
    const { createClient } = await import('@/lib/supabase/server');
    const { data, error } = await (await createClient()).auth.getUser();
    expect(data.user).toBeNull();
    expect(error).toMatchObject({ code: 'mfa_required', status: 401 });
  });

  it('fator verificado + aal2 → passa', async () => {
    fake.user = { id: 'u1', factors: VERIFIED };
    fake.token = jwt({ aal: 'aal2' });
    const { createClient } = await import('@/lib/supabase/server');
    const { data, error } = await (await createClient()).auth.getUser();
    expect(error).toBeNull();
    expect(data.user?.id).toBe('u1');
  });

  it('getCurrentAccount → MfaRequiredError → 401 { code: mfa_required }', async () => {
    fake.user = { id: 'u1', factors: VERIFIED };
    const { getCurrentAccount, MfaRequiredError, toErrorResponse } = await import('./account');
    const err = await getCurrentAccount().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MfaRequiredError);
    const res = toErrorResponse(err);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Confirme o código de verificação em duas etapas.', code: 'mfa_required' });
  });
});

// ── front: 401 mfa_required reconhecido pelo apiFetch ─────────────────────────────────────────────────────────
describe('apiFetch', () => {
  it('reconhece só o 401 com code mfa_required, sem consumir o corpo original', async () => {
    const { isMfaRequiredResponse } = await import('@/lib/api-fetch');
    const mfa = new Response(JSON.stringify({ error: 'x', code: 'mfa_required' }), { status: 401 });
    expect(await isMfaRequiredResponse(mfa)).toBe(true);
    expect((await mfa.json()).code).toBe('mfa_required');
    expect(await isMfaRequiredResponse(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }))).toBe(false);
    expect(await isMfaRequiredResponse(new Response('{}', { status: 403 }))).toBe(false);
  });
});

// ── middleware: passo /login/2fa e rotas isentas ─────────────────────────────────────────────────────────────
describe('middleware', () => {
  const sessionCookie = () =>
    `base64-${Buffer.from(JSON.stringify({ access_token: jwt({ aal: 'aal1' }) })).toString('base64url')}`;

  async function run(path: string, withSession: boolean) {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://projeto.supabase.co');
    const { NextRequest } = await import('next/server');
    const { middleware } = await import('@/middleware');
    const req = new NextRequest(new URL(path, 'https://crm.example'), {
      headers: withSession ? { cookie: `sb-projeto-auth-token=${sessionCookie()}` } : {},
    });
    return middleware(req);
  }

  it('/login/2fa sem sessão → /login preservando o next', async () => {
    const res = await run(`${MFA_PATH}?next=%2Finbox`, false);
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.pathname).toBe('/login');
    expect(loc.searchParams.get('next')).toBe('/inbox');
  });

  it('/login/2fa com sessão → segue (a página decide), sem redirecionar para o painel', async () => {
    const res = await run(`${MFA_PATH}?next=%2Finbox`, true);
    expect(res.headers.get('location')).toBeNull();
  });

  it.each(['/api/v1/contacts', '/api/whatsapp/webhook', '/api/disparador/cron', '/w/abc123', '/api/automations/cron'])(
    'rota isenta %s não é desviada para o 2FA',
    async (path) => {
      const res = await run(path, false);
      expect(res.headers.get('location') ?? '').not.toContain(MFA_PATH);
    },
  );
});
