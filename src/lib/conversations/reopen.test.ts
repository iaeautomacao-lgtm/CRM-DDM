import { describe, expect, it } from "vitest";
import { reopenConversationFields } from "./reopen";

describe("reopenConversationFields", () => {
  it("volta para pending e zera tabulação, procedência e sugestão", () => {
    expect(reopenConversationFields()).toEqual({
      status: "pending",
      outcome_tag_id: null,
      outcome_source: null,
      outcome_set_by: null,
      outcome_set_at: null,
      suggested_outcome_tag_id: null,
      outcome_suggestion_source: null,
      outcome_suggestion_confidence: null,
      outcome_suggestion_reason: null,
      outcome_suggested_at: null,
      outcome_suggestion_key: null,
    });
  });

  it("devolve um objeto novo a cada chamada (seguro para Object.assign)", () => {
    const a = reopenConversationFields();
    a.status = "open";
    expect(reopenConversationFields().status).toBe("pending");
  });
});
