import { describe, expect, it, vi } from "vitest";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { unauthorized } from "@/lib/api/v1/respond";
import { fakeDb, type Tables } from "../__tests__/fake-db";
import type { ToolCallLog } from "../audit";
import type { IntelligenceKeyContext } from "../api-key";
import * as tools from "../tools";
import { METRICS } from "../metrics/registry";
import { handleMcpRequest, mcpToolCatalog, type HandleMcpDeps } from "./server";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const T1 = "11111111-0000-4000-8000-000000000001";
const T2 = "22222222-0000-4000-8000-000000000002";
const C1 = "00000000-0000-4000-8000-000000000001";
const C2 = "00000000-0000-4000-8000-000000000002";
const at = "2026-10-04T15:00:00.000Z";

const conv = (id: string, team_id: string) => ({
  id,
  account_id: A,
  team_id,
  status: "open",
  channel_type: "whatsapp",
  client_id: null,
  assigned_agent_id: null,
  created_at: at,
  first_response_at: null,
  closed_at: null,
  contact_id: null,
  last_message_at: at,
});

function tables(): Tables {
  return {
    conversations: [conv(C1, T1), conv(C2, T2)],
    messages: [
      {
        id: "m1",
        conversation_id: C1,
        sender_type: "customer",
        sender_id: null,
        content_type: "text",
        content_text: "meu cpf é 123.456.789-12 e o zap (11) 91234-5678",
        created_at: at,
      },
    ],
    flow_runs: [],
    flow_run_events: [],
    flows: [],
    profiles: [],
    conversation_assignments: [],
    audit_logs: [],
  };
}

const supervisor: IntelligenceKeyContext = {
  keyId: "key-sup",
  scope: { accountId: A, userId: "sup", role: "supervisor", teamIds: [T1] },
};

function setup(ctx: IntelligenceKeyContext = supervisor) {
  const log = vi.fn<(entry: ToolCallLog) => Promise<void>>(async () => {});
  const { db } = fakeDb(tables());
  const deps: HandleMcpDeps = { authenticate: async () => ctx, db, log, allowCall: () => true };
  return { log, deps };
}

let nextId = 1;
function rpc(method: string, params: Record<string, unknown> = {}): Request {
  return new Request("https://crm.example.com/api/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer wacrm_live_x",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": LATEST_PROTOCOL_VERSION,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
}

async function call(deps: HandleMcpDeps, method: string, params: Record<string, unknown> = {}) {
  const res = await handleMcpRequest(rpc(method, params), deps);
  expect(res.status).toBe(200);
  return (await res.json()) as { result?: Record<string, unknown>; error?: { message: string } };
}

describe("handleMcpRequest — autenticação", () => {
  it.each(["tools/list", "resources/list", "resources/read"])("%s sem chave válida → 401 antes de tocar no protocolo", async (method) => {
    const res = await handleMcpRequest(rpc(method, { uri: "ddm://metrics/conversations_total" }), {
      authenticate: async () => {
        throw unauthorized();
      },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
  });
});

describe("handleMcpRequest — protocolo", () => {
  it("initialize responde com o servidor e as capacidades de ferramentas e resources", async () => {
    const { deps } = setup();
    const body = await call(deps, "initialize", {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(body.result).toMatchObject({ serverInfo: { name: "ddm-intelligence" }, capabilities: { tools: {}, resources: {} } });
  });

  it("resources/list expõe todas as definições do registry em JSON", async () => {
    const { deps, log } = setup();
    const body = await call(deps, "resources/list");
    expect(body.result).toEqual({
      resources: METRICS.map((metric) => ({
        uri: `ddm://metrics/${metric.id}`,
        name: metric.display_name,
        description: metric.description,
        mimeType: "application/json",
      })),
    });
    expect(log).not.toHaveBeenCalled();
  });

  it("resources/read devolve as definições completas sem executar ferramentas ou consultar o banco", async () => {
    const { deps, log } = setup();
    const db = { from: vi.fn(() => { throw new Error("não deve consultar o banco"); }) } as unknown as HandleMcpDeps["db"];
    const spy = vi.spyOn(tools, "executeTool");
    try {
      for (const metric of METRICS) {
        const uri = `ddm://metrics/${metric.id}`;
        const body = await call({ ...deps, db }, "resources/read", { uri });
        const { contents } = body.result as { contents: Array<{ uri: string; mimeType: string; text: string }> };
        expect(contents).toHaveLength(1);
        expect(contents[0]).toMatchObject({ uri, mimeType: "application/json" });
        expect(JSON.parse(contents[0].text)).toEqual(metric);
      }
      expect(spy).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    "ddm://metrics/inexistente",
    "https://metrics/conversations_total",
    "ddm://metrics/conversations_total?account_id=outra",
    "ddm://metrics/../conversations_total",
  ])("resources/read recusa URI não catalogada: %s", async (uri) => {
    const { deps } = setup();
    const body = await call(deps, "resources/read", { uri });
    expect(body.error).toMatchObject({ code: -32002, message: expect.stringContaining("Métrica não encontrada"), data: { uri } });
    expect(body.result).toBeUndefined();
  });

  it("resources são somente leitura: resources/write não é suportado", async () => {
    const { deps, log } = setup();
    const body = await call(deps, "resources/write", { uri: "ddm://metrics/conversations_total", text: "{}" });
    expect(body.error).toMatchObject({ code: -32601 });
    expect(log).not.toHaveBeenCalled();
  });

  it("tools/list devolve o catálogo 1:1 (nome, descrição, inputSchema), só leitura", async () => {
    const { deps } = setup();
    const body = await call(deps, "tools/list");
    const listed = (body.result as { tools: Array<Record<string, unknown>> }).tools;
    expect(listed.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))).toEqual(
      tools.listTools(),
    );
    expect(listed.every((t) => (t.annotations as { readOnlyHint: boolean }).readOnlyHint)).toBe(true);
    expect(mcpToolCatalog()).toHaveLength(10);
  });

  it("tools/call passa por executeTool com o escopo da chave, audita com origem mcp e mascara CPF/telefone", async () => {
    const spy = vi.spyOn(tools, "executeTool");
    const { deps, log } = setup();
    const body = await call(deps, "tools/call", {
      name: "get_conversation_timeline",
      arguments: { conversation_id: C1 },
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toEqual(supervisor.scope);
    spy.mockRestore();

    const result = body.result as { isError?: boolean; content: Array<{ type: string; text: string }> };
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("***.***.***-12");
    expect(text).toContain("11 9****-5678");
    expect(text).not.toContain("123.456.789-12");
    expect(text).not.toContain("91234-5678");
    expect(JSON.parse(text).scope).toEqual({ teams: 1 });

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatchObject({
      toolName: "get_conversation_timeline",
      success: true,
      origin: "mcp",
      apiKeyId: "key-sup",
      scope: { accountId: A, userId: "sup" },
      args: { conversation_id: C1 },
    });
  });

  it("chave de supervisor respeita o escopo: conversa de outra equipe → erro auditado", async () => {
    const { deps, log } = setup();
    const body = await call(deps, "tools/call", {
      name: "get_conversation_timeline",
      arguments: { conversation_id: C2 },
    });
    const result = body.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^not_found:/);
    expect(log.mock.calls[0][0]).toMatchObject({ success: false, origin: "mcp" });
  });

  it("escopo não vem do input: account_id nos argumentos é recusado", async () => {
    const { deps } = setup();
    const body = await call(deps, "tools/call", {
      name: "search_conversations",
      arguments: { account_id: "outra" },
    });
    const result = body.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^bad_request:/);
  });

  it("ferramenta inexistente (ex.: de escrita) → erro, nada executado", async () => {
    const spy = vi.spyOn(tools, "executeTool");
    const { deps } = setup();
    const body = await call(deps, "tools/call", { name: "reassign_conversation", arguments: {} });
    expect((body.result as { isError?: boolean }).isError).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("limite por usuário compartilhado: estourado → erro rate_limited", async () => {
    const { deps } = setup();
    const body = await call({ ...deps, allowCall: () => false }, "tools/call", {
      name: "get_conversation_timeline",
      arguments: { conversation_id: C1 },
    });
    const result = body.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^rate_limited:/);
  });
});
