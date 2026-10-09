import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migration = readFileSync("supabase/migrations/301_quick_replies_visibility_usage.sql", "utf8").replace(/NOTIFY pgrst[^;]*;/g, "");
const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
const ADMIN = "00000000-0000-0000-0000-000000000001";
const AG1 = "00000000-0000-0000-0000-000000000002"; // agente da equipe T1
const AG2 = "00000000-0000-0000-0000-000000000003"; // agente sem equipe
const T1 = "00000000-0000-0000-0000-0000000000a1";
const T_B = "00000000-0000-0000-0000-0000000000b1"; // equipe de OUTRA conta
let db: PGlite;

async function as<T = Record<string, unknown>>(user: string, sql: string) {
  await db.exec(`SET ROLE authenticated; SELECT set_config('test.uid', '${user}', false);`);
  try {
    return (await db.query<T>(sql)).rows;
  } finally {
    await db.exec("RESET ROLE");
  }
}
const shortcuts = async (user: string) =>
  (await as<{ shortcut: string }>(user, "SELECT shortcut FROM wacrm.quick_replies ORDER BY shortcut")).map((r) => r.shortcut);

describe("301 — visibilidade e usos das respostas rápidas", () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth; CREATE SCHEMA wacrm;
      GRANT USAGE ON SCHEMA auth, wacrm TO authenticated, service_role;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
      GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;
      CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY);
      CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
      CREATE TABLE wacrm.profiles (user_id uuid PRIMARY KEY, account_id uuid, rank int);  -- rank: 1 agent, 3 admin
      CREATE TABLE wacrm.teams (id uuid PRIMARY KEY, account_id uuid NOT NULL);
      CREATE TABLE wacrm.team_members (team_id uuid, user_id uuid);
      GRANT SELECT ON wacrm.profiles, wacrm.teams, wacrm.team_members TO authenticated;
      CREATE FUNCTION wacrm.current_account_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
        AS $$ SELECT account_id FROM wacrm.profiles WHERE user_id = auth.uid() LIMIT 1 $$;
      CREATE FUNCTION wacrm.is_account_member(p_account uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
        AS $$ SELECT EXISTS (SELECT 1 FROM wacrm.profiles WHERE user_id = auth.uid() AND account_id = p_account) $$;
      CREATE FUNCTION wacrm.is_account_member(p_account uuid, p_min text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
        AS $$ SELECT EXISTS (SELECT 1 FROM wacrm.profiles WHERE user_id = auth.uid() AND account_id = p_account
                              AND rank >= CASE p_min WHEN 'admin' THEN 3 ELSE 1 END) $$;
      CREATE TABLE wacrm.quick_replies (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
        shortcut text NOT NULL, title text NOT NULL, content text NOT NULL, created_by uuid,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (account_id, shortcut));
      ALTER TABLE wacrm.quick_replies ENABLE ROW LEVEL SECURITY;
      GRANT SELECT, INSERT, UPDATE, DELETE ON wacrm.quick_replies TO authenticated;
      INSERT INTO wacrm.accounts VALUES ('${A}'), ('${B}');
      INSERT INTO wacrm.profiles VALUES ('${ADMIN}', '${A}', 3), ('${AG1}', '${A}', 1), ('${AG2}', '${A}', 1);
      INSERT INTO wacrm.teams VALUES ('${T1}', '${A}'), ('${T_B}', '${B}');
      INSERT INTO wacrm.team_members VALUES ('${T1}', '${AG1}');
      INSERT INTO wacrm.quick_replies (account_id, shortcut, title, content) VALUES ('${A}', 'antiga', 't', 'c');`);
    await db.exec(migration);
    await db.exec(migration); // idempotente
    await db.exec(`INSERT INTO wacrm.quick_replies (account_id, shortcut, title, content, created_by, visibility, team_id) VALUES
      ('${A}', 'conta', 't', 'c', '${ADMIN}', 'account', NULL),
      ('${A}', 'equipe', 't', 'c', '${ADMIN}', 'team', '${T1}'),
      ('${A}', 'pessoal1', 't', 'c', '${AG1}', 'personal', NULL),
      ('${A}', 'pessoal2', 't', 'c', '${AG2}', 'personal', NULL);`);
  }, 60000);
  afterAll(async () => { await db?.close(); });

  it("as respostas que já existiam viram 'account'", async () => {
    const r = await db.query<{ visibility: string }>("SELECT visibility FROM wacrm.quick_replies WHERE shortcut = 'antiga'");
    expect(r.rows[0].visibility).toBe("account");
  });

  it("leitura: pessoal só do dono; equipe só dos membros (e admin)", async () => {
    expect(await shortcuts(AG1)).toEqual(["antiga", "conta", "equipe", "pessoal1"]);
    expect(await shortcuts(AG2)).toEqual(["antiga", "conta", "pessoal2"]);
    expect(await shortcuts(ADMIN)).toEqual(["antiga", "conta", "equipe"]);
  });

  it("agente cria pessoal, mas não promove para conta/equipe nem cria conta", async () => {
    await as(AG2, `INSERT INTO wacrm.quick_replies (account_id, shortcut, title, content, created_by, visibility) VALUES ('${A}', 'meu', 't', 'c', '${AG2}', 'personal')`);
    await expect(as(AG2, `INSERT INTO wacrm.quick_replies (account_id, shortcut, title, content, created_by, visibility) VALUES ('${A}', 'x1', 't', 'c', '${AG2}', 'account')`)).rejects.toThrow(/row-level security/);
    await expect(as(AG2, `UPDATE wacrm.quick_replies SET visibility = 'account' WHERE shortcut = 'meu'`)).rejects.toThrow(/row-level security/);
    await expect(as(AG2, `INSERT INTO wacrm.quick_replies (account_id, shortcut, title, content, created_by, visibility) VALUES ('${A}', 'x2', 't', 'c', '${AG1}', 'personal')`)).rejects.toThrow(/row-level security/);
  });

  it("agente não altera nem apaga a resposta pessoal de outro, nem a da conta", async () => {
    expect(await as(AG2, "UPDATE wacrm.quick_replies SET title = 'z' WHERE shortcut IN ('pessoal1', 'conta') RETURNING id")).toHaveLength(0);
    expect(await as(AG2, "DELETE FROM wacrm.quick_replies WHERE shortcut IN ('pessoal1', 'conta') RETURNING id")).toHaveLength(0);
  });

  it("admin cria equipe só com equipe da própria conta; atalho pessoal repetido entre donos é permitido", async () => {
    await as(ADMIN, `INSERT INTO wacrm.quick_replies (account_id, shortcut, title, content, created_by, visibility, team_id) VALUES ('${A}', 'eq2', 't', 'c', '${ADMIN}', 'team', '${T1}')`);
    await expect(as(ADMIN, `INSERT INTO wacrm.quick_replies (account_id, shortcut, title, content, created_by, visibility, team_id) VALUES ('${A}', 'eq3', 't', 'c', '${ADMIN}', 'team', '${T_B}')`)).rejects.toThrow(/row-level security/);
    await as(AG1, `INSERT INTO wacrm.quick_replies (account_id, shortcut, title, content, created_by, visibility) VALUES ('${A}', 'oi', 't', 'c', '${AG1}', 'personal')`);
    await as(AG2, `INSERT INTO wacrm.quick_replies (account_id, shortcut, title, content, created_by, visibility) VALUES ('${A}', 'oi', 't', 'c', '${AG2}', 'personal')`);
    await expect(as(AG2, `INSERT INTO wacrm.quick_replies (account_id, shortcut, title, content, created_by, visibility) VALUES ('${A}', 'oi', 't', 'c', '${AG2}', 'personal')`)).rejects.toThrow(/duplicate key|idx_quick_replies_scope_shortcut/);
  });

  it("check: team exige team_id e vice-versa", async () => {
    await expect(db.exec(`INSERT INTO wacrm.quick_replies (account_id, shortcut, title, content, visibility) VALUES ('${A}', 'ruim', 't', 'c', 'team')`)).rejects.toThrow(/quick_replies_team_scope_chk/);
    await expect(db.exec(`INSERT INTO wacrm.quick_replies (account_id, shortcut, title, content, visibility, team_id) VALUES ('${A}', 'ruim', 't', 'c', 'account', '${T1}')`)).rejects.toThrow(/quick_replies_team_scope_chk/);
  });

  it("usos: soma 30 dias, ignora mais antigos, respeita a visibilidade e rejeita resposta de outra conta", async () => {
    const id = (await db.query<{ id: string }>("SELECT id FROM wacrm.quick_replies WHERE shortcut = 'conta'")).rows[0].id;
    const priv = (await db.query<{ id: string }>("SELECT id FROM wacrm.quick_replies WHERE shortcut = 'pessoal1'")).rows[0].id;
    await db.exec(`SELECT wacrm.bump_quick_reply_use('${id}', '${A}', '${AG1}'); SELECT wacrm.bump_quick_reply_use('${id}', '${A}', '${AG1}');
      SELECT wacrm.bump_quick_reply_use('${id}', '${A}', '${AG2}'); SELECT wacrm.bump_quick_reply_use('${priv}', '${A}', '${AG1}');
      SELECT wacrm.bump_quick_reply_use('${id}', '${B}', '${AG1}');
      INSERT INTO wacrm.quick_reply_usage_daily VALUES ('${id}', '${AG1}', current_date - 40, '${A}', 99);
      INSERT INTO wacrm.quick_reply_usage_daily VALUES ('${id}', '${ADMIN}', current_date - 31, '${A}', 50);`);
    // a poda (35 dias) roda no próximo registro
    await db.exec(`SELECT wacrm.bump_quick_reply_use('${id}', '${A}', '${AG1}')`);
    const total = (await db.query<{ n: number }>(`SELECT sum(uses)::int AS n FROM wacrm.quick_reply_usage_daily WHERE quick_reply_id = '${id}'`)).rows[0].n;
    expect(total).toBe(3 + 1 + 50); // 3 de hoje por AG1 (2+1) e 1 por AG2, +50 de 31 dias atrás; o de 40 dias foi podado
    const ag1 = Object.fromEntries((await as<{ quick_reply_id: string; uses: string }>(AG1, "SELECT * FROM wacrm.quick_reply_usage_30d()")).map((r) => [r.quick_reply_id, Number(r.uses)]));
    expect(ag1[id]).toBe(4);
    expect(ag1[priv]).toBe(1);
    const ag2 = Object.fromEntries((await as<{ quick_reply_id: string; uses: string }>(AG2, "SELECT * FROM wacrm.quick_reply_usage_30d()")).map((r) => [r.quick_reply_id, Number(r.uses)]));
    expect(priv in ag2).toBe(false);
    await expect(as(AG1, `SELECT wacrm.bump_quick_reply_use('${id}', '${A}', '${AG1}')`)).rejects.toThrow(/permission denied/);
  });

  it("registra a migration", async () => {
    const r = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM wacrm.schema_migrations WHERE version = '301_quick_replies_visibility_usage'");
    expect(r.rows[0].n).toBe(1);
  });
});
