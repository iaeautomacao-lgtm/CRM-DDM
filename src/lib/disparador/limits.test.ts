import { describe, expect, it } from "vitest";
import {
  applyLimitsChange,
  diffLimits,
  LimitsInputError,
  loadLimitsOverview,
  maxInFlightCeiling,
  parseLimitsRequest,
  summarizeChanges,
  validatePatchForProvider,
  type LimitsDb,
} from "./limits";

const ACC = "00000000-0000-0000-0000-0000000000a1";
const META = "00000000-0000-0000-0000-0000000000d1";
const WAHA = "00000000-0000-0000-0000-0000000000d2";
const OTHER = "00000000-0000-0000-0000-0000000000d9";
const ENV = {};

type Op = [string, ...unknown[]];
interface Call {
  table: string;
  ops: Op[];
}
type Handler = (call: Call) => { data: unknown; error?: { message: string; code?: string } | null };

function fakeDb(handlers: Record<string, Handler>) {
  const calls: Call[] = [];
  const db = {
    from(table: string) {
      const call: Call = { table, ops: [] };
      calls.push(call);
      const proxy: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "is", "gte", "order", "limit", "update", "insert"]) {
        proxy[m] = (...args: unknown[]) => {
          call.ops.push([m, ...args]);
          return proxy;
        };
      }
      proxy.then = (resolve: (v: unknown) => unknown) => {
        const r = handlers[table]?.(call) ?? { data: [] };
        return resolve({ data: r.data, error: r.error ?? null });
      };
      return proxy;
    },
  };
  return { db: db as unknown as LimitsDb, calls };
}
const has = (call: Call, ...op: Op) => call.ops.some((o) => JSON.stringify(o) === JSON.stringify(op));
const find = (calls: Call[], table: string, method: string) => calls.find((c) => c.table === table && c.ops.some((o) => o[0] === method));

// Colunas reais de whatsapp_config (o nome da Meta vem de channel_health.verified_name; o do WAHA, de waha_session).
const cfg = (id: string, provider: string, name: string) => ({
  id,
  display_phone_number: "5511",
  phone_number_id: "pn-" + id.slice(0, 4),
  waha_session: provider === "waha" ? name : null,
  provider,
  habilitado: true,
});
const healthName = (id: string, name: string) => ({ session_id: id, verified_name: name, display_phone_number: "5511", checked_at: "2026-10-08T10:00:00Z", last_error: null });
const base = { sessionId: META, reason: "teste de capacidade", confirm: true };

describe("parseLimitsRequest", () => {
  it("aceita um pedido válido e normaliza", () => {
    const r = parseLimitsRequest({ ...base, sessionId: META.toUpperCase(), maxInFlight: 20, hourlyLimit: null, paused: true, expected: { maxInFlight: 4, hourlyLimit: null, paused: false } });
    expect(r).toMatchObject({ sessionId: META, patch: { maxInFlight: 20, hourlyLimit: null, paused: true }, expected: { maxInFlight: 4, hourlyLimit: null, paused: false } });
  });
  it("motivo obrigatório (mínimo 5, máximo 300)", () => {
    expect(() => parseLimitsRequest({ ...base, reason: "  ", maxInFlight: 5 })).toThrow(/motivo/i);
    expect(() => parseLimitsRequest({ ...base, reason: "abc", maxInFlight: 5 })).toThrow(/motivo/i);
    expect(() => parseLimitsRequest({ ...base, reason: "x".repeat(301), maxInFlight: 5 })).toThrow(/motivo/i);
  });
  it("exige confirmação explícita", () => {
    expect(() => parseLimitsRequest({ ...base, confirm: undefined, maxInFlight: 5 })).toThrow(/confirmad/i);
    expect(() => parseLimitsRequest({ ...base, confirm: "true", maxInFlight: 5 })).toThrow(/confirmad/i);
  });
  it("rejeita tipos e faixas inválidas e pedido vazio", () => {
    for (const body of [
      null,
      "x",
      { ...base, sessionId: "abc", maxInFlight: 5 },
      { ...base, maxInFlight: 5.5 },
      { ...base, maxInFlight: "5" },
      { ...base, hourlyLimit: 0 },
      { ...base, hourlyLimit: 2_000_000 },
      { ...base, hourlyLimit: 1.5 },
      { ...base, paused: "sim" },
      { ...base },
    ]) {
      expect(() => parseLimitsRequest(body), JSON.stringify(body)).toThrow(LimitsInputError);
    }
  });
});

describe("faixas por provedor", () => {
  it("Meta 1..150; WAHA e desconhecido 1..50", () => {
    expect(maxInFlightCeiling("meta")).toBe(150);
    expect(maxInFlightCeiling("waha")).toBe(50);
    expect(maxInFlightCeiling("unknown")).toBe(50);
    expect(() => validatePatchForProvider({ maxInFlight: 150 }, "meta")).not.toThrow();
    expect(() => validatePatchForProvider({ maxInFlight: 151 }, "meta")).toThrow(LimitsInputError);
    expect(() => validatePatchForProvider({ maxInFlight: 51 }, "waha")).toThrow(/WAHA/);
    expect(() => validatePatchForProvider({ maxInFlight: 0 }, "meta")).toThrow(LimitsInputError);
    expect(() => validatePatchForProvider({ hourlyLimit: 10 }, "waha")).not.toThrow();
  });
});

describe("diff antes → depois", () => {
  it("só entram campos que mudaram", () => {
    const cur = { maxInFlight: 4, hourlyLimit: null, paused: false };
    expect(diffLimits(cur, { maxInFlight: 4, hourlyLimit: 100, paused: false })).toEqual([{ field: "hourly_limit", before: null, after: 100 }]);
    expect(diffLimits(cur, { maxInFlight: 4 })).toEqual([]);
    expect(summarizeChanges("Principal", diffLimits(cur, { maxInFlight: 20, paused: true }))).toBe(
      "Número Principal: vagas 4 → 20; pausa ativo → pausado",
    );
  });
});

describe("applyLimitsChange", () => {
  const baseHandlers = (limitRow: unknown): Record<string, Handler> => ({
    whatsapp_config: (call) => {
      const id = call.ops.find((o) => o[0] === "eq" && o[1] === "id")?.[2];
      const acc = call.ops.find((o) => o[0] === "eq" && o[1] === "account_id")?.[2];
      const all = [cfg(META, "meta", "Principal"), cfg(WAHA, "waha", "Waha")];
      return { data: acc === ACC ? all.filter((c) => c.id === id) : [] };
    },
    dispatch_channel_limits: (call) => (call.ops.some((o) => o[0] === "select") ? { data: limitRow ? [limitRow] : [] } : { data: null }),
  });
  const req = (patch: object, expected: object | null = null) => parseLimitsRequest({ ...base, ...patch, ...(expected ? { expected } : {}) });

  it("número de outra conta ou inexistente: 404 e nada é gravado", async () => {
    const { db, calls } = fakeDb(baseHandlers(null));
    await expect(applyLimitsChange(db, "00000000-0000-0000-0000-0000000000ff", req({ maxInFlight: 10 }), ENV)).rejects.toMatchObject({ status: 404 });
    await expect(applyLimitsChange(db, ACC, req({ sessionId: OTHER, maxInFlight: 10 }), ENV)).rejects.toMatchObject({ status: 404 });
    expect(calls.some((c) => c.ops.some((o) => o[0] === "update" || o[0] === "insert"))).toBe(false);
    expect(has(calls[0], "eq", "account_id", "00000000-0000-0000-0000-0000000000ff")).toBe(true);
  });

  it("faixa por provedor vale na gravação (WAHA ≤ 50)", async () => {
    const { db, calls } = fakeDb(baseHandlers(null));
    await expect(applyLimitsChange(db, ACC, req({ sessionId: WAHA, maxInFlight: 60 }), ENV)).rejects.toThrow(/WAHA/);
    await expect(applyLimitsChange(db, ACC, req({ maxInFlight: 151 }), ENV)).rejects.toBeInstanceOf(LimitsInputError);
    expect(calls.some((c) => c.ops.some((o) => o[0] === "update" || o[0] === "insert"))).toBe(false);
  });

  it("atualiza a linha existente só com os campos que mudaram", async () => {
    const { db, calls } = fakeDb(baseHandlers({ session_id: META, max_in_flight: 4, hourly_limit: null, paused: false }));
    const r = await applyLimitsChange(db, ACC, req({ maxInFlight: 40, hourlyLimit: 5000 }, { maxInFlight: 4, hourlyLimit: null, paused: false }), ENV);
    expect(r.noop).toBe(false);
    expect(r.changes).toEqual([
      { field: "max_in_flight", before: 4, after: 40 },
      { field: "hourly_limit", before: null, after: 5000 },
    ]);
    const upd = find(calls, "dispatch_channel_limits", "update")!;
    expect(upd.ops.find((o) => o[0] === "update")?.[1]).toEqual({ max_in_flight: 40, hourly_limit: 5000 });
    expect(has(upd, "eq", "session_id", META)).toBe(true);
  });

  it("sem linha: cria com as vagas padrão do provedor + a mudança pedida", async () => {
    const { db, calls } = fakeDb(baseHandlers(null));
    const r = await applyLimitsChange(db, ACC, req({ paused: true }), ENV);
    expect(r.changes).toEqual([{ field: "paused", before: false, after: true }]);
    const ins = find(calls, "dispatch_channel_limits", "insert")!;
    expect(ins.ops.find((o) => o[0] === "insert")?.[1]).toEqual({ session_id: META, max_in_flight: 4, paused: true });
  });

  it("mudança igual ao que já vale: não grava (noop)", async () => {
    const { db, calls } = fakeDb(baseHandlers({ session_id: META, max_in_flight: 20, hourly_limit: null, paused: false }));
    const r = await applyLimitsChange(db, ACC, req({ maxInFlight: 20 }), ENV);
    expect(r).toMatchObject({ noop: true, changes: [] });
    expect(calls.some((c) => c.ops.some((o) => o[0] === "update" || o[0] === "insert"))).toBe(false);
  });

  it("o 'antes' da tela mudou no banco: 409, ninguém sobrescreve", async () => {
    const { db, calls } = fakeDb(baseHandlers({ session_id: META, max_in_flight: 30, hourly_limit: null, paused: false }));
    await expect(applyLimitsChange(db, ACC, req({ maxInFlight: 40 }, { maxInFlight: 4 }), ENV)).rejects.toMatchObject({ status: 409 });
    expect(calls.some((c) => c.ops.some((o) => o[0] === "update" || o[0] === "insert"))).toBe(false);
  });

  it("pausa sem a migration 192: 409 explicando; sem tocar o banco", async () => {
    const h = baseHandlers(null);
    const { db, calls } = fakeDb({
      ...h,
      dispatch_channel_limits: (call) =>
        call.ops.some((o) => o[0] === "select" && String(o[1]).includes("paused"))
          ? { data: null, error: { message: 'column "paused" does not exist', code: "42703" } }
          : { data: [] },
    });
    await expect(applyLimitsChange(db, ACC, req({ paused: true }), ENV)).rejects.toMatchObject({ status: 409 });
    expect(calls.some((c) => c.ops.some((o) => o[0] === "update" || o[0] === "insert"))).toBe(false);
    // Vagas continuam editáveis sem a 192.
    const r = await applyLimitsChange(db, ACC, req({ maxInFlight: 8 }), ENV);
    expect(r.changes).toHaveLength(1);
  });
});

describe("loadLimitsOverview", () => {
  it("monta números (efetivo/padrão/teto/pausa/campanhas), globais e histórico", async () => {
    const { db, calls } = fakeDb({
      whatsapp_config: () => ({ data: [cfg(WAHA, "waha", "Waha"), cfg(META, "meta", "Principal")] }),
      channel_health: (call) => ({ data: call.ops.some((o) => String(o[1] ?? "").includes("verified_name")) ? [healthName(META, "Principal")] : [] }),
      dispatch_channel_limits: () => ({ data: [{ session_id: META, max_in_flight: 40, hourly_limit: 9000, paused: true }] }),
      campaigns: () => ({ data: [{ id: "c1", nome: "Camp", session_ids: [META] }] }),
      audit_logs: () => ({
        data: [{ id: "a1", created_at: "2026-10-07T10:00:00Z", resource_id: META, user_name: "Ana", summary: "s", changes: { paused: { before: false, after: true } }, metadata: { reason: "manutenção" } }],
      }),
    });
    const o = await loadLimitsOverview(db, ACC, { DISPATCH_PROCESS_CONCURRENCY: "16", DISPARADOR_BATCH_CLAIM: "1" });
    expect(o.numbers.map((n) => n.label)).toEqual(["Principal", "Waha"]);
    expect(o.numbers[0]).toMatchObject({ maxInFlight: 40, effectiveMaxInFlight: 40, maxAllowed: 150, hourlyLimit: 9000, paused: true, hasRow: true, activeCampaigns: [{ id: "c1", nome: "Camp" }] });
    expect(o.numbers[1]).toMatchObject({ maxInFlight: null, effectiveMaxInFlight: 4, maxAllowed: 50, paused: false, hasRow: false });
    expect(o.globals).toMatchObject({ processConcurrency: 16, batchClaimEnabled: true, tickChainEnabled: expect.any(Boolean) });
    expect(o.history[0]).toMatchObject({ numero: "Principal", userName: "Ana", reason: "manutenção" });
    expect(o.pauseSupported).toBe(true);
    // Sem dados de qualidade ainda: o número Meta aparece sem leitura, sem derrubar a tela.
    expect(o.rate?.[META]).toMatchObject({ quality: null, effectivePerSecond: null, manualPerSecond: null });
    // Tudo escopado pela conta.
    for (const t of ["whatsapp_config", "campaigns", "audit_logs"]) {
      expect(has(calls.find((c) => c.table === t)!, "eq", "account_id", ACC)).toBe(true);
    }
    expect(has(calls.find((c) => c.table === "audit_logs")!, "eq", "resource_type", "dispatch_channel_limits")).toBe(true);
  });

  const rateHandlers = {
    whatsapp_config: () => ({ data: [cfg(META, "meta", "Principal")] }),
    channel_health: () => ({ data: [{ ...healthName(META, "Principal"), quality_rating: "YELLOW", messaging_limit_tier: "TIER_10K", daily_limit: 10000 }] }),
    dispatch_channel_rate: () => ({
      data: [{ session_id: META, auto_rate_per_second: 30, manual_rate_per_second: 12, manual_reason: "teste", force_above_quality: false }],
    }),
    dispatch_channel_rate_history: () => ({
      data: [
        { id: "h1", created_at: "2026-10-07T11:00:00Z", session_id: META, source: "webhook", quality_old: "GREEN", quality_new: "YELLOW", rate_old: "50.00", rate_new: "30.00", reason: null },
      ],
    }),
  };

  it("liga qualidade, automático/manual/efetivo e o histórico do limite/s (PR #140)", async () => {
    const { db, calls } = fakeDb(rateHandlers);
    const o = await loadLimitsOverview(db, ACC, ENV);
    expect(o.rate?.[META]).toMatchObject({ quality: "YELLOW", tier: "TIER_10K", manualPerSecond: 12, manualReason: "teste" });
    expect(o.rate?.[META].effectivePerSecond).toBe(12);
    expect(o.rateCeiling).toBeGreaterThan(0);
    expect(o.rateHistory[0]).toMatchObject({ numero: "Principal", source: "webhook", qualityOld: "GREEN", qualityNew: "YELLOW", rateOld: 50, rateNew: 30 });
    expect(has(calls.find((c) => c.table === "dispatch_channel_rate_history" && c.ops.some((x) => x[0] === "order"))!, "eq", "account_id", ACC)).toBe(true);
  });

  it("sem a migration 190: limite/s indisponível (null), histórico vazio, o resto da tela segue", async () => {
    const { db } = fakeDb({
      ...rateHandlers,
      dispatch_rate_policy: () => ({ data: null, error: { message: 'relation "wacrm.dispatch_rate_policy" does not exist', code: "42P01" } }),
    });
    const o = await loadLimitsOverview(db, ACC, ENV);
    expect(o.rate).toBeNull();
    expect(o.rateCeiling).toBeNull();
    expect(o.rateHistory).toEqual([]);
    expect(o.numbers).toHaveLength(1);
  });
});
