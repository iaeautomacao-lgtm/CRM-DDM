import { describe, expect, it } from "vitest";
import { computeSla, type SlaConversationRow } from "./sla";

const now = Date.parse("2026-10-02T12:00:00Z");
const minsAgo = (m: number) => new Date(now - m * 60_000).toISOString();
const row = (over: Partial<SlaConversationRow>): SlaConversationRow => ({
  channel_type: "whatsapp",
  team_id: null,
  status: "open",
  assigned_agent_id: "a1",
  created_at: minsAgo(60),
  first_response_at: null,
  last_customer_message_at: null,
  ...over,
});

describe("computeSla", () => {
  const sinceMs = now - 86_400_000;

  it("primeira resposta: média, p90 e % na meta", () => {
    const rows = [
      row({ created_at: minsAgo(100), first_response_at: minsAgo(95) }), // 5 min
      row({ created_at: minsAgo(100), first_response_at: minsAgo(90) }), // 10 min
      row({ created_at: minsAgo(100), first_response_at: minsAgo(40) }), // 60 min
      row({ created_at: minsAgo(100) }), // sem resposta
    ];
    const { total } = computeSla(rows, { sinceMs, nowMs: now });
    expect(total.created).toBe(4);
    expect(total.responded).toBe(3);
    expect(total.firstResponseAvgMin).toBe(25);
    expect(total.firstResponseP90Min).toBe(60);
    expect(total.withinTargetPct).toBe(67);
  });

  it("fila: abertas sem atendente e a maior espera", () => {
    const rows = [
      row({ assigned_agent_id: null, last_customer_message_at: minsAgo(30) }),
      row({ assigned_agent_id: null, status: "pending", last_customer_message_at: minsAgo(90) }),
      row({ assigned_agent_id: null, status: "closed", last_customer_message_at: minsAgo(500) }),
    ];
    const { total } = computeSla(rows, { sinceMs, nowMs: now });
    expect(total.queued).toBe(2);
    expect(total.longestWaitMin).toBe(90);
  });

  it("conversa aberta antiga conta na fila mas não no período", () => {
    const old = row({ created_at: minsAgo(60 * 48), assigned_agent_id: null, last_customer_message_at: minsAgo(10) });
    const { total } = computeSla([old], { sinceMs, nowMs: now });
    expect(total.created).toBe(0);
    expect(total.queued).toBe(1);
    expect(total.firstResponseAvgMin).toBeNull();
  });

  it("agrupa por canal (whatsapp por padrão) e por equipe", () => {
    const rows = [
      row({ channel_type: null, team_id: "t1" }),
      row({ channel_type: "instagram", team_id: "t1" }),
      row({ channel_type: "instagram" }),
    ];
    const { byChannel, byTeam } = computeSla(rows, { sinceMs, nowMs: now });
    expect(byChannel.map((s) => [s.key, s.created])).toEqual([
      ["instagram", 2],
      ["whatsapp", 1],
    ]);
    expect(byTeam.map((s) => [s.key, s.created])).toEqual([
      ["t1", 2],
      ["none", 1],
    ]);
  });
});
