import { describe, expect, it } from "vitest";
import { computeDayView, dayBounds, isValidDay, todayInBrazil, type DayConversationRow } from "./day-view";

const row = (over: Partial<DayConversationRow>): DayConversationRow => ({
  channel_type: "whatsapp",
  team_id: null,
  assigned_agent_id: null,
  status: "open",
  created_at: "2026-10-05T12:00:00Z",
  first_response_at: null,
  closed_at: null,
  ...over,
});

describe("datas em Brasília", () => {
  it("hoje vira no fuso -03:00", () => {
    expect(todayInBrazil(Date.parse("2026-10-06T02:59:00Z"))).toBe("2026-10-05");
    expect(todayInBrazil(Date.parse("2026-10-06T03:00:00Z"))).toBe("2026-10-06");
  });
  it("limites do dia", () => {
    const b = dayBounds("2026-10-05");
    expect(new Date(b.startMs).toISOString()).toBe("2026-10-05T03:00:00.000Z");
    expect(b.endMs - b.startMs).toBe(86_400_000);
  });
  it("valida formato", () => {
    expect(isValidDay("2026-10-05")).toBe(true);
    expect(isValidDay("05/10/2026")).toBe(false);
    expect(isValidDay(null)).toBe(false);
  });
});

describe("computeDayView", () => {
  it("conta recebidas, atendidas, finalizadas e em aberto", () => {
    const rows = [
      row({ assigned_agent_id: "a1", created_at: "2026-10-05T12:00:00Z", first_response_at: "2026-10-05T12:10:00Z" }),
      // criada ontem, atendida e finalizada hoje
      row({
        assigned_agent_id: "a1",
        status: "closed",
        created_at: "2026-10-04T20:00:00Z",
        first_response_at: "2026-10-05T11:00:00Z",
        closed_at: "2026-10-05T13:00:00Z",
      }),
      row({ created_at: "2026-10-05T03:30:00Z" }), // 00:30 em Brasília
    ];
    const v = computeDayView(rows, "2026-10-05", true);
    expect(v.total).toMatchObject({ received: 2, attended: 2, closed: 1, open: 2 });
    expect(v.hourly[0]).toBe(1);
    expect(v.hourly[9]).toBe(1); // 12:00Z = 09h em Brasília
    const a1 = v.byAgent.find((s) => s.key === "a1");
    expect(a1).toMatchObject({ attended: 2, closed: 1, open: 1 });
    expect(v.byAgent.find((s) => s.key === "none")).toMatchObject({ received: 1, open: 1 });
  });

  it("em outro dia 'em aberto' fica zerado", () => {
    const v = computeDayView([row({})], "2026-10-05", false);
    expect(v.total.open).toBe(0);
  });

  it("média da 1ª resposta em minutos", () => {
    const v = computeDayView(
      [
        row({ created_at: "2026-10-05T12:00:00Z", first_response_at: "2026-10-05T12:05:00Z" }),
        row({ created_at: "2026-10-05T12:00:00Z", first_response_at: "2026-10-05T12:15:00Z" }),
      ],
      "2026-10-05",
      true
    );
    expect(v.total.firstResponseAvgMin).toBe(10);
  });
});
