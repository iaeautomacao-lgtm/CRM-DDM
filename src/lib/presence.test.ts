import { describe, expect, it } from "vitest";

import {
  OFFLINE_AFTER_MS,
  derivePresence,
  formatLastSeen,
  presenceLabel,
  summarize,
} from "./presence";

// Fixed reference clock so every case is deterministic.
const NOW = new Date("2026-06-22T12:00:00.000Z").getTime();
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("derivePresence", () => {
  it("returns the stored status for a fresh heartbeat", () => {
    expect(derivePresence("online", ago(1_000), NOW)).toBe("online");
    expect(derivePresence("away", ago(1_000), NOW)).toBe("away");
  });

  it("reads as offline when the heartbeat is stale", () => {
    expect(derivePresence("online", ago(OFFLINE_AFTER_MS + 1_000), NOW)).toBe(
      "offline",
    );
    // Stored 'away' goes stale to offline too (tab was closed while idle).
    expect(derivePresence("away", ago(OFFLINE_AFTER_MS + 1_000), NOW)).toBe(
      "offline",
    );
  });

  it("treats a missing row or timestamp as offline", () => {
    expect(derivePresence(undefined, null, NOW)).toBe("offline");
    expect(derivePresence("online", null, NOW)).toBe("offline");
    expect(derivePresence("online", "not-a-date", NOW)).toBe("offline");
  });

  it("stays online exactly at the threshold and flips just past it", () => {
    expect(derivePresence("online", ago(OFFLINE_AFTER_MS), NOW)).toBe("online");
    expect(derivePresence("online", ago(OFFLINE_AFTER_MS + 1), NOW)).toBe(
      "offline",
    );
  });
});

describe("formatLastSeen", () => {
  it("describes recent activity coarsely", () => {
    expect(formatLastSeen(ago(10_000), NOW)).toBe("agora mesmo");
    expect(formatLastSeen(ago(60_000), NOW)).toBe("há 1 minuto");
    expect(formatLastSeen(ago(5 * 60_000), NOW)).toBe("há 5 minutos");
  });

  it("rolls up into hours and days", () => {
    expect(formatLastSeen(ago(60 * 60_000), NOW)).toBe("há 1 hora");
    expect(formatLastSeen(ago(2 * 60 * 60_000), NOW)).toBe("há 2 horas");
    expect(formatLastSeen(ago(24 * 60 * 60_000), NOW)).toBe("há 1 dia");
    expect(formatLastSeen(ago(3 * 24 * 60 * 60_000), NOW)).toBe("há 3 dias");
  });

  it("falls back gracefully on missing/invalid input", () => {
    expect(formatLastSeen(null, NOW)).toBe("há algum tempo");
    expect(formatLastSeen("nonsense", NOW)).toBe("há algum tempo");
  });
});

describe("presenceLabel", () => {
  it("labels each state for the tooltip", () => {
    expect(presenceLabel("online", ago(1_000), NOW)).toBe(
      "Online — ativo agora",
    );
    expect(presenceLabel("away", ago(1_000), NOW)).toBe("Ausente — inativo");
    expect(presenceLabel("offline", ago(2 * 60 * 60_000), NOW)).toBe(
      "Offline — visto pela última vez há 2 horas",
    );
  });
});

describe("summarize", () => {
  it("counts each status", () => {
    expect(
      summarize(["online", "online", "online", "away", "offline"]),
    ).toEqual({ online: 3, away: 1, offline: 1 });
  });

  it("returns zeroes for an empty roster", () => {
    expect(summarize([])).toEqual({ online: 0, away: 0, offline: 0 });
  });
});
