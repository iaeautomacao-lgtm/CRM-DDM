import { describe, expect, it } from "vitest";
import { agentMetricsRange, formatFirstResponse, indexMetricsByAgent } from "./agent-metrics";

describe("agent-metrics", () => {
  it("Hoje começa à meia-noite de Brasília", () => {
    // 2026-10-09 15:00 UTC = 12:00 em Brasília; o dia começou 03:00 UTC.
    const now = Date.parse("2026-10-09T15:00:00Z");
    expect(agentMetricsRange("hoje", now)).toEqual({ from: "2026-10-09T03:00:00.000Z", to: "2026-10-09T15:00:00.000Z" });
    // 01:00 UTC ainda é o dia anterior em Brasília.
    const early = Date.parse("2026-10-09T01:00:00Z");
    expect(agentMetricsRange("hoje", early).from).toBe("2026-10-08T03:00:00.000Z");
  });

  it("7 dias recua 7 dias exatos", () => {
    const now = Date.parse("2026-10-09T15:00:00Z");
    expect(agentMetricsRange("7d", now).from).toBe("2026-10-02T15:00:00.000Z");
  });

  it("formata a 1ª resposta", () => {
    expect(formatFirstResponse(null)).toBe("—");
    expect(formatFirstResponse(40)).toBe("40 s");
    expect(formatFirstResponse(12 * 60)).toBe("12 min");
    expect(formatFirstResponse(65 * 60)).toBe("1 h 05 min");
  });

  it("indexa por atendente", () => {
    const m = indexMetricsByAgent([{ agent_id: "a", first_response_count: 1, first_response_avg_seconds: 30, resolved_count: 2 }]);
    expect(m.get("a")?.resolved_count).toBe(2);
    expect(m.get("b")).toBeUndefined();
  });
});
