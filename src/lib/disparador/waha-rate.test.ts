import { beforeEach, describe, expect, it, vi } from "vitest";

const audit = vi.fn(async () => {});
vi.mock("@/lib/audit/log-event", () => ({ logAuditEvent: (...a: unknown[]) => audit(...(a as [])) }));

import {
  DEFAULT_WAHA_RATE_PER_SECOND,
  listWahaRates,
  loadWahaRates,
  resolveWahaRate,
  setWahaRate,
  WahaRateError,
} from "./waha-rate";

type Row = Record<string, unknown>;

// Fake em memória: select/eq/in filtram, upsert/delete alteram, `missing` simula a migration 338 ausente.
function fakeDb(tables: Record<string, Row[]>, opts: { missing?: boolean } = {}) {
  return {
    from(table: string) {
      const rows = tables[table] ?? (tables[table] = []);
      const filters: Array<(r: Row) => boolean> = [];
      let op: "select" | "upsert" | "delete" = "select";
      let payload: Row = {};
      const run = () => {
        if (opts.missing && table === "dispatch_waha_rate") return { data: null, error: { code: "42P01", message: "relation does not exist" } };
        const hit = rows.filter((r) => filters.every((f) => f(r)));
        if (op === "upsert") {
          const i = rows.findIndex((r) => r.session_id === payload.session_id);
          if (i >= 0) rows[i] = { ...rows[i], ...payload };
          else rows.push({ ...payload });
          return { data: null, error: null };
        }
        if (op === "delete") {
          tables[table] = rows.filter((r) => !hit.includes(r));
          return { data: null, error: null };
        }
        return { data: hit, error: null };
      };
      const b: Record<string, unknown> = {
        select: () => b,
        upsert: (p: Row) => ((op = "upsert"), (payload = p), b),
        delete: () => ((op = "delete"), b),
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
        in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), b),
        limit: () => b,
        then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, ko),
      };
      return b;
    },
  } as never;
}

const S1 = "00000000-0000-0000-0000-0000000000a1";
const S2 = "00000000-0000-0000-0000-0000000000a2";
const META = "00000000-0000-0000-0000-0000000000a3";
const actor = { accountId: "A", userId: "u1", role: "admin" as const };

const seed = () => ({
  whatsapp_config: [
    { id: S1, account_id: "A", provider: "waha", waha_session: "WAHA 1" },
    { id: S2, account_id: "A", provider: "waha", waha_session: "WAHA 2" },
    { id: META, account_id: "A", provider: "meta", waha_session: "Meta" },
    { id: "00000000-0000-0000-0000-0000000000b1", account_id: "B", provider: "waha", waha_session: "Outra conta" },
  ] as Row[],
  dispatch_waha_rate: [] as Row[],
});

beforeEach(() => {
  audit.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("resolveWahaRate", () => {
  it("padrão conservador de 1/s quando não há linha ou o valor é inválido", () => {
    expect(DEFAULT_WAHA_RATE_PER_SECOND).toBe(1);
    expect(resolveWahaRate(null)).toBe(1);
    expect(resolveWahaRate({ rate_per_second: "abc" })).toBe(1);
    expect(resolveWahaRate({ rate_per_second: 0 })).toBe(1);
    expect(resolveWahaRate({ rate_per_second: 500 })).toBe(1);
  });
  it("aceita número ou texto numérico dentro da faixa (numeric do Postgres vem como texto)", () => {
    expect(resolveWahaRate({ rate_per_second: 2.5 })).toBe(2.5);
    expect(resolveWahaRate({ rate_per_second: "0.50" })).toBe(0.5);
  });
});

describe("loadWahaRates", () => {
  it("devolve só as sessões com linha; as demais ficam de fora (o cron aplica o padrão)", async () => {
    const t = seed();
    t.dispatch_waha_rate.push({ session_id: S1, account_id: "A", rate_per_second: "3.00" });
    const m = await loadWahaRates(fakeDb(t), [S1, S2]);
    expect([...m]).toEqual([[S1, 3]]);
  });
  it("sem a migration 338 devolve mapa vazio e não lança", async () => {
    await expect(loadWahaRates(fakeDb(seed(), { missing: true }), [S1])).resolves.toEqual(new Map());
  });
  it("sem sessões não consulta nada", async () => {
    expect((await loadWahaRates(fakeDb(seed()), [])).size).toBe(0);
  });
});

describe("listWahaRates", () => {
  it("lista só as sessões WAHA da conta, com origem padrão/personalizada", async () => {
    const t = seed();
    t.dispatch_waha_rate.push({ session_id: S2, account_id: "A", rate_per_second: 4, reason: "servidor novo", updated_at: "2026-10-13T12:00:00Z" });
    const v = await listWahaRates(fakeDb(t), "A");
    expect(v).toMatchObject({ default_rate_per_second: 1, min_rate_per_second: 0.1, max_rate_per_second: 20 });
    expect(v.channels).toEqual([
      { session_id: S1, label: "WAHA 1", rate_per_second: 1, source: "default", reason: null, updated_at: null },
      { session_id: S2, label: "WAHA 2", rate_per_second: 4, source: "custom", reason: "servidor novo", updated_at: "2026-10-13T12:00:00Z" },
    ]);
  });
  it("sem a migration 338 responde 503 com a instrução", async () => {
    await expect(listWahaRates(fakeDb(seed(), { missing: true }), "A")).rejects.toMatchObject({ status: 503 });
  });
});

describe("setWahaRate", () => {
  it("grava o valor, audita antes/depois e vale para a sessão", async () => {
    const t = seed();
    const r = await setWahaRate(fakeDb(t), actor, { session_id: S1, rate_per_second: 2, reason: "servidor aguenta" });
    expect(r).toEqual({ session_id: S1, rate_per_second: 2, source: "custom" });
    expect(t.dispatch_waha_rate[0]).toMatchObject({ session_id: S1, account_id: "A", rate_per_second: 2, updated_by: "u1" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "dispatch_waha_rate.set", changes: { rate_per_second: { before: 1, after: 2 } } }));
  });

  it("null volta ao padrão (remove a linha)", async () => {
    const t = seed();
    t.dispatch_waha_rate.push({ session_id: S1, account_id: "A", rate_per_second: 5 });
    const r = await setWahaRate(fakeDb(t), actor, { session_id: S1, rate_per_second: null, reason: "voltar ao padrão" });
    expect(r).toEqual({ session_id: S1, rate_per_second: 1, source: "default" });
    expect(t.dispatch_waha_rate).toHaveLength(0);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "dispatch_waha_rate.reset" }));
  });

  it.each([0, 0.05, 21, "x", NaN])("recusa valor fora da faixa (%s)", async (bad) => {
    await expect(setWahaRate(fakeDb(seed()), actor, { session_id: S1, rate_per_second: bad, reason: "teste" })).rejects.toMatchObject({ status: 422 });
  });

  it("exige motivo, UUID válido e canal WAHA da própria conta (Meta e outra conta dão 404)", async () => {
    const db = fakeDb(seed());
    await expect(setWahaRate(db, actor, { session_id: S1, rate_per_second: 2, reason: " " })).rejects.toMatchObject({ status: 422 });
    await expect(setWahaRate(db, actor, { session_id: "xx", rate_per_second: 2, reason: "teste" })).rejects.toMatchObject({ status: 400 });
    await expect(setWahaRate(db, actor, { session_id: META, rate_per_second: 2, reason: "teste" })).rejects.toMatchObject({ status: 404 });
    await expect(setWahaRate(db, { ...actor, accountId: "B" }, { session_id: S1, rate_per_second: 2, reason: "teste" })).rejects.toBeInstanceOf(WahaRateError);
  });

  it("só admin/proprietário (permissão campaigns.rate_limit): operador recebe 403", async () => {
    await expect(setWahaRate(fakeDb(seed()), { ...actor, role: "agent" }, { session_id: S1, rate_per_second: 2, reason: "teste" })).rejects.toMatchObject({ status: 403 });
  });
});
