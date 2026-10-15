// Migrations 370 e 371 (decisão do dono 15/10 — pausas de atendimento). PGlite com as migrations REAIS 169, 240, 241, 241b, 276, 304, 370 e 371.
// Prova: permissões por papel; uma pausa aberta por atendente; supervisor só pausa quem divide equipe (admin/owner, qualquer um da conta); quem foi
// pausado por outro não se retoma sozinho; RLS de leitura por escopo e isolamento entre contas; escrita direta negada; motivos (padrão, inativo,
// renomear não muda o histórico); is_agent_available; fechamento por desconexão; estouro avisado uma vez só.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const mig = (f: string) => readFileSync(resolve(process.cwd(), "supabase/migrations", f), "utf8").replace(/NOTIFY pgrst[^;]*;/g, "");
const A = "0000000a-0000-0000-0000-000000000000";
const B = "0000000b-0000-0000-0000-000000000000";
const OWNER = "00000000-0000-0000-0000-000000000101";
const ADMIN = "00000000-0000-0000-0000-000000000102";
const SUP1 = "00000000-0000-0000-0000-000000000103";
const SUP2 = "00000000-0000-0000-0000-000000000104";
const AG1 = "00000000-0000-0000-0000-000000000105";
const AG2 = "00000000-0000-0000-0000-000000000106";
const AG3 = "00000000-0000-0000-0000-000000000107";
const VIEWER = "00000000-0000-0000-0000-000000000108";
const OWNER_B = "00000000-0000-0000-0000-000000000201";
const AG_B = "00000000-0000-0000-0000-000000000202";
const T1 = "20000000-0000-0000-0000-000000000001";
const T2 = "20000000-0000-0000-0000-000000000002";

let db: PGlite;
type Json = Record<string, any>;

async function as<T>(user: string, fn: () => Promise<T>): Promise<T> {
  await db.query(`SELECT set_config('test.uid', $1, false)`, [user]);
  await db.exec("SET ROLE authenticated");
  try {
    return await fn();
  } finally {
    await db.exec("RESET ROLE");
  }
}
const start = (user: string, reason: string, target: string | null = null) =>
  as(user, async () => (await db.query<{ r: Json }>(`SELECT wacrm.start_pause($1, $2) AS r`, [reason, target])).rows[0].r);
const end = (user: string, target: string | null = null) =>
  as(user, async () => (await db.query<{ r: Json }>(`SELECT wacrm.end_pause($1) AS r`, [target])).rows[0].r);
const visible = (user: string) =>
  as(user, async () => (await db.query<{ user_id: string }>(`SELECT user_id FROM wacrm.agent_pauses ORDER BY user_id`)).rows.map((r) => r.user_id));
const openCount = async () => Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM wacrm.agent_pauses WHERE ended_at IS NULL`)).rows[0].n);

let LUNCH: string; // 60 min
let WC: string; // 10 min
let OTHER: string; // sem limite
let OFF: string; // inativo
let REASON_B: string;

describe("migrations 370 e 371 — pausas de atendimento", { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE SCHEMA wacrm; CREATE SCHEMA auth;
      GRANT USAGE ON SCHEMA wacrm, auth TO anon, authenticated, service_role;
      CREATE TABLE auth.users (id uuid PRIMARY KEY);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
      CREATE TYPE wacrm.account_role_enum AS ENUM ('owner', 'admin', 'supervisor', 'agent', 'viewer');
      CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY, name text NOT NULL DEFAULT 'conta', owner_user_id uuid);
      CREATE TABLE wacrm.profiles (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL UNIQUE, account_id uuid REFERENCES wacrm.accounts(id),
        account_role wacrm.account_role_enum NOT NULL, full_name text, avatar_url text, deactivated_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE wacrm.team_members (team_id uuid NOT NULL, user_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (team_id, user_id));
      CREATE TABLE wacrm.conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid, assigned_agent_id uuid, status text DEFAULT 'open');
      GRANT SELECT, UPDATE ON wacrm.conversations TO authenticated;
      CREATE TABLE wacrm.member_presence (user_id uuid PRIMARY KEY, account_id uuid, status text NOT NULL DEFAULT 'online', last_seen_at timestamptz NOT NULL DEFAULT now());
      CREATE FUNCTION wacrm.current_account_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = wacrm, public
        AS $$ SELECT p.account_id FROM wacrm.profiles p WHERE p.user_id = auth.uid() LIMIT 1 $$;
      CREATE FUNCTION wacrm.is_account_member(p_account uuid, p_role text DEFAULT 'viewer') RETURNS boolean
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = wacrm, public
        AS $$ SELECT EXISTS (SELECT 1 FROM wacrm.profiles p WHERE p.user_id = auth.uid() AND p.account_id = p_account) $$;
      CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
      CREATE TABLE wacrm.audit_test (account_id uuid, action text, resource_id uuid, summary text);
      CREATE FUNCTION wacrm.audit_write(p_account uuid, p_event text, p_resource_type text, p_resource_id uuid, p_label text,
        p_action text, p_summary text, p_changes jsonb DEFAULT NULL, p_metadata jsonb DEFAULT NULL) RETURNS void
        LANGUAGE sql SECURITY DEFINER AS $$ INSERT INTO wacrm.audit_test VALUES (p_account, p_action, p_resource_id, p_summary) $$;
      GRANT SELECT ON wacrm.profiles, wacrm.accounts, wacrm.team_members TO authenticated;
      INSERT INTO wacrm.accounts (id) VALUES ('${A}'), ('${B}');
    `);
    await db.exec(mig("169_profiles_lock_privileged_columns.sql"));
    for (const f of ["240_roles_foundation.sql", "241_roles_functions.sql", "241b_profiles_role_id_idx.sql", "276_billing_permissions.sql", "304_view_permission_keys.sql"]) {
      await db.exec(mig(f));
    }
    await db.exec(`INSERT INTO auth.users (id) VALUES ${[OWNER, ADMIN, SUP1, SUP2, AG1, AG2, AG3, VIEWER, OWNER_B, AG_B].map((u) => `('${u}')`).join(",")}`);
    await db.exec(mig("370_pausas_atendimento.sql"));
    await db.exec(mig("370_pausas_atendimento.sql")); // idempotente
    await db.exec(mig("371_pausas_distribuicao.sql"));
    await db.exec(mig("371_pausas_distribuicao.sql"));
    await db.exec(`INSERT INTO wacrm.profiles (user_id, account_id, account_role, full_name) VALUES
      ('${OWNER}', '${A}', 'owner', 'Dono'), ('${ADMIN}', '${A}', 'admin', 'Admin'), ('${SUP1}', '${A}', 'supervisor', 'Sup Um'),
      ('${SUP2}', '${A}', 'supervisor', 'Sup Dois'), ('${AG1}', '${A}', 'agent', 'Ana'), ('${AG2}', '${A}', 'agent', 'Bia'),
      ('${AG3}', '${A}', 'agent', 'Caio'), ('${VIEWER}', '${A}', 'viewer', 'Visitante'), ('${OWNER_B}', '${B}', 'owner', 'Dono B'),
      ('${AG_B}', '${B}', 'agent', 'Agente B')`);
    await db.exec(`INSERT INTO wacrm.team_members (team_id, user_id) VALUES ('${T1}', '${SUP1}'), ('${T1}', '${AG1}'), ('${T2}', '${SUP2}'), ('${T2}', '${AG2}')`);
  }, 120_000);
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.exec(`RESET ROLE; DELETE FROM wacrm.agent_pauses; DELETE FROM wacrm.pause_reasons; DELETE FROM wacrm.member_presence; DELETE FROM wacrm.audit_test; DELETE FROM wacrm.conversations;`);
    await db.query(`SELECT wacrm.ensure_default_pause_reasons($1)`, [A]);
    const rows = (await db.query<{ id: string; name: string }>(`SELECT id, name FROM wacrm.pause_reasons WHERE account_id = $1`, [A])).rows;
    LUNCH = rows.find((r) => r.name === "Almoço")!.id;
    WC = rows.find((r) => r.name === "Banheiro")!.id;
    OTHER = rows.find((r) => r.name === "Outro")!.id;
    OFF = (await db.query<{ id: string }>(`INSERT INTO wacrm.pause_reasons (account_id, name, active) VALUES ($1, 'Antigo', false) RETURNING id`, [A])).rows[0].id;
    REASON_B = (await db.query<{ id: string }>(`INSERT INTO wacrm.pause_reasons (account_id, name) VALUES ($1, 'Da outra conta') RETURNING id`, [B])).rows[0].id;
  });

  it("registra as migrations; permissões por papel de sistema (pause_self: operador+; pause_others: supervisor+; reasons_manage: admin+)", async () => {
    expect((await db.query(`SELECT version FROM wacrm.schema_migrations WHERE version IN ('370_pausas_atendimento', '371_pausas_distribuicao')`)).rows).toHaveLength(2);
    const byPerm = async (perm: string) =>
      (await db.query<{ key: string }>(`SELECT r.key FROM wacrm.role_permissions rp JOIN wacrm.account_roles r ON r.id = rp.role_id WHERE rp.permission = $1 AND r.account_id IS NULL ORDER BY 1`, [perm])).rows.map((r) => r.key);
    expect(await byPerm("presence.pause_self")).toEqual(["admin", "agent", "owner", "supervisor"]);
    expect(await byPerm("presence.pause_others")).toEqual(["admin", "owner", "supervisor"]);
    expect(await byPerm("presence.reasons_manage")).toEqual(["admin", "owner"]);
    expect((await db.query(`SELECT key FROM wacrm.permission_catalog WHERE key LIKE 'presence.%'`)).rows).toHaveLength(3);
  });

  it("motivos padrão: 4 por conta, idempotente (nunca recria se já há motivo)", async () => {
    const names = (await db.query<{ name: string; max_minutes: number | null }>(`SELECT name, max_minutes FROM wacrm.pause_reasons WHERE account_id = $1 AND active ORDER BY sort_order`, [A])).rows;
    expect(names).toEqual([
      { name: "Almoço", max_minutes: 60 }, { name: "Banheiro", max_minutes: 10 }, { name: "Treinamento", max_minutes: 120 }, { name: "Outro", max_minutes: null },
    ]);
    expect(Number((await db.query<{ n: number }>(`SELECT wacrm.ensure_default_pause_reasons($1) AS n`, [A])).rows[0].n)).toBe(0);
  });

  it("o atendente pausa a si mesmo; só UMA pausa aberta (a 2ª vira already_paused); retoma e fica manual", async () => {
    const r = await start(AG1, LUNCH);
    expect(r).toMatchObject({ ok: true, pause: { user_id: AG1, reason_name: "Almoço", max_minutes: 60, started_by: AG1, ended_at: null } });
    const again = await start(AG1, WC);
    expect(again).toMatchObject({ ok: false, code: "already_paused", pause: { reason_name: "Almoço" } });
    expect(await openCount()).toBe(1);
    const ended = await end(AG1);
    expect(ended).toMatchObject({ ok: true, pause: { end_kind: "manual", ended_by: AG1 } });
    expect(ended.pause.ended_at).not.toBeNull();
    expect(await end(AG1)).toMatchObject({ ok: false, code: "not_paused" });
    // pode pausar de novo depois de retomar
    expect(await start(AG1, WC)).toMatchObject({ ok: true });
  });

  it("papel sem pause_self (visualizador) não pausa; motivo inativo e motivo de outra conta são recusados", async () => {
    expect(await start(VIEWER, LUNCH)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await start(AG1, OFF)).toMatchObject({ ok: false, code: "reason_inactive" });
    expect(await start(AG1, REASON_B)).toMatchObject({ ok: false, code: "reason_not_found" });
    expect(await openCount()).toBe(0);
  });

  it("supervisor pausa quem é da equipe dele; o atendente NÃO se retoma; o supervisor retoma (end_kind supervisor)", async () => {
    const r = await start(SUP1, LUNCH, AG1);
    expect(r).toMatchObject({ ok: true, pause: { user_id: AG1, started_by: SUP1 } });
    expect(await end(AG1)).toMatchObject({ ok: false, code: "paused_by_supervisor" });
    expect(await openCount()).toBe(1);
    expect(await end(SUP1, AG1)).toMatchObject({ ok: true, pause: { end_kind: "supervisor", ended_by: SUP1 } });
  });

  it("supervisor NÃO pausa nem retoma atendente de OUTRA equipe; admin e proprietário pausam qualquer um da conta", async () => {
    expect(await start(SUP1, LUNCH, AG2)).toMatchObject({ ok: false, code: "other_team" });
    expect(await start(SUP1, LUNCH, AG3)).toMatchObject({ ok: false, code: "other_team" }); // sem equipe nenhuma
    expect(await start(ADMIN, LUNCH, AG2)).toMatchObject({ ok: true });
    expect(await end(SUP1, AG2)).toMatchObject({ ok: false, code: "other_team" });
    expect(await end(OWNER, AG2)).toMatchObject({ ok: true, pause: { end_kind: "supervisor" } });
    expect(await start(OWNER, WC, AG3)).toMatchObject({ ok: true });
  });

  it("operador não pausa outro; ninguém pausa gente de outra conta (nem revela que existe)", async () => {
    expect(await start(AG1, LUNCH, AG2)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await start(OWNER, LUNCH, AG_B)).toMatchObject({ ok: false, code: "user_not_found" });
    expect(await start(OWNER, LUNCH, "00000000-0000-0000-0000-0000000000ff")).toMatchObject({ ok: false, code: "user_not_found" });
    expect(await openCount()).toBe(0);
  });

  it("RLS de leitura: o próprio; supervisor = equipes dele; admin/owner = conta toda; outra conta não vê nada; escrita direta negada", async () => {
    await start(AG1, LUNCH);
    await start(AG2, WC);
    await start(AG3, OTHER);
    expect(await visible(AG1)).toEqual([AG1]);
    expect(await visible(SUP1)).toEqual([AG1]);
    expect(await visible(SUP2)).toEqual([AG2]);
    expect(await visible(ADMIN)).toEqual([AG1, AG2, AG3].sort());
    expect(await visible(OWNER_B)).toEqual([]);
    await expect(as(AG1, () => db.exec(`UPDATE wacrm.agent_pauses SET ended_at = now(), end_kind = 'manual'`))).rejects.toThrow();
    await expect(as(AG1, () => db.exec(`INSERT INTO wacrm.agent_pauses (account_id, user_id, reason_name) VALUES ('${A}', '${AG1}', 'x')`))).rejects.toThrow();
    expect(await openCount()).toBe(3);
  });

  it("motivos: só reasons_manage escreve; ninguém apaga; renomear/editar NÃO muda a pausa gravada; nome único sem diferenciar maiúsculas", async () => {
    await expect(as(AG1, () => db.exec(`INSERT INTO wacrm.pause_reasons (account_id, name) VALUES ('${A}', 'Novo')`))).rejects.toThrow();
    await as(ADMIN, () => db.exec(`INSERT INTO wacrm.pause_reasons (account_id, name, max_minutes) VALUES ('${A}', 'Reunião', 30)`));
    await expect(db.exec(`INSERT INTO wacrm.pause_reasons (account_id, name) VALUES ('${A}', '  almoço ')`)).rejects.toThrow();
    await expect(as(ADMIN, () => db.exec(`DELETE FROM wacrm.pause_reasons WHERE id = '${LUNCH}'`))).rejects.toThrow();
    const names = await as(AG1, async () => (await db.query<{ name: string }>(`SELECT name FROM wacrm.pause_reasons ORDER BY name`)).rows.map((r) => r.name));
    expect(names).toContain("Reunião");
    expect(names).not.toContain("Da outra conta");
    await start(AG1, LUNCH);
    await as(ADMIN, () => db.exec(`UPDATE wacrm.pause_reasons SET name = 'Refeição', max_minutes = 45 WHERE id = '${LUNCH}'`));
    const p = (await db.query<{ reason_name: string; max_minutes: number }>(`SELECT reason_name, max_minutes FROM wacrm.agent_pauses WHERE user_id = '${AG1}'`)).rows[0];
    expect(p).toEqual({ reason_name: "Almoço", max_minutes: 60 });
  });

  it("auditoria: pause.started e pause.ended com o resumo", async () => {
    await start(SUP1, LUNCH, AG1);
    await end(SUP1, AG1);
    const audit = (await db.query<{ action: string; summary: string }>(`SELECT action, summary FROM wacrm.audit_test ORDER BY action DESC`)).rows;
    expect(audit.map((a) => a.action)).toEqual(["pause.started", "pause.ended"]);
    expect(audit[0].summary).toContain("Ana");
  });

  // ── 371 ────────────────────────────────────────────────────────────────────
  const presence = (user: string, status: string, secondsAgo: number) =>
    db.exec(`INSERT INTO wacrm.member_presence (user_id, account_id, status, last_seen_at) VALUES ('${user}', '${A}', '${status}', now() - interval '${secondsAgo} seconds')
             ON CONFLICT (user_id) DO UPDATE SET status = EXCLUDED.status, last_seen_at = EXCLUDED.last_seen_at`);
  const available = async (user: string) => (await db.query<{ r: boolean }>(`SELECT wacrm.is_agent_available($1) AS r`, [user])).rows[0].r;

  it("is_agent_available = online (≤ 75 s) E sem pausa aberta; agents_in_pause lista os pausados", async () => {
    await presence(AG1, "online", 10);
    await presence(AG2, "online", 200); // offline pela régua de 75 s
    await presence(AG3, "away", 5);
    expect(await available(AG1)).toBe(true);
    expect(await available(AG2)).toBe(false);
    expect(await available(AG3)).toBe(false);
    await start(AG1, LUNCH);
    expect(await available(AG1)).toBe(false); // online, mas em pausa
    expect((await db.query<{ u: string }>(`SELECT wacrm.agents_in_pause(ARRAY['${AG1}', '${AG2}']::uuid[]) AS u`)).rows.map((r) => r.u)).toEqual([AG1]);
    await end(AG1);
    expect(await available(AG1)).toBe(true);
  });

  it("fechamento por desconexão: sem sinal há mais de 15 min fecha (end_kind desconexao, fim = último sinal); quem está ativo continua", async () => {
    await start(AG1, LUNCH);
    await start(AG2, LUNCH);
    await db.exec(`UPDATE wacrm.agent_pauses SET started_at = now() - interval '40 minutes'`);
    await presence(AG1, "online", 20 * 60); // sumiu há 20 min
    await presence(AG2, "online", 10); // ativo
    expect(Number((await db.query<{ n: number }>(`SELECT wacrm.close_disconnected_pauses(15) AS n`)).rows[0].n)).toBe(1);
    const rows = (await db.query<{ user_id: string; end_kind: string | null; ended_at: Date | null; started_at: Date }>(`SELECT user_id, end_kind, ended_at, started_at FROM wacrm.agent_pauses ORDER BY user_id`)).rows;
    const ag1 = rows.find((r) => r.user_id === AG1)!;
    const ag2 = rows.find((r) => r.user_id === AG2)!;
    expect(ag1.end_kind).toBe("desconexao");
    expect(ag1.ended_at!.getTime()).toBeGreaterThan(ag1.started_at.getTime());
    expect(ag2.end_kind).toBeNull();
    expect((await db.query(`SELECT 1 FROM wacrm.audit_test WHERE action = 'pause.ended'`)).rows).toHaveLength(1);
    // pausa recente de quem está offline há muito NÃO fecha de imediato (precisa de 15 min de pausa também)
    await start(AG3, LUNCH);
    await presence(AG3, "online", 3600);
    expect(Number((await db.query<{ n: number }>(`SELECT wacrm.close_disconnected_pauses(15) AS n`)).rows[0].n)).toBe(0);
  });

  it("estouro do tempo: avisado UMA vez por pausa; sem limite ou encerrada nunca; não encerra nem retoma", async () => {
    await start(AG1, WC); // 10 min
    await start(AG2, OTHER); // sem limite
    await start(AG3, LUNCH); // 60 min
    await db.exec(`UPDATE wacrm.agent_pauses SET started_at = now() - interval '30 minutes'`);
    const first = (await db.query<{ user_id: string; reason_name: string; max_minutes: number }>(`SELECT user_id, reason_name, max_minutes FROM wacrm.claim_exceeded_pauses()`)).rows;
    expect(first).toEqual([{ user_id: AG1, reason_name: "Banheiro", max_minutes: 10 }]);
    expect((await db.query(`SELECT 1 FROM wacrm.claim_exceeded_pauses()`)).rows).toHaveLength(0);
    expect(await openCount()).toBe(3);
    expect((await db.query<{ alerted_at: Date | null }>(`SELECT alerted_at FROM wacrm.agent_pauses WHERE user_id = '${AG1}'`)).rows[0].alerted_at).not.toBeNull();
    // 61 min no almoço: avisa o 2º, e só ele
    await db.exec(`UPDATE wacrm.agent_pauses SET started_at = now() - interval '61 minutes' WHERE user_id = '${AG3}'`);
    expect((await db.query<{ user_id: string }>(`SELECT user_id FROM wacrm.claim_exceeded_pauses()`)).rows.map((r) => r.user_id)).toEqual([AG3]);
  });

  it("trava da atribuição manual direta: o navegador não atribui a quem está em pausa (agent_paused); a si mesmo, a quem não está pausado e o service_role passam", async () => {
    const conv = (await db.query<{ id: string }>(`INSERT INTO wacrm.conversations (account_id) VALUES ('${A}') RETURNING id`)).rows[0].id;
    await start(AG2, LUNCH);
    const assign = (user: string, target: string) => as(user, () => db.query(`UPDATE wacrm.conversations SET assigned_agent_id = $1 WHERE id = $2`, [target, conv]));
    await expect(assign(SUP2, AG2)).rejects.toThrow(/agent_paused/);
    expect((await db.query<{ a: string | null }>(`SELECT assigned_agent_id AS a FROM wacrm.conversations WHERE id = $1`, [conv])).rows[0].a).toBeNull();
    await assign(SUP2, AG3); // não está em pausa
    await assign(AG2, AG2); // a si mesmo, mesmo pausado
    await db.query(`SELECT set_config('test.uid', '', false)`); // service_role: sem usuário
    await db.query(`UPDATE wacrm.conversations SET assigned_agent_id = $1 WHERE id = $2`, [AG2, conv]); // transfer confirmado / motor
    expect((await db.query<{ a: string }>(`SELECT assigned_agent_id AS a FROM wacrm.conversations WHERE id = $1`, [conv])).rows[0].a).toBe(AG2);
    await end(OWNER, AG2);
    await assign(SUP2, AG2); // depois de retomar, volta a poder
  });

  it("a RLS da leitura de motivos exige pause_self ou reasons_manage (visualizador não lê)", async () => {
    expect(await as(AG1, async () => (await db.query(`SELECT 1 FROM wacrm.pause_reasons`)).rows.length)).toBeGreaterThan(0);
    expect(await as(VIEWER, async () => (await db.query(`SELECT 1 FROM wacrm.pause_reasons`)).rows.length)).toBe(0);
  });
});
