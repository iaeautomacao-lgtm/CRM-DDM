import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { suggestAcordoRealizado } from "./acordo-tagging";
import { fakeRowsDb, type Tables } from "@/lib/conversations/__tests__/fake-rows-db";

const ACC = "acc-1";

function tables(conv: Record<string, unknown> = {}): Tables {
  return {
    conversations: [
      {
        id: "conv-1",
        account_id: ACC,
        status: "open",
        outcome_tag_id: null,
        outcome_suggestion_source: null,
        outcome_suggestion_key: null,
        ...conv,
      },
    ],
    flow_runs: [],
    messages: [
      { id: "m1", conversation_id: "conv-1", content_text: "Quanto fica?", sender_type: "customer", created_at: "2026-10-01T10:00:00Z" },
      { id: "m2", conversation_id: "conv-1", content_text: "Fechado, pode gerar o boleto", sender_type: "customer", created_at: "2026-10-01T10:05:00Z" },
    ],
    tags: [
      { id: "tag-142", account_id: ACC, kind: "outcome", codigo_tabulacao: 142 },
      { id: "tag-142-other", account_id: "acc-2", kind: "outcome", codigo_tabulacao: 142 },
    ],
    ai_config: [{ account_id: ACC, api_provider: "gemini", api_key: "k", api_model: "gemini-3.5-flash" }],
  };
}

const yes = () => vi.fn().mockResolvedValue('{"acordo_formalizado": true}');

describe("suggestAcordoRealizado", () => {
  it("grava SUGESTÃO (não tabulação) com o modelo da conta e a chave da última mensagem", async () => {
    const { db, tables: t } = fakeRowsDb(tables());
    const callLlm = yes();
    expect(await suggestAcordoRealizado(ACC, "conv-1", { db, callLlm })).toBe("suggested");
    expect(callLlm).toHaveBeenCalledWith("gemini", "k", expect.any(String), "gemini-3.5-flash");
    expect(t.conversations[0]).toMatchObject({
      outcome_tag_id: null,
      status: "open",
      suggested_outcome_tag_id: "tag-142",
      outcome_suggestion_source: "llm",
      outcome_suggestion_key: "m2",
    });
  });

  it("mesma última mensagem não chama a IA de novo", async () => {
    const { db } = fakeRowsDb(tables({ outcome_suggestion_key: "m2" }));
    const callLlm = yes();
    expect(await suggestAcordoRealizado(ACC, "conv-1", { db, callLlm })).toBe("already_analyzed");
    expect(callLlm).not.toHaveBeenCalled();
  });

  it("fluxo no comando (sugestão exit_tag ou run ativo) => não chama a IA", async () => {
    const callLlm = yes();
    const a = fakeRowsDb(tables({ outcome_suggestion_source: "exit_tag" }));
    expect(await suggestAcordoRealizado(ACC, "conv-1", { db: a.db, callLlm })).toBe("flow_in_charge");
    const t = tables();
    t.flow_runs = [{ id: "r1", conversation_id: "conv-1", status: "active" }];
    const b = fakeRowsDb(t);
    expect(await suggestAcordoRealizado(ACC, "conv-1", { db: b.db, callLlm })).toBe("flow_in_charge");
    expect(callLlm).not.toHaveBeenCalled();
  });

  it("conversa já tabulada ou fechada é ignorada", async () => {
    const callLlm = yes();
    expect(await suggestAcordoRealizado(ACC, "conv-1", { db: fakeRowsDb(tables({ outcome_tag_id: "x" })).db, callLlm })).toBe("skipped");
    expect(await suggestAcordoRealizado(ACC, "conv-1", { db: fakeRowsDb(tables({ status: "closed" })).db, callLlm })).toBe("skipped");
    expect(callLlm).not.toHaveBeenCalled();
  });

  it("sem acordo formalizado não escreve nada", async () => {
    const { db, log } = fakeRowsDb(tables());
    const callLlm = vi.fn().mockResolvedValue('{"acordo_formalizado": false}');
    expect(await suggestAcordoRealizado(ACC, "conv-1", { db, callLlm })).toBe("not_formalized");
    expect(log.some((o) => o.type === "update")).toBe(false);
  });
});

describe("scheduleAcordoSuggestion", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock("./acordo-tagging");
  });

  it("debounce: uma classificação por rajada", async () => {
    const suggest = vi.fn(async () => "suggested");
    vi.doMock("./acordo-tagging", () => ({ suggestAcordoRealizado: suggest }));
    const { scheduleAcordoSuggestion } = await import("./acordo-trigger");
    scheduleAcordoSuggestion(ACC, "conv-x", 1000);
    await vi.advanceTimersByTimeAsync(500);
    scheduleAcordoSuggestion(ACC, "conv-x", 1000);
    await vi.advanceTimersByTimeAsync(900);
    expect(suggest).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() => expect(suggest).toHaveBeenCalledTimes(1));
    expect(suggest).toHaveBeenCalledWith(ACC, "conv-x");
  });
});
