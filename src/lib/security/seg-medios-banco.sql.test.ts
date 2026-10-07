import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Migration 174 (auditoria: A-9 resto + M-12) sobre o estado da 170.
const m170 = readFileSync(resolve('supabase/migrations/170_rls_tabelas_e_rpcs_definer.sql'), 'utf8');
const m174 = readFileSync(resolve('supabase/migrations/174_seg_medios_banco.sql'), 'utf8');

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const VIEWER_A = '00000000-0000-0000-0000-0000000000a1';
const AGENT_A = '00000000-0000-0000-0000-0000000000a2';
const ADMIN_A = '00000000-0000-0000-0000-0000000000a3';
const ADMIN_B = '00000000-0000-0000-0000-0000000000b1';
const S1 = '00000000-0000-0000-0000-0000000000e1';
const S2 = '00000000-0000-0000-0000-0000000000e2';
const CONV = '00000000-0000-0000-0000-0000000000c1';
let db: PGlite;

type Role = 'authenticated' | 'anon' | 'service_role';

async function as(role: Role, uid: string | null, sql: string) {
  await db.exec(`SET ROLE ${role}`);
  await db.exec(`SELECT set_config('test.uid', '${uid ?? ''}', false)`);
  try {
    return await db.query<Record<string, unknown>>(sql);
  } finally {
    await db.exec('RESET ROLE');
  }
}

const dealsIn = async (account: string, stage: string) =>
  Number(
    (await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM wacrm.deals WHERE account_id = '${account}' AND stage_id = '${stage}'`
    )).rows[0].n
  );

describe('migration 174 — RPCs com search_path vazio, deal_aging_rules e internal_messages', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
        $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
      CREATE SCHEMA wacrm;
      GRANT USAGE ON SCHEMA wacrm, auth TO anon, authenticated, service_role;
      GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
      CREATE TYPE wacrm.account_role_enum AS ENUM ('viewer','agent','admin','owner');
      CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY);
      CREATE TABLE wacrm.profiles (user_id uuid PRIMARY KEY, account_id uuid, account_role wacrm.account_role_enum);
      CREATE FUNCTION wacrm.is_account_member(target uuid, min_role wacrm.account_role_enum DEFAULT 'viewer')
        RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = wacrm AS $$
          SELECT EXISTS (SELECT 1 FROM wacrm.profiles p WHERE p.user_id = auth.uid()
            AND p.account_id = target AND p.account_role >= min_role) $$;
      CREATE TABLE wacrm.contacts (id uuid PRIMARY KEY, account_id uuid);
      CREATE TABLE wacrm.campaigns (id uuid PRIMARY KEY, account_id uuid);
      CREATE TABLE wacrm.system_logs (id serial PRIMARY KEY, account_id uuid, message text);
      CREATE TABLE wacrm.page_views (id serial PRIMARY KEY, account_id uuid, path text);
      CREATE TABLE wacrm.user_sessions (id uuid PRIMARY KEY, account_id uuid, page_count int DEFAULT 0, user_id uuid);
      CREATE TABLE wacrm.contact_import_variables (id serial PRIMARY KEY, contact_id uuid, value text);
      CREATE TABLE wacrm.disparador_utm_links (id serial PRIMARY KEY, campaign_id uuid, draft_id uuid, link_curto text);
      CREATE TABLE wacrm.knowledge_base_files (id serial PRIMARY KEY, account_id uuid, name text);
      CREATE TABLE wacrm.deals (id serial PRIMARY KEY, account_id uuid, stage_id uuid, status text, updated_at timestamptz);
      CREATE TABLE wacrm.deal_aging_rules (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid,
        source_stage_id uuid, target_stage_id uuid, days_limit int);
      CREATE POLICY "Users can manage deal aging rules" ON wacrm.deal_aging_rules FOR ALL
        USING (wacrm.is_account_member(account_id));
      ALTER TABLE wacrm.deal_aging_rules ENABLE ROW LEVEL SECURITY;
      CREATE TABLE wacrm.conversations (id uuid PRIMARY KEY, unread_count int DEFAULT 0);
      CREATE TABLE wacrm.tags (id serial PRIMARY KEY, account_id uuid, name text);
      CREATE FUNCTION wacrm.seed_tabulacao_tags(p_account_id uuid, p_user_id uuid) RETURNS void
        LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN
          INSERT INTO wacrm.tags (account_id, name) VALUES (p_account_id, 'seed'); END $$;
      CREATE FUNCTION wacrm.increment_unread_count(conversation_id uuid) RETURNS void
        LANGUAGE sql SECURITY DEFINER AS $$ UPDATE wacrm.conversations SET unread_count = unread_count + 1 WHERE id = conversation_id $$;
      CREATE FUNCTION wacrm.increment_session_page_count(p_session_id uuid, p_user_id uuid) RETURNS void
        LANGUAGE sql SECURITY DEFINER AS $$ UPDATE wacrm.user_sessions SET page_count = page_count + 1 WHERE id = p_session_id $$;
      CREATE FUNCTION wacrm.move_stale_deals(p_source_stage_id uuid, p_target_stage_id uuid, p_days_limit int) RETURNS int LANGUAGE sql AS $$ SELECT 0 $$;
      CREATE TABLE wacrm.internal_messages (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL,
        sender_id uuid NOT NULL, recipient_id uuid NOT NULL, content text NOT NULL, read_at timestamptz);
      ALTER TABLE wacrm.internal_messages ENABLE ROW LEVEL SECURITY;
      CREATE POLICY internal_messages_select ON wacrm.internal_messages FOR SELECT
        USING ((auth.uid() = sender_id OR auth.uid() = recipient_id) AND wacrm.is_account_member(account_id));
      CREATE POLICY internal_messages_update ON wacrm.internal_messages FOR UPDATE
        USING (auth.uid() = recipient_id) WITH CHECK (auth.uid() = recipient_id);
      -- GRANT da 027: tudo para anon/authenticated.
      GRANT ALL ON ALL TABLES IN SCHEMA wacrm TO anon, authenticated, service_role;
      GRANT ALL ON ALL FUNCTIONS IN SCHEMA wacrm TO anon, authenticated, service_role;
      GRANT ALL ON ALL SEQUENCES IN SCHEMA wacrm TO anon, authenticated, service_role;
      INSERT INTO wacrm.accounts VALUES ('${A}'), ('${B}');
      INSERT INTO wacrm.profiles VALUES
        ('${VIEWER_A}', '${A}', 'viewer'), ('${AGENT_A}', '${A}', 'agent'),
        ('${ADMIN_A}', '${A}', 'admin'), ('${ADMIN_B}', '${B}', 'admin');
      INSERT INTO wacrm.deals (account_id, stage_id, status, updated_at) VALUES
        ('${A}', '${S1}', 'open', now() - interval '30 days'),
        ('${B}', '${S1}', 'open', now() - interval '30 days');
      INSERT INTO wacrm.deal_aging_rules (account_id, source_stage_id, target_stage_id, days_limit)
        VALUES ('${A}', '${S1}', '${S2}', 7);
      INSERT INTO wacrm.conversations (id) VALUES ('${CONV}');
      INSERT INTO wacrm.internal_messages (id, account_id, sender_id, recipient_id, content) VALUES
        ('00000000-0000-0000-0000-0000000000f1', '${A}', '${ADMIN_A}', '${AGENT_A}', 'oi'),
        ('00000000-0000-0000-0000-0000000000f2', '${B}', '${ADMIN_B}', '${ADMIN_B}', 'nota B');
    `);
    await db.exec(m170);
    await db.exec(m174);
    await db.exec(m174); // idempotente
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  describe('RPCs', () => {
    it.each(['move_stale_deals', 'run_all_deal_aging_rules', 'seed_tabulacao_tags', 'increment_unread_count'])(
      '%s: SECURITY DEFINER com search_path vazio',
      async (name) => {
        const { rows } = await db.query<{ prosecdef: boolean; proconfig: string[] | null }>(
          `SELECT prosecdef, proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'wacrm' AND p.proname = '${name}'`
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].prosecdef).toBe(true);
        expect(rows[0].proconfig).toContain('search_path=""');
      }
    );

    it('run_all_deal_aging_rules: viewer e anon negados; admin de OUTRA conta negado', async () => {
      await expect(as('authenticated', VIEWER_A, `SELECT * FROM wacrm.run_all_deal_aging_rules('${A}')`)).rejects.toThrow(/Acesso negado/);
      await expect(as('authenticated', ADMIN_B, `SELECT * FROM wacrm.run_all_deal_aging_rules('${A}')`)).rejects.toThrow(/Acesso negado/);
      await expect(as('anon', null, `SELECT * FROM wacrm.run_all_deal_aging_rules('${A}')`)).rejects.toThrow(/permission denied/);
      expect(await dealsIn(A, S1)).toBe(1);
    });

    it('run_all_deal_aging_rules: agent da conta move só os deals da própria conta', async () => {
      const { rows } = await as('authenticated', AGENT_A, `SELECT * FROM wacrm.run_all_deal_aging_rules('${A}')`);
      expect(rows).toHaveLength(1);
      expect(rows[0].moved_count).toBe(1);
      expect(await dealsIn(A, S2)).toBe(1);
      expect(await dealsIn(B, S1)).toBe(1); // conta B intacta (mesmo stage_id)
    });

    it('move_stale_deals, seed_tabulacao_tags e increment_unread_count: só service_role', async () => {
      const calls = [
        `SELECT wacrm.move_stale_deals('${S1}', '${S2}', 1)`,
        `SELECT wacrm.seed_tabulacao_tags('${A}', '${ADMIN_A}')`,
        `SELECT wacrm.increment_unread_count('${CONV}')`,
      ];
      for (const sql of calls) {
        await expect(as('authenticated', ADMIN_A, sql)).rejects.toThrow(/permission denied/);
        await expect(as('anon', null, sql)).rejects.toThrow(/permission denied/);
        await as('service_role', null, sql); // funciona com search_path vazio
      }
      const unread = await db.query<{ unread_count: number }>(`SELECT unread_count FROM wacrm.conversations WHERE id = '${CONV}'`);
      expect(unread.rows[0].unread_count).toBe(1);
      expect((await db.query(`SELECT 1 FROM wacrm.tags WHERE account_id = '${A}' AND name = 'seed'`)).rows).toHaveLength(1);
    });
  });

  describe('M-12: deal_aging_rules', () => {
    const insert = (account: string) =>
      `INSERT INTO wacrm.deal_aging_rules (account_id, source_stage_id, target_stage_id, days_limit)
       VALUES ('${account}', '${S2}', '${S1}', 3)`;

    it('membro lê as regras da própria conta; outra conta não vê', async () => {
      expect((await as('authenticated', VIEWER_A, 'SELECT * FROM wacrm.deal_aging_rules')).rows).toHaveLength(1);
      expect((await as('authenticated', ADMIN_B, 'SELECT * FROM wacrm.deal_aging_rules')).rows).toHaveLength(0);
    });

    it('viewer e agent não escrevem (INSERT/UPDATE/DELETE)', async () => {
      for (const uid of [VIEWER_A, AGENT_A]) {
        await expect(as('authenticated', uid, insert(A))).rejects.toThrow(/row-level security/);
        await as('authenticated', uid, 'UPDATE wacrm.deal_aging_rules SET days_limit = 1');
        await as('authenticated', uid, 'DELETE FROM wacrm.deal_aging_rules');
      }
      const { rows } = await db.query<{ days_limit: number }>('SELECT days_limit FROM wacrm.deal_aging_rules');
      expect(rows).toEqual([{ days_limit: 7 }]); // update/delete sem efeito
    });

    it('admin escreve na própria conta, mas não na de outra', async () => {
      await as('authenticated', ADMIN_A, insert(A));
      await expect(as('authenticated', ADMIN_B, insert(A))).rejects.toThrow(/row-level security/);
      await as('authenticated', ADMIN_A, "UPDATE wacrm.deal_aging_rules SET days_limit = 9 WHERE days_limit = 3");
      await as('authenticated', ADMIN_A, 'DELETE FROM wacrm.deal_aging_rules WHERE days_limit = 9');
      expect((await db.query('SELECT 1 FROM wacrm.deal_aging_rules')).rows).toHaveLength(1);
    });
  });

  describe('M-12: internal_messages', () => {
    const MSG = '00000000-0000-0000-0000-0000000000f1';

    it('destinatário NÃO altera content/sender_id/recipient_id (permission denied)', async () => {
      for (const col of ["content = 'forjado'", `sender_id = '${VIEWER_A}'`, `recipient_id = '${VIEWER_A}'`]) {
        await expect(as('authenticated', AGENT_A, `UPDATE wacrm.internal_messages SET ${col} WHERE id = '${MSG}'`))
          .rejects.toThrow(/permission denied/);
      }
      const row = await db.query<{ content: string }>(`SELECT content FROM wacrm.internal_messages WHERE id = '${MSG}'`);
      expect(row.rows[0].content).toBe('oi');
    });

    it('destinatário marca como lida (só read_at)', async () => {
      await as('authenticated', AGENT_A, `UPDATE wacrm.internal_messages SET read_at = now() WHERE id = '${MSG}' AND read_at IS NULL`);
      const row = await db.query<{ read_at: string | null }>(`SELECT read_at FROM wacrm.internal_messages WHERE id = '${MSG}'`);
      expect(row.rows[0].read_at).not.toBeNull();
    });

    it('remetente e terceiros não conseguem marcar/alterar; anon sem acesso', async () => {
      await db.exec(`UPDATE wacrm.internal_messages SET read_at = NULL WHERE id = '${MSG}'`);
      await as('authenticated', ADMIN_A, `UPDATE wacrm.internal_messages SET read_at = now() WHERE id = '${MSG}'`); // remetente: RLS filtra
      await as('authenticated', ADMIN_B, `UPDATE wacrm.internal_messages SET read_at = now() WHERE id = '${MSG}'`);
      const row = await db.query<{ read_at: string | null }>(`SELECT read_at FROM wacrm.internal_messages WHERE id = '${MSG}'`);
      expect(row.rows[0].read_at).toBeNull();
      await expect(as('anon', null, `UPDATE wacrm.internal_messages SET read_at = now()`)).rejects.toThrow(/permission denied/);
    });

    it('INSERT continua permitido ao remetente da conta (grant só tirou UPDATE)', async () => {
      await as('authenticated', ADMIN_A,
        `INSERT INTO wacrm.internal_messages (account_id, sender_id, recipient_id, content)
         VALUES ('${A}', '${ADMIN_A}', '${AGENT_A}', 'nova')`).catch(() => undefined);
      // O stub não cria policy de INSERT (RLS nega); o ponto é o privilégio de tabela não ter sido removido.
      const priv = await db.query<{ ok: boolean }>(
        `SELECT has_table_privilege('authenticated', 'wacrm.internal_messages', 'INSERT') AS ok`
      );
      expect(priv.rows[0].ok).toBe(true);
    });
  });
});
