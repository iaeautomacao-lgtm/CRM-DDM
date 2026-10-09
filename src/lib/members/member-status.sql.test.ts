// Migration 311 (TASK3): desativar/reativar membro e último acesso. PGlite com as migrations REAIS 169 e 311 sobre um
// schema mínimo (profiles no estado da 027, auth.users/sessions, member_presence).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const mig = (f: string) => readFileSync(resolve('supabase/migrations', f), 'utf8').replace(/NOTIFY pgrst[^;]*;/g, '');
const A = '0000000a-0000-0000-0000-000000000000';
const B = '0000000b-0000-0000-0000-000000000000';
const OWNER = '00000000-0000-0000-0000-000000000001';
const ADMIN = '00000000-0000-0000-0000-000000000002';
const AGENT = '00000000-0000-0000-0000-000000000003';
const OTHER_ACC = '00000000-0000-0000-0000-000000000004';

let db: PGlite;

async function asRole<T>(role: 'authenticated' | 'service_role', fn: () => Promise<T>) {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec('RESET ROLE');
  }
}
const call = (target: string, active: boolean, actor = ADMIN, account = A) =>
  asRole('service_role', () =>
    db.query<{ r: Record<string, unknown> }>(`SELECT wacrm.set_member_active($1, $2, $3, $4) AS r`, [account, actor, target, active]).then((x) => x.rows[0].r),
  );

describe('migration 311 — desativar membro e último acesso', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA wacrm; CREATE SCHEMA auth;
      GRANT USAGE ON SCHEMA wacrm, auth TO anon, authenticated, service_role;
      CREATE TYPE wacrm.account_role_enum AS ENUM ('owner', 'admin', 'supervisor', 'agent', 'viewer');
      CREATE TABLE wacrm.profiles (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL UNIQUE, full_name text NOT NULL, email text NOT NULL,
        avatar_url text, role text DEFAULT 'user', beta_features text[], account_id uuid NOT NULL,
        account_role wacrm.account_role_enum NOT NULL, team_id uuid, max_simultaneous_chats int, updated_at timestamptz, created_at timestamptz DEFAULT now()
      );
      GRANT ALL ON wacrm.profiles TO anon, authenticated, service_role;   -- estado da 027
      CREATE TABLE auth.users (id uuid PRIMARY KEY, last_sign_in_at timestamptz);
      CREATE TABLE auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, created_at timestamptz, updated_at timestamptz, refreshed_at timestamp);
      SET TIME ZONE 'America/Sao_Paulo';  -- como o banco real: refreshed_at sem fuso precisa ser lido como UTC
      CREATE TABLE wacrm.member_presence (user_id uuid PRIMARY KEY, account_id uuid NOT NULL, status text NOT NULL, last_seen_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
      INSERT INTO wacrm.profiles (user_id, full_name, email, account_id, account_role) VALUES
        ('${OWNER}', 'Dona', 'o@x', '${A}', 'owner'), ('${ADMIN}', 'Admin', 'a@x', '${A}', 'admin'),
        ('${AGENT}', 'Operador', 'g@x', '${A}', 'agent'), ('${OTHER_ACC}', 'Outra conta', 'b@x', '${B}', 'agent');
      INSERT INTO auth.users VALUES ('${OWNER}', '2026-10-09T08:00:00Z'), ('${ADMIN}', '2026-10-09T09:00:00Z'), ('${AGENT}', '2026-10-08T10:00:00Z'), ('${OTHER_ACC}', null);
      INSERT INTO auth.sessions (user_id, created_at, updated_at, refreshed_at) VALUES
        ('${AGENT}', '2026-10-08T10:00:00Z', '2026-10-09T11:00:00Z', '2026-10-09 12:00:00'),
        ('${AGENT}', '2026-10-07T10:00:00Z', '2026-10-07T10:00:00Z', null),
        ('${ADMIN}', '2026-10-09T09:00:00Z', '2026-10-09T09:30:00Z', null);
      INSERT INTO wacrm.member_presence VALUES ('${AGENT}', '${A}', 'online', now());
    `);
    await db.exec(mig('169_profiles_lock_privileged_columns.sql'));
    await db.exec(mig('311_member_deactivation_last_access.sql'));
    await db.exec(mig('311_member_deactivation_last_access.sql')); // idempotente
  }, 60_000);
  afterAll(async () => {
    await db.close();
  });

  it('último acesso: login e atividade mais recente (refreshed_at > updated_at); sem sessão = null', async () => {
    const rows = await asRole('service_role', () =>
      db.query<{ user_id: string; last_sign_in_at: Date | null; last_active_at: Date | null }>(
        `SELECT * FROM wacrm.account_members_access($1) ORDER BY user_id`,
        [A],
      ),
    );
    const byId = new Map(rows.rows.map((r) => [r.user_id, r]));
    expect(rows.rows.map((r) => r.user_id)).toEqual([OWNER, ADMIN, AGENT]); // só a conta A
    expect(new Date(byId.get(AGENT)!.last_active_at!).toISOString()).toBe('2026-10-09T12:00:00.000Z');
    expect(new Date(byId.get(ADMIN)!.last_active_at!).toISOString()).toBe('2026-10-09T09:30:00.000Z');
    expect(byId.get(OWNER)!.last_active_at).toBeNull();
    expect(new Date(byId.get(OWNER)!.last_sign_in_at!).toISOString()).toBe('2026-10-09T08:00:00.000Z');
  });

  it('desativar: marca o perfil, apaga TODAS as sessões e a presença do alvo; devolve o estado anterior', async () => {
    const r = await call(AGENT, false);
    expect(r).toMatchObject({ was_active: true, is_active: false, role: 'agent', sessions_revoked: 2 });
    const p = (await db.query<{ deactivated_at: Date | null; deactivated_by: string | null }>(`SELECT deactivated_at, deactivated_by FROM wacrm.profiles WHERE user_id = $1`, [AGENT])).rows[0];
    expect(p.deactivated_at).not.toBeNull();
    expect(p.deactivated_by).toBe(ADMIN);
    expect((await db.query(`SELECT 1 FROM auth.sessions WHERE user_id = $1`, [AGENT])).rows).toHaveLength(0);
    expect((await db.query(`SELECT 1 FROM wacrm.member_presence WHERE user_id = $1`, [AGENT])).rows).toHaveLength(0);
    // sessões de outros membros intactas
    expect((await db.query(`SELECT 1 FROM auth.sessions WHERE user_id = $1`, [ADMIN])).rows).toHaveLength(1);
  });

  it('desativar de novo é idempotente (mantém data e autor originais)', async () => {
    const before = (await db.query<{ d: Date }>(`SELECT deactivated_at AS d FROM wacrm.profiles WHERE user_id = $1`, [AGENT])).rows[0].d;
    const r = await call(AGENT, false, OWNER);
    expect(r).toMatchObject({ was_active: false, is_active: false });
    const p = (await db.query<{ d: Date; by: string }>(`SELECT deactivated_at AS d, deactivated_by AS by FROM wacrm.profiles WHERE user_id = $1`, [AGENT])).rows[0];
    expect(new Date(p.d).getTime()).toBe(new Date(before).getTime());
    expect(p.by).toBe(ADMIN);
  });

  it('reativar limpa a marca', async () => {
    expect(await call(AGENT, true)).toMatchObject({ was_active: false, is_active: true });
    expect((await db.query<{ d: Date | null }>(`SELECT deactivated_at AS d FROM wacrm.profiles WHERE user_id = $1`, [AGENT])).rows[0].d).toBeNull();
  });

  it('nunca o proprietário, nunca a si mesmo, nunca membro de outra conta', async () => {
    await expect(call(OWNER, false)).rejects.toThrow(/proprietário não pode ser desativado/);
    await expect(call(ADMIN, false)).rejects.toThrow(/a si mesmo/);
    await expect(call(OTHER_ACC, false)).rejects.toThrow(/não encontrado nesta organização/);
  });

  it('o próprio usuário não consegue se reativar (sem UPDATE nas colunas novas) nem chamar as funções', async () => {
    await expect(asRole('authenticated', () => db.query(`UPDATE wacrm.profiles SET deactivated_at = NULL WHERE user_id = '${AGENT}'`))).rejects.toThrow(/permission denied/);
    await expect(asRole('authenticated', () => db.query(`SELECT wacrm.set_member_active('${A}', '${AGENT}', '${ADMIN}', false)`))).rejects.toThrow(/permission denied/);
    await expect(asRole('authenticated', () => db.query(`SELECT * FROM wacrm.account_members_access('${A}')`))).rejects.toThrow(/permission denied/);
  });

  it('último acesso com refreshed_at timestamptz (outra versão do GoTrue): vale o fuso do texto', async () => {
    await db.exec(`ALTER TABLE auth.sessions ALTER COLUMN refreshed_at TYPE timestamptz USING refreshed_at AT TIME ZONE 'UTC'`);
    await db.query(`INSERT INTO auth.sessions (user_id, created_at, updated_at, refreshed_at) VALUES ($1, '2026-10-09T08:00:00Z', '2026-10-09T08:00:00Z', '2026-10-09T15:00:00Z')`, [OWNER]);
    const r = await asRole('service_role', () =>
      db.query<{ last_active_at: Date }>(`SELECT last_active_at FROM wacrm.account_members_access($1) WHERE user_id = $2`, [A, OWNER]),
    );
    expect(new Date(r.rows[0].last_active_at).toISOString()).toBe('2026-10-09T15:00:00.000Z');
  });

  it('registra a si mesma', async () => {
    expect((await db.query(`SELECT 1 FROM wacrm.schema_migrations WHERE version = '311_member_deactivation_last_access'`)).rows).toHaveLength(1);
  });
});
