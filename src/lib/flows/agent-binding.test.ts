import { describe, expect, it } from "vitest";
import { convertAiAgentNode } from "@/lib/ai/agents/convert";
import { filterPriorityIntent, protectionEnabled, withAgentRuntime, currentAgentRuntime } from "@/lib/ai/agents/scope";
import { resolveBoundAiNode, snapshotRunAgentBindings } from "./agent-binding";

type Row = Record<string, unknown>;

function fakeDb(tables: Record<string, Row[]>) {
  return {
    tables,
    from(name: string) {
      const rows = (tables[name] ??= []);
      const filters: Array<(r: Row) => boolean> = [];
      let max = Infinity;
      const builder = {
        select: () => builder,
        eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), builder),
        in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), builder),
        limit: (n: number) => ((max = n), builder),
        upsert: (row: Row, opts: { onConflict: string }) => {
          const keys = opts.onConflict.split(",");
          if (!rows.some((r) => keys.every((k) => r[k] === row[k]))) rows.push({ ...row });
          return Promise.resolve({ error: null });
        },
        then: (resolve: (v: unknown) => void) =>
          resolve({ data: rows.filter((r) => filters.every((f) => f(r))).slice(0, max), error: null }),
      };
      return builder;
    },
  };
}

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const account = { account_id: ACCOUNT, enabled: true, api_provider: "openai", api_model: "gpt-4o-mini" };

function seed(over: { enabled?: boolean; protections?: Record<string, unknown> } = {}) {
  const v = convertAiAgentNode({ mode: "loop", max_turns: 3 } as never, account, { node_key: "n1" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const config = structuredClone(v.config) as Record<string, any>;
  if (over.protections) config.protections = { ...config.protections, ...over.protections };
  return fakeDb({
    ai_agents: [{ id: "ag1", account_id: ACCOUNT, name: "Agente 1", enabled: over.enabled ?? true, published_version_id: "v1" }],
    ai_agent_versions: [
      { id: "v1", account_id: ACCOUNT, agent_id: "ag1", config, prompt_content: "PROMPT V1", composition: "legacy_v1", config_hash: "h1" },
      { id: "v2", account_id: ACCOUNT, agent_id: "ag1", config, prompt_content: "PROMPT V2", composition: "legacy_v1", config_hash: "h2" },
    ],
    ai_rule_versions: [],
    ai_tools: [],
    flow_run_agent_bindings: [],
  });
}

const run = { id: "run-1", flow_id: "f1", account_id: ACCOUNT };
const node = { node_key: "n1", node_type: "ai_agent", config: { agent_id: "ag1", mode: "single" } } as never;

describe("snapshot por run", () => {
  it("fixa a versão publicada e não muda quando o agente publica outra", async () => {
    const db = seed();
    await snapshotRunAgentBindings(db as never, run, [node]);
    db.tables.ai_agents[0].published_version_id = "v2";
    const r = await resolveBoundAiNode(db as never, run, node);
    expect(r.agentVersionId).toBe("v1");
    expect(r.runtime?.promptContent).toBe("PROMPT V1");
    const r2 = await resolveBoundAiNode(db as never, { ...run, id: "run-2" }, node);
    expect(r2.agentVersionId).toBe("v2");
  });
  it("run sem snapshot fixa lazy na primeira resolução", async () => {
    const db = seed();
    await resolveBoundAiNode(db as never, run, node);
    expect(db.tables.flow_run_agent_bindings).toHaveLength(1);
    db.tables.ai_agents[0].published_version_id = "v2";
    expect((await resolveBoundAiNode(db as never, run, node)).agentVersionId).toBe("v1");
  });
  it("nó sem agent_id não consulta o banco", async () => {
    const db = {
      from: () => {
        throw new Error("não deveria consultar");
      },
    };
    const raw = { mode: "loop" };
    const r = await resolveBoundAiNode(db as never, run, { node_key: "x", config: raw } as never);
    expect(r.cfg).toBe(raw);
    expect(r.disabled).toBeNull();
  });
});

describe("agente desligado/indisponível não trava", () => {
  it("desligado → disabled agent_disabled", async () => {
    const r = await resolveBoundAiNode(seed({ enabled: false }) as never, run, node);
    expect(r.disabled).toEqual({ reason: "agent_disabled", agentName: "Agente 1" });
  });
  it("inexistente → agent_not_found", async () => {
    const r = await resolveBoundAiNode(seed() as never, run, { node_key: "n1", config: { agent_id: "nope" } } as never);
    expect(r.disabled?.reason).toBe("agent_not_found");
  });
  it("agente de outra conta → agent_not_found", async () => {
    const r = await resolveBoundAiNode(seed() as never, { ...run, account_id: "outra" }, node);
    expect(r.disabled?.reason).toBe("agent_not_found");
  });
  it("config inválida → agent_unavailable (falha fechado)", async () => {
    const db = seed();
    db.tables.ai_agent_versions[0].config = { schema_version: 99 };
    const r = await resolveBoundAiNode(db as never, run, node);
    expect(r.disabled?.reason).toBe("agent_unavailable");
  });
});

describe("config efetiva do nó vinculado", () => {
  it("agente manda em modo/max_turns/tools; nó mantém o fio", async () => {
    const raw = { agent_id: "ag1", mode: "single", next_node_key: "fim", tool_refs: ["x"] };
    const r = await resolveBoundAiNode(seed() as never, run, { node_key: "n1", config: raw } as never);
    expect(r.cfg.mode).toBe("loop");
    expect(r.cfg.max_turns).toBe(3);
    expect((r.cfg as unknown as Record<string, unknown>).next_node_key).toBe("fim");
    expect(r.cfg.tool_refs).toEqual([]);
  });
});

describe("proteções", () => {
  it("padrão ligadas sem agente", () => {
    expect(protectionEnabled("anti_xingamento", null)).toBe(true);
    expect(filterPriorityIntent({ kind: "wrong_person" }, null)).toEqual({ kind: "wrong_person" });
  });
  it("toggles desligam, mas opt-out passa SEMPRE", async () => {
    const off = { enabled: false };
    const db = seed({ protections: { anti_xingamento: off, anti_loop: off, pedido_humano_contestacao: off, pessoa_errada: off } });
    const { runtime } = await resolveBoundAiNode(db as never, run, node);
    expect(protectionEnabled("anti_xingamento", runtime)).toBe(false);
    expect(protectionEnabled("anti_loop", runtime)).toBe(false);
    expect(filterPriorityIntent({ kind: "wrong_person" }, runtime)).toBeNull();
    expect(filterPriorityIntent({ kind: "human_request" }, runtime)).toBeNull();
    expect(filterPriorityIntent({ kind: "contestation" }, runtime)).toBeNull();
    expect(filterPriorityIntent({ kind: "opt_out" }, runtime)).toEqual({ kind: "opt_out" });
  });
  it("escopo ALS é visível dentro de withAgentRuntime", async () => {
    const { runtime } = await resolveBoundAiNode(seed() as never, run, node);
    expect(currentAgentRuntime()).toBeNull();
    await withAgentRuntime(runtime, async () => expect(currentAgentRuntime()?.agentId).toBe("ag1"));
  });
});
