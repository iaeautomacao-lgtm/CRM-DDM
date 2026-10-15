import { describe, expect, it } from "vitest";
import {
  summarizeAgreements,
  type AgreementAudit,
  type AgreementConversation,
} from "./agreement-metrics";

const tagId = "agreement-tag";
const tags = new Map([[tagId, "Acordo Realizado"]]);
const now = new Date("2026-10-15T13:00:00.000Z"); // 10:00 Brasília

function conv(id: string, closed_at: string | null = "2026-10-15T11:00:00.000Z"): AgreementConversation {
  return { id, outcome_tag_id: tagId, closed_at };
}
function audit(
  id: string,
  resource_id: string,
  actor_type: string | null,
  created_at = "2026-10-15T09:00:00.000Z",
  after: string | null = "Acordo Realizado",
): AgreementAudit {
  return { id, resource_id, actor_type, created_at, changes: { outcome_tag_id: { before: null, after } } };
}

describe("Dashboard: attribution of formalized agreements", () => {
  it("returns zeros for accounts with no agreement tag", () => {
    expect(summarizeAgreements([], [], new Map(), now)).toEqual({
      total: 0, ai: 0, human: 0, unknown: 0, attributed: 0,
      aiShareOfAttributed: 0, attributionCoverage: 0,
      closedToday: 0, closedLast7Days: 0, closedLast30Days: 0,
    });
  });

  it("counts once per conversation and distinguishes AI, human and unknown", () => {
    const conversations = [conv("a"), conv("b"), conv("c"), conv("d")];
    const events = [
      audit("a1", "a", "ai"),
      audit("b1", "b", "user"),
      audit("c1", "c", "system"),
    ];
    expect(summarizeAgreements(conversations, events, tags, now)).toMatchObject({
      total: 4, ai: 1, human: 1, unknown: 2, attributed: 2,
      aiShareOfAttributed: 50, attributionCoverage: 50,
    });
  });

  it("does not mistake a human closing a conversation for a human who tagged it", () => {
    const events = [
      audit("tag-by-ai", "conversation", "ai", "2026-10-13T12:00:00Z"),
      {
        id: "closed-by-user", resource_id: "conversation", actor_type: "user",
        created_at: "2026-10-14T12:00:00Z", changes: { status: { after: "closed" } },
      },
    ];
    // Even if an unrelated status event is accidentally included,
    // it must not overwrite the prior agreement-tag attribution.
    const result = summarizeAgreements([conv("conversation")], events, tags, now);
    expect(result.ai).toBe(1);
    expect(result.human).toBe(0);
  });

  it("uses the last audit on retagged conversations, rather than counting twice", () => {
    const events = [
      audit("first", "a", "ai", "2026-10-12T09:00:00Z"),
      audit("second", "a", "user", "2026-10-13T10:00:00Z"),
    ];
    const result = summarizeAgreements([conv("a")], events, tags, now);
    expect(result.total).toBe(1);
    expect(result.human).toBe(1);
    expect(result.ai).toBe(0);
  });

  it("attributes historical records without audited changes as unknown", () => {
    const result = summarizeAgreements([conv("old", "2026-09-10T12:00:00Z")], [], tags, now);
    expect(result.unknown).toBe(1);
    expect(result.attributionCoverage).toBe(0);
    expect(result.closedLast30Days).toBe(0);
  });

  it("does not misattribute when the audited tag label changed", () => {
    const events = [audit("a1", "a", "user", "2026-10-13T12:00:00Z", "Outra Tabulação")];
    expect(summarizeAgreements([conv("a")], events, tags, now).unknown).toBe(1);
  });

  it("does not infer AI closing from bot messages, agent assignment or missing audit", () => {
    const result = summarizeAgreements([conv("a"), conv("b")], [], tags, now);
    expect(result).toMatchObject({ ai: 0, human: 0, unknown: 2 });
  });

  it("uses São Paulo calendar day for today's closure count", () => {
    const beforeMidnight = conv("first", "2026-10-15T02:59:00Z"); // 23:59 previous day Brasília
    const today = conv("second", "2026-10-15T03:01:00Z");
    const result = summarizeAgreements([beforeMidnight, today], [], tags, now);
    expect(result.closedToday).toBe(1);
  });

  it("counts closure in a rolling 7-day and 30-day window", () => {
    const result = summarizeAgreements(
      [
        conv("today", "2026-10-15T11:00:00Z"),
        conv("week", "2026-10-10T12:00:00Z"),
        conv("month", "2026-09-20T12:00:00Z"),
        conv("old", "2026-09-10T12:00:00Z"),
        conv("still-open", null),
      ],
      [],
      tags,
      now,
    );
    expect(result).toMatchObject({
      total: 5, closedToday: 1, closedLast7Days: 2, closedLast30Days: 3,
    });
  });

  it("never counts future closure dates in historical windows", () => {
    const result = summarizeAgreements([conv("future", "2026-10-16T13:00:00Z")], [], tags, now);
    expect(result).toMatchObject({ total: 1, closedToday: 0, closedLast7Days: 0, closedLast30Days: 0 });
  });

  it("handles an audit with unexpected metadata conservatively", () => {
    const events = [{ id: "a1", resource_id: "a", actor_type: "ai", created_at: now.toISOString(), changes: "invalid" }];
    expect(summarizeAgreements([conv("a")], events, tags, now).unknown).toBe(1);
  });

  it("calculates real distribution ratio using only attributable entries", () => {
    const events = [
      audit("one", "a", "ai"),
      audit("two", "b", "user"),
      audit("three", "c", "user"),
    ];
    const summary = summarizeAgreements([conv("a"), conv("b"), conv("c"), conv("d")], events, tags, now);
    expect(summary).toMatchObject({
      total: 4, ai: 1, human: 2, unknown: 1,
      aiShareOfAttributed: 33, attributionCoverage: 75,
    });
  });
});
