import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AI_HEARTBEAT_FRESH_MS,
  AI_HEARTBEAT_MIN_INTERVAL_MS,
  createAiHeartbeat,
  isAiHeartbeatFresh,
} from "./heartbeat";

type Update = { payload: Record<string, unknown>; filters: Array<[string, unknown]> };

function fakeDb(error: { message: string } | null = null) {
  const updates: Update[] = [];
  const from = vi.fn(() => {
    const u: Update = { payload: {}, filters: [] };
    const b: Record<string, unknown> = {
      update: (p: Record<string, unknown>) => { u.payload = p; return b; },
      eq: (c: string, v: unknown) => { u.filters.push([c, v]); return b; },
      then: (resolve: (v: unknown) => void) => {
        updates.push(u);
        resolve({ error });
      },
    };
    return b;
  });
  return { db: { from } as unknown as SupabaseClient, updates };
}

describe("isAiHeartbeatFresh", () => {
  const now = new Date("2026-10-06T12:00:00Z");
  it("fresco por menos de 2 min", () => {
    expect(isAiHeartbeatFresh(new Date(now.getTime() - 40_000).toISOString(), now)).toBe(true);
    expect(isAiHeartbeatFresh(new Date(now.getTime() - AI_HEARTBEAT_FRESH_MS).toISOString(), now)).toBe(false);
    expect(isAiHeartbeatFresh(null, now)).toBe(false);
    expect(isAiHeartbeatFresh("lixo", now)).toBe(false);
  });
});

describe("createAiHeartbeat", () => {
  it("grava, respeita o intervalo mínimo e limpa só a própria marca", async () => {
    let t = Date.parse("2026-10-06T12:00:00Z");
    const { db, updates } = fakeDb();
    const hb = createAiHeartbeat(db, "c1", () => t);

    await hb.beat(true);
    t += 1_000;
    await hb.beat(); // dentro do intervalo mínimo: não grava
    t += AI_HEARTBEAT_MIN_INTERVAL_MS;
    await hb.beat();
    expect(updates).toHaveLength(2);
    expect(updates[1].payload.ai_in_progress_at).toBe(new Date(t).toISOString());

    await hb.clear();
    expect(updates[2].payload).toEqual({ ai_in_progress_at: null });
    expect(updates[2].filters).toEqual([
      ["id", "c1"],
      ["ai_in_progress_at", new Date(t).toISOString()],
    ]);
  });

  it("sem gravação, clear não faz nada", async () => {
    const { db, updates } = fakeDb();
    await createAiHeartbeat(db, "c1").clear();
    expect(updates).toHaveLength(0);
  });

  it("coluna ausente (migration pendente): para de tentar, sem lançar", async () => {
    const { db, updates } = fakeDb({ message: 'column "ai_in_progress_at" does not exist' });
    const hb = createAiHeartbeat(db, "c1");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await hb.beat(true);
    await hb.beat(true);
    await hb.clear();
    expect(updates).toHaveLength(1);
    warn.mockRestore();
  });
});
