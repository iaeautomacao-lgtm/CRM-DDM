// Migration 381: wacrm.teams.first_response_sla_min (1..1440, NULL = padrão). PGlite: CHECK, idempotência, rollback do cabeçalho, pré-check.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";

import { ACC, T1, createRolesDb, headerRollback, migration } from "@/lib/security/rls-fixture";

describe("migration 381 — SLA de primeira resposta por equipe", { timeout: 180_000 }, () => {
  let db: PGlite;
  const sla = async () => (await db.query<{ v: number | null }>(`SELECT first_response_sla_min AS v FROM wacrm.teams WHERE id = $1`, [T1])).rows[0].v;
  const set = (v: number | null) => db.query(`UPDATE wacrm.teams SET first_response_sla_min = $2 WHERE id = $1`, [T1, v]);

  beforeAll(async () => {
    db = await createRolesDb();
  }, 120_000);
  afterAll(async () => {
    await db.close();
  });

  it("pré-check: sem wacrm.teams a migration aborta sem alterar nada", async () => {
    const empty = new (await import("@electric-sql/pglite")).PGlite();
    await empty.exec(`CREATE SCHEMA wacrm;`);
    await expect(empty.exec(migration("381_teams_first_response_sla.sql"))).rejects.toThrow(/falta wacrm\.teams/);
    await empty.close();
  });

  it("cria a coluna nula (equipes existentes seguem no padrão) e a faixa 1..1440 vale no banco", async () => {
    await db.exec(migration("381_teams_first_response_sla.sql"));
    expect(await sla()).toBeNull();
    for (const ok of [1, 15, 1440, null]) {
      await set(ok);
      expect(await sla()).toBe(ok);
    }
    for (const bad of [0, -5, 1441]) await expect(set(bad)).rejects.toThrow(/teams_first_response_sla_range|check/i);
    expect(await sla()).toBeNull();
  });

  it("idempotente, registra a versão e não toca nos demais dados da equipe", async () => {
    await set(30);
    await db.exec(migration("381_teams_first_response_sla.sql"));
    expect(await sla()).toBe(30);
    expect((await db.query(`SELECT 1 FROM wacrm.schema_migrations WHERE version = '381_teams_first_response_sla'`)).rows).toHaveLength(1);
    expect((await db.query(`SELECT 1 FROM wacrm.teams WHERE id = $1 AND account_id = $2`, [T1, ACC])).rows).toHaveLength(1);
  });

  it("rollback do cabeçalho remove coluna, constraint e registro", async () => {
    await db.exec(headerRollback("381_teams_first_response_sla.sql"));
    const col = await db.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'wacrm' AND table_name = 'teams' AND column_name = 'first_response_sla_min'`);
    expect(col.rows).toHaveLength(0);
    const con = await db.query(`SELECT 1 FROM pg_constraint WHERE conname = 'teams_first_response_sla_range'`);
    expect(con.rows).toHaveLength(0);
    expect((await db.query(`SELECT 1 FROM wacrm.schema_migrations WHERE version = '381_teams_first_response_sla'`)).rows).toHaveLength(0);
    expect((await db.query(`SELECT 1 FROM wacrm.teams WHERE id = $1`, [T1])).rows).toHaveLength(1);
  });
});
