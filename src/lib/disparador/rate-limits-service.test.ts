import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb } from "./fake-db.test-helper";

const audit = vi.fn();
vi.mock("@/lib/audit/log-event", () => ({ logAuditEvent: (...a: unknown[]) => audit(...a) }));
vi.mock("@/lib/logger", () => ({ writeLog: vi.fn() }));

import { acknowledgeHistory, listRateLimits, RateLimitError, redChannelsNeedingOwner, revertToAuto, setManualRate, updatePolicy } from "./rate-limits-service";

const SESSION = "11111111-1111-1111-1111-111111111111";
const ACCOUNT = "acc-1";
const owner = { accountId: ACCOUNT, userId: "u-owner", role: "owner" as const };
const admin = { accountId: ACCOUNT, userId: "u-admin", role: "admin" as const };
const agent = { accountId: ACCOUNT, userId: "u-agent", role: "agent" as never };

function seed(quality: string | null = "GREEN") {
  return fakeDb({
    whatsapp_config: [{ id: SESSION, account_id: ACCOUNT, provider: "meta", display_phone_number: "+55 11 99999-0000", phone_number_id: "pn1" }],
    channel_health: quality ? [{ session_id: SESSION, account_id: ACCOUNT, quality_rating: quality, messaging_limit_tier: "TIER_10K", checked_at: new Date().toISOString() }] : [],
    dispatch_channel_rate: [{ session_id: SESSION, account_id: ACCOUNT, auto_rate_per_second: 80, manual_rate_per_second: null }],
    dispatch_rate_policy: [],
    dispatch_channel_rate_history: [],
  });
}

const fail = async (p: Promise<unknown>) => (await p.then(() => null, (e) => e)) as RateLimitError | null;

describe("setManualRate", () => {
  beforeEach(() => audit.mockClear());

  it("grava manual, histórico e auditoria", async () => {
    const { db, tables } = seed();
    await setManualRate(db, admin, { session_id: SESSION, rate_per_second: 20, reason: "teste de carga" });
    expect(tables.dispatch_channel_rate[0]).toMatchObject({ manual_rate_per_second: 20, manual_reason: "teste de carga", manual_set_by: "u-admin", force_above_quality: false });
    expect(tables.dispatch_channel_rate_history[0]).toMatchObject({ source: "admin", rate_new: 20, actor_id: "u-admin" });
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it("exige motivo", async () => {
    const e = await fail(setManualRate(seed().db, admin, { session_id: SESSION, rate_per_second: 20, reason: " " }));
    expect(e?.status).toBe(422);
  });

  it("valida 0 < rate ≤ teto", async () => {
    for (const rate of [0, -1, 81, "x"]) {
      const e = await fail(setManualRate(seed().db, admin, { session_id: SESSION, rate_per_second: rate, reason: "motivo ok" }));
      expect(e?.status, String(rate)).toBe(422);
    }
  });

  it("papel sem permissão leva 403", async () => {
    const e = await fail(setManualRate(seed().db, agent, { session_id: SESSION, rate_per_second: 5, reason: "motivo ok" }));
    expect(e?.status).toBe(403);
  });

  it("force_above_quality só owner", async () => {
    const e = await fail(setManualRate(seed("RED").db, admin, { session_id: SESSION, rate_per_second: 60, reason: "motivo ok", force_above_quality: true }));
    expect(e?.status).toBe(403);
    const { db, tables } = seed("RED");
    await setManualRate(db, owner, { session_id: SESSION, rate_per_second: 60, reason: "motivo ok", force_above_quality: true });
    expect(tables.dispatch_channel_rate[0].force_above_quality).toBe(true);
  });

  it("número de outra conta / WAHA não é alterado", async () => {
    const { db } = seed();
    expect((await fail(setManualRate(db, { ...admin, accountId: "outra" }, { session_id: SESSION, rate_per_second: 5, reason: "motivo ok" })))?.status).toBe(404);
    const waha = fakeDb({ whatsapp_config: [{ id: SESSION, account_id: ACCOUNT, provider: "waha" }] });
    expect((await fail(setManualRate(waha.db, admin, { session_id: SESSION, rate_per_second: 5, reason: "motivo ok" })))?.status).toBe(422);
  });

  it("tabelas ausentes → 503", async () => {
    const { db } = fakeDb({ whatsapp_config: [{ id: SESSION, account_id: ACCOUNT, provider: "meta" }] }, ["dispatch_rate_policy"]);
    expect((await fail(setManualRate(db, admin, { session_id: SESSION, rate_per_second: 5, reason: "motivo ok" })))?.status).toBe(503);
  });
});

describe("revertToAuto", () => {
  it("remove o manual e a trava, com histórico", async () => {
    const { db, tables } = seed();
    await setManualRate(db, owner, { session_id: SESSION, rate_per_second: 30, reason: "motivo ok", force_above_quality: true });
    await revertToAuto(db, admin, SESSION);
    expect(tables.dispatch_channel_rate[0]).toMatchObject({ manual_rate_per_second: null, force_above_quality: false });
    expect(tables.dispatch_channel_rate_history.at(-1)).toMatchObject({ source: "revert_auto", rate_old: 30, rate_new: 80 });
  });
  it("já automático → 409", async () => {
    expect((await fail(revertToAuto(seed().db, admin, SESSION)))?.status).toBe(409);
  });
});

describe("listRateLimits", () => {
  it("manual acima do automático em vermelho fica limitado pela qualidade", async () => {
    const { db, tables } = seed("RED");
    tables.dispatch_channel_rate[0].auto_rate_per_second = 8;
    tables.dispatch_channel_rate[0].manual_rate_per_second = 60;
    const view = await listRateLimits(db, ACCOUNT);
    expect(view.channels[0].rate).toMatchObject({ effective: 8, effective_source: "manual_capped_by_quality" });
    expect(view.channels[0].requires_owner_confirmation).toBe(true);
    expect(view.ceiling).toBe(80);
  });
  it("sem linha de rate → rate null", async () => {
    const { db, tables } = seed();
    tables.dispatch_channel_rate.length = 0;
    expect((await listRateLimits(db, ACCOUNT)).channels[0].rate).toBeNull();
  });
});

describe("updatePolicy / acknowledge / vermelho", () => {
  it("política só owner, com motivo e ordem verde ≥ amarelo ≥ vermelho", async () => {
    const { db, tables } = seed();
    expect((await fail(updatePolicy(db, admin, { green_rate: 50 }, "motivo ok")))?.status).toBe(403);
    expect((await fail(updatePolicy(db, owner, { green_rate: 50 }, "")))?.status).toBe(422);
    expect((await fail(updatePolicy(db, owner, { red_rate: 70 }, "motivo ok")))?.status).toBe(422);
    await updatePolicy(db, owner, { green_rate: 60, yellow_rate: 30 }, "motivo ok");
    expect(tables.dispatch_rate_policy[0]).toMatchObject({ account_id: ACCOUNT, green_rate: 60, yellow_rate: 30 });
  });
  it("acknowledge marca avisos", async () => {
    const { db, tables } = seed();
    const id = "22222222-2222-2222-2222-222222222222";
    tables.dispatch_channel_rate_history.push({ id, account_id: ACCOUNT, acknowledged_at: null });
    expect(await acknowledgeHistory(db, admin, [id])).toEqual({ acknowledged: 1 });
    expect(tables.dispatch_channel_rate_history[0].acknowledged_by).toBe("u-admin");
  });
  it("redChannelsNeedingOwner lista só os vermelhos e é inerte sem tabela", async () => {
    expect(await redChannelsNeedingOwner(seed("RED").db, ACCOUNT, [SESSION])).toEqual([SESSION]);
    expect(await redChannelsNeedingOwner(seed("GREEN").db, ACCOUNT, [SESSION])).toEqual([]);
    expect(await redChannelsNeedingOwner(fakeDb({}, ["channel_health"]).db, ACCOUNT, [SESSION])).toEqual([]);
  });
});
