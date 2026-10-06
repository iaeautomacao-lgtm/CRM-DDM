import { describe, expect, it } from "vitest";
import { isStaleConversationUpdateAfterClose } from "./realtime-guard";

describe("isStaleConversationUpdateAfterClose", () => {
  const closedAt = Date.parse("2026-10-06T17:00:00.000Z");

  it("ignora open/pending antigo depois do fechamento", () => {
    expect(isStaleConversationUpdateAfterClose(closedAt, {
      status: "open",
      updated_at: "2026-10-06T16:59:59.000Z",
    })).toBe(true);
    expect(isStaleConversationUpdateAfterClose(closedAt, {
      status: "pending",
      updated_at: "2026-10-06T17:00:00.000Z",
    })).toBe(true);
  });

  it("aceita reabertura real posterior", () => {
    expect(isStaleConversationUpdateAfterClose(closedAt, {
      status: "pending",
      updated_at: "2026-10-06T17:00:01.000Z",
    })).toBe(false);
  });

  it("nunca bloqueia o próprio evento closed", () => {
    expect(isStaleConversationUpdateAfterClose(closedAt, {
      status: "closed",
      updated_at: "2026-10-06T16:59:00.000Z",
    })).toBe(false);
  });
});
