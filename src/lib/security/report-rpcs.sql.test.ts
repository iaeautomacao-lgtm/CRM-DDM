// Migration 322 (RLS fase 2, item C): RPCs de relatório pelo catálogo (reports.view_team / reports.view_all), recorte do supervisor por PERMISSÃO.
// PGlite com as migrations REAIS 140 (papéis/equipes), 143 (recorte do supervisor), 169, 240/241 (catálogo, has_perm) e 322.
// As RPCs de relatório são stand-ins com o MESMO formato de guard das reais (o teste estático no fim confere que o guard das definições reais
// aparece exatamente as vezes que a 322 espera). Prova: nas TELAS os papéis de sistema recebem o MESMO de hoje; só a chamada direta muda.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migration = (file: string) => readFileSync(resolve(process.cwd(), "supabase/migrations", file), "utf8").replace(/NOTIFY pgrst[^;]*;/g, "");
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const ACC = id(1);
const ACC_B = id(2);
const U = { owner: id(101), admin: id(102), supervisor: id(103), agent: id(104), viewer: id(105), agent2: id(106), customTeam: id(107), customScoped: id(108), customAll: id(109), other: id(110) };
const T1 = id(201);
const T2 = id(202);
const C = { c1: id(301), c2: id(302), c3: id(303), c4: id(304), c5: id(305), cb: id(306) };
const K = { k1: id(401), k2: id(402), kb: id(403) };

const BOOTSTRAP = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
  CREATE SCHEMA wacrm; CREATE SCHEMA auth;
  GRANT USAGE ON SCHEMA wacrm, auth TO anon, authenticated, service_role;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
  CREATE TYPE wacrm.account_role_enum AS ENUM ('owner', 'admin', 'supervisor', 'agent', 'viewer');
  CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL DEFAULT 'conta', owner_user_id uuid);
  CREATE TABLE wacrm.profiles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL UNIQUE, account_id uuid REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
    account_role wacrm.account_role_enum NOT NULL, full_name text, avatar_url text, updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE FUNCTION wacrm.current_account_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = wacrm, public
    AS $$ SELECT p.account_id FROM wacrm.profiles p WHERE p.user_id = auth.uid() LIMIT 1 $$;
  INSERT INTO wacrm.accounts (id, name) VALUES ('${ACC}', 'A'), ('${ACC_B}', 'B');
  CREATE TABLE wacrm.teams (id uuid PRIMARY KEY, account_id uuid);
  CREATE TABLE wacrm.team_members (team_id uuid, user_id uuid);
  CREATE TABLE wacrm.whatsapp_config (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid, team_id uuid);
  CREATE TABLE wacrm.conversations (id uuid PRIMARY KEY, account_id uuid, team_id uuid, assigned_agent_id uuid, status text, created_at timestamptz DEFAULT now());
  CREATE TABLE wacrm.agent_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid, user_id uuid);
  CREATE TABLE wacrm.campaigns (id uuid PRIMARY KEY, created_by uuid, nome text);
  CREATE TABLE wacrm.disp_message_queue (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), campaign_id uuid, contact_phone text);
  CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
  -- is_account_member da 017 (a 140 real a reescreve com 'supervisor')
  CREATE FUNCTION wacrm.is_account_member(target_account_id uuid, min_role wacrm.account_role_enum DEFAULT 'viewer') RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT false $$;
`;

// RPCs de relatório no formato das reais (guard `AND is_account_member(p_account_id)` antes da 143; 143 insere o recorte logo depois).
const attendance = (name: string, sig: string, select: string, from: string, where: string) => `
  CREATE FUNCTION wacrm.${name}(${sig}) RETURNS TABLE (item text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = wacrm, public AS $$
    SELECT ${select} FROM ${from} WHERE ${where}
      AND is_account_member(p_account_id);
  $$;`;
const RPCS = `
  ${attendance("get_attendance_report_by_team", "p_account_id uuid, p_from timestamptz, p_to timestamptz", "c.id::text", "wacrm.conversations c", "c.account_id = p_account_id")}
  ${attendance("get_attendance_report_by_agent", "p_account_id uuid, p_from timestamptz, p_to timestamptz", "c.id::text", "wacrm.conversations c", "c.account_id = p_account_id")}
  ${attendance("get_attendance_summary", "p_account_id uuid, p_from timestamptz, p_to timestamptz", "c.id::text", "wacrm.conversations c", "c.account_id = p_account_id")}
  ${attendance("get_conversations_report", "p_account_id uuid, p_from timestamptz, p_to timestamptz, p_a text, p_b text, p_c uuid, p_d uuid, p_e text, p_f text, p_g integer, p_h integer", "c.id::text", "wacrm.conversations c", "c.account_id = p_account_id")}
  ${attendance("get_agent_sessions_report", "p_account_id uuid, p_from timestamptz, p_to timestamptz, p_agent uuid", "s.user_id::text", "wacrm.agent_sessions s", "s.account_id = p_account_id")}
  CREATE FUNCTION wacrm.get_campaigns_for_report(p_account_id uuid) RETURNS TABLE (item text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = wacrm, public, extensions AS $$
    SELECT c.id::text FROM wacrm.campaigns c JOIN wacrm.profiles p ON p.user_id = c.created_by
     WHERE p.account_id = p_account_id
       AND is_account_member(p_account_id);
  $$;
  CREATE FUNCTION wacrm.get_campaign_report_detail(p_campaign_id uuid, p_account_id uuid) RETURNS TABLE (item text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = wacrm, public, extensions AS $$
    SELECT c.id::text FROM wacrm.campaigns c JOIN wacrm.profiles p ON p.user_id = c.created_by
     WHERE c.id = p_campaign_id AND p.account_id = p_account_id
       AND is_account_member(p_account_id);
  $$;
  CREATE FUNCTION wacrm.get_campaign_queue_items(p_campaign_id uuid, p_account_id uuid, p_status text DEFAULT NULL, p_search text DEFAULT NULL, p_limit integer DEFAULT 60, p_offset integer DEFAULT 0)
    RETURNS TABLE (item text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = wacrm, public, extensions AS $$
    SELECT q.contact_phone FROM wacrm.disp_message_queue q JOIN wacrm.campaigns c ON c.id = q.campaign_id JOIN wacrm.profiles p ON p.user_id = c.created_by
     WHERE q.campaign_id = p_campaign_id AND p.account_id = p_account_id
       AND is_account_member(p_account_id);
  $$;
`;
// report_tabulacoes no formato da 165 (guard qualificado, 2 ocorrências, e o recorte já via report_sees_conversation)
const TABULACOES = `
  CREATE FUNCTION wacrm.report_tabulacoes(p_account_id uuid, p_from timestamptz, p_to timestamptz, p_team_id uuid DEFAULT NULL, p_agent_id uuid DEFAULT NULL)
    RETURNS TABLE (item text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    WITH encerradas AS (
      SELECT c.id::text AS item FROM wacrm.conversations c
       WHERE c.account_id = p_account_id
         AND wacrm.is_account_member(p_account_id)
         AND wacrm.report_sees_conversation(c.team_id, c.assigned_agent_id)
    )
    SELECT item FROM encerradas
    UNION ALL
    SELECT 'sem-tabulacao' WHERE wacrm.is_account_member(p_account_id);
  $$;`;

type Who = keyof typeof U;
const SYSTEM: Who[] = ["owner", "admin", "supervisor", "agent", "viewer"];

describe("migration 322 — RPCs de relatório pelo catálogo", { timeout: 180_000 }, () => {
  let db: PGlite;
  const results: Record<string, Record<string, string[]>> = { before: {}, after: {} };

  async function call(who: Who, fn: string, args: string): Promise<string[]> {
    await db.exec("SET ROLE authenticated");
    await db.exec(`SELECT set_config('test.uid', '${U[who]}', false)`);
    try {
      return (await db.query<{ item: string }>(`SELECT item FROM wacrm.${fn}(${args})`)).rows.map((r) => r.item).sort();
    } finally {
      await db.exec("RESET ROLE");
    }
  }
  const CALLS: Record<string, [string, string]> = {
    by_team: ["get_attendance_report_by_team", `'${ACC}', now() - interval '1 day', now()`],
    by_agent: ["get_attendance_report_by_agent", `'${ACC}', now() - interval '1 day', now()`],
    summary: ["get_attendance_summary", `'${ACC}', now() - interval '1 day', now()`],
    conversations: ["get_conversations_report", `'${ACC}', now() - interval '1 day', now(), null, null, null, null, null, null, 10, 0`],
    sessions: ["get_agent_sessions_report", `'${ACC}', now() - interval '1 day', now(), null`],
    tabulacoes: ["report_tabulacoes", `'${ACC}', now() - interval '1 day', now()`],
    campaigns: ["get_campaigns_for_report", `'${ACC}'`],
    detail: ["get_campaign_report_detail", `'${K.k1}', '${ACC}'`],
    queue: ["get_campaign_queue_items", `'${K.k1}', '${ACC}'`],
  };
  const TEAM_FAMILY = ["by_team", "by_agent", "summary", "conversations", "sessions", "tabulacoes"];
  const ALL_FAMILY = ["campaigns", "detail", "queue"];

  async function snapshot(label: "before" | "after") {
    for (const who of Object.keys(U) as Who[]) {
      if (who === "other") continue;
      for (const [k, [fn, args]] of Object.entries(CALLS)) results[label][`${who}:${k}`] = await call(who, fn, args);
    }
  }
  const r = (label: "before" | "after", who: Who, k: string) => results[label][`${who}:${k}`];

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(BOOTSTRAP);
    await db.exec(migration("169_profiles_lock_privileged_columns.sql"));
    await db.exec(`GRANT SELECT ON wacrm.profiles, wacrm.accounts, wacrm.team_members TO authenticated`);
    await db.exec(migration("140_supervisor_role_access.sql")); // is_account_member com supervisor, current_user_role, current_user_team_ids
    await db.exec(migration("240_roles_foundation.sql"));
    await db.exec(migration("241_roles_functions.sql"));
    await db.exec(migration("241b_profiles_role_id_idx.sql"));
    await db.exec(`GRANT SELECT ON wacrm.account_roles, wacrm.role_permissions, wacrm.permission_catalog TO authenticated`);

    // perfis (a trigger da 240 preenche role_id a partir do account_role)
    for (const w of SYSTEM) await db.query(`INSERT INTO wacrm.profiles (user_id, account_id, account_role) VALUES ($1, $2, $3::wacrm.account_role_enum)`, [U[w], ACC, w]);
    await db.query(`INSERT INTO wacrm.profiles (user_id, account_id, account_role) VALUES ($1, $2, 'agent')`, [U.agent2, ACC]);
    await db.query(`INSERT INTO wacrm.profiles (user_id, account_id, account_role) VALUES ($1, $2, 'admin')`, [U.other, ACC_B]);
    // 3 papéis personalizados: só view_team (compat supervisor); view_team + permissões de admin (compat ADMIN, mas SEM view_all); view_all (compat admin)
    const custom = async (key: string, compat: string, perms: string[], user: string) => {
      const rid = (await db.query<{ id: string }>(`INSERT INTO wacrm.account_roles (account_id, key, name, kind, rank, compat_role) VALUES ($1, $2, $2, 'custom', 2, $3) RETURNING id`, [ACC, key, compat])).rows[0].id;
      for (const p of perms) await db.query(`INSERT INTO wacrm.role_permissions (role_id, permission) VALUES ($1, $2)`, [rid, p]);
      await db.query(`INSERT INTO wacrm.profiles (user_id, account_id, account_role) VALUES ($1, $2, 'viewer')`, [user, ACC]);
      await db.query(`UPDATE wacrm.profiles SET role_id = $2 WHERE user_id = $1`, [user, rid]);
    };
    await custom("so_equipe", "supervisor", ["reports.view_team"], U.customTeam);
    await custom("admin_sem_all", "admin", ["reports.view_team", "members.view", "members.manage"], U.customScoped);
    await custom("todos", "admin", ["reports.view_team", "reports.view_all"], U.customAll);

    await db.exec(`
      INSERT INTO wacrm.teams VALUES ('${T1}', '${ACC}'), ('${T2}', '${ACC}');
      INSERT INTO wacrm.team_members VALUES ('${T1}', '${U.supervisor}'), ('${T1}', '${U.agent}'), ('${T1}', '${U.customTeam}'), ('${T1}', '${U.customScoped}'), ('${T2}', '${U.agent2}');
      INSERT INTO wacrm.conversations (id, account_id, team_id, assigned_agent_id, status) VALUES
        ('${C.c1}', '${ACC}', '${T1}', '${U.agent}', 'open'), ('${C.c2}', '${ACC}', '${T1}', NULL, 'open'), ('${C.c3}', '${ACC}', '${T2}', NULL, 'open'),
        ('${C.c4}', '${ACC}', '${T2}', '${U.agent2}', 'open'), ('${C.c5}', '${ACC}', NULL, '${U.agent2}', 'open'), ('${C.cb}', '${ACC_B}', NULL, NULL, 'open');
      INSERT INTO wacrm.agent_sessions (account_id, user_id) VALUES ('${ACC}', '${U.agent}'), ('${ACC}', '${U.agent2}'), ('${ACC}', '${U.supervisor}'), ('${ACC}', '${U.owner}');
      INSERT INTO wacrm.campaigns VALUES ('${K.k1}', '${U.admin}', 'k1'), ('${K.k2}', '${U.owner}', 'k2'), ('${K.kb}', '${U.other}', 'kb');
      INSERT INTO wacrm.disp_message_queue (campaign_id, contact_phone) VALUES ('${K.k1}', '5521999990001'), ('${K.k1}', '5521999990002'), ('${K.k2}', '5521999990003');
    `);

    // ANTES: RPCs com o guard de membership; 143 REAL insere o recorte do supervisor (por nome); tabulações já nasceu com o recorte (165)
    await db.exec(RPCS);
    await db.exec(migration("143_supervisor_report_scope.sql"));
    await db.exec(TABULACOES);
    await db.exec(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA wacrm TO authenticated`);
    await snapshot("before");

    await db.exec(migration("322_report_rpcs_has_perm.sql"));
    await snapshot("after");
  }, 120_000);
  afterAll(async () => {
    await db.close();
  }, 60_000);

  it("ANTES (documenta o problema): operador e visualizador recebiam o relatório da conta inteira e a fila por contato; supervisor também os de envio em lote", () => {
    expect(r("before", "agent", "summary")).toHaveLength(5);
    expect(r("before", "viewer", "summary")).toHaveLength(5);
    expect(r("before", "viewer", "queue")).toEqual(["5521999990001", "5521999990002"]);
    expect(r("before", "supervisor", "queue")).toHaveLength(2);
    expect(r("before", "customScoped", "summary")).toHaveLength(5); // compat admin ⇒ sem recorte, por NOME do papel
  });

  it("TELAS dos papéis de sistema inalteradas — atendimento (owner/admin/supervisor): o MESMO conjunto de antes, em todas as 6 RPCs", () => {
    for (const k of TEAM_FAMILY) {
      for (const who of ["owner", "admin", "supervisor"] as Who[]) expect(r("after", who, k), `${who}:${k}`).toEqual(r("before", who, k));
    }
    // owner/admin sem recorte; supervisor recortado às equipes dele (T1): C1 e C2 (conversas) e sessões de agent + supervisor
    expect(r("after", "owner", "summary")).toHaveLength(5);
    expect(r("after", "admin", "tabulacoes")).toHaveLength(6); // 5 conversas + a linha 'sem-tabulacao'
    expect(r("after", "supervisor", "summary")).toEqual([C.c1, C.c2].sort());
    expect(r("after", "supervisor", "sessions")).toEqual([U.agent, U.supervisor].sort());
  });

  it("TELAS dos papéis de sistema inalteradas — envio em lote (owner/admin): o MESMO de antes", () => {
    for (const k of ALL_FAMILY) for (const who of ["owner", "admin"] as Who[]) expect(r("after", who, k), `${who}:${k}`).toEqual(r("before", who, k));
    expect(r("after", "admin", "campaigns")).toEqual([K.k1, K.k2].sort());
    expect(r("after", "owner", "queue")).toEqual(["5521999990001", "5521999990002"]);
  });

  it("o que muda é só a chamada direta: operador/visualizador não recebem nenhum relatório; supervisor não recebe envio em lote", () => {
    for (const who of ["agent", "viewer", "agent2"] as Who[]) for (const k of [...TEAM_FAMILY, ...ALL_FAMILY]) expect(r("after", who, k), `${who}:${k}`).toEqual([]);
    for (const k of ALL_FAMILY) expect(r("after", "supervisor", k), `supervisor:${k}`).toEqual([]);
  });

  it("recorte por PERMISSÃO, não por nome: admin personalizado SEM reports.view_all é recortado; com view_all vê tudo; só view_team age como supervisor", () => {
    expect(r("after", "customScoped", "summary")).toEqual([C.c1, C.c2].sort()); // antes: 5 (compat admin)
    expect(r("after", "customScoped", "sessions")).toEqual([U.agent, U.supervisor].sort());
    expect(r("after", "customTeam", "summary")).toEqual(r("after", "supervisor", "summary"));
    expect(r("after", "customAll", "summary")).toHaveLength(5);
    expect(r("after", "customAll", "sessions")).toHaveLength(4);
    // envio em lote: só quem tem reports.view_all
    for (const k of ALL_FAMILY) expect(r("after", "customAll", k)).toEqual(r("after", "admin", k));
    for (const who of ["customTeam", "customScoped"] as Who[]) for (const k of ALL_FAMILY) expect(r("after", who, k)).toEqual([]);
  });

  it("outra conta: não lê a conta A (is_account_member continua no guard)", async () => {
    expect(await call("other", "get_attendance_summary", `'${ACC}', now() - interval '1 day', now()`)).toEqual([]);
    expect(await call("other", "get_campaign_queue_items", `'${K.k1}', '${ACC}'`)).toEqual([]);
  });

  it("report_can: só authenticated executa; idempotente (rodar de novo pula o que já usa report_can) e registra a versão", async () => {
    expect((await db.query<{ a: boolean; u: boolean }>(`SELECT has_function_privilege('anon', 'wacrm.report_can(uuid,text)', 'EXECUTE') AS a, has_function_privilege('authenticated', 'wacrm.report_can(uuid,text)', 'EXECUTE') AS u`)).rows[0]).toEqual({ a: false, u: true });
    await db.exec(migration("322_report_rpcs_has_perm.sql"));
    const defs = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_proc WHERE pronamespace = 'wacrm'::regnamespace AND pg_get_functiondef(oid) LIKE '%report_can(p_account_id%'`)).rows[0].n;
    expect(defs).toBe(9);
    expect((await db.query(`SELECT version FROM wacrm.schema_migrations WHERE version LIKE '322%'`)).rows).toEqual([{ version: "322_report_rpcs_has_perm" }]);
  });

  it("aborta sem alterar nada se a definição viva tem o guard em número diferente do esperado", async () => {
    await db.exec(`CREATE OR REPLACE FUNCTION wacrm.get_campaigns_for_report(p_account_id uuid) RETURNS TABLE (item text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = wacrm, public AS $$
      SELECT c.id::text FROM wacrm.campaigns c WHERE is_account_member(p_account_id) AND is_account_member(p_account_id); $$`);
    await expect(db.exec(migration("322_report_rpcs_has_perm.sql"))).rejects.toThrow(/nada foi alterado/);
    await db.exec("ROLLBACK");
  });
});

// ---- definições REAIS: o guard aparece exatamente as vezes que a 322 espera ----------------------------------------------------------
describe("322 × definições reais das migrations (051–054, 165, 183)", () => {
  function body(file: string, fn: string): string {
    const src = readFileSync(resolve(process.cwd(), "supabase/migrations", file), "utf8");
    const start = Math.max(src.lastIndexOf(`CREATE OR REPLACE FUNCTION wacrm.${fn}(`), src.lastIndexOf(`CREATE FUNCTION wacrm.${fn}(`));
    expect(start, `${fn} em ${file}`).toBeGreaterThan(-1);
    const open = src.indexOf("$$", start);
    const close = src.indexOf("$$", open + 2);
    return src.slice(open, close);
  }
  const GUARD = /(wacrm\.)?is_account_member\(p_account_id\)/g;
  const cases: Array<[string, string, number]> = [
    ["051_attendance_report_rpc.sql", "get_attendance_report_by_team", 1],
    ["051_attendance_report_rpc.sql", "get_attendance_report_by_agent", 1],
    ["051_attendance_report_rpc.sql", "get_attendance_summary", 1],
    ["053_conversations_report_rpc.sql", "get_conversations_report", 1],
    ["052_agent_sessions.sql", "get_agent_sessions_report", 1],
    ["165_report_tabulacoes.sql", "report_tabulacoes", 2],
    ["054_broadcast_report_rpc.sql", "get_campaigns_for_report", 1],
    ["183_campaign_metric_deltas.sql", "get_campaign_report_detail", 1],
    ["054_broadcast_report_rpc.sql", "get_campaign_queue_items", 1],
  ];
  it.each(cases)("%s · %s: %i ocorrência(s) do guard", (file, fn, expected) => {
    expect((body(file, fn).match(GUARD) ?? []).length).toBe(expected);
  });
});
