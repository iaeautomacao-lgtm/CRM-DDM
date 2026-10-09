import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, expect, it } from 'vitest';

// Migration 295: coluna import_token em disp_import_contacts (idempotente) e semântica de limpeza do bloco 0.
let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE SCHEMA wacrm;
    CREATE TABLE wacrm.disp_import_contacts (id serial PRIMARY KEY, draft_id uuid, contact_id uuid);
  `);
  const sql = readFileSync(resolve('supabase/migrations/295_import_links_token.sql'), 'utf8');
  await db.exec(sql);
  await db.exec(sql);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

it('o filtro do bloco 0 apaga legado e outro token, mas preserva a própria importação', async () => {
  const D = '00000000-0000-0000-0000-0000000000d1';
  await db.exec(`INSERT INTO wacrm.disp_import_contacts(draft_id, contact_id, import_token) VALUES
    ('${D}', gen_random_uuid(), NULL), ('${D}', gen_random_uuid(), 'antigo-0001'), ('${D}', gen_random_uuid(), 'atual-0001')`);
  await db.exec(`DELETE FROM wacrm.disp_import_contacts WHERE draft_id='${D}' AND (import_token IS NULL OR import_token <> 'atual-0001')`);
  const { rows } = await db.query<{ import_token: string }>('SELECT import_token FROM wacrm.disp_import_contacts');
  expect(rows).toEqual([{ import_token: 'atual-0001' }]);
});
