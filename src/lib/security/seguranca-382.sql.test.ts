// Migration 382 (revisão de segurança de 16/10): M2 carteira, M3 resumo do painel com 2FA, M5 reserva do @operador, M6 RPC e fluxo 'delayed'.
// PGlite com as migrations REAIS 372 e 376, as funções REAIS de 310 (mfa_ok) e 375 (dashboard_ai_snapshot_read) extraídas dos arquivos, e a 382.
// Cada achado é provado ANTES (banco sem a 382: o problema existe) e DEPOIS (com a 382: corrigido). O rollback executado é o bloco documentado no
// cabeçalho da própria migration.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const read = (file: string) => readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8')
const migration = (file: string) => read(file).replace(/NOTIFY pgrst[^;]*;/g, '')

/** Trecho [de, até] (inclusive) de um arquivo de migration. */
function slice(file: string, from: string, to: string): string {
  const text = read(file)
  const i = text.indexOf(from)
  const j = text.indexOf(to, i)
  if (i < 0 || j < 0) throw new Error(`trecho não encontrado em ${file}: ${from}`)
  return text.slice(i, j + to.length)
}

const MFA_OK_310 = slice('310_rls_mfa_aal2.sql', 'CREATE OR REPLACE FUNCTION wacrm.mfa_ok()', 'GRANT EXECUTE ON FUNCTION wacrm.mfa_ok() TO authenticated;')
const SNAPSHOT_READ_375 = slice(
  '375_dashboard_ai_snapshot.sql',
  'CREATE OR REPLACE FUNCTION wacrm.dashboard_ai_snapshot_read()',
  'GRANT EXECUTE ON FUNCTION wacrm.dashboard_ai_snapshot_read() TO authenticated, service_role;',
)
const ROLLBACK_382 = (() => {
  const text = read('382_seguranca_carteira_mfa_reserva.sql')
  const a = text.indexOf('-- ROLLBACK-INICIO')
  const b = text.indexOf('-- ROLLBACK-FIM')
  return text
    .slice(a, b)
    .split('\n')
    .slice(1)
    .map((l) => l.replace(/^--\s?/, ''))
    .join('\n')
    .replace(/NOTIFY pgrst[^;]*;/g, '')
})()

const A = '00000000-0000-0000-0000-00000000000a'
const B = '00000000-0000-0000-0000-00000000000b'
const u = (n: number) => `00000000-0000-0000-0000-0000000004${String(n).padStart(2, '0')}`
const T1 = '00000000-0000-0000-0000-0000000005aa'
const ADMIN = u(1)
const AG1 = u(2) // operador com apelido
const AG2 = u(3) // outro operador
const SUP = u(4)
const VIEWER = u(5)
const AGB = u(6) // operador da conta B
const AGDEAC = u(7) // operador desativado da conta A
const GHOST = u(8) // operador da conta A, usado nos testes de limpeza

const BOOTSTRAP = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA wacrm; CREATE SCHEMA auth;
  GRANT USAGE ON SCHEMA wacrm, auth TO anon, authenticated, service_role;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
  CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT jsonb_build_object('aal', nullif(current_setting('test.aal', true), '')) $$;
  CREATE TABLE auth.users (id uuid PRIMARY KEY);
  CREATE TABLE auth.mfa_factors (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, status text, factor_type text);
  CREATE TYPE wacrm.account_role_enum AS ENUM ('owner', 'admin', 'supervisor', 'agent', 'viewer');
  CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
  CREATE TABLE wacrm.profiles (
    user_id uuid PRIMARY KEY, account_id uuid REFERENCES wacrm.accounts(id),
    account_role wacrm.account_role_enum NOT NULL, deactivated_at timestamptz, full_name text
  );
  CREATE TABLE wacrm.teams (id uuid PRIMARY KEY, account_id uuid REFERENCES wacrm.accounts(id));
  CREATE TABLE wacrm.team_members (team_id uuid REFERENCES wacrm.teams(id), user_id uuid, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (team_id, user_id));
  CREATE TABLE wacrm.conversations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES wacrm.accounts(id),
    status text NOT NULL DEFAULT 'open', assigned_agent_id uuid, team_id uuid REFERENCES wacrm.teams(id),
    last_message_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
  );
  CREATE TABLE wacrm.flow_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid, conversation_id uuid,
    status text NOT NULL DEFAULT 'active', end_reason text, ended_at timestamptz
  );
  CREATE TABLE wacrm.contacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES wacrm.accounts(id), name text);
  CREATE TABLE wacrm.dashboard_ai_snapshot (account_id uuid PRIMARY KEY, data jsonb NOT NULL, refreshed_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);

  CREATE FUNCTION wacrm.current_user_role() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = wacrm, public
    AS $$ SELECT p.account_role::text FROM wacrm.profiles p WHERE p.user_id = auth.uid() LIMIT 1 $$;
  CREATE FUNCTION wacrm.current_account_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = wacrm, public
    AS $$ SELECT p.account_id FROM wacrm.profiles p WHERE p.user_id = auth.uid() LIMIT 1 $$;
  CREATE FUNCTION wacrm.is_account_member(p_account uuid, p_role wacrm.account_role_enum DEFAULT 'viewer') RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = wacrm, public
    AS $$ SELECT EXISTS (SELECT 1 FROM wacrm.profiles p WHERE p.user_id = auth.uid() AND p.account_id = p_account AND p.account_role <= p_role) $$;
  CREATE FUNCTION wacrm.has_perm(p text) RETURNS boolean LANGUAGE sql STABLE
    AS $$ SELECT p = ANY (string_to_array(coalesce(current_setting('test.perms', true), ''), ',')) $$;
  ${MFA_OK_310}

  -- RLS reduzida das tabelas tocadas (o que importa aqui são as colunas protegidas pelos triggers, não as policies de linha)
  ALTER TABLE wacrm.contacts ENABLE ROW LEVEL SECURITY;
  CREATE POLICY contacts_select ON wacrm.contacts FOR SELECT USING (wacrm.is_account_member(account_id));
  CREATE POLICY contacts_insert ON wacrm.contacts FOR INSERT WITH CHECK (wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('contacts.edit')));
  CREATE POLICY contacts_update ON wacrm.contacts FOR UPDATE USING (wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('contacts.edit')));
  ALTER TABLE wacrm.profiles ENABLE ROW LEVEL SECURITY;
  CREATE POLICY profiles_select ON wacrm.profiles FOR SELECT USING (wacrm.is_account_member(account_id));
  ALTER TABLE wacrm.conversations ENABLE ROW LEVEL SECURITY;
  CREATE POLICY conversations_select ON wacrm.conversations FOR SELECT USING (wacrm.is_account_member(account_id));
  GRANT SELECT, INSERT, UPDATE ON wacrm.contacts TO authenticated, service_role;
  GRANT SELECT ON wacrm.profiles, wacrm.conversations TO authenticated;
  GRANT SELECT, UPDATE ON wacrm.profiles TO service_role;
  GRANT SELECT, INSERT, UPDATE ON wacrm.conversations, wacrm.flow_runs TO service_role;
  GRANT SELECT ON auth.mfa_factors TO authenticated;

  INSERT INTO wacrm.accounts (id, name) VALUES ('${A}', 'A'), ('${B}', 'B');
  INSERT INTO auth.users (id) VALUES ('${ADMIN}'), ('${AG1}'), ('${AG2}'), ('${SUP}'), ('${VIEWER}'), ('${AGB}'), ('${AGDEAC}'), ('${GHOST}');
  INSERT INTO wacrm.profiles (user_id, account_id, account_role, deactivated_at, full_name) VALUES
    ('${ADMIN}', '${A}', 'admin', NULL, 'Admin'), ('${AG1}', '${A}', 'agent', NULL, 'Ana'), ('${AG2}', '${A}', 'agent', NULL, 'Bia'),
    ('${SUP}', '${A}', 'supervisor', NULL, 'Sup'), ('${VIEWER}', '${A}', 'viewer', NULL, 'Vi'), ('${AGB}', '${B}', 'agent', NULL, 'Outra conta'),
    ('${AGDEAC}', '${A}', 'agent', now(), 'Desativado'), ('${GHOST}', '${A}', 'agent', NULL, 'Gui');
  INSERT INTO wacrm.teams (id, account_id) VALUES ('${T1}', '${A}');
  INSERT INTO wacrm.team_members (team_id, user_id) VALUES ('${T1}', '${AG1}'), ('${T1}', '${AG2}');
  INSERT INTO wacrm.dashboard_ai_snapshot (account_id, data) VALUES ('${A}', '{"financials":{"won":123}}');
`

async function makeDb(opts: { with382?: boolean; noMfa?: boolean } = {}): Promise<PGlite> {
  const db = new PGlite()
  await db.exec(opts.noMfa ? BOOTSTRAP.replace(MFA_OK_310, '') : BOOTSTRAP)
  await db.exec(migration('372_contacts_owner.sql')) // coluna owner_user_id (REAL)
  await db.exec(migration('376_agent_mention_queue.sql')) // mention_alias, requested_agent_id, RPC (REAL)
  await db.exec(SNAPSHOT_READ_375) // função REAL da 375 (a versão com a falha)
  if (opts.with382) await db.exec(migration('382_seguranca_carteira_mfa_reserva.sql'))
  return db
}

const asUser = async (db: PGlite, user: string, perms: string, aal = 'aal2') => {
  await db.exec(
    `RESET ROLE; SELECT set_config('test.uid', '${user}', false), set_config('test.perms', '${perms}', false), set_config('test.aal', '${aal}', false); SET ROLE authenticated;`,
  )
}
const asServer = (db: PGlite) => db.exec(`RESET ROLE; SET ROLE service_role`)
const asOwner = (db: PGlite) => db.exec(`RESET ROLE`)

const PERMS_ADMIN = 'contacts.edit,pipelines.view'
const PERMS_AGENT = 'contacts.edit'

describe('migration 382 — M2: carteira (contacts.owner_user_id)', { timeout: 120_000 }, () => {
  let pre: PGlite
  let db: PGlite
  let c1: string
  let cB: string
  beforeAll(async () => {
    pre = await makeDb()
    db = await makeDb({ with382: true })
    for (const d of [pre, db]) {
      await d.exec(`INSERT INTO wacrm.contacts (id, account_id, name) VALUES ('${u(90)}', '${A}', 'c1'), ('${u(91)}', '${B}', 'cB')`)
    }
    c1 = u(90)
    cB = u(91)
  }, 90_000)
  afterAll(async () => {
    await pre.close()
    await db.close()
  }, 60_000)

  it('ANTES: um operador comum se põe como dono de qualquer contato, ou aponta para usuário de outra conta', async () => {
    await asUser(pre, AG1, PERMS_AGENT)
    await pre.query(`UPDATE wacrm.contacts SET owner_user_id = $1 WHERE id = $2`, [AG1, c1])
    await pre.query(`UPDATE wacrm.contacts SET owner_user_id = $1 WHERE id = $2`, [AGB, c1]) // outra conta
    await asOwner(pre)
    expect((await pre.query<{ o: string }>(`SELECT owner_user_id AS o FROM wacrm.contacts WHERE id = $1`, [c1])).rows[0].o).toBe(AGB)
  })

  it('DEPOIS: operador comum não muda a carteira (42501), mas edita as outras colunas e regrava o mesmo dono', async () => {
    await asUser(db, AG1, PERMS_AGENT)
    await expect(db.query(`UPDATE wacrm.contacts SET owner_user_id = $1 WHERE id = $2`, [AG1, c1])).rejects.toThrow(/managed by administrators/)
    await expect(db.query(`UPDATE wacrm.contacts SET owner_user_id = NULL WHERE id = $1`, [c1])).resolves.toBeDefined() // já era NULL: sem mudança
    await db.query(`UPDATE wacrm.contacts SET name = 'novo nome' WHERE id = $1`, [c1])
    await asOwner(db)
    expect((await db.query<{ n: string }>(`SELECT name AS n FROM wacrm.contacts WHERE id = $1`, [c1])).rows[0].n).toBe('novo nome')
  })

  it('DEPOIS: admin com contacts.edit define o dono; dono de outra conta, viewer, desativado ou inexistente é recusado', async () => {
    await asUser(db, ADMIN, PERMS_ADMIN)
    await db.query(`UPDATE wacrm.contacts SET owner_user_id = $1 WHERE id = $2`, [AG1, c1])
    await db.query(`UPDATE wacrm.contacts SET owner_user_id = $1 WHERE id = $2`, [SUP, c1]) // supervisor vale (mesma regra da API)
    await expect(db.query(`UPDATE wacrm.contacts SET owner_user_id = $1 WHERE id = $2`, [AGB, c1])).rejects.toThrow(/active attendant of the same account/)
    await expect(db.query(`UPDATE wacrm.contacts SET owner_user_id = $1 WHERE id = $2`, [VIEWER, c1])).rejects.toThrow(/active attendant/)
    await expect(db.query(`UPDATE wacrm.contacts SET owner_user_id = $1 WHERE id = $2`, [AGDEAC, c1])).rejects.toThrow(/active attendant/)
    await expect(db.query(`UPDATE wacrm.contacts SET owner_user_id = $1 WHERE id = $2`, [u(99), c1])).rejects.toThrow() // FK
    await asOwner(db)
    expect((await db.query<{ o: string }>(`SELECT owner_user_id AS o FROM wacrm.contacts WHERE id = $1`, [c1])).rows[0].o).toBe(SUP)
  })

  it('DEPOIS: tirar o dono também é mudança de carteira: só a gestão; admin sem contacts.edit também não', async () => {
    await asUser(db, AG1, PERMS_AGENT)
    await expect(db.query(`UPDATE wacrm.contacts SET owner_user_id = NULL WHERE id = $1`, [c1])).rejects.toThrow(/managed by administrators/)
    await asUser(db, ADMIN, '') // admin mas sem contacts.edit (papel personalizado): a RLS de update já recusa ou o trigger barra
    const r = await db.query(`UPDATE wacrm.contacts SET owner_user_id = NULL WHERE id = $1 RETURNING id`, [c1]).catch(() => null)
    expect(r === null || r.rows.length === 0).toBe(true)
    await asUser(db, ADMIN, PERMS_ADMIN)
    await db.query(`UPDATE wacrm.contacts SET owner_user_id = NULL WHERE id = $1`, [c1])
  })

  it('DEPOIS: INSERT com dono pelo navegador segue a mesma regra; sem dono não muda nada', async () => {
    await asUser(db, AG1, PERMS_AGENT)
    await expect(db.query(`INSERT INTO wacrm.contacts (account_id, name, owner_user_id) VALUES ($1, 'n', $2)`, [A, AG1])).rejects.toThrow(/managed by administrators/)
    await db.query(`INSERT INTO wacrm.contacts (account_id, name) VALUES ($1, 'sem dono')`, [A])
    await asUser(db, ADMIN, PERMS_ADMIN)
    await db.query(`INSERT INTO wacrm.contacts (account_id, name, owner_user_id) VALUES ($1, 'com dono', $2)`, [A, AG2])
    await expect(db.query(`INSERT INTO wacrm.contacts (account_id, name, owner_user_id) VALUES ($1, 'x', $2)`, [A, AGB])).rejects.toThrow(/same account/)
  })

  it('DEPOIS: o servidor (service_role) passa, mas também não grava dono de outra conta (defesa em profundidade)', async () => {
    await asServer(db)
    await db.query(`UPDATE wacrm.contacts SET owner_user_id = $1 WHERE id = $2`, [AG2, c1])
    await expect(db.query(`UPDATE wacrm.contacts SET owner_user_id = $1 WHERE id = $2`, [AGB, c1])).rejects.toThrow(/same account/)
    await expect(db.query(`UPDATE wacrm.contacts SET owner_user_id = $1 WHERE id = $2`, [AG1, cB])).rejects.toThrow(/same account/) // contato da conta B
    await asOwner(db)
  })

  it('a cascata ON DELETE SET NULL (usuário removido) não é barrada pelo trigger', async () => {
    await db.exec(`INSERT INTO auth.users (id) VALUES ('${u(77)}')`)
    await db.exec(`INSERT INTO wacrm.profiles (user_id, account_id, account_role) VALUES ('${u(77)}', '${A}', 'agent')`)
    await db.exec(`UPDATE wacrm.contacts SET owner_user_id = '${u(77)}' WHERE id = '${c1}'`)
    await db.exec(`DELETE FROM wacrm.profiles WHERE user_id = '${u(77)}'; DELETE FROM auth.users WHERE id = '${u(77)}'`)
    expect((await db.query<{ o: string | null }>(`SELECT owner_user_id AS o FROM wacrm.contacts WHERE id = $1`, [c1])).rows[0].o).toBeNull()
  })
})

describe('migration 382 — M3: resumo do painel de IA exige 2FA', { timeout: 120_000 }, () => {
  let pre: PGlite
  let db: PGlite
  beforeAll(async () => {
    pre = await makeDb()
    db = await makeDb({ with382: true })
    for (const d of [pre, db]) await d.exec(`INSERT INTO auth.mfa_factors (user_id, status, factor_type) VALUES ('${ADMIN}', 'verified', 'totp')`)
  }, 90_000)
  afterAll(async () => {
    await pre.close()
    await db.close()
  }, 60_000)

  const read = async (d: PGlite) => (await d.query<{ v: unknown }>(`SELECT wacrm.dashboard_ai_snapshot_read() AS v`)).rows[0].v

  it('ANTES: admin com TOTP e sessão aal1 lê o resumo da conta inteira', async () => {
    await asUser(pre, ADMIN, PERMS_ADMIN, 'aal1')
    expect(await read(pre)).toEqual({ financials: { won: 123 } })
  })

  it('DEPOIS: aal1 de quem tem TOTP recebe nulo; aal2 lê; quem não tem TOTP lê normalmente', async () => {
    await asUser(db, ADMIN, PERMS_ADMIN, 'aal1')
    expect(await read(db)).toBeNull()
    await asUser(db, ADMIN, PERMS_ADMIN, 'aal2')
    expect(await read(db)).toEqual({ financials: { won: 123 } })
    await db.exec(`RESET ROLE; DELETE FROM auth.mfa_factors`)
    await asUser(db, ADMIN, PERMS_ADMIN, 'aal1')
    expect(await read(db)).toEqual({ financials: { won: 123 } }) // sem fator verificado, a regra da 310 não exige aal2
  })

  it('as outras regras seguem: sem pipelines.view, não-admin, outra conta ou resumo velho = nulo; anon não executa', async () => {
    await asUser(db, ADMIN, 'contacts.edit')
    expect(await read(db)).toBeNull()
    await asUser(db, AG1, PERMS_ADMIN)
    expect(await read(db)).toBeNull()
    await asUser(db, AGB, PERMS_ADMIN)
    expect(await read(db)).toBeNull()
    await db.exec(`RESET ROLE; UPDATE wacrm.dashboard_ai_snapshot SET refreshed_at = now() - interval '2 hours'`)
    await asUser(db, ADMIN, PERMS_ADMIN)
    expect(await read(db)).toBeNull()
    await db.exec(`RESET ROLE; UPDATE wacrm.dashboard_ai_snapshot SET refreshed_at = now(); SET ROLE anon`)
    await expect(db.query(`SELECT wacrm.dashboard_ai_snapshot_read()`)).rejects.toThrow(/permission denied/)
    await db.exec(`RESET ROLE`)
  })

  it('mesma assinatura e mesmos grants da 375', async () => {
    const f = (await db.query<{ args: string; secdef: boolean; ret: string }>(
      `SELECT pg_get_function_identity_arguments(p.oid) AS args, p.prosecdef AS secdef, pg_get_function_result(p.oid) AS ret
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'wacrm' AND p.proname = 'dashboard_ai_snapshot_read'`,
    )).rows
    expect(f).toEqual([{ args: '', secdef: true, ret: 'jsonb' }])
    expect((await db.query<{ a: boolean; s: boolean }>(`SELECT has_function_privilege('authenticated', 'wacrm.dashboard_ai_snapshot_read()', 'EXECUTE') AS a, has_function_privilege('anon', 'wacrm.dashboard_ai_snapshot_read()', 'EXECUTE') AS s`)).rows[0]).toEqual({ a: true, s: false })
  })
})

describe('migration 382 — M5: reserva do @operador some com o operador', { timeout: 120_000 }, () => {
  let pre: PGlite
  let db: PGlite
  beforeAll(async () => {
    pre = await makeDb()
    db = await makeDb({ with382: true })
  }, 90_000)
  afterAll(async () => {
    await pre.close()
    await db.close()
  }, 60_000)

  const reserve = async (d: PGlite, agent: string, account = A) => {
    const r = await d.query<{ id: string }>(
      `INSERT INTO wacrm.conversations (account_id, status, team_id, updated_at) VALUES ($1, 'pending', $2, now() - interval '1 hour') RETURNING id`,
      [account, account === A ? T1 : null],
    )
    await d.query(`UPDATE wacrm.conversations SET requested_agent_id = $2 WHERE id = $1`, [r.rows[0].id, agent])
    return r.rows[0].id
  }
  const state = async (d: PGlite, id: string) =>
    (await d.query<{ requested_agent_id: string | null; status: string; assigned_agent_id: string | null; team_id: string | null; old: boolean }>(
      `SELECT requested_agent_id, status, assigned_agent_id, team_id, updated_at < now() - interval '30 minutes' AS old FROM wacrm.conversations WHERE id = $1`, [id])).rows[0]
  const profile = (d: PGlite, sql: string) => d.exec(`RESET ROLE; ${sql}`)

  it('ANTES: desativar o operador reservado deixa a conversa presa a ele', async () => {
    await profile(pre, `UPDATE wacrm.profiles SET mention_alias = 'ana' WHERE user_id = '${AG1}'`)
    const id = await reserve(pre, AG1)
    await profile(pre, `UPDATE wacrm.profiles SET deactivated_at = now() WHERE user_id = '${AG1}'`)
    expect((await state(pre, id)).requested_agent_id).toBe(AG1)
  })

  it('DEPOIS: desativar libera a reserva; status, equipe e updated_at ficam (o cron de reatribuição a pega)', async () => {
    await profile(db, `UPDATE wacrm.profiles SET mention_alias = 'ana' WHERE user_id = '${AG1}'`)
    const id = await reserve(db, AG1)
    await profile(db, `UPDATE wacrm.profiles SET deactivated_at = now() WHERE user_id = '${AG1}'`)
    expect(await state(db, id)).toEqual({ requested_agent_id: null, status: 'pending', assigned_agent_id: null, team_id: T1, old: true })
    await profile(db, `UPDATE wacrm.profiles SET deactivated_at = NULL WHERE user_id = '${AG1}'`) // reativar não recria nada
    expect((await state(db, id)).requested_agent_id).toBeNull()
  })

  it('DEPOIS: deixar de ser operador libera; virar supervisor, admin ou viewer libera', async () => {
    for (const role of ['supervisor', 'admin', 'viewer']) {
      await profile(db, `UPDATE wacrm.profiles SET account_role = 'agent', mention_alias = 'ana', deactivated_at = NULL WHERE user_id = '${AG1}'`)
      const id = await reserve(db, AG1)
      await profile(db, `UPDATE wacrm.profiles SET account_role = '${role}' WHERE user_id = '${AG1}'`)
      expect((await state(db, id)).requested_agent_id, role).toBeNull()
    }
    await profile(db, `UPDATE wacrm.profiles SET account_role = 'agent' WHERE user_id = '${AG1}'`)
  })

  it('DEPOIS: ficar sem apelido libera; trocar de apelido, editar o nome ou regravar o mesmo valor mantém a reserva', async () => {
    await profile(db, `UPDATE wacrm.profiles SET mention_alias = 'ana', deactivated_at = NULL WHERE user_id = '${AG1}'`)
    const id = await reserve(db, AG1)
    await profile(db, `UPDATE wacrm.profiles SET mention_alias = 'ana2' WHERE user_id = '${AG1}'`)
    await profile(db, `UPDATE wacrm.profiles SET full_name = 'Ana Maria' WHERE user_id = '${AG1}'`)
    await profile(db, `UPDATE wacrm.profiles SET mention_alias = 'ana2' WHERE user_id = '${AG1}'`)
    await profile(db, `UPDATE wacrm.profiles SET account_role = 'agent' WHERE user_id = '${AG1}'`)
    expect((await state(db, id)).requested_agent_id).toBe(AG1)
    await profile(db, `UPDATE wacrm.profiles SET mention_alias = NULL WHERE user_id = '${AG1}'`)
    expect((await state(db, id)).requested_agent_id).toBeNull()
  })

  it('DEPOIS: apagar o perfil libera; reservas de outros operadores e de outra conta não são tocadas', async () => {
    await profile(db, `UPDATE wacrm.profiles SET mention_alias = 'bia' WHERE user_id = '${AG2}'`)
    await profile(db, `UPDATE wacrm.profiles SET mention_alias = 'gui', deactivated_at = NULL WHERE user_id = '${GHOST}'`)
    const gone = await reserve(db, GHOST)
    const other = await reserve(db, AG2)
    await profile(db, `UPDATE wacrm.profiles SET mention_alias = 'agb' WHERE user_id = '${AGB}'`)
    const outraConta = await reserve(db, AGB, B)
    await profile(db, `DELETE FROM wacrm.profiles WHERE user_id = '${GHOST}'`)
    expect((await state(db, gone)).requested_agent_id).toBeNull()
    expect((await state(db, other)).requested_agent_id).toBe(AG2)
    expect((await state(db, outraConta)).requested_agent_id).toBe(AGB)
  })

  it('o servidor (service_role) dispara a liberação; o trigger da 376 não a bloqueia', async () => {
    await profile(db, `UPDATE wacrm.profiles SET account_role = 'agent', mention_alias = 'bia', deactivated_at = NULL WHERE user_id = '${AG2}'`)
    const id = await reserve(db, AG2)
    await asServer(db)
    await db.query(`UPDATE wacrm.profiles SET deactivated_at = now() WHERE user_id = $1`, [AG2])
    await asOwner(db)
    expect((await state(db, id)).requested_agent_id).toBeNull()
  })

  it('limpeza única na aplicação: reservas já órfãs (desativado, outro papel, sem apelido) são soltas; a válida fica', async () => {
    const d = await makeDb()
    try {
      await d.exec(`UPDATE wacrm.profiles SET mention_alias = 'ana' WHERE user_id = '${AG1}'`) // válido
      await d.exec(`UPDATE wacrm.profiles SET mention_alias = 'bia' WHERE user_id = '${AG2}'`) // vai ficar sem apelido
      await d.exec(`UPDATE wacrm.profiles SET mention_alias = 'sup' WHERE user_id = '${SUP}'`) // não é operador
      await d.exec(`UPDATE wacrm.profiles SET mention_alias = 'deac' WHERE user_id = '${AGDEAC}'`) // desativado
      const ok = await reserve(d, AG1)
      const semAlias = await reserve(d, AG2)
      await d.exec(`UPDATE wacrm.profiles SET mention_alias = NULL WHERE user_id = '${AG2}'`)
      const naoOperador = await reserve(d, SUP)
      const desativado = await reserve(d, AGDEAC)
      await d.exec(migration('382_seguranca_carteira_mfa_reserva.sql'))
      expect((await state(d, ok)).requested_agent_id).toBe(AG1)
      for (const id of [semAlias, naoOperador, desativado]) expect((await state(d, id)).requested_agent_id).toBeNull()
    } finally {
      await d.close()
    }
  }, 60_000)
})

describe('migration 382 — M6: a RPC da 376 encerra também o fluxo "delayed"', { timeout: 120_000 }, () => {
  let pre: PGlite
  let db: PGlite
  beforeAll(async () => {
    pre = await makeDb()
    db = await makeDb({ with382: true })
    for (const d of [pre, db]) await d.exec(`UPDATE wacrm.profiles SET mention_alias = 'ana' WHERE user_id = '${AG1}'`)
  }, 90_000)
  afterAll(async () => {
    await pre.close()
    await db.close()
  }, 60_000)

  const run = async (d: PGlite) => {
    const conv = (await d.query<{ id: string }>(`INSERT INTO wacrm.conversations (account_id, status, team_id) VALUES ($1, 'pending', $2) RETURNING id`, [A, T1])).rows[0].id
    const ids: Record<string, string> = {}
    for (const st of ['active', 'delayed', 'completed']) {
      ids[st] = (await d.query<{ id: string }>(`INSERT INTO wacrm.flow_runs (account_id, conversation_id, status) VALUES ($1, $2, $3) RETURNING id`, [A, conv, st])).rows[0].id
    }
    const other = (await d.query<{ id: string }>(`INSERT INTO wacrm.flow_runs (account_id, conversation_id, status) VALUES ($1, gen_random_uuid(), 'delayed') RETURNING id`, [A])).rows[0].id
    await asServer(d)
    const r = await d.query<{ v: string | null }>(`SELECT wacrm.route_conversation_to_mentioned_agent($1, $2, 'ana') AS v`, [A, conv])
    await asOwner(d)
    const st = async (id: string) => (await d.query<{ status: string; end_reason: string | null }>(`SELECT status, end_reason FROM wacrm.flow_runs WHERE id = $1`, [id])).rows[0]
    return { routed: r.rows[0].v, active: await st(ids.active), delayed: await st(ids.delayed), completed: await st(ids.completed), other: await st(other) }
  }

  it('ANTES: o fluxo delayed continua vivo e acordaria depois', async () => {
    const r = await run(pre)
    expect(r.routed).toBe(AG1)
    expect(r.active.status).toBe('handed_off')
    expect(r.delayed.status).toBe('delayed')
  })

  it('DEPOIS: active e delayed viram handed_off (agent_mention); concluído e fluxo de outra conversa ficam', async () => {
    const r = await run(db)
    expect(r.routed).toBe(AG1)
    expect(r.active).toEqual({ status: 'handed_off', end_reason: 'agent_mention' })
    expect(r.delayed).toEqual({ status: 'handed_off', end_reason: 'agent_mention' })
    expect(r.completed.status).toBe('completed')
    expect(r.other.status).toBe('delayed')
  })

  it('mesma assinatura e mesmos grants da 376: só service_role executa', async () => {
    for (const role of ['anon', 'authenticated']) {
      const g = (await db.query<{ g: boolean }>(`SELECT has_function_privilege('${role}', 'wacrm.route_conversation_to_mentioned_agent(uuid,uuid,text)', 'EXECUTE') AS g`)).rows[0].g
      expect(g, role).toBe(false)
    }
    expect((await db.query<{ g: boolean }>(`SELECT has_function_privilege('service_role', 'wacrm.route_conversation_to_mentioned_agent(uuid,uuid,text)', 'EXECUTE') AS g`)).rows[0].g).toBe(true)
  })
})

describe('migration 382 — pré-check, idempotência, lock_timeout e rollback', { timeout: 180_000 }, () => {
  it('pré-check: sem wacrm.mfa_ok() (310) aborta sem criar nada', async () => {
    const d = await makeDb({ noMfa: true })
    try {
      await expect(d.exec(migration('382_seguranca_carteira_mfa_reserva.sql'))).rejects.toThrow(/382: falta wacrm\.mfa_ok\(\) \(migration 310\)/)
      await d.exec('ROLLBACK') // o SQL Editor desfaz a transação ao dar erro; no PGlite a sessão fica abortada até o ROLLBACK
      const t = await d.query(`SELECT tgname FROM pg_trigger WHERE tgname IN ('trg_guard_contact_owner_write', 'trg_release_mention_reservations_upd') AND NOT tgisinternal`)
      expect(t.rows).toHaveLength(0)
    } finally {
      await d.close()
    }
  }, 60_000)

  it('pré-check: sem a coluna da carteira (372) aborta', async () => {
    const d = await makeDb()
    try {
      await d.exec(`ALTER TABLE wacrm.contacts DROP COLUMN owner_user_id`)
      await expect(d.exec(migration('382_seguranca_carteira_mfa_reserva.sql'))).rejects.toThrow(/382: faltam colunas/)
    } finally {
      await d.close()
    }
  }, 60_000)

  it('idempotente (roda duas vezes), registra a versão uma vez e tem lock_timeout na migration e no rollback', async () => {
    const d = await makeDb({ with382: true })
    try {
      await d.exec(migration('382_seguranca_carteira_mfa_reserva.sql'))
      expect((await d.query(`SELECT 1 FROM wacrm.schema_migrations WHERE version = '382_seguranca_carteira_mfa_reserva'`)).rows).toHaveLength(1)
      const triggers = await d.query<{ tgname: string }>(`SELECT tgname FROM pg_trigger WHERE tgname LIKE 'trg_guard_contact_owner_write' OR tgname LIKE 'trg_release_mention_reservations_%' ORDER BY 1`)
      expect(triggers.rows.map((r) => r.tgname)).toEqual(['trg_guard_contact_owner_write', 'trg_release_mention_reservations_del', 'trg_release_mention_reservations_upd'])
    } finally {
      await d.close()
    }
    expect(migration('382_seguranca_carteira_mfa_reserva.sql')).toMatch(/BEGIN;\s*SET LOCAL lock_timeout = '5s';/)
    expect(ROLLBACK_382).toMatch(/SET LOCAL lock_timeout = '5s';/)
  }, 60_000)

  it('rollback (o bloco do cabeçalho): remove triggers e funções novas, volta as duas funções ao corpo anterior e desregistra; reaplicar funciona', async () => {
    const d = await makeDb({ with382: true })
    try {
      await d.exec(`UPDATE wacrm.profiles SET mention_alias = 'ana' WHERE user_id = '${AG1}'`)
      await d.exec(ROLLBACK_382)

      const gone = await d.query(`SELECT 1 FROM pg_trigger WHERE tgname IN ('trg_guard_contact_owner_write', 'trg_release_mention_reservations_upd', 'trg_release_mention_reservations_del') AND NOT tgisinternal`)
      expect(gone.rows).toHaveLength(0)
      const fns = await d.query(`SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'wacrm' AND p.proname IN ('guard_contact_owner_write', 'release_mention_reservations')`)
      expect(fns.rows).toHaveLength(0)
      expect((await d.query(`SELECT 1 FROM wacrm.schema_migrations WHERE version = '382_seguranca_carteira_mfa_reserva'`)).rows).toHaveLength(0)

      // comportamento anterior de volta
      await d.exec(`INSERT INTO auth.mfa_factors (user_id, status, factor_type) VALUES ('${ADMIN}', 'verified', 'totp')`)
      await asUser(d, ADMIN, PERMS_ADMIN, 'aal1')
      expect((await d.query<{ v: unknown }>(`SELECT wacrm.dashboard_ai_snapshot_read() AS v`)).rows[0].v).not.toBeNull()
      await asUser(d, AG1, PERMS_AGENT)
      await d.query(`UPDATE wacrm.contacts SET owner_user_id = $1 WHERE false`, [AG1]) // sem linhas: só confirma que não há trigger barrando
      await asOwner(d)
      const conv = (await d.query<{ id: string }>(`INSERT INTO wacrm.conversations (account_id, status, team_id) VALUES ($1, 'pending', $2) RETURNING id`, [A, T1])).rows[0].id
      await d.exec(`INSERT INTO wacrm.flow_runs (account_id, conversation_id, status) VALUES ('${A}', '${conv}', 'delayed')`)
      await asServer(d)
      expect((await d.query<{ v: string }>(`SELECT wacrm.route_conversation_to_mentioned_agent($1, $2, 'ana') AS v`, [A, conv])).rows[0].v).toBe(AG1)
      await asOwner(d)
      expect((await d.query<{ status: string }>(`SELECT status FROM wacrm.flow_runs WHERE conversation_id = $1`, [conv])).rows[0].status).toBe('delayed')
      // e a desativação deixa de liberar a reserva
      await d.exec(`UPDATE wacrm.profiles SET deactivated_at = now() WHERE user_id = '${AG1}'`)
      expect((await d.query<{ r: string | null }>(`SELECT requested_agent_id AS r FROM wacrm.conversations WHERE id = $1`, [conv])).rows[0].r).toBe(AG1)

      // reaplicar depois do rollback
      await d.exec(`UPDATE wacrm.profiles SET deactivated_at = NULL WHERE user_id = '${AG1}'`)
      await d.exec(migration('382_seguranca_carteira_mfa_reserva.sql'))
      expect((await d.query(`SELECT 1 FROM wacrm.schema_migrations WHERE version = '382_seguranca_carteira_mfa_reserva'`)).rows).toHaveLength(1)
    } finally {
      await d.close()
    }
  }, 90_000)
})
