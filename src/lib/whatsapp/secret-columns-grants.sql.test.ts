// Migrations 200 (ai_config) e 200b (whatsapp_config): o navegador (papel `authenticated`) não lê segredo
// nem escreve em ai_config. Postgres real (PGlite) com RLS, roles e os grants herdados da 027/153.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const A = '00000000-0000-0000-0000-0000000000a1';
const B = '00000000-0000-0000-0000-0000000000b2';
let db: PGlite;

const migration = (file: string) =>
  readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8').replace(/NOTIFY pgrst[^;]*;/g, '');

/** Executa como o navegador (authenticated, membro da conta A) ou anon; sempre volta ao superusuário. */
async function as<T>(role: 'authenticated' | 'anon', fn: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}; SELECT set_config('app.account', '${A}', false);`);
  try {
    return await fn();
  } finally {
    await db.exec('RESET ROLE');
  }
}
const denied = (p: Promise<unknown>) => expect(p).rejects.toThrow(/permission denied/i);

describe('migrations 200 / 200b — segredos fora do alcance do navegador', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA wacrm;
      GRANT USAGE ON SCHEMA wacrm TO anon, authenticated, service_role;
      CREATE FUNCTION wacrm.is_account_member(p_account uuid) RETURNS boolean
        LANGUAGE sql STABLE AS $$ SELECT p_account = nullif(current_setting('app.account', true), '')::uuid $$;
      GRANT EXECUTE ON FUNCTION wacrm.is_account_member(uuid) TO anon, authenticated;

      CREATE TABLE wacrm.ai_config (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, enabled boolean NOT NULL DEFAULT false,
        api_provider text DEFAULT 'gemini', api_key text, elevenlabs_api_key text, system_prompt text
      );
      ALTER TABLE wacrm.ai_config ENABLE ROW LEVEL SECURITY;
      CREATE POLICY "Users can manage own AI config" ON wacrm.ai_config FOR ALL USING (wacrm.is_account_member(account_id));
      INSERT INTO wacrm.ai_config(account_id, enabled, api_key, system_prompt) VALUES
        ('${A}', true, 'sk-legado-em-texto-puro', 'prompt A'), ('${B}', true, 'sk-outra-conta', 'prompt B');

      CREATE TABLE wacrm.whatsapp_config (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, user_id uuid, provider text DEFAULT 'meta',
        phone_number_id text, waba_id text, display_phone_number text, waha_url text, waha_session text,
        access_token text NOT NULL DEFAULT 'x', app_secret text, verify_token text, waha_api_key text,
        flow_id uuid, receptivo boolean DEFAULT false, habilitado boolean DEFAULT true, team_id uuid, client_id uuid
      );
      ALTER TABLE wacrm.whatsapp_config ENABLE ROW LEVEL SECURITY;
      CREATE POLICY whatsapp_config_select ON wacrm.whatsapp_config FOR SELECT USING (wacrm.is_account_member(account_id));
      CREATE POLICY whatsapp_config_update ON wacrm.whatsapp_config FOR UPDATE USING (wacrm.is_account_member(account_id));
      CREATE POLICY whatsapp_config_delete ON wacrm.whatsapp_config FOR DELETE USING (wacrm.is_account_member(account_id));
      INSERT INTO wacrm.whatsapp_config(account_id, display_phone_number, access_token, app_secret, verify_token, waha_api_key) VALUES
        ('${A}', '5511900000001', 'tok-A', 'app-A', 'ver-A', 'waha-A'), ('${B}', '5511900000002', 'tok-B', 'app-B', 'ver-B', 'waha-B');

      -- Estado herdado: 027 (GRANT ALL a anon/authenticated) + 153 (UPDATE só em 5 colunas; sem INSERT).
      GRANT ALL ON ALL TABLES IN SCHEMA wacrm TO anon, authenticated, service_role;
      REVOKE UPDATE, INSERT ON wacrm.whatsapp_config FROM authenticated;
      GRANT UPDATE (flow_id, receptivo, habilitado, team_id, client_id) ON wacrm.whatsapp_config TO authenticated;
    `);
    for (const file of ['200_ai_config_secret_columns.sql', '200b_whatsapp_config_select_columns.sql']) {
      const sql = migration(file);
      await db.exec(sql);
      await db.exec(sql); // idempotente
    }
  }, 60_000);
  afterAll(async () => {
    await db?.close();
  });

  describe('200 — ai_config', () => {
    it('o navegador ainda lê se a IA está ligada (só da própria conta)', async () => {
      const rows = await as('authenticated', async () => (await db.query<{ enabled: boolean; account_id: string }>('SELECT account_id, enabled FROM wacrm.ai_config')).rows);
      expect(rows).toEqual([{ account_id: A, enabled: true }]);
    });

    it('chaves, provedor e prompt não são legíveis (nem por select *)', async () => {
      await as('authenticated', async () => {
        for (const col of ['api_key', 'elevenlabs_api_key', 'api_provider', 'system_prompt']) {
          await denied(db.query(`SELECT ${col} FROM wacrm.ai_config`));
        }
        await denied(db.query('SELECT * FROM wacrm.ai_config'));
      });
    });

    it('nenhuma escrita pelo navegador (insert/update/delete)', async () => {
      await as('authenticated', async () => {
        await denied(db.query(`INSERT INTO wacrm.ai_config(account_id) VALUES ('${A}')`));
        await denied(db.query(`UPDATE wacrm.ai_config SET system_prompt = 'injetado' WHERE account_id = '${A}'`));
        await denied(db.query(`UPDATE wacrm.ai_config SET enabled = false WHERE account_id = '${A}'`));
        await denied(db.query(`DELETE FROM wacrm.ai_config WHERE account_id = '${A}'`));
      });
      const { rows } = await db.query<{ system_prompt: string }>(`SELECT system_prompt FROM wacrm.ai_config WHERE account_id = '${A}'`);
      expect(rows[0].system_prompt).toBe('prompt A');
    });

    it('anon não vê nada; só resta a policy de SELECT por membro', async () => {
      await as('anon', async () => denied(db.query('SELECT enabled FROM wacrm.ai_config')));
      const pol = await db.query<{ policyname: string; cmd: string }>(`SELECT policyname, cmd FROM pg_policies WHERE schemaname='wacrm' AND tablename='ai_config'`);
      expect(pol.rows).toEqual([{ policyname: 'ai_config_select', cmd: 'SELECT' }]);
    });

    it('o servidor (service_role) segue lendo e gravando tudo', async () => {
      const g = await db.query<{ ok: boolean }>(
        `SELECT has_table_privilege('service_role','wacrm.ai_config','SELECT') AND has_table_privilege('service_role','wacrm.ai_config','INSERT') AND has_table_privilege('service_role','wacrm.ai_config','UPDATE') AS ok`,
      );
      expect(g.rows[0].ok).toBe(true);
    });
  });

  describe('200b — whatsapp_config', () => {
    const SECRETS = ['access_token', 'app_secret', 'verify_token', 'waha_api_key'];

    it('colunas não secretas continuam legíveis, filtradas pela RLS', async () => {
      const rows = await as('authenticated', async () =>
        (await db.query<{ display_phone_number: string }>('SELECT id, account_id, provider, display_phone_number, waba_id, waha_session, team_id, flow_id, habilitado FROM wacrm.whatsapp_config')).rows,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].display_phone_number).toBe('5511900000001');
    });

    it('os 4 segredos e o select * não são legíveis pelo navegador', async () => {
      await as('authenticated', async () => {
        for (const col of SECRETS) await denied(db.query(`SELECT ${col} FROM wacrm.whatsapp_config`));
        await denied(db.query('SELECT * FROM wacrm.whatsapp_config'));
        // Segredo usado só em filtro também não vaza por tentativa/erro.
        await denied(db.query(`SELECT id FROM wacrm.whatsapp_config WHERE app_secret = 'app-A'`));
      });
    });

    it('anon não tem acesso nenhum', async () => {
      await as('anon', async () => {
        await denied(db.query('SELECT id FROM wacrm.whatsapp_config'));
        await denied(db.query(`DELETE FROM wacrm.whatsapp_config`));
      });
    });

    it('o PATCH não secreto (153) e o DELETE por RLS seguem funcionando; escrita de segredo continua negada', async () => {
      await as('authenticated', async () => {
        await db.query(`UPDATE wacrm.whatsapp_config SET habilitado = false, receptivo = true WHERE account_id = '${A}'`);
        await denied(db.query(`UPDATE wacrm.whatsapp_config SET access_token = 'roubado' WHERE account_id = '${A}'`));
        await denied(db.query(`INSERT INTO wacrm.whatsapp_config(account_id) VALUES ('${A}')`));
      });
      const { rows } = await db.query<{ habilitado: boolean; access_token: string }>(`SELECT habilitado, access_token FROM wacrm.whatsapp_config WHERE account_id = '${A}'`);
      expect(rows[0]).toEqual({ habilitado: false, access_token: 'tok-A' });

      await as('authenticated', async () => {
        await db.query(`DELETE FROM wacrm.whatsapp_config WHERE account_id = '${B}'`); // RLS: outra conta = 0 linhas
      });
      expect((await db.query(`SELECT 1 FROM wacrm.whatsapp_config WHERE account_id = '${B}'`)).rows).toHaveLength(1);
    });

    it('o service_role segue com acesso total (o servidor lê os segredos por ele)', async () => {
      const g = await db.query<{ ok: boolean }>(`SELECT has_column_privilege('service_role','wacrm.whatsapp_config','access_token','SELECT') AS ok`);
      expect(g.rows[0].ok).toBe(true);
    });

    it('aborta sem alterar nada se uma coluna de segredo não existir no banco', async () => {
      const other = new PGlite();
      await other.exec(`
        CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA wacrm;
        CREATE TABLE wacrm.whatsapp_config (id uuid PRIMARY KEY, account_id uuid, access_token text);
        GRANT ALL ON wacrm.whatsapp_config TO authenticated;
      `);
      await expect(other.exec(migration('200b_whatsapp_config_select_columns.sql'))).rejects.toThrow(/esperava as colunas/);
      await other.exec('ROLLBACK');
      const g = await other.query<{ ok: boolean }>(`SELECT has_table_privilege('authenticated','wacrm.whatsapp_config','SELECT') AS ok`);
      expect(g.rows[0].ok).toBe(true); // nada foi revogado
      await other.close();
    }, 60_000);
  });
});
