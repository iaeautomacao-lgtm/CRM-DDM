import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const secrets = ['app_secret', 'verify_token', 'access_token', 'waha_api_key'];
const settings = ['flow_id', 'receptivo', 'habilitado', 'team_id', 'client_id'];
const migration = readFileSync(
  resolve('supabase/migrations/153_whatsapp_config_secret_columns.sql'),
  'utf8',
);
let db: PGlite;

// RESET ROLE precisa acontecer mesmo após uma escrita negada.
async function asRole(role: 'authenticated' | 'service_role', sql: string) {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await db.exec(sql);
  } finally {
    await db.exec('RESET ROLE');
  }
}

describe('permissões de segredos de whatsapp_config (migration 153)', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE authenticated;
      CREATE ROLE service_role;
      CREATE SCHEMA wacrm;
      GRANT USAGE ON SCHEMA wacrm TO authenticated, service_role;
      CREATE TABLE wacrm.whatsapp_config (
        id int PRIMARY KEY,
        app_secret text, verify_token text, access_token text, waha_api_key text,
        flow_id text, receptivo boolean, habilitado boolean, team_id text, client_id text,
        account_id text, updated_at timestamptz
      );
      INSERT INTO wacrm.whatsapp_config (id) VALUES (1);
      GRANT ALL ON wacrm.whatsapp_config TO authenticated, service_role;
      -- Simular grants explícitos antigos, além dos grants na tabela.
      GRANT INSERT (app_secret, account_id), UPDATE (app_secret, account_id)
        ON wacrm.whatsapp_config TO authenticated;
    `);
    await db.exec(migration);
    await db.exec(migration);
  }, 30_000);

  afterAll(async () => {
    await db?.close();
  });

  it.each(secrets)('nega UPDATE e INSERT de %s para authenticated', async (column) => {
    await expect(asRole('authenticated',
      `UPDATE wacrm.whatsapp_config SET ${column} = 'texto puro' WHERE id = 1`,
    )).rejects.toThrow(/permission denied/);
    await expect(asRole('authenticated',
      `INSERT INTO wacrm.whatsapp_config (${column}) VALUES ('texto puro')`,
    )).rejects.toThrow(/permission denied/);
  });

  it('preserva os cinco campos do PATCH após reaplicar a migration', async () => {
    await asRole('authenticated', `
      UPDATE wacrm.whatsapp_config SET flow_id = 'fluxo', receptivo = true,
        habilitado = false, team_id = 'equipe', client_id = 'cliente' WHERE id = 1;
    `);
    const { rows } = await db.query(`
      SELECT flow_id, receptivo, habilitado, team_id, client_id
      FROM wacrm.whatsapp_config WHERE id = 1
    `);
    expect(rows[0]).toEqual({
      flow_id: 'fluxo', receptivo: true, habilitado: false,
      team_id: 'equipe', client_id: 'cliente',
    });
  });

  it('nega INSERT sem segredos e UPDATE fora da lista permitida', async () => {
    await expect(asRole('authenticated',
      "INSERT INTO wacrm.whatsapp_config (account_id) VALUES ('conta')",
    )).rejects.toThrow(/permission denied/);
    await expect(asRole('authenticated',
      "UPDATE wacrm.whatsapp_config SET account_id = 'outra conta' WHERE id = 1",
    )).rejects.toThrow(/permission denied/);
  });

  it('mantém INSERT e UPDATE dos quatro segredos para service_role', async () => {
    await asRole('service_role', `
      INSERT INTO wacrm.whatsapp_config (id, ${secrets.join(', ')})
        VALUES (2, 'cifrado', 'cifrado', 'cifrado', 'cifrado');
      UPDATE wacrm.whatsapp_config SET
        ${secrets.map((column) => `${column} = 'novo cifrado'`).join(', ')} WHERE id = 2;
    `);
    const { rows } = await db.query(`SELECT ${secrets.join(', ')} FROM wacrm.whatsapp_config WHERE id = 2`);
    expect(rows[0]).toEqual(Object.fromEntries(secrets.map((column) => [column, 'novo cifrado'])));
  });

  it('preserva SELECT e DELETE e limita UPDATE às configurações', async () => {
    const { rows } = await db.query<{ column_name: string; can_update: boolean; can_insert: boolean }>(`
      SELECT column_name,
        has_column_privilege('authenticated', 'wacrm.whatsapp_config', column_name, 'UPDATE') AS can_update,
        has_column_privilege('authenticated', 'wacrm.whatsapp_config', column_name, 'INSERT') AS can_insert
      FROM information_schema.columns
      WHERE table_schema = 'wacrm' AND table_name = 'whatsapp_config'
    `);
    for (const row of rows) {
      expect(row.can_update).toBe(settings.includes(row.column_name));
      expect(row.can_insert).toBe(false);
    }
    await asRole('authenticated', `
      SELECT id FROM wacrm.whatsapp_config;
      DELETE FROM wacrm.whatsapp_config WHERE id = 2;
    `);
  });
});
