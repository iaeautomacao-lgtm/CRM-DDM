// Cron de fluxos — acordar runs `delayed` (PRD 13, IA-07/IA-08): run inconsistente não fica `active` preso,
// exceção num run não impede os outros, ordem por wake_at, lote/loop da V2 e flag desligada = caminho antigo.
import { beforeEach, describe, expect, it, vi } from "vitest";

const advance = vi.fn();
const loadNodes = vi.fn();
vi.mock("@/lib/flows/engine", () => ({
  advanceFromNodeKey: (...a: unknown[]) => advance(...a),
  loadAllNodes: (...a: unknown[]) => loadNodes(...a),
}));

import { flowsCronV2Enabled, wakeDelayedRuns, WAKE_LEGACY_LIMIT } from "./wake-runs";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
const NOW = new Date("2026-10-08T12:00:00Z");

/** Banco em memória mínimo: select/eq/lte/order/limit, update (guardado por filtros) e insert. */
function fakeDb(runs: Row[], rpc?: (fn: string, args: Row) => { data?: unknown; error?: { code?: string; message: string } | null }) {
  const events: Row[] = [];
  const rpcCalls: Array<{ fn: string; args: Row }> = [];
  const selects: Row[] = [];
  const db = {
    rpc: async (fn: string, args: Row) => {
      rpcCalls.push({ fn, args });
      return { data: null, error: null, ...(rpc?.(fn, args) ?? {}) };
    },
    from: (table: string) => {
      const filters: Array<[string, string, unknown]> = [];
      let order: { col: string; asc: boolean } | null = null;
      let limit = Infinity;
      let patch: Row | null = null;
      const b: any = {};
      b.select = () => b;
      b.eq = (c: string, v: unknown) => (filters.push(["eq", c, v]), b);
      b.lte = (c: string, v: unknown) => (filters.push(["lte", c, v]), b);
      b.order = (c: string, o?: { ascending?: boolean }) => ((order = { col: c, asc: o?.ascending !== false }), b);
      b.limit = (n: number) => ((limit = n), b);
      b.update = (p: Row) => ((patch = p), b);
      b.insert = async (row: Row) => (events.push(row), { error: null });
      b.then = (resolve: (v: unknown) => void) => {
        if (table !== "flow_runs") return resolve({ data: [], error: null });
        let rows = runs.filter((r) =>
          filters.every(([op, c, v]) => (op === "eq" ? r[c] === v : String(r[c]) <= String(v))),
        );
        if (order) rows = [...rows].sort((a, z) => (String(a[order!.col]) < String(z[order!.col]) ? -1 : 1) * (order!.asc ? 1 : -1));
        rows = rows.slice(0, limit);
        if (patch) {
          for (const r of rows) Object.assign(r, patch);
          return resolve({ data: rows.map((r) => ({ id: r.id })), error: null });
        }
        selects.push({ filters, order, limit });
        return resolve({ data: rows.map((r) => ({ ...r })), error: null });
      };
      return b;
    },
  };
  return { db, events, rpcCalls, selects };
}

const run = (id: string, over: Row = {}): Row => ({
  id,
  flow_id: "F1",
  account_id: "ACC",
  status: "delayed",
  wake_at: "2026-10-08T11:00:00Z",
  current_node_key: "espera",
  ...over,
});
const nodesWith = (next: string | null) => new Map([["espera", { config: { next_node_key: next } }]]);

beforeEach(() => {
  advance.mockReset();
  advance.mockResolvedValue({ outcome: "advanced" });
  loadNodes.mockReset();
  loadNodes.mockResolvedValue(nodesWith("proximo"));
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("wakeDelayedRuns — caminho padrão (FLOWS_CRON_V2 desligada)", () => {
  it("acorda na ordem de wake_at (mais antigo primeiro) e conta woken", async () => {
    const runs = [run("r3", { wake_at: "2026-10-08T11:30:00Z" }), run("r1", { wake_at: "2026-10-08T10:00:00Z" }), run("r2", { wake_at: "2026-10-08T11:00:00Z" })];
    const { db, selects } = fakeDb(runs);
    const summary = await wakeDelayedRuns(db, { now: NOW, v2: false });
    expect(summary).toEqual({ woken: 3, failed: 0, skipped: 0, path: "legacy" });
    expect(advance.mock.calls.map((c) => (c[1] as Row).id)).toEqual(["r1", "r2", "r3"]);
    expect(selects[0].order).toEqual({ col: "wake_at", asc: true });
    expect(selects[0].limit).toBe(WAKE_LEGACY_LIMIT);
    expect(advance.mock.calls[0][2]).toBe("proximo"); // retoma do next_node_key do smart_delay
    expect(advance.mock.calls[0][1]).toMatchObject({ status: "active", wake_at: null });
  });

  it("run sem current_node_key: encerrado de forma controlada, NÃO fica active; os outros seguem", async () => {
    const runs = [run("ruim", { current_node_key: null, wake_at: "2026-10-08T09:00:00Z" }), run("ok")];
    const { db, events } = fakeDb(runs);
    const summary = await wakeDelayedRuns(db, { now: NOW, v2: false });
    expect(summary).toMatchObject({ woken: 1, failed: 1 });
    expect(runs[0]).toMatchObject({ status: "error", end_reason: "wake_inconsistent:no_current_node" });
    expect(runs[0].status).not.toBe("active");
    expect(events.map((e) => e.event_type)).toEqual(["node_error", "run_error"]);
    expect(events[0]).toMatchObject({ flow_run_id: "ruim", account_id: "ACC", status: "error" });
    expect(advance).toHaveBeenCalledTimes(1);
  });

  it("smart_delay sem next_node_key (ou nó apagado): validado ANTES de reivindicar, vira error e não active", async () => {
    loadNodes.mockResolvedValueOnce(nodesWith(null)).mockResolvedValueOnce(new Map());
    const runs = [run("sem-next", { wake_at: "2026-10-08T09:00:00Z" }), run("sem-no", { wake_at: "2026-10-08T10:00:00Z" })];
    const { db } = fakeDb(runs);
    const summary = await wakeDelayedRuns(db, { now: NOW, v2: false });
    expect(summary).toMatchObject({ woken: 0, failed: 2 });
    expect(runs.map((r) => r.end_reason)).toEqual(["wake_inconsistent:no_next_node", "wake_inconsistent:node_missing"]);
    expect(runs.every((r) => r.status === "error")).toBe(true);
    expect(advance).not.toHaveBeenCalled();
  });

  it("exceção ao avançar um run não impede os outros; o run com exceção é encerrado (error), não fica active", async () => {
    advance.mockRejectedValueOnce(new Error("boom")).mockResolvedValue({ outcome: "advanced" });
    const runs = [run("a", { wake_at: "2026-10-08T08:00:00Z" }), run("b"), run("c")];
    const { db, events } = fakeDb(runs);
    const summary = await wakeDelayedRuns(db, { now: NOW, v2: false });
    expect(summary).toMatchObject({ woken: 2, failed: 1 });
    expect(runs[0]).toMatchObject({ status: "error", end_reason: "wake_exception" });
    expect(runs[1].status).toBe("active");
    expect(events.find((e) => e.event_type === "node_error")?.error_message).toContain("boom");
  });

  it("falha ao carregar os nós (antes de reivindicar): o run segue delayed para o próximo tick e os demais continuam", async () => {
    loadNodes.mockRejectedValueOnce(new Error("db fora")).mockResolvedValue(nodesWith("proximo"));
    const runs = [run("a", { wake_at: "2026-10-08T08:00:00Z" }), run("b")];
    const { db } = fakeDb(runs);
    const summary = await wakeDelayedRuns(db, { now: NOW, v2: false });
    expect(summary).toMatchObject({ woken: 1, failed: 1 });
    expect(runs[0].status).toBe("delayed");
  });

  it("run reivindicado por outro cron entre a leitura e o claim: skipped, sem avançar", async () => {
    const runs = [run("a")];
    const { db } = fakeDb(runs);
    // simula outro cron: o status muda logo depois da leitura (antes do claim guardado)
    loadNodes.mockImplementationOnce(async () => {
      runs[0].status = "active";
      return nodesWith("proximo");
    });
    const summary = await wakeDelayedRuns(db, { now: NOW, v2: false });
    expect(summary).toMatchObject({ woken: 0, skipped: 1 });
    expect(advance).not.toHaveBeenCalled();
  });

  it("flag desligada nunca chama a RPC", async () => {
    const { db, rpcCalls } = fakeDb([run("a")]);
    await wakeDelayedRuns(db, { now: NOW, v2: false });
    expect(rpcCalls).toEqual([]);
  });
});

describe("wakeDelayedRuns — FLOWS_CRON_V2 (RPC wakeable_flow_runs)", () => {
  const rpcRow = (id: string, over: Row = {}) => ({ run: run(id, { status: "active", wake_at: null }), next_node_key: "proximo", problem: null, ...over });

  it("lê em lotes até esvaziar, na ordem devolvida, e usa o lote pedido", async () => {
    const batches = [[rpcRow("r1"), rpcRow("r2")], [rpcRow("r3")], []];
    const { db, rpcCalls } = fakeDb([], () => ({ data: batches.shift() ?? [] }));
    const summary = await wakeDelayedRuns(db, { now: NOW, v2: true, batch: 2 });
    expect(summary).toEqual({ woken: 3, failed: 0, skipped: 0, path: "v2" });
    expect(advance.mock.calls.map((c) => (c[1] as Row).id)).toEqual(["r1", "r2", "r3"]);
    expect(rpcCalls.map((c) => c.args.p_limit)).toEqual([2, 2]); // 2º lote veio com 1 < 2: para
  });

  it("problema devolvido pela RPC (não reivindicado): encerra controlado e continua", async () => {
    const bad = { run: run("ruim", { current_node_key: null }), next_node_key: null, problem: "no_current_node" };
    const runs = [bad.run as Row];
    const { db, events } = fakeDb(runs, () => ({ data: [bad, rpcRow("ok")] }));
    const summary = await wakeDelayedRuns(db, { now: NOW, v2: true, batch: 50 });
    expect(summary).toMatchObject({ woken: 1, failed: 1 });
    expect(runs[0]).toMatchObject({ status: "error", end_reason: "wake_inconsistent:no_current_node" });
    expect(events.map((e) => e.event_type)).toContain("run_error");
  });

  it("exceção num run da RPC não derruba o lote", async () => {
    advance.mockRejectedValueOnce(new Error("x")).mockResolvedValue({});
    const runs = [run("a", { status: "active" }), run("b", { status: "active" })];
    const { db } = fakeDb(runs, () => ({ data: [rpcRow("a"), rpcRow("b")] }));
    const summary = await wakeDelayedRuns(db, { now: NOW, v2: true, batch: 50, budgetMs: 0 });
    expect(summary).toMatchObject({ woken: 1, failed: 1 });
    expect(runs[0]).toMatchObject({ status: "error", end_reason: "wake_exception" });
  });

  it("teto de tempo: não inicia outro lote depois do orçamento", async () => {
    let t = 0;
    const { db, rpcCalls } = fakeDb([], () => ({ data: [rpcRow("x"), rpcRow("y")] }));
    const summary = await wakeDelayedRuns(db, { now: NOW, v2: true, batch: 2, budgetMs: 100, clock: () => (t += 60) });
    expect(rpcCalls.length).toBeLessThan(20);
    expect(summary.woken).toBe(rpcCalls.length * 2);
  });

  it("migration 210 ausente: cai no caminho padrão", async () => {
    const { db, rpcCalls } = fakeDb([run("a")], () => ({ error: { code: "PGRST202", message: "Could not find the function wacrm.wakeable_flow_runs" } }));
    const summary = await wakeDelayedRuns(db, { now: NOW, v2: true });
    expect(rpcCalls).toHaveLength(1);
    expect(summary).toMatchObject({ path: "legacy", woken: 1 });
  });

  it("flowsCronV2Enabled: padrão desligada", () => {
    expect(flowsCronV2Enabled({})).toBe(false);
    expect(flowsCronV2Enabled({ FLOWS_CRON_V2: "off" })).toBe(false);
    expect(flowsCronV2Enabled({ FLOWS_CRON_V2: "on" })).toBe(true);
    expect(flowsCronV2Enabled({ FLOWS_CRON_V2: "1" })).toBe(true);
  });
});
