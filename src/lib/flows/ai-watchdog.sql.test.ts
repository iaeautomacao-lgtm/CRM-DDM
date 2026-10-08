// Migration 211: stalled_ai_conversations (PGlite com a 211 real). O critério é o MESMO de antes (só muda onde o
// filtro roda): comparamos a RPC com o filtro antigo — limit(50) das mais antigas + heartbeat, resposta, run ativo e
// tipo de nó por candidata — traduzido fielmente para SQL, numa massa variada. E mostramos o ganho: com >50 conversas
// que nunca serão tratadas ocupando as vagas, o filtro antigo não vê as travadas mais novas; a RPC vê.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AI_HEARTBEAT_FRESH_MS, isAiHeartbeatFresh } from "@/lib/ai/heartbeat";
import { stallWindow } from "./ai-watchdog";

let db: PGlite;
const now = new Date("2026-10-08T20:00:00Z");
const win = stallWindow(now);
const ago = (s: number) => new Date(now.getTime() - s * 1000).toISOString();
const uid = (prefix: string, n: number) => `${prefix}0000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const FLOW = "f0000000-0000-0000-0000-000000000001";
const ACC = "a0000000-0000-0000-0000-000000000001";

type Pair = { conversation_id: string; run_id: string };

async function viaRpc(limit = 50): Promise<Pair[]> {
  const heartbeatAfter = new Date(now.getTime() - AI_HEARTBEAT_FRESH_MS).toISOString();
  const res = await db.query<Pair>(
    "SELECT conversation_id, run_id FROM wacrm.stalled_ai_conversations($1::timestamptz,$2::timestamptz,$3::timestamptz,$4)",
    [win.stalledBefore, win.notOlderThan, heartbeatAfter, limit],
  );
  return res.rows;
}

/** O vigia ANTIGO (ai-watchdog.ts antes da 211), consulta por consulta. */
async function legacy(): Promise<Pair[]> {
  const convs = await db.query<{ id: string; last_customer_message_at: Date; ai_in_progress_at: Date | null }>(
    `SELECT id, last_customer_message_at, ai_in_progress_at
       FROM wacrm.conversations
      WHERE status = 'open' AND assigned_agent_id IS NULL AND last_customer_message_at < $1 AND last_customer_message_at > $2
      ORDER BY last_customer_message_at ASC, id LIMIT 50`,
    [win.stalledBefore, win.notOlderThan],
  );
  const out: Pair[] = [];
  for (const conv of convs.rows) {
    if (isAiHeartbeatFresh(conv.ai_in_progress_at ? conv.ai_in_progress_at.toISOString() : null, now)) continue;
    const replies = await db.query(
      "SELECT 1 FROM wacrm.messages WHERE conversation_id = $1 AND sender_type <> 'customer' AND created_at > $2::timestamptz LIMIT 1",
      [conv.id, conv.last_customer_message_at.toISOString()],
    );
    if (replies.rows.length > 0) continue;
    const runs = await db.query<{ id: string; flow_id: string; current_node_key: string | null }>(
      "SELECT id, flow_id, current_node_key FROM wacrm.flow_runs WHERE conversation_id = $1 AND status = 'active' ORDER BY id LIMIT 1",
      [conv.id],
    );
    const run = runs.rows[0];
    if (!run || !run.current_node_key) continue;
    const node = await db.query<{ node_type: string }>("SELECT node_type FROM wacrm.flow_nodes WHERE flow_id = $1 AND node_key = $2 LIMIT 1", [run.flow_id, run.current_node_key]);
    if (node.rows[0]?.node_type !== "ai_agent") continue;
    out.push({ conversation_id: conv.id, run_id: run.id });
  }
  return out;
}

interface Seed {
  n: number;
  status?: string;
  agent?: string | null;
  age?: number;
  heartbeat?: number | null;
  reply?: "none" | "bot" | "agent" | "customer" | "before";
  run?: "ai" | "buttons" | "nullnode" | "completed" | "none" | "nonode";
}

async function seed(s: Seed) {
  const id = uid("c", s.n);
  const age = s.age ?? 200;
  await db.query(
    "INSERT INTO wacrm.conversations(id, account_id, status, assigned_agent_id, last_customer_message_at, ai_in_progress_at) VALUES ($1,$2,$3,$4,$5,$6)",
    [id, ACC, s.status ?? "open", s.agent ?? null, ago(age), s.heartbeat == null ? null : ago(s.heartbeat)],
  );
  await db.query("INSERT INTO wacrm.messages(id, conversation_id, sender_type, created_at) VALUES ($1,$2,'customer',$3)", [uid("b", s.n), id, ago(age)]);
  const reply = s.reply ?? "none";
  if (reply === "bot" || reply === "agent") await db.query("INSERT INTO wacrm.messages(id, conversation_id, sender_type, created_at) VALUES ($1,$2,$3,$4)", [uid("d", s.n), id, reply, ago(Math.max(age - 30, 1))]);
  if (reply === "customer") await db.query("INSERT INTO wacrm.messages(id, conversation_id, sender_type, created_at) VALUES ($1,$2,'customer',$3)", [uid("d", s.n), id, ago(Math.max(age - 30, 1))]);
  if (reply === "before") await db.query("INSERT INTO wacrm.messages(id, conversation_id, sender_type, created_at) VALUES ($1,$2,'bot',$3)", [uid("d", s.n), id, ago(age + 500)]);
  const run = s.run ?? "ai";
  if (run !== "none") {
    const node = run === "ai" ? "agente_ddm" : run === "buttons" ? "menu" : run === "nullnode" ? null : run === "nonode" ? "apagado" : "agente_ddm";
    await db.query("INSERT INTO wacrm.flow_runs(id, flow_id, conversation_id, status, current_node_key) VALUES ($1,$2,$3,$4,$5)", [uid("e", s.n), FLOW, id, run === "completed" ? "completed" : "active", node]);
  }
}

describe("migration 211 — stalled_ai_conversations", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA wacrm;
      CREATE TABLE wacrm.conversations (id uuid PRIMARY KEY, account_id uuid, status text, assigned_agent_id uuid, last_customer_message_at timestamptz, ai_in_progress_at timestamptz);
      CREATE TABLE wacrm.messages (id uuid PRIMARY KEY, conversation_id uuid, sender_type text, created_at timestamptz);
      CREATE TABLE wacrm.flow_runs (id uuid PRIMARY KEY, flow_id uuid, conversation_id uuid, status text, current_node_key text);
      CREATE TABLE wacrm.flow_nodes (flow_id uuid, node_key text, node_type text);
    `);
    await db.exec(readFileSync(resolve(process.cwd(), "supabase/migrations/211_stalled_ai_conversations.sql"), "utf8").replace(/NOTIFY pgrst[^;]*;/g, ""));
    await db.exec(`INSERT INTO wacrm.flow_nodes VALUES ('${FLOW}','agente_ddm','ai_agent'), ('${FLOW}','menu','send_buttons')`);
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.exec("TRUNCATE wacrm.conversations, wacrm.messages, wacrm.flow_runs");
  });

  it("equivalência com o filtro antigo numa massa variada (todas as combinações dos critérios)", async () => {
    // Listas com repetição = pesos (favorecem o caminho "transfere" para a massa realmente exercitá-lo).
    const statuses = ["open", "open", "open", "pending"];
    const agents = [null, null, null, "99999999-0000-0000-0000-000000000001"];
    const ages = [200, 900, 200, 900, 100, 5000]; // dentro do prazo / travada / travada / velha demais (> 30 min)
    const heartbeats = [null, null, 130, 40];
    const replies: NonNullable<Seed["reply"]>[] = ["none", "none", "customer", "before", "bot", "agent"];
    const runs: NonNullable<Seed["run"]>[] = ["ai", "ai", "ai", "buttons", "nullnode", "completed", "none", "nonode"];
    // Muitas combinações (> 50): sorteia 45 por rodada com LCG determinístico e repete várias rodadas.
    let state = 12345;
    const next = (m: number) => ((state = (state * 1664525 + 1013904223) % 4294967296), state % m);
    let compared = 0;
    let nonEmpty = 0;
    for (let round = 0; round < 25; round++) {
      await db.exec("TRUNCATE wacrm.conversations, wacrm.messages, wacrm.flow_runs");
      for (let n = 1; n <= 45; n++) {
        await seed({
          n,
          status: statuses[next(4)],
          agent: agents[next(4)],
          age: ages[next(6)] + next(7), // evita empates exatos de horário
          heartbeat: heartbeats[next(4)],
          reply: replies[next(6)],
          run: runs[next(8)],
        });
      }
      const [oldWay, newWay] = [await legacy(), await viaRpc()];
      expect(newWay.map((r) => [r.conversation_id, r.run_id])).toEqual(oldWay.map((r) => [r.conversation_id, r.run_id]));
      compared += oldWay.length;
      if (oldWay.length > 0) nonEmpty++;
    }
    expect(nonEmpty).toBeGreaterThan(8); // a massa realmente exercita o caminho "transfere"
    expect(compared).toBeGreaterThan(15);
  });

  it("casos limite: heartbeat exatamente em 120 s é velho; resposta no mesmo instante não conta; limite de prazo é exclusivo", async () => {
    await seed({ n: 1, heartbeat: 120 }); // now - t == 120 s: não é fresco (fresco = < 120 s)
    await seed({ n: 2, heartbeat: 119 }); // fresco
    await seed({ n: 3, age: 180 }); // exatamente no limite: last < stalledBefore é falso
    await seed({ n: 4, age: 1800 }); // exatamente 30 min: last > notOlderThan é falso
    expect((await viaRpc()).map((r) => r.conversation_id)).toEqual([uid("c", 1)]);
    expect((await legacy()).map((r) => r.conversation_id)).toEqual([uid("c", 1)]);
  });

  it("o GANHO: 60 conversas que nunca serão tratadas ocupam as vagas do filtro antigo; a RPC acha a travada mais nova", async () => {
    for (let n = 1; n <= 60; n++) await seed({ n, age: 1500 + n, run: "buttons" }); // antigas, run em botões (nunca tratadas)
    await seed({ n: 100, age: 200, run: "ai" }); // travada de verdade, mais nova
    expect(await legacy()).toEqual([]); // as 50 vagas foram para as 'buttons' — a travada nunca entra
    const found = await viaRpc();
    expect(found.map((r) => r.conversation_id)).toEqual([uid("c", 100)]);
  });

  it("ordena pelas mais antigas e respeita o limite (teto 200)", async () => {
    for (let n = 1; n <= 5; n++) await seed({ n, age: 200 + n * 10 });
    expect((await viaRpc(3)).map((r) => r.conversation_id)).toEqual([uid("c", 5), uid("c", 4), uid("c", 3)]);
    expect((await viaRpc(1000)).length).toBe(5);
  });

  it("grants: só service_role executa", async () => {
    const res = await db.query<{ anon: boolean; svc: boolean }>(
      `SELECT has_function_privilege('anon','wacrm.stalled_ai_conversations(timestamptz,timestamptz,timestamptz,integer)','EXECUTE') AS anon,
              has_function_privilege('service_role','wacrm.stalled_ai_conversations(timestamptz,timestamptz,timestamptz,integer)','EXECUTE') AS svc`,
    );
    expect(res.rows[0]).toEqual({ anon: false, svc: true });
  });
});
