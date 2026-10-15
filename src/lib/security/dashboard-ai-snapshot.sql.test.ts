// Migration 375: painel de IA lê o resumo da conta (admin+ com pipelines.view); os demais seguem no cálculo ao vivo. Mesma informação.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";

import { ACC, ACC_B, SYSTEM, U, asUser, createRolesDb, headerRollback, id, migration } from "./rls-fixture";

const liveFunction = () => {
  const sql = migration("293_dashboard_aggregates.sql");
  const m = sql.match(/CREATE OR REPLACE FUNCTION wacrm\.dashboard_ai_analytics\(\)[\s\S]*?\n\$\$;/);
  if (!m) throw new Error("função da 293 não encontrada");
  return m[0];
};

type Ratio = { messagesRatio: { total: number } };

describe("migration 375 — resumo do painel de IA", { timeout: 180_000 }, () => {
  let db: PGlite;
  const call = async (who: string) => (await asUser<{ r: Record<string, unknown> }>(db, who, `SELECT wacrm.dashboard_ai_analytics() AS r`))[0].r;
  const before: Record<string, Record<string, unknown>> = {};
  const everyone = () => [...SYSTEM, "other"];

  beforeAll(async () => {
    db = await createRolesDb();
    await db.exec(migration("304_view_permission_keys.sql"));
    await db.exec(`
      ALTER TABLE wacrm.conversations ADD COLUMN sentiment text;
      CREATE TABLE wacrm.messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid, conversation_id uuid, sender_type text, created_at timestamptz DEFAULT now());
      CREATE TABLE wacrm.deals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid, user_id uuid, status text, value numeric);
      CREATE TABLE wacrm.member_presence (user_id uuid PRIMARY KEY, account_id uuid, last_seen_at timestamptz);
      CREATE FUNCTION wacrm.visible_member_email(p_user uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT p.email FROM wacrm.profiles p WHERE p.user_id = p_user $$;
      GRANT SELECT ON wacrm.conversations, wacrm.messages, wacrm.deals TO authenticated;
      ALTER TABLE wacrm.conversations ENABLE ROW LEVEL SECURITY; ALTER TABLE wacrm.messages ENABLE ROW LEVEL SECURITY; ALTER TABLE wacrm.deals ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS conversations_select ON wacrm.conversations;
      CREATE POLICY conversations_select ON wacrm.conversations FOR SELECT USING (wacrm.is_account_member(account_id, 'admin'));
      CREATE POLICY messages_select ON wacrm.messages FOR SELECT USING (wacrm.is_account_member(account_id, 'admin'));
      CREATE POLICY deals_select ON wacrm.deals FOR SELECT USING (wacrm.is_account_member(account_id, 'admin'));
      ${liveFunction()}
      GRANT EXECUTE ON FUNCTION wacrm.dashboard_ai_analytics() TO authenticated, service_role;
      INSERT INTO wacrm.conversations (id, account_id, sentiment) VALUES ('${id(901)}', '${ACC}', 'positive'), ('${id(902)}', '${ACC}', 'negative'), ('${id(903)}', '${ACC}', 'neutral'), ('${id(904)}', '${ACC_B}', 'mixed');
      INSERT INTO wacrm.messages (account_id, sender_type) VALUES ('${ACC}', 'bot'), ('${ACC}', 'bot'), ('${ACC}', 'agent'), ('${ACC}', 'customer'), ('${ACC_B}', 'agent');
      INSERT INTO wacrm.deals (account_id, user_id, status, value) VALUES ('${ACC}', '${U.agent}', 'won', 100), ('${ACC}', '${U.agent}', 'won', 50), ('${ACC}', '${U.admin}', 'won', 30), ('${ACC}', '${U.agent}', 'lost', 9), ('${ACC}', NULL, 'open', 7), ('${ACC_B}', '${U.other}', 'won', 1000);
      UPDATE wacrm.profiles SET full_name = 'Agente Um' WHERE user_id = '${U.agent}';
      INSERT INTO wacrm.member_presence VALUES ('${U.admin}', '${ACC}', now()), ('${U.other}', '${ACC_B}', now() - interval '3 days');
    `);
    for (const who of everyone()) before[who] = await call(who);
    await db.exec(migration("375_dashboard_ai_snapshot.sql"));
  }, 120_000);
  afterAll(async () => {
    await db.close();
  });

  it("antes: admin vê a conta; supervisor, agente e visualizador não veem contagens (RLS por linha)", () => {
    expect((before.admin as unknown as Ratio).messagesRatio.total).toBe(3);
    expect((before.admin.conversion as { won: number }).won).toBe(3);
    expect((before.agent as unknown as Ratio).messagesRatio.total).toBe(0);
  });

  it("sem resumo ainda: todos recebem EXATAMENTE o que recebiam (cai no cálculo ao vivo)", async () => {
    for (const who of everyone()) expect(await call(who), who).toEqual(before[who]);
  });

  it("só a conta com atividade recente ganha resumo (a outra, com presença de 3 dias, não); fresco não recalcula", async () => {
    expect((await db.query<{ n: number }>(`SELECT wacrm.refresh_dashboard_ai_snapshots() AS n`)).rows[0].n).toBe(1);
    expect((await db.query<{ account_id: string }>(`SELECT account_id FROM wacrm.dashboard_ai_snapshot`)).rows).toEqual([{ account_id: ACC }]);
    expect((await db.query<{ n: number }>(`SELECT wacrm.refresh_dashboard_ai_snapshots() AS n`)).rows[0].n).toBe(0);
  });

  it("EQUIVALÊNCIA: com resumo, todo usuário recebe o MESMO resultado de antes (admin/owner pelo resumo; os outros ao vivo), com o nome do operador", async () => {
    for (const who of everyone()) expect(await call(who), who).toEqual(before[who]);
    const admin = (await call("admin")) as { financials: { operators: Array<{ userName: string }> } };
    expect(admin.financials.operators.map((o) => o.userName)).toEqual(["Agente Um", expect.any(String)]);
  });

  it("o admin lê mesmo o resumo (não vê mudança nova enquanto está fresco); o agente segue ao vivo", async () => {
    await db.exec(`INSERT INTO wacrm.messages (account_id, sender_type) VALUES ('${ACC}', 'agent')`);
    expect(((await call("admin")) as unknown as Ratio).messagesRatio.total).toBe(3);
    expect(((await call("agent")) as unknown as Ratio).messagesRatio.total).toBe(0);
  });

  it("resumo velho (> 30 min) cai no ao vivo com o número novo; o refresh recalcula", async () => {
    await db.exec(`UPDATE wacrm.dashboard_ai_snapshot SET refreshed_at = now() - interval '31 minutes'`);
    expect(((await call("admin")) as unknown as Ratio).messagesRatio.total).toBe(4);
    expect((await db.query<{ n: number }>(`SELECT wacrm.refresh_dashboard_ai_snapshots() AS n`)).rows[0].n).toBe(1);
    expect(((await call("admin")) as unknown as Ratio).messagesRatio.total).toBe(4);
  });

  it("a tabela do resumo e as funções de escrita NÃO são acessíveis ao navegador", async () => {
    await expect(asUser(db, "admin", `SELECT * FROM wacrm.dashboard_ai_snapshot`)).rejects.toThrow(/permission denied/);
    await expect(asUser(db, "admin", `SELECT wacrm.refresh_dashboard_ai_snapshots()`)).rejects.toThrow(/permission denied/);
    await expect(asUser(db, "admin", `SELECT wacrm.dashboard_ai_compute('${ACC}')`)).rejects.toThrow(/permission denied/);
  });

  it("idempotente; ROLLBACK do cabeçalho devolve a função original com o mesmo resultado; reaplicar funciona", async () => {
    await db.exec(migration("375_dashboard_ai_snapshot.sql"));
    await db.exec(headerRollback("375_dashboard_ai_snapshot.sql"));
    expect((await db.query(`SELECT to_regclass('wacrm.dashboard_ai_snapshot') AS t`)).rows[0]).toEqual({ t: null });
    expect(((await call("admin")) as unknown as Ratio).messagesRatio.total).toBe(4);
    await db.exec(migration("375_dashboard_ai_snapshot.sql"));
    expect((await db.query(`SELECT to_regprocedure('wacrm.dashboard_ai_analytics_live()') IS NOT NULL AS ok`)).rows[0]).toEqual({ ok: true });
  });
});
