import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Migration 175 (wacrm.account_secrets): constraints, unique e acesso.
const migration = readFileSync(resolve('supabase/migrations/175_account_secrets.sql'), 'utf8').replace(
  /NOTIFY pgrst[^;]*;/g,
  ''
);
const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
let db: PGlite;

async function as(role: 'authenticated' | 'anon' | 'service_role', sql: string) {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await db.query<Record<string, unknown>>(sql);
  } finally {
    await db.exec('RESET ROLE');
  }
}

const ENC = 'aabbccddeeff001122334455:00112233:ffeeddccbbaa99887766554433221100';
const insert = (cols: string, vals: string) =>
  `INSERT INTO wacrm.account_secrets (account_id, ${cols}) VALUES ('${A}', ${vals})`;

describe('migration 175 — account_secrets', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA wacrm;
      GRANT USAGE ON SCHEMA wacrm TO anon, authenticated, service_role;
      CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY);
      INSERT INTO wacrm.accounts VALUES ('${A}'), ('${B}');
    `);
    await db.exec(migration);
    await db.exec(migration); // idempotente
  }, 30_000);

  afterAll(async () => {
    await db?.close();
  });

  it('variável válida e credencial válida entram', async () => {
    await db.exec(insert('name, kind, value_plain', "'BASE_URL', 'variable', 'https://a.com'"));
    await db.exec(
      insert('name, kind, value_encrypted, last4, allowed_hosts', `'DDM_TOKEN', 'credential', '${ENC}', '1234', ARRAY['ddmacordos.com']`)
    );
    const { rows } = await db.query('SELECT name, kind FROM wacrm.account_secrets ORDER BY name');
    expect(rows).toEqual([
      { name: 'BASE_URL', kind: 'variable' },
      { name: 'DDM_TOKEN', kind: 'credential' },
    ]);
  });

  it('nome: só UPPER_SNAKE (^[A-Z][A-Z0-9_]{1,63}$)', async () => {
    for (const bad of ['minusculo', '1ABC', 'A', 'COM-HIFEN', 'COM ESPACO', `X${'A'.repeat(64)}`]) {
      await expect(db.exec(insert('name, kind, value_plain', `'${bad}', 'variable', 'v'`))).rejects.toThrow(/name_format/);
    }
  });

  it('tipo inválido é recusado', async () => {
    await expect(db.exec(insert('name, kind, value_plain', "'TIPO_X', 'secret', 'v'"))).rejects.toThrow(/kind_check/);
  });

  it('credencial: sem value_plain, com value_encrypted e hosts não vazios', async () => {
    await expect(
      db.exec(insert('name, kind, value_plain, value_encrypted, allowed_hosts', `'C1', 'credential', 'texto', '${ENC}', ARRAY['a.com']`))
    ).rejects.toThrow(/credential_shape/);
    await expect(db.exec(insert('name, kind, allowed_hosts', "'C2', 'credential', ARRAY['a.com']"))).rejects.toThrow(/credential_shape/);
    await expect(
      db.exec(insert('name, kind, value_encrypted', `'C3', 'credential', '${ENC}'`))
    ).rejects.toThrow(/credential_shape/); // sem hosts
    await expect(
      db.exec(insert('name, kind, value_encrypted, allowed_hosts', `'C4', 'credential', '${ENC}', ARRAY[]::text[]`))
    ).rejects.toThrow(/credential_shape/); // hosts vazio
  });

  it('variável: com value_plain e SEM value_encrypted', async () => {
    await expect(db.exec(insert('name, kind', "'V1', 'variable'"))).rejects.toThrow(/variable_shape/);
    await expect(
      db.exec(insert('name, kind, value_plain, value_encrypted', `'V2', 'variable', 'v', '${ENC}'`))
    ).rejects.toThrow(/variable_shape/);
  });

  it('nome único por conta; o mesmo nome em outra conta é permitido', async () => {
    await expect(db.exec(insert('name, kind, value_plain', "'BASE_URL', 'variable', 'outra'"))).rejects.toThrow(/unique_name/);
    await db.exec(
      `INSERT INTO wacrm.account_secrets (account_id, name, kind, value_plain) VALUES ('${B}', 'BASE_URL', 'variable', 'b')`
    );
    expect((await db.query('SELECT 1 FROM wacrm.account_secrets WHERE name = \'BASE_URL\'')).rows).toHaveLength(2);
  });

  it('apagar a conta apaga os segredos (ON DELETE CASCADE)', async () => {
    await db.exec(`INSERT INTO wacrm.accounts VALUES ('00000000-0000-0000-0000-00000000000c')`);
    await db.exec(
      `INSERT INTO wacrm.account_secrets (account_id, name, kind, value_plain) VALUES ('00000000-0000-0000-0000-00000000000c', 'TMP_X', 'variable', 'v')`
    );
    await db.exec(`DELETE FROM wacrm.accounts WHERE id = '00000000-0000-0000-0000-00000000000c'`);
    expect((await db.query("SELECT 1 FROM wacrm.account_secrets WHERE name = 'TMP_X'")).rows).toHaveLength(0);
  });

  it('sem acesso direto do navegador: anon/authenticated negados; service_role lê e escreve', async () => {
    for (const role of ['anon', 'authenticated'] as const) {
      await expect(as(role, 'SELECT * FROM wacrm.account_secrets')).rejects.toThrow(/permission denied/);
      await expect(as(role, `DELETE FROM wacrm.account_secrets`)).rejects.toThrow(/permission denied/);
      await expect(as(role, `UPDATE wacrm.account_secrets SET description = 'x'`)).rejects.toThrow(/permission denied/);
    }
    expect((await as('service_role', 'SELECT * FROM wacrm.account_secrets')).rows.length).toBeGreaterThan(0);
    const rls = await db.query<{ relrowsecurity: boolean }>(
      "SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname='wacrm' AND c.relname='account_secrets'"
    );
    expect(rls.rows[0].relrowsecurity).toBe(true);
  });
});
