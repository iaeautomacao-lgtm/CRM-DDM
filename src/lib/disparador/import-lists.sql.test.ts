// Migration 292: nome da lista + duplicate_import_list (PGlite com a 197 e a 292 reais; 132/079 em versão mínima com os mesmos índices únicos).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

let db: PGlite;
const migration = (f: string) => readFileSync(resolve(process.cwd(), 'supabase/migrations', f), 'utf8').replace(/NOTIFY pgrst[^;]*;/g, '');
const ACC = 'a0000000-0000-0000-0000-000000000001';
const OTHER = 'a0000000-0000-0000-0000-000000000002';
const SRC = 'd0000000-0000-0000-0000-000000000001';
const NEW = 'd0000000-0000-0000-0000-000000000002';
const CAMP = 'c0000000-0000-0000-0000-000000000001';
const C = (n: number) => `b0000000-0000-0000-0000-00000000000${n}`;

const dup = async (over: { account?: string; draft?: string | null; campaign?: string | null; newDraft?: string } = {}) =>
  (
    await db.query<{ r: { contacts: number; variables: number } }>('SELECT wacrm.duplicate_import_list($1,$2,$3,$4) AS r', [
      over.account ?? ACC,
      over.draft === undefined ? SRC : over.draft,
      over.campaign ?? null,
      over.newDraft ?? NEW,
    ])
  ).rows[0].r;
const links = async (draft: string) => (await db.query<{ contact_id: string }>('SELECT contact_id FROM wacrm.disp_import_contacts WHERE draft_id = $1 ORDER BY contact_id', [draft])).rows.map((r) => r.contact_id);
const vars = async (draft: string) =>
  (await db.query<{ contact_id: string; var_index: number; value: string; campaign_id: string | null }>('SELECT contact_id, var_index, value, campaign_id FROM wacrm.contact_import_variables WHERE draft_id = $1 ORDER BY contact_id, var_index', [draft])).rows;

describe('migration 292 — listas importadas reutilizáveis', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA wacrm;
      CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY);
      CREATE TABLE wacrm.contacts (id uuid PRIMARY KEY, account_id uuid NOT NULL);
      CREATE TABLE wacrm.campaigns (id uuid PRIMARY KEY, account_id uuid, import_draft_id uuid);
      CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
      CREATE TABLE wacrm.disp_import_contacts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, draft_id uuid, campaign_id uuid,
        contact_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), CHECK (draft_id IS NOT NULL OR campaign_id IS NOT NULL));
      CREATE UNIQUE INDEX disp_import_contacts_draft_contact ON wacrm.disp_import_contacts (draft_id, contact_id) WHERE draft_id IS NOT NULL;
      CREATE UNIQUE INDEX disp_import_contacts_campaign_contact ON wacrm.disp_import_contacts (campaign_id, contact_id) WHERE campaign_id IS NOT NULL;
      CREATE TABLE wacrm.contact_import_variables (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_id uuid NOT NULL, campaign_id uuid, draft_id uuid,
        var_index smallint NOT NULL, value text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (contact_id, campaign_id, var_index), UNIQUE (contact_id, draft_id, var_index));
      INSERT INTO wacrm.accounts VALUES ('${ACC}'), ('${OTHER}');
    `);
    await db.exec(migration('197_dispatch_import_jobs.sql'));
    const sql = migration('292_import_lists.sql');
    await db.exec(sql);
    await db.exec(sql); // idempotente
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.exec('TRUNCATE wacrm.disp_import_contacts, wacrm.contact_import_variables, wacrm.contacts, wacrm.campaigns, wacrm.dispatch_import_jobs');
    await db.exec(`
      INSERT INTO wacrm.contacts VALUES ('${C(1)}','${ACC}'), ('${C(2)}','${ACC}'), ('${C(3)}','${ACC}'), ('${C(9)}','${OTHER}');
      INSERT INTO wacrm.disp_import_contacts(account_id, draft_id, contact_id) VALUES ('${ACC}','${SRC}','${C(1)}'), ('${ACC}','${SRC}','${C(2)}'), ('${ACC}','${SRC}','${C(3)}');
      -- a 1ª campanha já "consumiu" as variáveis do rascunho (campaign_id preenchido, draft_id mantido), como o startCampaign faz
      INSERT INTO wacrm.contact_import_variables(contact_id, campaign_id, draft_id, var_index, value) VALUES
        ('${C(1)}','${CAMP}','${SRC}',0,'a1'), ('${C(1)}','${CAMP}','${SRC}',1,'b1'), ('${C(2)}','${CAMP}','${SRC}',0,'a2');
      -- variável de contato de OUTRA conta sob o mesmo rascunho (dado sujo): nunca deve ser copiada
      INSERT INTO wacrm.contact_import_variables(contact_id, campaign_id, draft_id, var_index, value) VALUES ('${C(9)}',NULL,'${SRC}',0,'alheio');
    `);
  });

  it('registra a si mesma em schema_migrations e cria name com limite de 1 a 120 caracteres', async () => {
    expect((await db.query<{ version: string }>("SELECT version FROM wacrm.schema_migrations WHERE version LIKE '292%'")).rows).toEqual([{ version: '292_import_lists' }]);
    await db.query("INSERT INTO wacrm.dispatch_import_jobs(account_id, name) VALUES ($1, 'Inadimplentes 2024')", [ACC]);
    await db.query('INSERT INTO wacrm.dispatch_import_jobs(account_id) VALUES ($1)', [ACC]); // sem nome continua valendo
    await expect(db.query("INSERT INTO wacrm.dispatch_import_jobs(account_id, name) VALUES ($1, '')", [ACC])).rejects.toThrow();
    await expect(db.query('INSERT INTO wacrm.dispatch_import_jobs(account_id, name) VALUES ($1, $2)', [ACC, 'x'.repeat(121)])).rejects.toThrow();
  });

  it('copia vínculos e variáveis do rascunho de origem para o rascunho NOVO (variáveis sem campaign_id, prontas para a campanha nova)', async () => {
    expect(await dup()).toEqual({ contacts: 3, variables: 3 });
    expect(await links(NEW)).toEqual([C(1), C(2), C(3)]);
    expect(await vars(NEW)).toEqual([
      { contact_id: C(1), var_index: 0, value: 'a1', campaign_id: null },
      { contact_id: C(1), var_index: 1, value: 'b1', campaign_id: null },
      { contact_id: C(2), var_index: 0, value: 'a2', campaign_id: null },
    ]);
  });

  it('a lista de origem NÃO muda e pode ser reutilizada de novo (outro rascunho novo)', async () => {
    await dup();
    expect(await links(SRC)).toEqual([C(1), C(2), C(3)]);
    expect((await vars(SRC)).filter((v) => v.campaign_id === CAMP)).toHaveLength(3);
    const NEW2 = 'd0000000-0000-0000-0000-000000000003';
    expect(await dup({ newDraft: NEW2 })).toEqual({ contacts: 3, variables: 3 });
    expect(await links(NEW2)).toEqual([C(1), C(2), C(3)]);
  });

  it('idempotente: repetir com o mesmo rascunho novo não duplica', async () => {
    await dup();
    expect(await dup()).toEqual({ contacts: 0, variables: 0 });
    expect(await links(NEW)).toHaveLength(3);
  });

  it('origem por CAMPANHA (importação feita ao editar): copia os vínculos e variáveis daquela campanha', async () => {
    await db.exec(`
      INSERT INTO wacrm.disp_import_contacts(account_id, campaign_id, contact_id) VALUES ('${ACC}','${CAMP}','${C(1)}'), ('${ACC}','${CAMP}','${C(2)}');
    `);
    expect(await dup({ draft: null, campaign: CAMP })).toEqual({ contacts: 2, variables: 3 });
    expect(await links(NEW)).toEqual([C(1), C(2)]);
  });

  it('isolamento por conta: não copia contato/variável de outra conta; origem de outra conta copia nada; rascunho novo de outra conta é recusado', async () => {
    await dup();
    expect((await vars(NEW)).some((v) => v.contact_id === C(9))).toBe(false)
    const NEW4 = 'd0000000-0000-0000-0000-000000000004';
    // a conta OTHER, mesmo apontando para o rascunho da ACC, não leva nenhum vínculo/contato da ACC (só os próprios contatos dela)
    expect((await dup({ account: OTHER, newDraft: NEW4 })).contacts).toBe(0);
    expect(await links(NEW4)).toEqual([]);
    expect((await vars(NEW4)).every((v) => v.contact_id === C(9))).toBe(true);
    await expect(dup({ account: OTHER })).rejects.toThrow(/outra conta/); // NEW já pertence à ACC
  });

  it('entradas vazias não fazem nada', async () => {
    expect(await dup({ draft: null, campaign: null })).toEqual({ contacts: 0, variables: 0 });
    expect(await links(NEW)).toEqual([]);
  });

  it('fechada: só service_role executa', async () => {
    const g = await db.query<{ r: string; f: boolean }>(`
      SELECT r, has_function_privilege(r, 'wacrm.duplicate_import_list(uuid,uuid,uuid,uuid)', 'EXECUTE') AS f
        FROM (VALUES ('anon'), ('authenticated'), ('service_role')) v(r)`);
    expect(Object.fromEntries(g.rows.map((x) => [x.r, x.f]))).toEqual({ anon: false, authenticated: false, service_role: true });
  });
});
