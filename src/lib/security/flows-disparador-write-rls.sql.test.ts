// Migration 349 (RLS fase 3, escrita): fluxos, automações, envios em lote, fila e métricas só pelo servidor (REVOKE); blacklist, templates e UTM do disparador por permissão.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";

import { ACC, ACC_B, SYSTEM, U, asUser, createRolesDb, headerRollback, id, migration } from "./rls-fixture";
import { writeSnapshot, type WriteProbe, type WriteSnap } from "./rls-write-fixture";

const R = (n: number) => id(800 + n);
const P = (table: string, n: number, cols: string, vals: string, upd: string, key = "id"): WriteProbe => ({
  table,
  insert: `INSERT INTO wacrm.${table} (${cols}) VALUES (${vals})`,
  update: `UPDATE wacrm.${table} SET ${upd} WHERE ${key} = '${R(n)}' RETURNING 1`,
  delete: `DELETE FROM wacrm.${table} WHERE ${key} = '${R(n)}' RETURNING 1`,
});

// tabelas que o navegador não grava (viram só-servidor) e as que ele grava (viram por permissão)
const SERVER_ONLY: WriteProbe[] = [
  P("flows", 1, "account_id, name", `'${ACC}', 'n'`, "name = 'x'"),
  P("flow_nodes", 2, "flow_id, kind", `'${R(1)}', 'n'`, "kind = 'x'"),
  P("automations", 3, "account_id, name", `'${ACC}', 'n'`, "name = 'x'"),
  P("automation_steps", 4, "automation_id, kind", `'${R(3)}', 'n'`, "kind = 'x'"),
  P("broadcasts", 5, "account_id, name", `'${ACC}', 'n'`, "name = 'x'"),
  P("broadcast_recipients", 6, "broadcast_id, status", `'${R(5)}', 'n'`, "status = 'x'"),
  P("disp_message_queue", 7, "account_id, status", `'${ACC}', 'n'`, "status = 'x'"),
  P("campaign_metrics", 8, "account_id, name", `'${ACC}', 'n'`, "name = 'x'"),
];
const BROWSER: WriteProbe[] = [
  P("blacklist", 9, "account_id, phone", `'${ACC}', '5511'`, "phone = 'x'"),
  P("disparador_message_templates", 10, "account_id, name", `'${ACC}', 'n'`, "name = 'x'"),
  P("disparador_utm_links", 11, "account_id, url", `'${ACC}', 'u'`, "url = 'x'"),
];
const ALL = [...SERVER_ONLY, ...BROWSER];
const only = (s: WriteSnap, tables: string[]) => Object.entries(s).filter(([k]) => tables.includes(k.split(".")[0]));
const names = (ps: WriteProbe[]) => ps.map((p) => p.table);

describe("migration 349 — fluxos/disparador: só servidor ou por permissão", { timeout: 300_000 }, () => {
  let db: PGlite;
  const before: Record<string, WriteSnap> = {};
  const after: Record<string, WriteSnap> = {};
  const readBefore: Record<string, string[]> = {};
  const readAfter: Record<string, string[]> = {};
  const everyone = () => [...SYSTEM, "other", "soCamp", "soTpl", "soView"];
  const reads = async (who: string) => {
    const out: string[] = [];
    for (const t of names(ALL)) out.push(`${t}:${(await asUser<{ k: string }>(db, who, `SELECT id::text AS k FROM wacrm.${t}`)).length}`);
    return out;
  };

  beforeAll(async () => {
    db = await createRolesDb([
      { who: "soCamp", compat: "viewer", permissions: ["campaigns.manage"] },
      { who: "soTpl", compat: "viewer", permissions: ["templates.manage"] },
      { who: "soView", compat: "admin", permissions: ["contacts.view"] },
    ]);
    const mk = (t: string, cols: string) => `CREATE TABLE wacrm.${t} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ${cols});`;
    await db.exec(`
      ${mk("flows", "account_id uuid NOT NULL, name text")} ${mk("flow_nodes", "flow_id uuid, kind text")}
      ${mk("automations", "account_id uuid NOT NULL, name text")} ${mk("automation_steps", "automation_id uuid, kind text")}
      ${mk("broadcasts", "account_id uuid NOT NULL, name text")} ${mk("broadcast_recipients", "broadcast_id uuid, status text")}
      ${mk("disp_message_queue", "account_id uuid NOT NULL, status text")} ${mk("campaign_metrics", "account_id uuid NOT NULL, name text")}
      ${mk("blacklist", "account_id uuid NOT NULL, phone text")} ${mk("disparador_message_templates", "account_id uuid NOT NULL, name text")}
      ${mk("disparador_utm_links", "account_id uuid NOT NULL, url text")}
      GRANT SELECT, INSERT, UPDATE, DELETE ON wacrm.flows, wacrm.flow_nodes, wacrm.automations, wacrm.automation_steps, wacrm.broadcasts, wacrm.broadcast_recipients, wacrm.disp_message_queue, wacrm.campaign_metrics, wacrm.blacklist, wacrm.disparador_message_templates, wacrm.disparador_utm_links TO authenticated;
    `);
    for (const t of names(ALL)) await db.exec(`ALTER TABLE wacrm.${t} ENABLE ROW LEVEL SECURITY;`);
    const w = (t: string, ins = "agent") =>
      `CREATE POLICY ${t}_select ON wacrm.${t} FOR SELECT USING (wacrm.is_account_member(account_id));
       CREATE POLICY ${t}_insert ON wacrm.${t} FOR INSERT WITH CHECK (wacrm.is_account_member(account_id, '${ins}'));
       CREATE POLICY ${t}_update ON wacrm.${t} FOR UPDATE USING (wacrm.is_account_member(account_id, '${ins}'));
       CREATE POLICY ${t}_delete ON wacrm.${t} FOR DELETE USING (wacrm.is_account_member(account_id, '${ins}'));`;
    const child = (t: string, parent: string, fk: string) =>
      `CREATE POLICY ${t}_select ON wacrm.${t} FOR SELECT USING (EXISTS (SELECT 1 FROM wacrm.${parent} p WHERE p.id = ${t}.${fk} AND wacrm.is_account_member(p.account_id)));
       CREATE POLICY ${t}_modify ON wacrm.${t} FOR ALL USING (EXISTS (SELECT 1 FROM wacrm.${parent} p WHERE p.id = ${t}.${fk} AND wacrm.is_account_member(p.account_id, 'agent'))) WITH CHECK (EXISTS (SELECT 1 FROM wacrm.${parent} p WHERE p.id = ${t}.${fk} AND wacrm.is_account_member(p.account_id, 'agent')));`;
    await db.exec(`
      ${w("flows")} ${child("flow_nodes", "flows", "flow_id")} ${w("automations")} ${child("automation_steps", "automations", "automation_id")}
      ${w("broadcasts")} ${child("broadcast_recipients", "broadcasts", "broadcast_id")} ${w("disp_message_queue")} ${w("campaign_metrics")}
      ${w("blacklist")} ${w("disparador_message_templates")}
      CREATE POLICY disparador_utm_links_all ON wacrm.disparador_utm_links FOR ALL TO authenticated USING (wacrm.is_account_member(account_id)) WITH CHECK (wacrm.is_account_member(account_id));
      INSERT INTO wacrm.flows (id, account_id) VALUES ('${R(1)}', '${ACC}'), ('${R(21)}', '${ACC_B}');
      INSERT INTO wacrm.flow_nodes (id, flow_id) VALUES ('${R(2)}', '${R(1)}');
      INSERT INTO wacrm.automations (id, account_id) VALUES ('${R(3)}', '${ACC}');
      INSERT INTO wacrm.automation_steps (id, automation_id) VALUES ('${R(4)}', '${R(3)}');
      INSERT INTO wacrm.broadcasts (id, account_id) VALUES ('${R(5)}', '${ACC}');
      INSERT INTO wacrm.broadcast_recipients (id, broadcast_id) VALUES ('${R(6)}', '${R(5)}');
      INSERT INTO wacrm.disp_message_queue (id, account_id) VALUES ('${R(7)}', '${ACC}');
      INSERT INTO wacrm.campaign_metrics (id, account_id) VALUES ('${R(8)}', '${ACC}');
      INSERT INTO wacrm.blacklist (id, account_id) VALUES ('${R(9)}', '${ACC}');
      INSERT INTO wacrm.disparador_message_templates (id, account_id) VALUES ('${R(10)}', '${ACC}');
      INSERT INTO wacrm.disparador_utm_links (id, account_id) VALUES ('${R(11)}', '${ACC}');
    `);
    for (const who of everyone()) {
      before[who] = await writeSnapshot(db, who, ALL);
      readBefore[who] = await reads(who);
    }

    await db.exec(`SET session_replication_role = replica; UPDATE wacrm.profiles SET role_id = NULL WHERE user_id = '${U.viewer}'; SET session_replication_role = DEFAULT;`);
    await expect(db.exec(migration("349_flows_disparador_write_rls.sql"))).rejects.toThrow(/sem role_id/);
    await db.exec("ROLLBACK");
    await db.exec(`SET session_replication_role = replica; UPDATE wacrm.profiles SET role_id = (SELECT id FROM wacrm.account_roles WHERE key = 'viewer' AND account_id IS NULL) WHERE user_id = '${U.viewer}'; SET session_replication_role = DEFAULT;`);

    await db.exec(migration("349_flows_disparador_write_rls.sql"));
    for (const who of everyone()) {
      after[who] = await writeSnapshot(db, who, ALL);
      readAfter[who] = await reads(who);
    }
  }, 280_000);
  afterAll(async () => {
    await db.close();
  }, 60_000);

  it("cenário de hoje: agent+ escreve tudo direto (inclusive fluxos e fila); o visualizador só escreve links UTM (policy FOR ALL por membro)", () => {
    expect(before.agent["flows.insert"]).toBe("ok");
    expect(before.agent["disp_message_queue.update"]).toBe("ok");
    expect(before.viewer["flows.insert"]).toBe("negado");
    expect(before.viewer["disparador_utm_links.insert"]).toBe("ok");
    expect(before.other["flows.update"]).toBe("negado");
  });

  it("tabelas que o navegador não grava: NINGUÉM escreve pelo PostgREST (todos os papéis, todas as operações)", () => {
    for (const who of everyone()) for (const [k, v] of only(after[who], names(SERVER_ONLY))) expect(v, `${who} ${k}`).toBe("negado");
  });

  it("LEITURA não muda para ninguém (as *_select continuam; as FOR ALL que também liam foram trocadas)", () => {
    for (const who of everyone()) expect(readAfter[who], `${who} leitura`).toEqual(readBefore[who]);
  });

  it("blacklist: admin, proprietário e supervisor escrevem (telas do disparador e do relatório); agent e visualizador não", () => {
    for (const who of ["owner", "admin", "supervisor"]) for (const [k, v] of only(after[who], ["blacklist"])) expect(v, `${who} ${k}`).toBe("ok");
    for (const who of ["agent", "agent2", "viewer", "other"]) for (const [k, v] of only(after[who], ["blacklist"])) expect(v, `${who} ${k}`).toBe("negado");
  });

  it("templates e UTM do disparador: admin e proprietário seguem escrevendo; supervisor, agent e visualizador não (o visualizador deixa de gravar UTM)", () => {
    for (const who of ["owner", "admin"]) for (const [k, v] of only(after[who], ["disparador_message_templates", "disparador_utm_links"])) expect(v, `${who} ${k}`).toBe("ok");
    for (const who of ["supervisor", "agent", "viewer", "other"]) for (const [k, v] of only(after[who], ["disparador_message_templates", "disparador_utm_links"])) expect(v, `${who} ${k}`).toBe("negado");
  });

  it("papel personalizado: campaigns.manage escreve blacklist, templates e UTM; templates.manage só templates; só leitura (mesmo com nível admin) não escreve", () => {
    for (const [k, v] of only(after.soCamp, names(BROWSER))) expect(v, `soCamp ${k}`).toBe("ok");
    for (const [k, v] of only(after.soTpl, ["disparador_message_templates"])) expect(v, `soTpl ${k}`).toBe("ok");
    for (const [k, v] of only(after.soTpl, ["blacklist", "disparador_utm_links"])) expect(v, `soTpl ${k}`).toBe("negado");
    for (const [k, v] of Object.entries(after.soView)) expect(v, `soView ${k}`).toBe("negado");
  });

  it("não sobra policy FOR ALL nas tabelas filhas nem nos UTM", async () => {
    const rows = (await db.query<{ policyname: string; cmd: string }>(`SELECT policyname, cmd FROM pg_policies WHERE schemaname = 'wacrm' AND cmd = 'ALL'`)).rows;
    expect(rows).toEqual([]);
  });

  it("ROLLBACK do cabeçalho é SQL executável: devolve EXATAMENTE a escrita e a leitura de antes (todos os usuários); reaplicar funciona", async () => {
    await db.exec(headerRollback("349_flows_disparador_write_rls.sql"));
    for (const who of everyone()) {
      expect(await writeSnapshot(db, who, ALL), `${who} depois do rollback`).toEqual(before[who]);
      expect(await reads(who), `${who} leitura depois do rollback`).toEqual(readBefore[who]);
    }
    expect((await db.query(`SELECT version FROM wacrm.schema_migrations WHERE version LIKE '349%'`)).rows).toEqual([]);
    await db.exec(migration("349_flows_disparador_write_rls.sql"));
    for (const who of everyone()) expect(await writeSnapshot(db, who, ALL), `${who} reaplicada`).toEqual(after[who]);
  });
});
