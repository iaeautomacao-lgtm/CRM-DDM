// A3: backoff da preparação de campanha agendada — 1, 2, 4, 8, 16, 30 min (teto), motivo com a tentativa, alerta na 5ª falha.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const writeLog = vi.fn();
vi.mock("@/lib/logger", () => ({ writeLog: (...a: unknown[]) => writeLog(...a) }));

import {
  formatPrepareRetryReason,
  prepareBackoffMinutes,
  recordPrepareRetry,
  resetPrepareBackoff,
  shouldAlertPrepare,
} from "./prepare-backoff";

/* eslint-disable @typescript-eslint/no-explicit-any */
function fakeDb(opts: { attempts?: number; noColumns?: boolean } = {}) {
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    from: () => {
      let values: Record<string, unknown> | null = null;
      const b: any = {};
      for (const m of ["select", "eq", "gt", "limit"]) b[m] = () => b;
      b.update = (v: Record<string, unknown>) => ((values = v), b);
      b.then = (resolve: (v: unknown) => void) => {
        if (values) {
          const usesNew = "prepare_attempts" in values || "next_prepare_at" in values;
          if (usesNew && opts.noColumns) return resolve({ data: null, error: { code: "42703", message: "column prepare_attempts does not exist" } });
          updates.push(values);
          return resolve({ data: null, error: null });
        }
        if (opts.noColumns) return resolve({ data: null, error: { code: "42703", message: "column campaigns.prepare_attempts does not exist" } });
        return resolve({ data: [{ prepare_attempts: opts.attempts ?? 0 }], error: null });
      };
      return b;
    },
  } as unknown as SupabaseClient;
  return { db, updates };
}

const NOW = new Date("2026-10-08T12:00:00.000Z");
beforeEach(() => {
  writeLog.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("curva do backoff", () => {
  it("1, 2, 4, 8, 16, 30, 30… (teto de 30 min)", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(prepareBackoffMinutes)).toEqual([1, 2, 4, 8, 16, 30, 30, 30]);
    expect(prepareBackoffMinutes(0)).toBe(1);
  });
  it("alerta na 5ª falha seguida e depois a cada 10 (15ª, 25ª…) — nunca a cada tentativa", () => {
    expect([1, 2, 3, 4, 5, 6, 14, 15, 16, 25].map(shouldAlertPrepare)).toEqual([false, false, false, false, true, false, false, true, false, true]);
  });
  it("texto do motivo: tentativa, espera e causa; sem dizer que voltou para rascunho", () => {
    const text = formatPrepareRetryReason("fetch failed", "2026-10-08T11:00:00.000Z", 3, 4);
    expect(text).toMatch(/tentativa 3/);
    expect(text).toMatch(/nova tentativa em 4 min/);
    expect(text).toMatch(/fetch failed/);
    expect(text).not.toMatch(/rascunho/);
  });
});

describe("recordPrepareRetry", () => {
  it("1ª falha: attempts=1, próxima tentativa em 1 min, motivo gravado, sem alerta", async () => {
    const { db, updates } = fakeDb({ attempts: 0 });
    const r = await recordPrepareRetry(db, { campaignId: "c1", accountId: "acc", agendamento: null, error: "timeout", now: NOW });
    expect(r).toEqual({ attempts: 1, delayMinutes: 1 });
    expect(updates[0]).toMatchObject({ prepare_attempts: 1, next_prepare_at: "2026-10-08T12:01:00.000Z" });
    expect(String(updates[0].motivo_falha_inicio)).toMatch(/tentativa 1/);
    expect(writeLog).not.toHaveBeenCalled();
  });

  it("sobe a partir do contador gravado e respeita o teto: 6ª falha espera 30 min", async () => {
    const { db, updates } = fakeDb({ attempts: 5 });
    const r = await recordPrepareRetry(db, { campaignId: "c1", accountId: "acc", agendamento: null, error: "x", now: NOW });
    expect(r).toEqual({ attempts: 6, delayMinutes: 30 });
    expect(updates[0].next_prepare_at).toBe("2026-10-08T12:30:00.000Z");
  });

  it("5ª falha seguida: alerta de ERRO no feed (evento campaign_prepare_alert) com campanha, tentativas e causa", async () => {
    const { db } = fakeDb({ attempts: 4 });
    await recordPrepareRetry(db, { campaignId: "c1", accountId: "acc", agendamento: null, error: "banco indisponível", now: NOW });
    expect(writeLog).toHaveBeenCalledTimes(1);
    expect(writeLog.mock.calls[0][0]).toMatchObject({
      account_id: "acc",
      level: "error",
      source: "disparador",
      event: "campaign_prepare_alert",
      payload: expect.objectContaining({ campaign_id: "c1", attempts: 5 }),
    });
  });

  it("sem a migration 196 (colunas ausentes): grava só o motivo, sem lançar", async () => {
    const { db, updates } = fakeDb({ noColumns: true });
    const r = await recordPrepareRetry(db, { campaignId: "c1", accountId: "acc", agendamento: null, error: "x", now: NOW });
    expect(r).toEqual({ attempts: 1, delayMinutes: 1 });
    expect(updates).toHaveLength(1);
    expect(Object.keys(updates[0])).toEqual(["motivo_falha_inicio"]);
  });

  it("qualquer falha interna é engolida (nunca derruba o fluxo de início)", async () => {
    const db = {
      from: () => {
        throw new Error("boom");
      },
    } as unknown as SupabaseClient;
    expect(await recordPrepareRetry(db, { campaignId: "c1", accountId: "acc", agendamento: null, error: "x" })).toBeNull();
  });
});

describe("resetPrepareBackoff", () => {
  it("zera contador e espera só de quem tinha tentativas", async () => {
    const { db, updates } = fakeDb();
    await resetPrepareBackoff(db, "c1");
    expect(updates[0]).toEqual({ prepare_attempts: 0, next_prepare_at: null });
  });
  it("sem a migration: silencioso", async () => {
    const { db } = fakeDb({ noColumns: true });
    await expect(resetPrepareBackoff(db, "c1")).resolves.toBeUndefined();
  });
});
