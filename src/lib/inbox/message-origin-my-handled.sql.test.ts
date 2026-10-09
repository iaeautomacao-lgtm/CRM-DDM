import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migration = readFileSync("supabase/migrations/302_message_origin_my_handled.sql", "utf8").replace(/NOTIFY pgrst[^;]*;/g, "");
const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
const ME = "00000000-0000-0000-0000-000000000001";
const OTHER = "00000000-0000-0000-0000-000000000002";
const C = (n: number) => `00000000-0000-0000-0000-0000000000c${n}`;
let db: PGlite;

async function handled(user: string, args = "") {
  await db.exec(`SET ROLE authenticated; SELECT set_config('test.uid', '${user}', false);`);
  try {
    return (await db.query<{ conversation_id: string; to_agent_id: string | null; reason: string | null }>(
      `SELECT * FROM wacrm.inbox_my_handled(${args})`)).rows;
  } finally {
    await db.exec("RESET ROLE");
  }
}

describe("302 — origem da mensagem e Meus atendidos", () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
      CREATE SCHEMA auth; CREATE SCHEMA wacrm;
      GRANT USAGE ON SCHEMA auth, wacrm TO authenticated, anon, service_role;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
      GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;
      CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
      CREATE TABLE wacrm.profiles (user_id uuid PRIMARY KEY, account_id uuid);
      CREATE FUNCTION wacrm.current_account_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
        AS $$ SELECT account_id FROM wacrm.profiles WHERE user_id = auth.uid() LIMIT 1 $$;
      CREATE TABLE wacrm.conversations (id uuid PRIMARY KEY, account_id uuid NOT NULL, assigned_agent_id uuid);
      CREATE TABLE wacrm.messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid, sender_type text NOT NULL, sender_id uuid);
      CREATE TABLE wacrm.conversation_assignments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, conversation_id uuid NOT NULL,
        from_agent_id uuid, to_agent_id uuid, from_team_id uuid, to_team_id uuid, actor_id uuid, reason text,
        created_at timestamptz NOT NULL DEFAULT now());
      INSERT INTO wacrm.profiles VALUES ('${ME}', '${A}'), ('${OTHER}', '${A}');
      INSERT INTO wacrm.conversations VALUES
        ('${C(1)}', '${A}', '${OTHER}'),  -- eu atendi e transferi
        ('${C(2)}', '${A}', NULL),        -- eu atendi e devolvi à fila
        ('${C(3)}', '${A}', '${ME}'),     -- transferiram e voltou para mim (já é "Minhas")
        ('${C(4)}', '${A}', '${OTHER}'),  -- nunca foi minha
        ('${C(5)}', '${A}', '${OTHER}'),  -- minha há 200 dias (fora da janela)
        ('${C(6)}', '${B}', '${OTHER}');  -- de outra conta
      INSERT INTO wacrm.conversation_assignments (account_id, conversation_id, from_agent_id, to_agent_id, reason, created_at) VALUES
        ('${A}', '${C(1)}', '${ME}', '${OTHER}', 'primeira', now() - interval '3 days'),
        ('${A}', '${C(1)}', '${OTHER}', '${ME}', NULL, now() - interval '2 days'),
        ('${A}', '${C(1)}', '${ME}', '${OTHER}', 'segunda', now() - interval '1 day'),
        ('${A}', '${C(2)}', '${ME}', NULL, 'fila', now() - interval '5 hours'),
        ('${A}', '${C(3)}', '${ME}', '${OTHER}', 'x', now() - interval '4 days'),
        ('${A}', '${C(3)}', '${OTHER}', '${ME}', 'y', now() - interval '3 days'),
        ('${A}', '${C(4)}', '${OTHER}', '${ME}', NULL, now()),
        ('${A}', '${C(5)}', '${ME}', '${OTHER}', 'velha', now() - interval '200 days'),
        ('${B}', '${C(6)}', '${ME}', '${OTHER}', 'outra conta', now());`);
    await db.exec(migration);
    await db.exec(migration);
  }, 60000);
  afterAll(async () => { await db?.close(); });

  it("origem: cliente e atendente com sender_id são preenchidos; bot e eco sem dono ficam nulos; o escritor manda", async () => {
    await db.exec(`INSERT INTO wacrm.messages (sender_type, sender_id) VALUES ('customer', NULL), ('agent', '${ME}'), ('agent', NULL), ('bot', NULL);
      INSERT INTO wacrm.messages (sender_type, origin) VALUES ('bot', 'ai'), ('bot', 'flow'), ('bot', 'campaign');`);
    const r = (await db.query<{ sender_type: string; origin: string | null }>(
      "SELECT sender_type, origin FROM wacrm.messages ORDER BY sender_type, origin NULLS FIRST")).rows.map((x) => `${x.sender_type}:${x.origin}`);
    expect(r).toEqual(["agent:null", "agent:operator", "bot:null", "bot:ai", "bot:campaign", "bot:flow", "customer:customer"]);
  });

  it("origem inválida é rejeitada", async () => {
    await expect(db.exec("INSERT INTO wacrm.messages (sender_type, origin) VALUES ('bot', 'robo')")).rejects.toThrow(/messages_origin_chk/);
  });

  it("meus atendidos: só as que atendi e saíram de mim, da minha conta, dentro da janela, mais recente primeiro", async () => {
    const rows = await handled(ME);
    expect(rows.map((r) => r.conversation_id)).toEqual([C(2), C(1)]);
    expect(rows[0].to_agent_id).toBeNull();
    expect(rows[1].reason).toBe("segunda");
  });

  it("janela e paginação por cursor", async () => {
    expect((await handled(ME, "NULL, NULL, 50, 365")).map((r) => r.conversation_id)).toEqual([C(2), C(1), C(5)]);
    expect((await handled(ME, "NULL, NULL, 1")).map((r) => r.conversation_id)).toEqual([C(2)]);
    const at = (await db.query<{ t: string }>(`SELECT created_at::text AS t FROM wacrm.conversation_assignments WHERE reason = 'fila'`)).rows[0].t;
    expect((await handled(ME, `'${at}', '${C(2)}', 50`)).map((r) => r.conversation_id)).toEqual([C(1)]);
  });

  it("outro usuário não vê o histórico alheio", async () => {
    // o OUTRO só vê o que ELE atendeu e transferiu (C3, que passou para mim); nada de C1/C2 (histórico meu)
    expect((await handled(OTHER)).map((r) => r.conversation_id)).toEqual([C(3)]);
  });

  it("registra a migration", async () => {
    const r = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM wacrm.schema_migrations WHERE version = '302_message_origin_my_handled'");
    expect(r.rows[0].n).toBe(1);
  });
});
