import { describe, expect, it, vi } from "vitest";

const emit = vi.fn(async () => ({ emitted: true, webhooks: 1, pushSent: 0 }));
vi.mock("@/lib/disparador/active-alerts", () => ({ emitActiveAlert: (...a: unknown[]) => emit(...(a as [])) }));

import { alertStalledCrons } from "./cron-stalled-alert";

const NOW = new Date("2026-10-13T12:00:00Z");
const iso = (secondsAgo: number) => new Date(NOW.getTime() - secondsAgo * 1000).toISOString();

// from("cron_heartbeat") devolve o batimento; from("accounts") devolve as contas.
function fakeDb(heartbeat: Array<Record<string, unknown>> | null, accounts: Array<{ id: string }> = [{ id: "A" }, { id: "B" }]) {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {
        select: () => b,
        order: () => b,
        limit: () => Promise.resolve(table === "cron_heartbeat" ? (heartbeat ? { data: heartbeat, error: null } : { data: null, error: { message: "x" } }) : { data: accounts, error: null }),
      };
      return b;
    },
    rpc: vi.fn(),
  } as never;
}

const row = (job: string, ageSeconds: number, every = 60) => ({
  job,
  expected_every_seconds: every,
  last_ok_at: iso(ageSeconds),
  last_status: "ok",
  last_error: null,
  runs: 10,
  failures: 0,
});

describe("alertStalledCrons", () => {
  it("avisa cada conta sobre cada cron parado, e só sobre os parados", async () => {
    emit.mockClear();
    const db = fakeDb([row("disparador_tick", 20 * 60), row("webhooks_out", 30), row("flows", 400, 300)]);
    const r = await alertStalledCrons(db, NOW);
    expect(r.stalled).toEqual(["disparador_tick"]);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[0]).toEqual([
      db,
      expect.objectContaining({ accountId: "A", event: "dispatch.cron_stalled", subjectId: "disparador_tick", data: expect.objectContaining({ job: "disparador_tick", age_seconds: 1200 }) }),
    ]);
  });

  it("o cron de saúde não se avisa a si mesmo", async () => {
    emit.mockClear();
    const r = await alertStalledCrons(fakeDb([row("disparador_health", 3 * 3600, 600)]), NOW);
    expect(r.stalled).toEqual([]);
    expect(emit).not.toHaveBeenCalled();
  });

  it("sem batimento legível (migration 334 ausente) não faz nada e não lança", async () => {
    emit.mockClear();
    await expect(alertStalledCrons(fakeDb(null), NOW)).resolves.toEqual({ stalled: [], alerts: 0 });
    expect(emit).not.toHaveBeenCalled();
  });
});
