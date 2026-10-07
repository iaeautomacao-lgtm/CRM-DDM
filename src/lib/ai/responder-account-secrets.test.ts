// Ferramentas do agente com credenciais/variáveis da conta, de ponta a ponta
// (generateOpenAiResponse): a credencial só vai se o host da URL FINAL
// (depois de {{var}} e dos argumentos do modelo) estiver permitido; o
// argumento do modelo nunca vira {{cred}}/{{var}}; com credencial na
// requisição o redirect cross-origin é bloqueado.

const safeFetchCalls: Array<{ url: string; init: RequestInit; options: Record<string, unknown> }> = [];
vi.mock("@/lib/security/ssrf-guard", async (orig) => ({
  ...(await orig<typeof import("@/lib/security/ssrf-guard")>()),
  safeFetch: (url: string, init?: RequestInit, options?: Record<string, unknown>) => {
    safeFetchCalls.push({ url, init: init ?? {}, options: options ?? {} });
    return Promise.resolve(new Response(JSON.stringify({ ok: true, nominal: "10,00" }), { status: 200 }));
  },
}));

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ writeLog: vi.fn() }));
const accountState = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/ai/account-secrets", () => ({
  currentAccountSecrets: async () => accountState.ctx,
  withAccountSecretsScope: (_a: string, fn: () => Promise<unknown>) => fn(),
}));

import { generateOpenAiResponse } from "./responder";
import type { AiAgentTool } from "@/lib/flows/types";

const account = () => ({
  vars: new Map([["BASE", "api.exemplo.com"]]),
  creds: new Map([["API_KEY", { value: "SEGREDO-123456", hosts: ["exemplo.com"] }]]),
});

function tool(http: AiAgentTool["http"]): AiAgentTool {
  return {
    name: "buscar",
    description: "d",
    parameters: {
      type: "object",
      properties: { host: { type: "string", description: "h" }, termo: { type: "string", description: "t" } },
      required: [],
    },
    http,
  };
}

async function run(t: AiAgentTool, args: Record<string, string>) {
  let openAiCalls = 0;
  const toolMessages: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input).startsWith("https://api.openai.com/")).toBe(true);
      openAiCalls += 1;
      if (openAiCalls === 1) {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "buscar", arguments: JSON.stringify(args) } }] } }],
          }),
          { status: 200 },
        );
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages: Array<{ role: string; content: string }> };
      toolMessages.push(...body.messages.filter((m) => m.role === "tool").map((m) => m.content));
      return new Response(JSON.stringify({ choices: [{ message: { content: "pronto" } }] }), { status: 200 });
    }),
  );
  await generateOpenAiResponse("sk-test", "sys", [{ sender_type: "customer", content_type: "text", content_text: "oi" }], [t]);
  return { toolMessages };
}

describe("ferramentas × credenciais da conta (runtime)", () => {
  beforeEach(() => {
    safeFetchCalls.length = 0;
    accountState.ctx = account();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.unstubAllGlobals());

  it("host final permitido: a credencial vai no header e o redirect cross-origin fica bloqueado", async () => {
    await run(tool({ url: "https://{{var.BASE}}/busca?q={{termo}}", method: "GET", headers: { Authorization: "Bearer {{cred.API_KEY}}" } }), { termo: "abc" });
    expect(safeFetchCalls).toHaveLength(1);
    expect(safeFetchCalls[0].url).toBe("https://api.exemplo.com/busca?q=abc");
    expect((safeFetchCalls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer SEGREDO-123456");
    expect(safeFetchCalls[0].options.failOnCrossOriginRedirect).toBe(true);
  });

  it("host montado por ARGUMENTO do modelo fora da lista: a credencial não sai e nada é chamado", async () => {
    const { toolMessages } = await run(
      tool({ url: "https://{{host}}/busca", method: "GET", headers: { Authorization: "Bearer {{cred.API_KEY}}" } }),
      { host: "evil.com" },
    );
    expect(safeFetchCalls).toHaveLength(0);
    expect(toolMessages.join(" ")).not.toContain("SEGREDO-123456");
    expect(toolMessages.join(" ")).toMatch(/permiss|configurad/i);
  });

  it("host montado por argumento DENTRO da lista (subdomínio permitido): credencial vai", async () => {
    await run(tool({ url: "https://{{host}}/busca", method: "GET", headers: { "X-Key": "{{cred.API_KEY}}" } }), { host: "api.exemplo.com" });
    expect(safeFetchCalls).toHaveLength(1);
    expect((safeFetchCalls[0].init.headers as Record<string, string>)["X-Key"]).toBe("SEGREDO-123456");
  });

  it("argumento do modelo com {{cred.X}}/{{var.X}} nunca vira segredo", async () => {
    await run(tool({ url: "https://api.exemplo.com/busca?q={{termo}}", method: "GET", headers: { Authorization: "Bearer {{cred.API_KEY}}" } }), {
      termo: "{{cred.API_KEY}}{{var.BASE}}",
    });
    expect(safeFetchCalls).toHaveLength(1);
    expect(safeFetchCalls[0].url).toBe("https://api.exemplo.com/busca?q={{cred.API_KEY}}{{var.BASE}}");
    expect(safeFetchCalls[0].url).not.toContain("SEGREDO-123456");
  });

  it("sem credencial na requisição (só variável): redirect segue a regra normal", async () => {
    await run(tool({ url: "https://{{var.BASE}}/busca", method: "GET" }), {});
    expect(safeFetchCalls[0].options.failOnCrossOriginRedirect).toBe(false);
  });

  it("timeout da ferramenta (catálogo) vira o timeout do safeFetch, limitado a 1–60 s", async () => {
    await run({ ...tool({ url: "https://api.exemplo.com/x", method: "GET" }), timeout_ms: 5000 }, {});
    await run({ ...tool({ url: "https://api.exemplo.com/x", method: "GET" }), timeout_ms: 999999 }, {});
    await run(tool({ url: "https://api.exemplo.com/x", method: "GET" }), {});
    expect(safeFetchCalls.map((c) => c.options.timeoutMs)).toEqual([5000, 60000, 30000]);
  });
});
