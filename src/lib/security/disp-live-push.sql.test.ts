// Migration 364: delta do disparador empurrado pelo Realtime (canal privado por conta), policy só admin+ e presença fora da publication.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";

import { ACC, ACC_B, SYSTEM, asUser, createRolesDb, headerRollback, id, migration } from "./rls-fixture";

const C1 = id(801);
const C2 = id(802);
const CB = id(803);

describe("migration 364 — acompanhamento do disparador por Realtime", { timeout: 180_000 }, () => {
  let db: PGlite;
  const sent = async () => (await db.query<{ topic: string; event: string; payload: Record<string, unknown> }>(`SELECT topic, event, payload FROM realtime.sent ORDER BY n`)).rows;

  beforeAll(async () => {
    db = await createRolesDb();
    await db.exec(`
      CREATE SCHEMA realtime;
      CREATE TABLE realtime.messages (id bigserial PRIMARY KEY, topic text, extension text);
      CREATE TABLE realtime.sent (n bigserial PRIMARY KEY, topic text, event text, payload jsonb);
      CREATE FUNCTION realtime.topic() RETURNS text LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.topic', true), '') $$;
      CREATE FUNCTION realtime.send(payload jsonb, event text, topic text, private boolean DEFAULT true) RETURNS void LANGUAGE plpgsql AS $$
      BEGIN
        IF current_setting('test.send_fails', true) = 'on' THEN RAISE EXCEPTION 'realtime fora do ar'; END IF;
        INSERT INTO realtime.sent (topic, event, payload) VALUES (topic, event, payload);
        INSERT INTO realtime.messages (topic, extension) VALUES (topic, 'broadcast');
      END $$;
      ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
      GRANT USAGE ON SCHEMA realtime TO authenticated; GRANT SELECT ON realtime.messages TO authenticated; GRANT EXECUTE ON FUNCTION realtime.topic() TO authenticated;
      CREATE TABLE wacrm.campaigns (id uuid PRIMARY KEY, account_id uuid NOT NULL);
      CREATE TABLE wacrm.campaign_metric_deltas (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, campaign_id uuid NOT NULL, field text NOT NULL, n integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE wacrm.member_presence (user_id uuid PRIMARY KEY, account_id uuid);
      CREATE PUBLICATION supabase_realtime FOR TABLE wacrm.member_presence;
      INSERT INTO wacrm.campaigns VALUES ('${C1}', '${ACC}'), ('${C2}', '${ACC}'), ('${CB}', '${ACC_B}');
    `);
    await db.exec(migration("364_disp_live_push.sql"));
  }, 120_000);
  afterAll(async () => {
    await db.close();
  });

  it("um comando com vários deltas publica UMA mensagem por conta, agregada por campanha e campo", async () => {
    await db.exec(`INSERT INTO wacrm.campaign_metric_deltas (campaign_id, field, n) VALUES
      ('${C1}', 'total_enviados', 1), ('${C1}', 'total_enviados', 1), ('${C1}', 'total_erros', 1), ('${C2}', 'total_lidos', 3), ('${CB}', 'total_enviados', 1)`);
    const rows = await sent();
    expect(rows).toHaveLength(2);
    const a = rows.find((r) => r.topic === `disp:${ACC}`)!;
    expect(a.event).toBe("delta");
    expect((a.payload as { campaigns: unknown }).campaigns).toEqual({ [C1]: { total_enviados: 2, total_erros: 1 }, [C2]: { total_lidos: 3 } });
    expect(typeof (a.payload as { ts: unknown }).ts).toBe("string");
    expect((rows.find((r) => r.topic === `disp:${ACC_B}`)!.payload as { campaigns: unknown }).campaigns).toEqual({ [CB]: { total_enviados: 1 } });
  });

  it("campanha apagada (sem conta) não publica; e falha do Realtime NÃO derruba o INSERT do delta", async () => {
    const antes = (await sent()).length;
    await db.exec(`INSERT INTO wacrm.campaign_metric_deltas (campaign_id, field) VALUES ('${id(899)}', 'total_enviados')`);
    expect(await sent()).toHaveLength(antes);
    await db.exec(`SELECT set_config('test.send_fails', 'on', false)`);
    await db.exec(`INSERT INTO wacrm.campaign_metric_deltas (campaign_id, field) VALUES ('${C1}', 'total_enviados')`);
    await db.exec(`SELECT set_config('test.send_fails', 'off', false)`);
    expect((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM wacrm.campaign_metric_deltas WHERE campaign_id = '${C1}'`)).rows[0].n).toBe(4);
  });

  const canReceive = async (who: string, topic: string) => {
    await db.exec(`SELECT set_config('test.topic', '${topic}', false)`);
    try {
      return (await asUser<{ n: number }>(db, who, `SELECT count(*)::int AS n FROM realtime.messages WHERE topic = '${topic}'`))[0].n > 0;
    } finally {
      await db.exec(`SELECT set_config('test.topic', '', false)`);
    }
  };

  it("canal da conta: owner e admin recebem; supervisor, agente, visualizador e outra conta NÃO; tópico malformado nunca", async () => {
    const topic = `disp:${ACC}`;
    const got: Record<string, boolean> = {};
    for (const who of [...SYSTEM, "other"]) got[who] = await canReceive(who, topic);
    expect(got).toEqual({ owner: true, admin: true, supervisor: false, agent: false, viewer: false, agent2: false, other: false });
    await db.exec(`INSERT INTO realtime.messages (topic, extension) VALUES ('disp:lixo', 'broadcast'), ('outro:${ACC}', 'broadcast')`);
    expect(await canReceive("owner", "disp:lixo")).toBe(false);
    expect(await canReceive("owner", `outro:${ACC}`)).toBe(false);
  });

  it("presença saiu da publication; idempotente", async () => {
    const pub = async () => (await db.query(`SELECT tablename FROM pg_publication_tables WHERE pubname = 'supabase_realtime'`)).rows;
    expect(await pub()).toEqual([]);
    await db.exec(migration("364_disp_live_push.sql"));
    expect(await pub()).toEqual([]);
  });

  it("ROLLBACK do cabeçalho é SQL executável: tira trigger, função e policy e devolve a presença à publication; reaplicar funciona", async () => {
    await db.exec(headerRollback("364_disp_live_push.sql"));
    expect((await db.query(`SELECT tgname FROM pg_trigger WHERE tgname = 'campaign_metric_deltas_live_push'`)).rows).toEqual([]);
    expect((await db.query(`SELECT policyname FROM pg_policies WHERE tablename = 'messages' AND schemaname = 'realtime'`)).rows).toEqual([]);
    expect((await db.query(`SELECT tablename FROM pg_publication_tables WHERE pubname = 'supabase_realtime'`)).rows).toEqual([{ tablename: "member_presence" }]);
    await db.exec(migration("364_disp_live_push.sql"));
    expect((await db.query(`SELECT tgname FROM pg_trigger WHERE tgname = 'campaign_metric_deltas_live_push'`)).rows).toHaveLength(1);
  });
});
