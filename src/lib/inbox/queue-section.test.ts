import { describe, expect, it } from "vitest";
import { inboxQueueSection } from "./queue-section";

describe("inboxQueueSection", () => {
  it("prioriza atribuição humana sobre open/pending", () => {
    expect(inboxQueueSection({ status: "open", assigned_agent_id: "a1" })).toBe("attending");
    expect(inboxQueueSection({ status: "pending", assigned_agent_id: "a1" })).toBe("attending");
  });

  it("mantém conversa ativa sem atendente em espera", () => {
    expect(inboxQueueSection({ status: "open", assigned_agent_id: undefined })).toBe("waiting");
    expect(inboxQueueSection({ status: "pending", assigned_agent_id: undefined })).toBe("waiting");
  });

  it("closed nunca volta para fila ativa por causa da atribuição", () => {
    expect(inboxQueueSection({ status: "closed", assigned_agent_id: "a1" })).toBe("closed");
  });
});
