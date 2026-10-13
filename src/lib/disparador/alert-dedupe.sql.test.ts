import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";

// Migration 337: claim_alert_slot reserva o aviso 1 vez por (conta, chave, hora).
let db: PGlite;
const A = "00000000-0000-0000-0000-0000000000a1";
const B = "00000000-0000-0000-0000-0000000000b1";

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA wacrm;
    CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY);
    INSERT INTO wacrm.accounts VALUES ('${A}'), ('${B}');
  `);
  const sql = readFileSync(resolve("supabase/migrations/337_ops_alert_dedupe.sql"), "utf8");
  await db.exec(sql);
  await db.exec(sql); // idempotente
}, 60_000);

afterAll(async () => {
  await db?.close();
});

const claim = async (acc: string, key: string, bucket: string) =>
  (await db.query<{ ok: boolean }>(`SELECT wacrm.claim_alert_slot('${acc}', '${key}', '${bucket}'::timestamptz) AS ok`)).rows[0].ok;

it("o 1º da hora passa e o repetido da mesma hora é descartado", async () => {
  expect(await claim(A, "campaign.auto_paused:c1", "2026-10-13T12:00:00Z")).toBe(true);
  expect(await claim(A, "campaign.auto_paused:c1", "2026-10-13T12:00:00Z")).toBe(false);
});

it("outra hora, outra campanha/número e outra conta têm o próprio aviso", async () => {
  expect(await claim(A, "campaign.auto_paused:c1", "2026-10-13T13:00:00Z")).toBe(true);
  expect(await claim(A, "campaign.auto_paused:c2", "2026-10-13T12:00:00Z")).toBe(true);
  expect(await claim(B, "campaign.auto_paused:c1", "2026-10-13T12:00:00Z")).toBe(true);
});

it("argumento nulo não reserva", async () => {
  const r = await db.query<{ ok: boolean }>(`SELECT wacrm.claim_alert_slot('${A}', NULL, now()) AS ok`);
  expect(r.rows[0].ok).toBe(false);
});

it("linhas com mais de 2 dias são limpas na própria reserva", async () => {
  await db.exec(`INSERT INTO wacrm.alert_dedupe (account_id, alert_key, bucket, created_at) VALUES ('${A}', 'velho', now(), now() - interval '3 days')`);
  await claim(A, "limpeza", "2026-10-13T14:00:00Z");
  const r = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM wacrm.alert_dedupe WHERE alert_key = 'velho'`);
  expect(r.rows[0].n).toBe(0);
});

it("tabela fechada: authenticated/anon não leem nem chamam a função", async () => {
  await expect(db.exec(`SET ROLE authenticated; SELECT * FROM wacrm.alert_dedupe`)).rejects.toThrow();
  await db.exec("RESET ROLE");
  await expect(db.exec(`SET ROLE anon; SELECT wacrm.claim_alert_slot('${A}', 'x', now())`)).rejects.toThrow();
  await db.exec("RESET ROLE");
});
