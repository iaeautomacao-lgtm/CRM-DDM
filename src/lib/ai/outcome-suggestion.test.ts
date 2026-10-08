import { describe, expect, it } from "vitest";
import {
  applyExitTagOutcomeSuggestion,
  exitTagSuggestionReason,
} from "./outcome-suggestion";
import { fakeRowsDb } from "@/lib/conversations/__tests__/fake-rows-db";

const ACC = "acc-1";

function setup(opts: { autoClose?: boolean; conv?: Record<string, unknown> } = {}) {
  return fakeRowsDb({
    ai_exit_tag_outcome_map: [
      { account_id: ACC, exit_tag: "#ACORDOFORMALIZADO", outcome_tag_id: "tag-142", auto_close: opts.autoClose ?? false },
      { account_id: "acc-2", exit_tag: "#RECUSA_CONFIRMADA", outcome_tag_id: "tag-220-other", auto_close: false },
    ],
    conversations: [
      {
        id: "conv-1",
        account_id: ACC,
        status: "open",
        outcome_tag_id: null,
        outcome_source: null,
        ...opts.conv,
      },
    ],
  });
}

const conv = (t: ReturnType<typeof setup>["tables"]) => t.conversations[0];

describe("exitTagSuggestionReason", () => {
  it("tag + motivo do handoff", () => {
    expect(exitTagSuggestionReason("#RECUSA_CONFIRMADA", "SWITCH_DEFAULT_SEM_TAG")).toBe(
      "#RECUSA_CONFIRMADA — handoff: SWITCH_DEFAULT_SEM_TAG",
    );
    expect(exitTagSuggestionReason("#OPT_OUT")).toBe("#OPT_OUT");
  });
});

describe("applyExitTagOutcomeSuggestion", () => {
  it("tag mapeada vira sugestão 'exit_tag' com confiança 1 (sem fechar)", async () => {
    const { db, tables } = setup();
    const res = await applyExitTagOutcomeSuggestion(db, {
      accountId: ACC,
      conversationId: "conv-1",
      exitTag: "acordoformalizado",
      handoffReason: "ACORDO",
    });
    expect(res).toBe("suggested");
    expect(conv(tables)).toMatchObject({
      status: "open",
      outcome_tag_id: null,
      suggested_outcome_tag_id: "tag-142",
      outcome_suggestion_source: "exit_tag",
      outcome_suggestion_confidence: 1,
      outcome_suggestion_reason: "#ACORDOFORMALIZADO — handoff: ACORDO",
    });
  });

  it("tag sem mapeamento na conta (mesmo que outra conta tenha) não faz nada", async () => {
    const { db, tables, log } = setup();
    const res = await applyExitTagOutcomeSuggestion(db, { accountId: ACC, conversationId: "conv-1", exitTag: "#RECUSA_CONFIRMADA" });
    expect(res).toBe("no_mapping");
    expect(conv(tables).suggested_outcome_tag_id).toBeUndefined();
    expect(log.some((o) => o.type === "update")).toBe(false);
  });

  it("nunca mexe em tabulação humana", async () => {
    const { db, tables } = setup({ conv: { status: "pending", outcome_tag_id: "tag-human", outcome_source: "human" } });
    const res = await applyExitTagOutcomeSuggestion(db, { accountId: ACC, conversationId: "conv-1", exitTag: "#ACORDOFORMALIZADO" });
    expect(res).toBe("human_outcome");
    expect(conv(tables).outcome_tag_id).toBe("tag-human");
    expect(conv(tables).suggested_outcome_tag_id).toBeUndefined();
  });

  it("ignora conversa já fechada", async () => {
    const { db } = setup({ conv: { status: "closed" } });
    expect(
      await applyExitTagOutcomeSuggestion(db, { accountId: ACC, conversationId: "conv-1", exitTag: "#ACORDOFORMALIZADO" }),
    ).toBe("closed");
  });

  it("auto_close=true fecha com a tabulação e procedência 'ai_auto'", async () => {
    const { db, tables } = setup({ autoClose: true });
    const res = await applyExitTagOutcomeSuggestion(db, { accountId: ACC, conversationId: "conv-1", exitTag: "#ACORDOFORMALIZADO" });
    expect(res).toBe("auto_closed");
    expect(conv(tables)).toMatchObject({
      status: "closed",
      outcome_tag_id: "tag-142",
      outcome_source: "ai_auto",
      suggested_outcome_tag_id: "tag-142",
    });
  });

  it("auto_close não sobrescreve tabulação já existente (só sugere)", async () => {
    const { db, tables } = setup({ autoClose: true, conv: { outcome_tag_id: "tag-auto", outcome_source: "automation" } });
    const res = await applyExitTagOutcomeSuggestion(db, { accountId: ACC, conversationId: "conv-1", exitTag: "#ACORDOFORMALIZADO" });
    expect(res).toBe("suggested");
    expect(conv(tables)).toMatchObject({ status: "open", outcome_tag_id: "tag-auto" });
  });

  it("texto que não é tag é ignorado", async () => {
    const { db } = setup();
    expect(await applyExitTagOutcomeSuggestion(db, { accountId: ACC, conversationId: "conv-1", exitTag: "123" })).toBe("invalid_tag");
  });
});
