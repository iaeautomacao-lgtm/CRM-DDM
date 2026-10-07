import { describe, expect, it } from "vitest";
import { computeCampaignTiming, type CampaignStatusAuditEvent } from "./campaign-timing";

const HOUR = 3600;
const janela = { inicio: "13:00", fim: "18:00", dias: [1, 2, 3, 4, 5] };

function event(at: string, before: string, after: string): CampaignStatusAuditEvent {
  return { created_at: at, changes: { status: { before, after } } };
}

describe("computeCampaignTiming", () => {
  it("remove pausas do tempo efetivo e mantém o tempo corrido separado", () => {
    const result = computeCampaignTiming({
      currentStatus: "encerrada",
      updatedAt: "2026-10-07T21:00:00.000Z",
      janela,
      events: [
        event("2026-10-07T16:00:00.000Z", "preparando", "em_execucao"), // 13:00 BR
        event("2026-10-07T17:00:00.000Z", "em_execucao", "pausada"),    // 14:00 BR
        event("2026-10-07T18:00:00.000Z", "pausada", "em_execucao"),    // 15:00 BR
        event("2026-10-07T21:00:00.000Z", "em_execucao", "encerrada"),  // 18:00 BR
      ],
      nowMs: Date.parse("2026-10-07T21:00:00.000Z"),
    });

    expect(result.active_seconds).toBe(4 * HOUR);
    expect(result.paused_seconds).toBe(1 * HOUR);
    expect(result.wall_clock_seconds).toBe(5 * HOUR);
    expect(result.pause_count).toBe(1);
    expect(result.history_complete).toBe(true);
  });

  it("não conta noite como tempo efetivo nem como pausa operacional", () => {
    const result = computeCampaignTiming({
      currentStatus: "encerrada",
      updatedAt: "2026-10-08T18:00:00.000Z",
      janela,
      events: [
        event("2026-10-07T19:00:00.000Z", "preparando", "em_execucao"), // qua 16:00 BR
        event("2026-10-07T20:00:00.000Z", "em_execucao", "pausada"),    // qua 17:00 BR
        event("2026-10-08T17:00:00.000Z", "pausada", "em_execucao"),    // qui 14:00 BR
        event("2026-10-08T18:00:00.000Z", "em_execucao", "encerrada"),  // qui 15:00 BR
      ],
      nowMs: Date.parse("2026-10-08T18:00:00.000Z"),
    });

    expect(result.active_seconds).toBe(2 * HOUR);
    expect(result.paused_seconds).toBe(2 * HOUR); // qua 17–18 + qui 13–14
    expect(result.wall_clock_seconds).toBe(23 * HOUR);
    expect(result.pause_count).toBe(1);
  });

  it("campanha em execução soma até agora", () => {
    const result = computeCampaignTiming({
      currentStatus: "em_execucao",
      janela,
      events: [
        event("2026-10-07T16:00:00.000Z", "preparando", "em_execucao"),
      ],
      nowMs: Date.parse("2026-10-07T17:30:00.000Z"),
    });
    expect(result.active_seconds).toBe(90 * 60);
    expect(result.wall_clock_seconds).toBe(90 * 60);
    expect(result.ended_at).toBeNull();
  });

  it("não inventa início quando o histórico começa numa retomada", () => {
    const result = computeCampaignTiming({
      currentStatus: "em_execucao",
      janela,
      events: [
        event("2026-10-07T18:00:00.000Z", "pausada", "em_execucao"),
      ],
      nowMs: Date.parse("2026-10-07T19:00:00.000Z"),
    });
    expect(result.history_complete).toBe(false);
    expect(result.started_at).toBeNull();
    expect(result.active_seconds).toBeNull();
  });
});
