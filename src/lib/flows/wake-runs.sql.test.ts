// Migration 210: wakeable_flow_runs (PGlite com a 210 real). Ordem por wake_at, só vencidos, claim atômico dos
// válidos, inválidos NÃO reivindicados (voltam com `problem`), limite do lote e idempotência da reivindicação.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let db: PGlite;
const uid = (n: number) => `00000000-0000-0000-0000-${String(1000 + n).padStart(12, "0")}`;
const FLOW = "00000000-0000-0000-0000-00000000f001";
type Out = { run: Record<string, unknown>; next_node_key: string | null; problem: string | null };
const wake = async (limit = 50) => (await db.query<Out>("SELECT run, next_node_key, problem FROM wacrm.wakeable_flow_runs($1)", [limit])).rows;
const status = async (n: number) => (await db.query<{ status: string; wake_at: string | null }>("SELECT status, wake_at FROM wacrm.flow_runs WHERE id=$1", [uid(n)])).rows[0];

async function addRun(n: number, over: { wake: string; node?: string | null; status?: string }) {
  await db.query(
    "INSERT INTO wacrm.flow_runs(id, flow_id, status, wake_at, current_node_key) VALUES ($1,$2,$3,now() + $4::interval,$5)",
    [uid(n), FLOW, over.status ?? "delayed", over.wake, over.node === undefined ? "espera" : over.node],
  );
}

describe("migration 210 — wakeable_flow_runs", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA wacrm;
      CREATE TABLE wacrm.flow_runs (id uuid PRIMARY KEY, flow_id uuid, account_id uuid, status text, wake_at timestamptz, current_node_key text, last_advanced_at timestamptz DEFAULT now());
      CREATE TABLE wacrm.flow_nodes (flow_id uuid, node_key text, node_type text, config jsonb);
    `);
    await db.exec(readFileSync(resolve(process.cwd(), "supabase/migrations/210_wakeable_flow_runs.sql"), "utf8").replace(/NOTIFY pgrst[^;]*;/g, ""));
    await db.query(
      "INSERT INTO wacrm.flow_nodes VALUES ($1,'espera','smart_delay',$2::jsonb), ($1,'sem_next','smart_delay','{}'::jsonb)",
      [FLOW, JSON.stringify({ next_node_key: "proximo" })],
    );
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.exec("TRUNCATE wacrm.flow_runs");
  });

  it("devolve só os vencidos, em ordem de wake_at, e reivindica (active, wake_at nulo)", async () => {
    await addRun(1, { wake: "-10 minutes" });
    await addRun(2, { wake: "-3 hours" });
    await addRun(3, { wake: "+1 hour" }); // ainda não venceu
    await addRun(4, { wake: "-1 hour", status: "active" }); // não é delayed
    const rows = await wake();
    expect(rows.map((r) => r.run.id)).toEqual([uid(2), uid(1)]);
    expect(rows.every((r) => r.next_node_key === "proximo" && r.problem === null)).toBe(true);
    expect(rows[0].run).toMatchObject({ status: "active", wake_at: null });
    expect(await status(2)).toMatchObject({ status: "active", wake_at: null });
    expect((await status(3)).status).toBe("delayed");
    // segunda chamada: nada a acordar (já reivindicados) — dois crons não acordam o mesmo run
    expect(await wake()).toEqual([]);
  });

  it("inconsistentes NÃO são reivindicados e voltam com o problema; os válidos seguem", async () => {
    await addRun(1, { wake: "-3 hours", node: null });
    await addRun(2, { wake: "-2 hours", node: "nao_existe" });
    await addRun(3, { wake: "-90 minutes", node: "sem_next" });
    await addRun(4, { wake: "-1 hour" });
    const rows = await wake();
    expect(rows.map((r) => [r.run.id, r.problem])).toEqual([
      [uid(1), "no_current_node"],
      [uid(2), "node_missing"],
      [uid(3), "no_next_node"],
      [uid(4), null],
    ]);
    expect((await status(1)).status).toBe("delayed"); // intocados: o app encerra de forma controlada
    expect((await status(4)).status).toBe("active");
  });

  it("respeita o limite do lote (os mais antigos primeiro)", async () => {
    for (let i = 1; i <= 5; i++) await addRun(i, { wake: `-${i} hours` });
    expect((await wake(2)).map((r) => r.run.id)).toEqual([uid(5), uid(4)]);
    expect((await wake(100)).map((r) => r.run.id)).toEqual([uid(3), uid(2), uid(1)]);
  });
});
