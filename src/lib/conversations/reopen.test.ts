import { describe, expect, it } from "vitest";
import { reopenConversationFields } from "./reopen";

describe("reopenConversationFields", () => {
  it("volta para pending e zera a tabulação do atendimento anterior", () => {
    expect(reopenConversationFields()).toMatchObject({
      status: "pending",
      outcome_tag_id: null,
    });
  });

  it("devolve um objeto novo a cada chamada (seguro para Object.assign)", () => {
    const a = reopenConversationFields();
    a.status = "open";
    expect(reopenConversationFields().status).toBe("pending");
  });
});
