import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve('supabase/migrations/169_profiles_lock_privileged_columns.sql'),
  'utf8',
);
const ME = '00000000-0000-0000-0000-000000000001';
const OTHER = '00000000-0000-0000-0000-000000000002';
const ACC_A = '0000000a-0000-0000-0000-000000000000';
const ACC_B = '0000000b-0000-0000-0000-000000000000';
let db: PGlite;

// RESET ROLE precisa acontecer mesmo após uma escrita negada.
async function asRole(role: 'authenticated' | 'anon' | 'service_role', sql: string) {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await db.exec(sql);
  } finally {
    await db.exec('RESET ROLE');
  }
}

async function profile(userId: string) {
  const { rows } = await db.query<{ account_id: string; account_role: string; full_name: string }>(
    `SELECT account_id, account_role, full_name FROM wacrm.profiles WHERE user_id = $1`,
    [userId],
  );
  return rows[0];
}

describe('permissões de profiles (migration 169)', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE ROLE service_role;
      CREATE SCHEMA wacrm;
      GRANT USAGE ON SCHEMA wacrm TO anon, authenticated, service_role;
      CREATE TYPE wacrm.account_role_enum AS ENUM ('owner', 'admin', 'agent', 'viewer');
      CREATE TABLE wacrm.profiles (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL UNIQUE,
        full_name text NOT NULL,
        email text NOT NULL,
        avatar_url text,
        role text DEFAULT 'user',
        beta_features text[],
        account_id uuid NOT NULL,
        account_role wacrm.account_role_enum NOT NULL,
        team_id uuid,
        max_simultaneous_chats int,
        updated_at timestamptz
      );
      INSERT INTO wacrm.profiles (user_id, full_name, email, account_id, account_role) VALUES
        ('${ME}', 'Eu', 'eu@x.com', '${ACC_A}', 'viewer'),
        ('${OTHER}', 'Outro', 'outro@x.com', '${ACC_A}', 'agent');
      -- Estado da 027: GRANT ALL para os papéis do PostgREST, mais grants por coluna antigos.
      GRANT ALL ON wacrm.profiles TO anon, authenticated, service_role;
      GRANT UPDATE (account_role) ON wacrm.profiles TO authenticated;

      -- RPC SECURITY DEFINER no formato de set_member_role (018): roda como o dono.
      CREATE FUNCTION wacrm.set_member_role(p_user_id uuid, p_role wacrm.account_role_enum)
      RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = wacrm AS $$
      BEGIN
        UPDATE profiles SET account_role = p_role WHERE user_id = p_user_id;
      END;
      $$;
      CREATE FUNCTION wacrm.move_member(p_user_id uuid, p_account uuid)
      RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = wacrm AS $$
      BEGIN
        UPDATE profiles SET account_id = p_account, account_role = 'agent' WHERE user_id = p_user_id;
      END;
      $$;
      GRANT EXECUTE ON FUNCTION wacrm.set_member_role(uuid, wacrm.account_role_enum),
        wacrm.move_member(uuid, uuid) TO authenticated;
    `);
    await db.exec(migration);
    await db.exec(migration);
  }, 30_000);

  afterAll(async () => {
    await db?.close();
  });

  it.each([
    ['account_role', "'owner'"],
    ['account_id', `'${ACC_B}'`],
    ['user_id', `'${OTHER}'`],
    ['team_id', 'gen_random_uuid()'],
    ['max_simultaneous_chats', '99'],
    ['beta_features', "ARRAY['x']"],
    ['email', "'x@y.com'"],
  ])('nega UPDATE de %s para authenticated', async (column, value) => {
    await expect(asRole('authenticated',
      `UPDATE wacrm.profiles SET ${column} = ${value} WHERE user_id = '${ME}'`,
    )).rejects.toThrow(/permission denied/);
    expect((await profile(ME)).account_role).toBe('viewer');
  });

  it('nega INSERT para authenticated e anon', async () => {
    for (const role of ['authenticated', 'anon'] as const) {
      await expect(asRole(role, `
        INSERT INTO wacrm.profiles (user_id, full_name, email, account_id, account_role)
        VALUES (gen_random_uuid(), 'x', 'x', '${ACC_B}', 'owner')
      `)).rejects.toThrow(/permission denied/);
    }
  });

  it('permite ao authenticated alterar full_name e avatar_url', async () => {
    await asRole('authenticated',
      `UPDATE wacrm.profiles SET full_name = 'Novo nome', avatar_url = 'https://x/a.png' WHERE user_id = '${ME}'`,
    );
    expect((await profile(ME)).full_name).toBe('Novo nome');
  });

  it('limita os privilégios por coluna a full_name/avatar_url (pré-checagem do header)', async () => {
    const { rows } = await db.query<{ column_name: string; can_update: boolean; can_insert: boolean }>(`
      SELECT column_name,
        has_column_privilege('authenticated', 'wacrm.profiles', column_name, 'UPDATE') AS can_update,
        has_column_privilege('authenticated', 'wacrm.profiles', column_name, 'INSERT') AS can_insert
      FROM information_schema.columns
      WHERE table_schema = 'wacrm' AND table_name = 'profiles'
    `);
    for (const row of rows) {
      expect(row.can_update).toBe(['full_name', 'avatar_url'].includes(row.column_name));
      expect(row.can_insert).toBe(false);
    }
  });

  it('trigger barra account_id/account_role mesmo se um GRANT ALL futuro devolver a permissão', async () => {
    await db.exec('GRANT ALL ON wacrm.profiles TO authenticated');
    try {
      await expect(asRole('authenticated',
        `UPDATE wacrm.profiles SET account_role = 'owner' WHERE user_id = '${ME}'`,
      )).rejects.toThrow(/não permitida/);
      await expect(asRole('authenticated',
        `UPDATE wacrm.profiles SET account_id = '${ACC_B}' WHERE user_id = '${ME}'`,
      )).rejects.toThrow(/não permitida/);
      await expect(asRole('authenticated', `
        INSERT INTO wacrm.profiles (user_id, full_name, email, account_id, account_role)
        VALUES (gen_random_uuid(), 'x', 'x', '${ACC_B}', 'owner')
      `)).rejects.toThrow(/não permitida/);
      // Coluna comum continua passando pelo trigger.
      await asRole('authenticated', `UPDATE wacrm.profiles SET full_name = 'Ok' WHERE user_id = '${ME}'`);
    } finally {
      await db.exec(migration);
    }
    expect(await profile(ME)).toMatchObject({ account_id: ACC_A, account_role: 'viewer', full_name: 'Ok' });
  });

  it('RPCs SECURITY DEFINER continuam alterando papel e conta', async () => {
    await asRole('authenticated', `SELECT wacrm.set_member_role('${OTHER}', 'admin')`);
    expect((await profile(OTHER)).account_role).toBe('admin');
    await asRole('authenticated', `SELECT wacrm.move_member('${OTHER}', '${ACC_B}')`);
    expect(await profile(OTHER)).toMatchObject({ account_id: ACC_B, account_role: 'agent' });
  });

  it('service_role mantém INSERT e UPDATE completos (bulk-invite)', async () => {
    await asRole('service_role', `
      INSERT INTO wacrm.profiles (user_id, full_name, email, account_id, account_role)
      VALUES ('00000000-0000-0000-0000-000000000003', 'Novo', 'n@x.com', '${ACC_B}', 'owner');
      UPDATE wacrm.profiles SET account_id = '${ACC_A}', account_role = 'agent'
        WHERE user_id = '00000000-0000-0000-0000-000000000003';
    `);
    expect(await profile('00000000-0000-0000-0000-000000000003'))
      .toMatchObject({ account_id: ACC_A, account_role: 'agent' });
  });
});
