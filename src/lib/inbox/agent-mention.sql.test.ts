// Migration 376 (@operador): apelido, reserva da conversa, policies e RPC de roteamento.
// PGlite com a migration REAL sobre um schema mínimo. A policy de leitura/escrita de conversations é a da V2 (324/347), reduzida:
// has_perm() lê as permissões do teste (test.perms), para provar a convivência das policies restritivas da 376 com papel
// personalizado (account_role 'agent' sem inbox.view).
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const migration = (file: string) =>
  readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8').replace(/NOTIFY pgrst[^;]*;/g, '')

const A = '00000000-0000-0000-0000-00000000000a'
const B = '00000000-0000-0000-0000-00000000000b'
const u = (n: number) => `00000000-0000-0000-0000-0000000002${String(n).padStart(2, '0')}`
const T1 = '00000000-0000-0000-0000-0000000003aa'
const T2 = '00000000-0000-0000-0000-0000000003bb'

const ADMIN = u(1)
const AG_TARGET = u(2) // operador da equipe T1, alvo da menção
const AG_PEER = u(3) // operador da equipe T1 (colega)
const AG_NOTEAM = u(4) // operador sem equipe
const AG_CUSTOM = u(5) // papel base 'agent' com papel personalizado SEM inbox.view
const AG_B = u(6) // operador da conta B
const SUP = u(7) // supervisor da equipe T1

const BOOTSTRAP = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA wacrm; CREATE SCHEMA auth;
  GRANT USAGE ON SCHEMA wacrm, auth TO anon, authenticated, service_role;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
  CREATE TABLE auth.users (id uuid PRIMARY KEY);
  CREATE TYPE wacrm.account_role_enum AS ENUM ('owner', 'admin', 'supervisor', 'agent', 'viewer');
  CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
  CREATE TABLE wacrm.profiles (
    user_id uuid PRIMARY KEY, account_id uuid REFERENCES wacrm.accounts(id),
    account_role wacrm.account_role_enum NOT NULL, deactivated_at timestamptz
  );
  CREATE TABLE wacrm.teams (id uuid PRIMARY KEY, account_id uuid REFERENCES wacrm.accounts(id));
  CREATE TABLE wacrm.team_members (team_id uuid REFERENCES wacrm.teams(id), user_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, user_id));
  CREATE TABLE wacrm.conversations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES wacrm.accounts(id),
    status text NOT NULL DEFAULT 'open', assigned_agent_id uuid, team_id uuid REFERENCES wacrm.teams(id),
    last_message_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), note text
  );
  CREATE TABLE wacrm.flow_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid, conversation_id uuid,
    status text NOT NULL DEFAULT 'active', end_reason text, ended_at timestamptz
  );
  CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
  CREATE FUNCTION wacrm.current_user_role() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = wacrm, public
    AS $$ SELECT p.account_role::text FROM wacrm.profiles p WHERE p.user_id = auth.uid() LIMIT 1 $$;
  CREATE FUNCTION wacrm.current_user_team_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = wacrm, public
    AS $$ SELECT tm.team_id FROM wacrm.team_members tm WHERE tm.user_id = auth.uid() $$;
  CREATE FUNCTION wacrm.is_account_member(p_account uuid, p_role wacrm.account_role_enum DEFAULT 'viewer') RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = wacrm, public
    AS $$ SELECT EXISTS (SELECT 1 FROM wacrm.profiles p WHERE p.user_id = auth.uid() AND p.account_id = p_account AND p.account_role <= p_role) $$;
  CREATE FUNCTION wacrm.has_perm(p text) RETURNS boolean LANGUAGE sql STABLE
    AS $$ SELECT p = ANY (string_to_array(coalesce(current_setting('test.perms', true), ''), ',')) $$;

  -- conversations_select (324) e update (347), nas mesmas condições, só com permissões simuladas
  ALTER TABLE wacrm.conversations ENABLE ROW LEVEL SECURITY;
  CREATE POLICY conversations_select ON wacrm.conversations FOR SELECT USING (
    wacrm.is_account_member(account_id) AND (
      (SELECT wacrm.has_perm('conversations.scope_all'))
      OR ((SELECT wacrm.has_perm('conversations.scope_team')) AND (team_id IN (SELECT wacrm.current_user_team_ids()) OR assigned_agent_id = (SELECT auth.uid())))
      OR ((SELECT wacrm.has_perm('inbox.view')) AND (assigned_agent_id = (SELECT auth.uid())
          OR (assigned_agent_id IS NULL AND status IN ('open','pending') AND team_id IN (SELECT wacrm.current_user_team_ids()))))
    ));
  CREATE POLICY conversations_update ON wacrm.conversations FOR UPDATE USING (
    wacrm.is_account_member(account_id) AND ((SELECT wacrm.has_perm('inbox.reply')) OR (SELECT wacrm.has_perm('inbox.transfer')))
  ) WITH CHECK (wacrm.is_account_member(account_id));
  GRANT SELECT, UPDATE ON wacrm.conversations TO authenticated;
  GRANT SELECT, UPDATE ON wacrm.profiles TO authenticated;
  GRANT SELECT, INSERT, UPDATE ON wacrm.conversations, wacrm.flow_runs TO service_role;
  GRANT SELECT, UPDATE ON wacrm.profiles TO service_role;

  INSERT INTO wacrm.accounts (id, name) VALUES ('${A}', 'A'), ('${B}', 'B');
  INSERT INTO auth.users (id) VALUES ('${ADMIN}'), ('${AG_TARGET}'), ('${AG_PEER}'), ('${AG_NOTEAM}'), ('${AG_CUSTOM}'), ('${AG_B}'), ('${SUP}');
  INSERT INTO wacrm.profiles (user_id, account_id, account_role) VALUES
    ('${ADMIN}', '${A}', 'admin'), ('${AG_TARGET}', '${A}', 'agent'), ('${AG_PEER}', '${A}', 'agent'),
    ('${AG_NOTEAM}', '${A}', 'agent'), ('${AG_CUSTOM}', '${A}', 'agent'), ('${AG_B}', '${B}', 'agent'), ('${SUP}', '${A}', 'supervisor');
  INSERT INTO wacrm.teams (id, account_id) VALUES ('${T1}', '${A}'), ('${T2}', '${A}');
  INSERT INTO wacrm.team_members (team_id, user_id) VALUES ('${T1}', '${AG_TARGET}'), ('${T1}', '${AG_PEER}'), ('${T1}', '${SUP}'), ('${T1}', '${AG_CUSTOM}');
`

const PERMS = {
  admin: 'conversations.scope_all,inbox.view,inbox.reply,inbox.transfer',
  supervisor: 'conversations.scope_team,inbox.view,inbox.reply,inbox.transfer',
  agent: 'inbox.view,inbox.reply',
  customNoInboxView: 'inbox.reply', // papel personalizado sem inbox.view
} as const

describe('migration 376 — @operador: fila direta, policies e RPC', { timeout: 120_000 }, () => {
  let db: PGlite

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(BOOTSTRAP)
    await db.exec(migration('376_agent_mention_queue.sql'))
  }, 60_000)
  afterAll(async () => {
    await db.close()
  }, 60_000)
  beforeEach(async () => {
    await db.exec(`RESET ROLE; DELETE FROM wacrm.flow_runs; DELETE FROM wacrm.conversations; UPDATE wacrm.profiles SET deactivated_at = NULL;`)
    await db.exec(`UPDATE wacrm.profiles SET mention_alias = NULL`)
  })

  const conv = async (fields: { team?: string | null; status?: string; assigned?: string | null; account?: string } = {}) => {
    await db.exec(`RESET ROLE`)
    const r = await db.query<{ id: string }>(
      `INSERT INTO wacrm.conversations (account_id, team_id, status, assigned_agent_id) VALUES ($1, $2, $3, $4) RETURNING id`,
      [fields.account ?? A, fields.team === undefined ? T1 : fields.team, fields.status ?? 'pending', fields.assigned ?? null],
    )
    return r.rows[0].id
  }
  const reserve = async (id: string, agent: string) => {
    await db.exec(`RESET ROLE`)
    return db.query(`UPDATE wacrm.conversations SET requested_agent_id = $2 WHERE id = $1`, [id, agent]) // superusuário do teste = servidor
  }
  const as = async (user: string, perms: string) => {
    await db.exec(`RESET ROLE; SELECT set_config('test.uid', '${user}', false), set_config('test.perms', '${perms}', false); SET ROLE authenticated;`)
  }
  const visible = async (id: string) => (await db.query(`SELECT id FROM wacrm.conversations WHERE id = $1`, [id])).rows.length === 1
  const serverRpc = async (account: string, id: string, alias: string) => {
    await db.exec(`RESET ROLE; SET ROLE service_role`)
    const r = await db.query<{ v: string | null }>(`SELECT wacrm.route_conversation_to_mentioned_agent($1, $2, $3) AS v`, [account, id, alias])
    await db.exec(`RESET ROLE`)
    return r.rows[0].v
  }

  describe('policies de leitura', () => {
    it('só o alvo (e quem tem escopo de equipe/conta) vê a conversa reservada; o colega de equipe não', async () => {
      const id = await conv()
      await reserve(id, AG_TARGET)

      await as(AG_TARGET, PERMS.agent)
      expect(await visible(id)).toBe(true)
      await as(AG_PEER, PERMS.agent)
      expect(await visible(id)).toBe(false)
      await as(SUP, PERMS.supervisor)
      expect(await visible(id)).toBe(true)
      await as(ADMIN, PERMS.admin)
      expect(await visible(id)).toBe(true)
    })

    it('sem reserva, o colega de equipe continua vendo a fila (a 376 não muda o que já existia)', async () => {
      const id = await conv()
      await as(AG_PEER, PERMS.agent)
      expect(await visible(id)).toBe(true)
    })

    it('alvo SEM equipe também vê a própria fila (a permissiva dispensa o team_id)', async () => {
      const id = await conv({ team: null })
      await reserve(id, AG_NOTEAM)
      await as(AG_NOTEAM, PERMS.agent)
      expect(await visible(id)).toBe(true)
      await as(AG_PEER, PERMS.agent)
      expect(await visible(id)).toBe(false)
    })

    it('papel personalizado base agent SEM inbox.view: não vê a fila da equipe; só vê a reserva quando é o alvo', async () => {
      const outras = await conv()
      await as(AG_CUSTOM, PERMS.customNoInboxView)
      expect(await visible(outras)).toBe(false) // sem inbox.view a 324/347 já não deixa

      const reservada = await conv()
      await reserve(reservada, AG_CUSTOM)
      await as(AG_CUSTOM, PERMS.customNoInboxView)
      expect(await visible(reservada)).toBe(true) // comportamento documentado: a permissiva libera o alvo
      const outraReservada = await conv()
      await reserve(outraReservada, AG_TARGET)
      await as(AG_CUSTOM, PERMS.customNoInboxView)
      expect(await visible(outraReservada)).toBe(false)
    })

    it('operador de outra conta nunca vê a reserva', async () => {
      const id = await conv()
      await reserve(id, AG_TARGET)
      await as(AG_B, PERMS.agent)
      expect(await visible(id)).toBe(false)
    })
  })

  describe('policy de escrita', () => {
    it('colega de equipe não altera a conversa reservada a outro; o alvo altera', async () => {
      const id = await conv()
      await reserve(id, AG_TARGET)

      await as(AG_PEER, PERMS.agent)
      const peer = await db.query(`UPDATE wacrm.conversations SET note = 'x' WHERE id = $1 RETURNING id`, [id])
      expect(peer.rows).toHaveLength(0)

      await as(AG_TARGET, PERMS.agent)
      const alvo = await db.query(`UPDATE wacrm.conversations SET note = 'y' WHERE id = $1 RETURNING id`, [id])
      expect(alvo.rows).toHaveLength(1)
    })

    it('o navegador não cria nem apaga a reserva (42501)', async () => {
      const livre = await conv()
      await as(AG_TARGET, PERMS.agent)
      await expect(db.query(`UPDATE wacrm.conversations SET requested_agent_id = $2 WHERE id = $1`, [livre, AG_TARGET])).rejects.toThrow(/server-managed/)

      await db.exec(`RESET ROLE`)
      const reservada = await conv()
      await reserve(reservada, AG_TARGET)
      await as(AG_TARGET, PERMS.agent)
      await expect(db.query(`UPDATE wacrm.conversations SET requested_agent_id = NULL WHERE id = $1`, [reservada])).rejects.toThrow(/server-managed/)
    })
  })

  describe('apelido (profiles.mention_alias)', () => {
    it('formato e unicidade por conta; a mesma palavra em outra conta é livre', async () => {
      await db.query(`UPDATE wacrm.profiles SET mention_alias = 'adriana' WHERE user_id = $1`, [AG_TARGET])
      await expect(db.query(`UPDATE wacrm.profiles SET mention_alias = 'adriana' WHERE user_id = $1`, [AG_PEER])).rejects.toThrow(/unique/i)
      await expect(db.query(`UPDATE wacrm.profiles SET mention_alias = 'Adriana' WHERE user_id = $1`, [AG_PEER])).rejects.toThrow(/check/i)
      await expect(db.query(`UPDATE wacrm.profiles SET mention_alias = 'a' WHERE user_id = $1`, [AG_PEER])).rejects.toThrow(/check/i)
      await db.query(`UPDATE wacrm.profiles SET mention_alias = 'adriana' WHERE user_id = $1`, [AG_B])
    })

    it('o navegador não grava o apelido (só o servidor)', async () => {
      await as(AG_TARGET, PERMS.agent)
      await expect(db.query(`UPDATE wacrm.profiles SET mention_alias = 'eu' WHERE user_id = $1`, [AG_TARGET])).rejects.toThrow(/administrator-managed/)
    })
  })

  describe('RPC route_conversation_to_mentioned_agent', () => {
    beforeEach(async () => {
      await db.query(`UPDATE wacrm.profiles SET mention_alias = 'adriana' WHERE user_id = $1`, [AG_TARGET])
    })

    it('reserva ao alvo, devolve a equipe dele e encerra o fluxo ativo', async () => {
      const id = await conv({ team: T2, status: 'open' })
      await db.query(`INSERT INTO wacrm.flow_runs (account_id, conversation_id) VALUES ($1, $2)`, [A, id])
      expect(await serverRpc(A, id, 'adriana')).toBe(AG_TARGET)

      const c = (await db.query<{ status: string; assigned_agent_id: string | null; requested_agent_id: string; team_id: string }>(
        `SELECT status, assigned_agent_id, requested_agent_id, team_id FROM wacrm.conversations WHERE id = $1`, [id])).rows[0]
      expect(c).toMatchObject({ status: 'pending', assigned_agent_id: null, requested_agent_id: AG_TARGET, team_id: T1 })
      const run = (await db.query<{ status: string; end_reason: string }>(`SELECT status, end_reason FROM wacrm.flow_runs WHERE conversation_id = $1`, [id])).rows[0]
      expect(run).toMatchObject({ status: 'handed_off', end_reason: 'agent_mention' })
    })

    it('operador EM PAUSA continua sendo reservado (decisão do dono: espera por ele)', async () => {
      // a RPC não consulta pausa: nenhuma tabela de pausa existe neste schema e ela funciona do mesmo jeito
      const id = await conv()
      expect(await serverRpc(A, id, 'adriana')).toBe(AG_TARGET)
    })

    it('não roteia: alias de outra conta, inexistente, malformado, desativado, conversa fechada ou já atribuída', async () => {
      const id = await conv()
      expect(await serverRpc(B, id, 'adriana')).toBeNull() // conta errada
      expect(await serverRpc(A, id, 'ninguem')).toBeNull()
      expect(await serverRpc(A, id, '@adriana')).toBeNull()
      expect(await serverRpc(A, id, "x'; --")).toBeNull()

      await db.query(`UPDATE wacrm.profiles SET deactivated_at = now() WHERE user_id = $1`, [AG_TARGET])
      expect(await serverRpc(A, id, 'adriana')).toBeNull()
      await db.query(`UPDATE wacrm.profiles SET deactivated_at = NULL WHERE user_id = $1`, [AG_TARGET])

      const fechada = await conv({ status: 'closed' })
      expect(await serverRpc(A, fechada, 'adriana')).toBeNull()
      const atribuida = await conv({ status: 'open', assigned: AG_PEER })
      expect(await serverRpc(A, atribuida, 'adriana')).toBeNull()
    })

    it('só o alias de operador (role agent) vale: o de um admin não roteia', async () => {
      await db.query(`UPDATE wacrm.profiles SET mention_alias = 'chefe' WHERE user_id = $1`, [ADMIN])
      const id = await conv()
      expect(await serverRpc(A, id, 'chefe')).toBeNull()
    })

    it('anon e authenticated não executam a RPC', async () => {
      const id = await conv()
      for (const role of ['anon', 'authenticated']) {
        await db.exec(`RESET ROLE; SET ROLE ${role}`)
        await expect(db.query(`SELECT wacrm.route_conversation_to_mentioned_agent($1, $2, 'adriana')`, [A, id])).rejects.toThrow(/permission denied/)
      }
      await db.exec(`RESET ROLE`)
    })
  })

  describe('a reserva some quando alguém assume ou fecha', () => {
    it('atribuir um atendente ou fechar limpa requested_agent_id', async () => {
      const a = await conv()
      await reserve(a, AG_TARGET)
      await db.query(`UPDATE wacrm.conversations SET assigned_agent_id = $2 WHERE id = $1`, [a, AG_TARGET])
      expect((await db.query<{ r: string | null }>(`SELECT requested_agent_id AS r FROM wacrm.conversations WHERE id = $1`, [a])).rows[0].r).toBeNull()

      const b = await conv()
      await reserve(b, AG_TARGET)
      await db.query(`UPDATE wacrm.conversations SET status = 'closed' WHERE id = $1`, [b])
      expect((await db.query<{ r: string | null }>(`SELECT requested_agent_id AS r FROM wacrm.conversations WHERE id = $1`, [b])).rows[0].r).toBeNull()
    })
  })

  it('é idempotente: rodar a migration de novo não falha e registra a versão uma vez', async () => {
    await db.exec(migration('376_agent_mention_queue.sql'))
    const r = await db.query(`SELECT 1 FROM wacrm.schema_migrations WHERE version = '376_agent_mention_queue'`)
    expect(r.rows).toHaveLength(1)
  })
})
