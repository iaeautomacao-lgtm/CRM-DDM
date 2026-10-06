import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const account = '00000000-0000-0000-0000-000000000001';
const team = '00000000-0000-0000-0000-000000000002';
const agent = '00000000-0000-0000-0000-000000000003';
const tag = '00000000-0000-0000-0000-000000000004';
const none = '00000000-0000-0000-0000-000000000005';
const other = '00000000-0000-0000-0000-000000000006';
let db: PGlite;

async function report(
  teamId: string | null = null,
  agentId: string | null = null
) {
  return (
    await db.query<{
      codigo_tabulacao: number;
      total: number;
      human: number;
      ai_auto: number;
      automation: number;
      com_sugestao: number;
      aceitas: number;
      trocadas: number;
    }>(
      "SELECT * FROM wacrm.report_tabulacoes($1, '2026-10-01', '2026-10-31 23:59:59.999+00', $2, $3)",
      [account, teamId, agentId]
    )
  ).rows;
}

describe('RPC report_tabulacoes em PostgreSQL', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE authenticated; CREATE ROLE anon;
      CREATE ROLE service_role;
      CREATE SCHEMA wacrm; CREATE SCHEMA auth;
      GRANT USAGE ON SCHEMA wacrm TO authenticated;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '${agent}'::uuid $$;
      CREATE FUNCTION wacrm.current_user_role() RETURNS text LANGUAGE sql AS $$ SELECT current_setting('app.role') $$;
      CREATE FUNCTION wacrm.current_user_team_ids() RETURNS SETOF uuid LANGUAGE sql AS $$ SELECT '${team}'::uuid $$;
      CREATE FUNCTION wacrm.is_account_member(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT $1::text = current_setting('app.account') $$;
      CREATE TABLE wacrm.team_members(team_id uuid, user_id uuid);
      INSERT INTO wacrm.team_members VALUES ('${team}', '${agent}');
      CREATE TABLE wacrm.tags(id uuid, account_id uuid, kind text, codigo_tabulacao integer, name text);
      INSERT INTO wacrm.tags VALUES ('${tag}', '${account}', 'outcome', 142, 'Acordo'), ('${none}', '${account}', 'outcome', 16, 'SEM TABULACAO');
      CREATE TABLE wacrm.conversations(account_id uuid, team_id uuid, assigned_agent_id uuid, status text,
        created_at timestamptz, closed_at timestamptz, outcome_tag_id uuid, suggested_outcome_tag_id uuid, outcome_source text);
      INSERT INTO wacrm.conversations VALUES
        ('${account}', '${team}', '${agent}', 'closed', '2020-01-01', '2026-10-01', '${tag}', '${tag}', 'human'),
        ('${account}', '${team}', '${agent}', 'closed', '2020-01-01', '2026-10-02', '${none}', '${tag}', 'human'),
        ('${account}', '${other}', '${other}', 'closed', '2020-01-01', '2026-10-03', '${tag}', '${tag}', 'ai_auto'),
        ('${account}', NULL, '${agent}', 'closed', '2020-01-01', '2026-10-04', NULL, NULL, 'automation'),
        ('${account}', '${other}', '${agent}', 'closed', '2020-01-01', '2026-10-05', '${tag}', NULL, NULL),
        ('${account}', '${team}', '${agent}', 'open', '2020-01-01', '2026-10-06', '${tag}', NULL, NULL),
        ('${account}', '${team}', '${agent}', 'closed', '2020-01-01', '2026-11-01', '${tag}', NULL, NULL),
        ('${other}', '${team}', '${agent}', 'closed', '2020-01-01', '2026-10-07', '${tag}', NULL, NULL);
      SELECT set_config('app.account', '${account}', false), set_config('app.role', 'owner', false);
    `);
    // Usar o filtro real da 143, incluindo conversa sem equipe e atribuída ao supervisor.
    const scopeMigration = readFileSync(
      resolve('supabase/migrations/143_supervisor_report_scope.sql'),
      'utf8'
    );
    await db.exec(
      scopeMigration.slice(
        scopeMigration.indexOf(
          'CREATE OR REPLACE FUNCTION wacrm.report_sees_conversation'
        ),
        scopeMigration.indexOf(
          'CREATE OR REPLACE FUNCTION wacrm.report_sees_user'
        )
      )
    );
    const migration = readFileSync(
      resolve('supabase/migrations/161_report_tabulacoes.sql'),
      'utf8'
    );
    await db.exec(migration);
    await db.exec(migration);
  }, 30_000);

  afterAll(async () => {
    await db?.close();
  });

  it('conta por closed_at, agrega NULL + código 16 e distingue aceite/troca humana', async () => {
    const rows = await report();
    expect(rows).toMatchObject([
      {
        codigo_tabulacao: 142,
        total: 3,
        human: 1,
        ai_auto: 1,
        automation: 0,
        com_sugestao: 2,
        aceitas: 1,
        trocadas: 0,
      },
      {
        codigo_tabulacao: 16,
        total: 2,
        human: 1,
        ai_auto: 0,
        automation: 1,
        com_sugestao: 1,
        aceitas: 0,
        trocadas: 1,
      },
    ]);
  });
  it('filtra equipe/agente e mantém Sem tabulação mesmo zerada', async () => {
    expect(await report(other, other)).toMatchObject([
      { codigo_tabulacao: 142, total: 1 },
      { codigo_tabulacao: 16, total: 0 },
    ]);
  });
  it('supervisor não acessa outra equipe, mesmo forçando filtros', async () => {
    await db.exec("SELECT set_config('app.role', 'supervisor', false)");
    try {
      expect(
        (await report()).reduce((sum, row) => sum + Number(row.total), 0)
      ).toBe(4);
      expect(await report(other, other)).toMatchObject([
        { codigo_tabulacao: 16, total: 0 },
      ]);
    } finally {
      await db.exec("SELECT set_config('app.role', 'owner', false)");
    }
  });
  it('não retorna outra conta e restringe execução a authenticated', async () => {
    await db.exec(`SELECT set_config('app.account', '${other}', false)`);
    try {
      expect(await report()).toEqual([]);
    } finally {
      await db.exec(`SELECT set_config('app.account', '${account}', false)`);
    }
    const { rows } = await db.query<{ allowed: boolean; anonymous: boolean }>(`
      SELECT has_function_privilege('authenticated', 'wacrm.report_tabulacoes(uuid,timestamptz,timestamptz,uuid,uuid)', 'EXECUTE') AS allowed,
        has_function_privilege('anon', 'wacrm.report_tabulacoes(uuid,timestamptz,timestamptz,uuid,uuid)', 'EXECUTE') AS anonymous
    `);
    expect(rows[0]).toEqual({ allowed: true, anonymous: false });
  });
});
