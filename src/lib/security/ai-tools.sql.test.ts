import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Migration 176 (wacrm.ai_tools): constraints, unique e acesso.
const migration = readFileSync(resolve('supabase/migrations/176_ai_tools.sql'), 'utf8').replace(/NOTIFY pgrst[^;]*;/g, '');
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

const HTTP = `'{"url":"https://api.exemplo.com/x","method":"GET"}'::jsonb`;

/** INSERT com colunas extras opcionais: extras = [coluna, expressão SQL]. */
const insert = (account: string, name: string, extras: Array<[string, string]> = [], http = HTTP) => {
  const cols = ['account_id', 'name', 'display_name', 'description', 'http', ...extras.map((e) => e[0])];
  const vals = [`'${account}'`, `'${name}'`, `'${name}'`, `'descrição'`, http, ...extras.map((e) => e[1])];
  return `INSERT INTO wacrm.ai_tools (${cols.join(', ')}) VALUES (${vals.join(', ')})`;
};

describe('migration 176 — ai_tools', () => {
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

  it('ferramenta válida entra com defaults (timeout 30000, ligada)', async () => {
    await db.exec(insert(A, 'buscar_cpf'));
    const { rows } = await db.query('SELECT name, timeout_ms, enabled FROM wacrm.ai_tools');
    expect(rows).toEqual([{ name: 'buscar_cpf', timeout_ms: 30000, enabled: true }]);
  });

  it('nome da função: ^[a-z][a-z0-9_]{1,63}$', async () => {
    for (const bad of ['Buscar', '1abc', 'a', 'com-hifen', 'com espaco', `a${'b'.repeat(64)}`]) {
      await expect(db.exec(insert(A, bad))).rejects.toThrow(/name_format/);
    }
  });

  it('http: https obrigatório, método válido, url string', async () => {
    await expect(db.exec(insert(A, 'sem_https', [], `'{"url":"http://a.com","method":"GET"}'::jsonb`))).rejects.toThrow(/http_shape/);
    await expect(db.exec(insert(A, 'metodo_ruim', [], `'{"url":"https://a.com","method":"TRACE"}'::jsonb`))).rejects.toThrow(/http_shape/);
    await expect(db.exec(insert(A, 'sem_url', [], `'{"method":"GET"}'::jsonb`))).rejects.toThrow(/http_shape/);
    await expect(db.exec(insert(A, 'url_num', [], `'{"url":5,"method":"GET"}'::jsonb`))).rejects.toThrow(/http_shape/);
  });

  it('parameters precisa ser objeto type=object; timeout 1000–60000', async () => {
    await expect(db.exec(insert(A, 'params_ruim', [['parameters', `'[]'::jsonb`]]))).rejects.toThrow(/parameters_shape/);
    await expect(db.exec(insert(A, 'params_tipo', [['parameters', `'{"type":"array"}'::jsonb`]]))).rejects.toThrow(/parameters_shape/);
    await expect(db.exec(insert(A, 'timeout_baixo', [['timeout_ms', '500']]))).rejects.toThrow(/timeout_range/);
    await expect(db.exec(insert(A, 'timeout_alto', [['timeout_ms', '60001']]))).rejects.toThrow(/timeout_range/);
    await db.exec(insert(A, 'timeout_ok', [['timeout_ms', '5000']]));
  });

  it('nome único por conta; mesmo nome em outra conta é permitido', async () => {
    await expect(db.exec(insert(A, 'buscar_cpf'))).rejects.toThrow(/unique_name/);
    await db.exec(insert(B, 'buscar_cpf'));
    expect((await db.query("SELECT 1 FROM wacrm.ai_tools WHERE name = 'buscar_cpf'")).rows).toHaveLength(2);
  });

  it('apagar a conta apaga as ferramentas (CASCADE)', async () => {
    const C = '00000000-0000-0000-0000-00000000000c';
    await db.exec(`INSERT INTO wacrm.accounts VALUES ('${C}')`);
    await db.exec(insert(C, 'tmp_tool'));
    await db.exec(`DELETE FROM wacrm.accounts WHERE id = '${C}'`);
    expect((await db.query("SELECT 1 FROM wacrm.ai_tools WHERE name = 'tmp_tool'")).rows).toHaveLength(0);
  });

  it('sem acesso direto do navegador: anon/authenticated negados; service_role lê e escreve; RLS ligada', async () => {
    for (const role of ['anon', 'authenticated'] as const) {
      await expect(as(role, 'SELECT * FROM wacrm.ai_tools')).rejects.toThrow(/permission denied/);
      await expect(as(role, 'DELETE FROM wacrm.ai_tools')).rejects.toThrow(/permission denied/);
      await expect(as(role, 'UPDATE wacrm.ai_tools SET enabled = false')).rejects.toThrow(/permission denied/);
    }
    expect((await as('service_role', 'SELECT * FROM wacrm.ai_tools')).rows.length).toBeGreaterThan(0);
    const rls = await db.query<{ relrowsecurity: boolean }>(
      "SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname='wacrm' AND c.relname='ai_tools'"
    );
    expect(rls.rows[0].relrowsecurity).toBe(true);
  });
});
