import { describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/auth/account";
import { fakeDb, type Tables } from "../__tests__/fake-db";
import { BadRequestError, NotFoundError } from "../errors";
import type { IntelligenceScope } from "../scope";
import { executeTool, getTool, INTELLIGENCE_TOOLS, listTools } from "./index";

const NOW = Date.parse("2026-10-05T15:00:00Z");
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const T1 = "11111111-0000-4000-8000-000000000001";
const T2 = "22222222-0000-4000-8000-000000000002";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const owner: IntelligenceScope = { accountId: A, userId: "owner", role: "owner", teamIds: null };
const supT1: IntelligenceScope = { accountId: A, userId: "sup", role: "supervisor", teamIds: [T1] };

const inPeriod = "2026-10-04T15:00:00.000Z";
const conv = (id: string, account_id: string, team_id: string | null, extra: Record<string, unknown> = {}) => ({
  id,
  account_id,
  team_id,
  status: "open",
  channel_type: "whatsapp",
  client_id: null,
  assigned_agent_id: null,
  created_at: inPeriod,
  first_response_at: null,
  closed_at: null,
  contact_id: null,
  last_message_at: inPeriod,
  ...extra,
});
const flowRun = (id: string, account_id: string, conversation_id: string, status: string, end_reason: string | null) => ({
  id,
  account_id,
  flow_id: uuid(900),
  conversation_id,
  status,
  current_node_key: null,
  started_at: inPeriod,
  ended_at: inPeriod,
  end_reason,
});
const aiEvent = (id: string, flow_run_id: string) => ({
  id,
  flow_run_id,
  event_type: "node_entered",
  node_key: "ia",
  node_type: null,
  status: null,
  duration_ms: null,
  created_at: inPeriod,
  p_tool_name: null,
  p_reason: null,
  p_node_type: "ai_agent",
  p_result: null,
});

function tables(): Tables {
  return {
    conversations: [
      conv(uuid(1), A, T1),
      conv(uuid(2), A, T1, { status: "closed", closed_at: inPeriod }),
      conv(uuid(3), A, T2),
      conv(uuid(4), A, null),
      conv(uuid(5), B, T1), // outra conta, mesmo team_id por acaso
      conv(uuid(6), B, null),
    ],
    flow_runs: [
      flowRun("ra1", A, uuid(1), "handed_off", "handoff_node"), // T1
      flowRun("ra2", A, uuid(3), "completed", "end_node"), // T2
      flowRun("rb1", B, uuid(5), "handed_off", "handoff_node"), // outra conta
    ],
    flow_run_events: [aiEvent("e1", "ra1"), aiEvent("e2", "ra2"), aiEvent("e3", "rb1")],
    messages: [
      { id: "m1", conversation_id: uuid(1), sender_type: "customer", sender_id: null, content_type: "text", content_text: "x".repeat(800), created_at: inPeriod },
      { id: "m2", conversation_id: uuid(3), sender_type: "customer", sender_id: null, content_type: "text", content_text: "segredo T2", created_at: inPeriod },
    ],
    flows: [{ id: uuid(900), account_id: A, name: "Cobrança" }],
    profiles: [],
    clients: [],
    teams: [],
    conversation_assignments: [],
    audit_logs: [],
  };
}

function metric(result: unknown, id: string) {
  return (result as { metrics: Array<{ id: string; value: number | null; numerator: number; denominator: number }> }).metrics.find(
    (m) => m.id === id,
  )!;
}

describe("registro", () => {
  it("tem as 10 ferramentas do MVP", () => {
    expect(INTELLIGENCE_TOOLS.map((t) => t.name).sort()).toEqual(
      [
        "compare_institutions",
        "compare_periods",
        "get_agent_performance",
        "get_ai_handoff_analysis",
        "get_ai_performance",
        "get_conversation_timeline",
        "get_flow_performance",
        "get_overview_metrics",
        "get_tool_performance",
        "search_conversations",
      ].sort(),
    );
    expect(listTools().every((t) => t.description.length > 40)).toBe(true);
  });

  it("nenhum inputSchema aceita conta ou lista de equipes de escopo", () => {
    for (const t of INTELLIGENCE_TOOLS) {
      const json = JSON.stringify(t.inputSchema);
      for (const forbidden of ["account_id", "accountId", "team_ids", "teamIds", "scope", "user_id"]) {
        expect(json, `${t.name} expõe ${forbidden}`).not.toContain(`"${forbidden}"`);
      }
      expect(t.inputSchema.additionalProperties).toBe(false);
    }
  });

  it("toda ferramenta recusa account_id no input", () => {
    for (const t of INTELLIGENCE_TOOLS) {
      expect(() => t.validate({ account_id: B }), t.name).toThrow(BadRequestError);
      expect(() => t.validate({ accountId: B }), t.name).toThrow(/não permitido/);
    }
  });
});

describe("validação", () => {
  it("mensagens claras para input inválido", () => {
    expect(() => getTool("compare_periods")!.validate({})).toThrow(/metric é obrigatório/);
    expect(() => getTool("compare_periods")!.validate({ metric: "receita" })).toThrow(/metric inválido/);
    expect(() =>
      getTool("get_overview_metrics")!.validate({ period: { date_from: "2026-01-01", date_to: "2026-06-01" } }),
    ).toThrow(/máximo/);
    expect(() => getTool("search_conversations")!.validate({ limit: 51 })).toThrow(/limit/);
    expect(() => getTool("search_conversations")!.validate({ has_handoff: "sim" })).toThrow(/true ou false/);
    expect(() => getTool("search_conversations")!.validate({ channel: "telegram" })).toThrow(/channel/);
    expect(() => getTool("get_conversation_timeline")!.validate({})).toThrow(/conversation_id é obrigatório/);
    expect(() => getTool("get_conversation_timeline")!.validate({ conversation_id: "123" })).toThrow(/UUID/);
    expect(() => getTool("get_overview_metrics")!.validate([])).toThrow(/objeto/);
  });

  it("aceita input vazio com padrões", () => {
    expect(getTool("search_conversations")!.validate(undefined)).toMatchObject({ limit: 20, offset: 0 });
    expect(getTool("compare_periods")!.validate({ metric: "ai_handoff_rate", period: { preset: "today" } })).toEqual({
      metric: "ai_handoff_rate",
      period: { preset: "today" },
    });
  });
});

describe("isolamento", () => {
  it("owner da conta A não vê a conta B", async () => {
    const { db, log } = fakeDb(tables());
    const r = await executeTool(getTool("get_overview_metrics")!, owner, { period: { preset: "last_7_days" } }, { db, nowMs: NOW });
    expect(metric(r, "conversations_total").value).toBe(4);
    expect(metric(r, "conversations_closed").value).toBe(1);
    expect(metric(r, "ai_runs").value).toBe(2);
    expect(metric(r, "ai_handoff_rate")).toMatchObject({ value: 0.5, numerator: 1, denominator: 2 });
    // Toda leitura de conversations/flow_runs filtrou pela conta.
    for (const q of log.filter((l) => l.table === "conversations" || l.table === "flow_runs")) {
      expect(q.calls).toContainEqual(["eq", "account_id", A]);
    }
  });

  it("supervisor só vê as equipes dele (conversas e execuções)", async () => {
    const { db, log } = fakeDb(tables());
    const r = await executeTool(getTool("get_overview_metrics")!, supT1, {}, { db, nowMs: NOW });
    expect(metric(r, "conversations_total").value).toBe(2); // uuid(1), uuid(2); não T2, não sem equipe, não B
    expect(metric(r, "ai_runs").value).toBe(1); // só ra1
    expect(metric(r, "ai_handoff_rate")).toMatchObject({ value: 1, numerator: 1, denominator: 1 });
    for (const q of log.filter((l) => l.table === "conversations")) {
      expect(q.calls).toContainEqual(["eq", "account_id", A]);
      expect(q.calls).toContainEqual(["in", "team_id", [T1]]);
    }
  });

  it("timeline: conversa fora do escopo = não encontrada; dentro = texto truncado em 500", async () => {
    const { db } = fakeDb(tables());
    const tool = getTool("get_conversation_timeline")!;
    await expect(executeTool(tool, supT1, { conversation_id: uuid(3) }, { db, nowMs: NOW })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(executeTool(tool, owner, { conversation_id: uuid(5) }, { db, nowMs: NOW })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    const r = (await executeTool(tool, supT1, { conversation_id: uuid(1) }, { db, nowMs: NOW })) as {
      messages: Array<{ text: string }>;
      flow_runs: Array<{ flow_name: string | null }>;
    };
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0].text).toHaveLength(500);
    expect(r.flow_runs[0].flow_name).toBe("Cobrança");
  });

  it("search: supervisor não filtra equipe alheia; resultado sem conteúdo de mensagem", async () => {
    const { db } = fakeDb(tables());
    const tool = getTool("search_conversations")!;
    await expect(executeTool(tool, supT1, { team_id: T2 }, { db, nowMs: NOW })).rejects.toBeInstanceOf(ForbiddenError);
    const r = (await executeTool(tool, supT1, {}, { db, nowMs: NOW })) as {
      total: number;
      conversations: Array<Record<string, unknown>>;
    };
    expect(r.total).toBe(2);
    expect(JSON.stringify(r)).not.toContain("segredo");
    expect(Object.keys(r.conversations[0])).not.toContain("content_text");

    const handed = (await executeTool(tool, owner, { has_handoff: true }, { db, nowMs: NOW })) as {
      conversations: Array<{ id: string }>;
    };
    expect(handed.conversations.map((c) => c.id)).toEqual([uuid(1)]);
  });

  it("compare_periods devolve atual, anterior e diferenças", async () => {
    const { db } = fakeDb(tables());
    const r = (await executeTool(
      getTool("compare_periods")!,
      owner,
      { metric: "conversations_total", period: { preset: "last_7_days" } },
      { db, nowMs: NOW },
    )) as { current: { value: number }; previous: { value: number }; abs_diff: { value: number }; pct_diff: { value: number | null } };
    expect(r.current.value).toBe(4);
    expect(r.previous.value).toBe(0);
    expect(r.abs_diff.value).toBe(4);
    expect(r.pct_diff.value).toBeNull();
  });
});
