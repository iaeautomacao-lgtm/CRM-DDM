// Ponta a ponta das tools da IA (PRD 01, seção 6, casos a–c): o loop real
// do modelo (generateOpenAiResponse) com OpenAI e API DDM simuladas via
// fetch, a contagem real por chamada (tallyToolResult — a mesma que o
// callback de handleAiAutoResponseAttempt usa) e a decisão real de forçar
// #INSTABILIDADE (decideForcedInstability).
//
// Não roda handleAiAutoResponse inteiro (config, reserva da mensagem,
// envio WhatsApp, persistência…): isso exigiria simular o banco todo sem
// testar nada a mais da decisão de instabilidade.

// Tools HTTP passam pelo guard anti-SSRF (ssrf-guard.test.ts); aqui delega ao fetch simulado.
vi.mock("@/lib/security/ssrf-guard", async (orig) => ({
  ...(await orig<typeof import("@/lib/security/ssrf-guard")>()),
  safeFetch: (url: string, init?: RequestInit) => globalThis.fetch(url, init),
}));

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ writeLog: vi.fn() }));

import { decideForcedInstability, generateOpenAiResponse } from "./responder";
import { tallyToolResult, type ToolExecutionMeta, type ToolRoundTally } from "./tool-recovery";
import type { AiAgentTool } from "@/lib/flows/types";

const DDM_URL = "https://api.ddm.test/debitos";

const consultarDebitos: AiAgentTool = {
  name: "consultar_debitos",
  description: "Consulta os débitos de um registro do devedor",
  parameters: {
    type: "object",
    properties: { registro: { type: "string", description: "id do registro" } },
    required: ["registro"],
  },
  http: { url: `${DDM_URL}?registro={{registro}}`, method: "GET" },
};

type DdmReply = { status: number; body: string };

/**
 * OpenAI simulada: 1ª chamada pede consultar_debitos para os registros
 * dados; 2ª devolve `finalText` (o modelo "respondendo" com o que recebeu).
 * API DDM: resposta por registro.
 */
function mockApis(registros: string[], ddm: Record<string, DdmReply>, finalText: (toolMsgs: string[]) => string) {
  let openAiCalls = 0;
  const toolMessagesSeen: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://api.openai.com/")) {
      openAiCalls += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages: Array<{ role: string; content: string }> };
      if (openAiCalls === 1) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: registros.map((r, i) => ({
                    id: `call_${i}`,
                    type: "function",
                    function: { name: "consultar_debitos", arguments: JSON.stringify({ registro: r }) },
                  })),
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      const toolMsgs = body.messages.filter((m) => m.role === "tool").map((m) => m.content);
      toolMessagesSeen.push(...toolMsgs);
      return new Response(JSON.stringify({ choices: [{ message: { content: finalText(toolMsgs) } }] }), {
        status: 200,
      });
    }
    if (url.startsWith(DDM_URL)) {
      const registro = new URL(url).searchParams.get("registro") ?? "";
      const reply = ddm[registro] ?? { status: 500, body: "" };
      return new Response(reply.body, { status: reply.status });
    }
    throw new Error(`fetch inesperado: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, toolMessagesSeen };
}

async function runRound(registros: string[], ddm: Record<string, DdmReply>, finalText: (toolMsgs: string[]) => string) {
  const { toolMessagesSeen, fetchMock } = mockApis(registros, ddm, finalText);
  const tally = new Map<string, ToolRoundTally>();
  const text = await generateOpenAiResponse(
    "sk-test",
    "Você é o agente de cobrança.",
    [{ sender_type: "customer", content_type: "text", content_text: "quero negociar" }],
    [consultarDebitos],
    undefined,
    async (toolName: string, _result: string, _ms: number, meta?: ToolExecutionMeta) => {
      tallyToolResult(tally, toolName, meta?.failureCode);
    },
    "agente_ddm",
  );
  return { text, forced: decideForcedInstability(tally, text), toolMessagesSeen, fetchMock };
}

const OK = (valor: string): DdmReply => ({ status: 200, body: JSON.stringify({ nominal: valor, parcelas: 3 }) });
const DOWN: DdmReply = { status: 503, body: "Service Unavailable" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("tools da IA de ponta a ponta (API DDM simulada)", () => {
  it("(a) 1 de 3 registros fora do ar: proposta com os outros 2, sem #INSTABILIDADE", async () => {
    const { text, forced, fetchMock } = await runRound(
      ["r1", "r2", "r3"],
      { r1: OK("100.00"), r2: OK("250.00"), r3: DOWN },
      (toolMsgs) => {
        const ok = toolMsgs.filter((m) => m.includes("nominal")).length;
        return `Encontrei ${ok} débitos. Posso parcelar em até 3x.`;
      },
    );
    expect(forced).toBeNull();
    expect(text).toBe("Encontrei 2 débitos. Posso parcelar em até 3x.");
    // r3 teve as 3 tentativas (GET seguro com retry), r1/r2 uma cada.
    const ddmCalls = fetchMock.mock.calls.filter(([u]) => String(u).startsWith(DDM_URL));
    expect(ddmCalls).toHaveLength(5);
  }, 15_000);

  it("(b) todos os registros fora do ar: força #INSTABILIDADE", async () => {
    const { forced } = await runRound(
      ["r1", "r2"],
      { r1: DOWN, r2: DOWN },
      () => "Vou verificar e já te retorno.",
    );
    expect(forced).toEqual({
      tag: "#INSTABILIDADE",
      tools: { consultar_debitos: "TOOL_SERVER_ERROR" },
    });
  }, 15_000);

  it("(c) 404 'não encontrado': sem instabilidade, o modelo recebe o resultado e pede o CPF", async () => {
    const { text, forced, toolMessagesSeen, fetchMock } = await runRound(
      ["r1"],
      { r1: { status: 404, body: JSON.stringify({ error: "CPF não encontrado" }) } },
      (toolMsgs) =>
        toolMsgs.some((m) => m.includes("TOOL_BUSINESS_ERROR"))
          ? "Não localizei seu cadastro. Pode me confirmar o CPF?"
          : "?",
    );
    expect(forced).toBeNull();
    expect(text).toBe("Não localizei seu cadastro. Pode me confirmar o CPF?");
    expect(toolMessagesSeen[0]).toContain("TOOL_BUSINESS_ERROR");
    expect(toolMessagesSeen[0]).toContain("CPF não encontrado");
    // Resposta de negócio não é repetida.
    expect(fetchMock.mock.calls.filter(([u]) => String(u).startsWith(DDM_URL))).toHaveLength(1);
  });

  it("modelo que já encerrou com tag não é sobrescrito", async () => {
    const { forced } = await runRound(["r1"], { r1: DOWN }, () => "Vou te passar para a equipe. #EQUIPEHUMANA");
    expect(forced).toBeNull();
  }, 15_000);
});
