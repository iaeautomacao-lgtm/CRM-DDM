import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fakeDb } from "../__tests__/fake-db";
import type { ToolCallLog } from "../audit";
import type { IntelligenceScope } from "../scope";
import { createToolExecutor } from "./execute";
import {
  EMPTY_ANSWER_FALLBACK,
  MAX_ROUNDS_INSTRUCTION,
  MAX_TOOL_RESULT_CHARS,
  REFUSAL_INSTRUCTION,
  runChatLoop,
  toolMessageContent,
} from "./loop";
import { buildSystemPrompt, chatToolDefinitions, scopeLabel } from "./prompt";
import { dailyMessageLimit, chatTitleFrom, DEFAULT_DAILY_MAX_MESSAGES } from "./store";
import type {
  ChatLlmClient,
  ChatLoopEvent,
  LlmCompletion,
  LlmCompletionRequest,
  LlmMessage,
  ToolExecutor,
} from "./types";

const NOW = Date.parse("2026-10-05T15:00:00Z");
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const T1 = "11111111-0000-4000-8000-000000000001";
const T2 = "22222222-0000-4000-8000-000000000002";

const owner: IntelligenceScope = { accountId: A, userId: "owner", role: "owner", teamIds: null };
const supT1: IntelligenceScope = { accountId: A, userId: "sup", role: "supervisor", teamIds: [T1] };

interface Recorded {
  messages: LlmMessage[];
  toolsOffered: boolean;
}

/** Modelo simulado: devolve as respostas roteirizadas em ordem (a última se repete). */
function fakeLlm(script: LlmCompletion[], opts: { streamText?: boolean } = {}) {
  const calls: Recorded[] = [];
  const client: ChatLlmClient = {
    async complete(req: LlmCompletionRequest) {
      calls.push({ messages: structuredClone(req.messages), toolsOffered: !!req.tools?.length });
      const next = script[Math.min(calls.length - 1, script.length - 1)];
      if (opts.streamText && next.content) {
        for (const part of next.content.match(/.{1,5}/g) ?? []) req.onTextDelta?.(part);
      }
      return next;
    },
  };
  return { client, calls };
}

const toolCall = (id: string, name: string, args: unknown = {}) => ({
  id,
  name,
  arguments: typeof args === "string" ? args : JSON.stringify(args),
});

function auditSpy() {
  const entries: ToolCallLog[] = [];
  return { entries, log: async (e: ToolCallLog) => void entries.push(e) };
}

const baseOpts = {
  systemPrompt: "sistema",
  history: [],
  tools: chatToolDefinitions(),
};

const toolMessages = (msgs: LlmMessage[]) =>
  msgs.filter((m): m is Extract<LlmMessage, { role: "tool" }> => m.role === "tool");

describe("runChatLoop", () => {
  it("faz a ida e volta da ferramenta pelo executor real, com auditoria", async () => {
    const { db } = fakeDb({});
    const audit = auditSpy();
    const execute = createToolExecutor(owner, { db, now: () => NOW, log: audit.log, allowCall: () => true });
    const { client, calls } = fakeLlm(
      [
        { content: "", toolCalls: [toolCall("c1", "get_overview_metrics", { period: { preset: "yesterday" } })] },
        { content: "Ontem (04/10/2026), conta inteira: **0** conversas.", toolCalls: [] },
      ],
      { streamText: true },
    );
    const events: ChatLoopEvent[] = [];

    const res = await runChatLoop({
      ...baseOpts,
      llm: client,
      userMessage: "como foi ontem?",
      execute,
      onEvent: (e) => events.push(e),
    });

    expect(res.stopReason).toBe("answered");
    expect(res.rounds).toBe(1);
    expect(res.answer).toContain("**0** conversas");
    expect(res.toolCalls).toEqual([
      expect.objectContaining({ name: "get_overview_metrics", ok: true, error_kind: null, arguments: { period: { preset: "yesterday" } } }),
    ]);
    // A segunda chamada ao modelo leva o resultado da ferramenta, ligado ao id da chamada.
    expect(calls).toHaveLength(2);
    const [toolMsg] = toolMessages(calls[1].messages);
    expect(toolMsg.tool_call_id).toBe("c1");
    expect(JSON.parse(toolMsg.content)).toHaveProperty("period");
    expect(calls[1].toolsOffered).toBe(true);
    // Auditoria com o escopo do servidor.
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({ origin: "chat", toolName: "get_overview_metrics", success: true, scope: { accountId: A, userId: "owner" } });
    // Streaming: o texto chega em pedaços e recompõe a resposta.
    const text = events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("");
    expect(text).toBe(res.answer);
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["tool_start", "tool_end"]));
  });

  it("para depois do máximo de rodadas e pede a resposta sem ferramentas", async () => {
    let executions = 0;
    const execute: ToolExecutor = async () => {
      executions += 1;
      return { ok: true, result: { n: executions }, durationMs: 1 };
    };
    const { client, calls } = fakeLlm([{ content: "", toolCalls: [toolCall("c", "get_overview_metrics")] }]);

    const res = await runChatLoop({ ...baseOpts, llm: client, userMessage: "x", execute, maxRounds: 6 });

    expect(executions).toBe(6);
    expect(res.rounds).toBe(6);
    expect(calls).toHaveLength(7);
    expect(calls.slice(0, 6).every((c) => c.toolsOffered)).toBe(true);
    expect(calls[6].toolsOffered).toBe(false);
    expect(calls[6].messages.at(-1)).toEqual({ role: "system", content: MAX_ROUNDS_INSTRUCTION });
    expect(res.stopReason).toBe("max_rounds");
    // A última resposta veio vazia (o modelo insistiu em ferramenta): texto padrão.
    expect(res.answer).toBe(EMPTY_ANSWER_FALLBACK);
  });

  it("pedido fora do escopo vira recusa: auditado, sem novas consultas", async () => {
    const { db } = fakeDb({});
    const audit = auditSpy();
    const execute = createToolExecutor(supT1, { db, now: () => NOW, log: audit.log, allowCall: () => true });
    const { client, calls } = fakeLlm([
      { content: "", toolCalls: [toolCall("c1", "search_conversations", { team_id: T2 })] },
      { content: "Não tenho acesso aos dados dessa equipe: ela está fora do seu escopo.", toolCalls: [] },
    ]);

    const res = await runChatLoop({ ...baseOpts, llm: client, userMessage: "conversas da equipe 2", execute });

    expect(res.stopReason).toBe("refused");
    expect(res.toolCalls[0]).toMatchObject({ name: "search_conversations", ok: false, error_kind: "forbidden" });
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({ origin: "chat", toolName: "search_conversations", success: false });
    expect(audit.entries[0].error).toContain("forbidden");
    // O modelo recebe o erro de escopo e a rodada seguinte vai SEM ferramentas.
    const [toolMsg] = toolMessages(calls[1].messages);
    expect(JSON.parse(toolMsg.content)).toMatchObject({ erro: "fora_do_escopo" });
    expect(calls[1].toolsOffered).toBe(false);
    expect(calls[1].messages.at(-1)).toEqual({ role: "system", content: REFUSAL_INSTRUCTION });
    expect(res.answer).toContain("fora do seu escopo");
  });

  it("erro da ferramenta não derruba o laço nem vaza a mensagem interna", async () => {
    const brokenDb = {
      from() {
        throw new Error("connection refused 10.0.0.5");
      },
    } as unknown as SupabaseClient;
    const audit = auditSpy();
    const execute = createToolExecutor(owner, { db: brokenDb, now: () => NOW, log: audit.log, allowCall: () => true });
    const { client, calls } = fakeLlm([
      {
        content: "",
        toolCalls: [toolCall("c1", "get_overview_metrics"), toolCall("c2", "get_flow_performance", "{not json")],
      },
      { content: "Não consegui obter os dados agora.", toolCalls: [] },
    ]);

    const res = await runChatLoop({ ...baseOpts, llm: client, userMessage: "x", execute });

    expect(res.stopReason).toBe("answered");
    expect(res.toolCalls.map((c) => c.error_kind)).toEqual(["internal", "bad_request"]);
    const msgs = toolMessages(calls[1].messages);
    expect(msgs.map((m) => m.tool_call_id)).toEqual(["c1", "c2"]);
    expect(msgs[0].content).toContain("falha_interna");
    expect(msgs[0].content).not.toContain("10.0.0.5");
    expect(JSON.parse(msgs[1].content)).toMatchObject({ erro: "bad_request" });
    // Falhas também são auditadas; o modelo continua podendo usar ferramentas.
    expect(audit.entries.map((e) => e.success)).toEqual([false, false]);
    expect(audit.entries.every((e) => e.origin === "chat")).toBe(true);
    expect(calls[1].toolsOffered).toBe(true);
    expect(res.answer).toBe("Não consegui obter os dados agora.");
  });

  it("respeita o limite por usuário e recusa ferramenta desconhecida", async () => {
    const audit = auditSpy();
    const limited = createToolExecutor(owner, { db: fakeDb({}).db, log: audit.log, allowCall: () => false });
    const r1 = await limited("get_overview_metrics", "{}");
    expect(r1).toMatchObject({ ok: false, kind: "rate_limited" });

    const open = createToolExecutor(owner, { db: fakeDb({}).db, log: audit.log, allowCall: () => true });
    const r2 = await open("drop_table", "{}");
    expect(r2).toMatchObject({ ok: false, kind: "unknown_tool" });
    expect(audit.entries).toHaveLength(2);
    expect(audit.entries.every((e) => e.origin === "chat")).toBe(true);
  });

  it("descarta o texto já transmitido quando a rodada termina em chamada de ferramenta", async () => {
    const execute: ToolExecutor = async () => ({ ok: true, result: {}, durationMs: 0 });
    const { client } = fakeLlm(
      [
        { content: "Vou consultar...", toolCalls: [toolCall("c1", "get_overview_metrics")] },
        { content: "Pronto.", toolCalls: [] },
      ],
      { streamText: true },
    );
    const events: ChatLoopEvent[] = [];
    await runChatLoop({ ...baseOpts, llm: client, userMessage: "x", execute, onEvent: (e) => events.push(e) });
    const resetAt = events.findIndex((e) => e.type === "reset");
    expect(resetAt).toBeGreaterThan(-1);
    const after = events.slice(resetAt).filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta);
    expect(after.join("")).toBe("Pronto.");
  });
});

describe("toolMessageContent", () => {
  it("corta resultados grandes", () => {
    const big = { rows: "x".repeat(MAX_TOOL_RESULT_CHARS * 2) };
    const out = toolMessageContent({ ok: true, result: big, durationMs: 0 });
    expect(out.length).toBeLessThan(MAX_TOOL_RESULT_CHARS + 500);
    expect(JSON.parse(out)).toHaveProperty("aviso");
  });
});

describe("prompt e configuração", () => {
  it("expõe as 10 ferramentas com o inputSchema do catálogo", () => {
    const defs = chatToolDefinitions();
    expect(defs).toHaveLength(10);
    for (const d of defs) {
      expect(d.parameters.type).toBe("object");
      expect(JSON.stringify(d.parameters)).not.toContain("account_id");
    }
  });

  it("cita escopo, data e o formato de link do Inbox", () => {
    const prompt = buildSystemPrompt({ scopeLabel: scopeLabel(supT1, ["Cobrança"]), nowMs: NOW });
    expect(prompt).toContain("equipes Cobrança");
    expect(prompt).toContain("05/10/2026");
    expect(prompt).toContain("/inbox?c=");
    expect(scopeLabel(owner)).toBe("conta inteira");
    expect(scopeLabel(supT1)).toBe("1 equipe do supervisor");
  });

  it("lê o teto diário do env com padrão seguro", () => {
    expect(dailyMessageLimit({})).toBe(DEFAULT_DAILY_MAX_MESSAGES);
    expect(dailyMessageLimit({ INTELLIGENCE_DAILY_MAX_MESSAGES: "50" })).toBe(50);
    expect(dailyMessageLimit({ INTELLIGENCE_DAILY_MAX_MESSAGES: "0" })).toBe(DEFAULT_DAILY_MAX_MESSAGES);
    expect(dailyMessageLimit({ INTELLIGENCE_DAILY_MAX_MESSAGES: "abc" })).toBe(DEFAULT_DAILY_MAX_MESSAGES);
  });

  it("título do chat em uma linha e limitado", () => {
    expect(chatTitleFrom("  oi\n\ntudo  bem ")).toBe("oi tudo bem");
    expect(chatTitleFrom("a".repeat(200))).toHaveLength(80);
  });
});
