import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb } from "./fake-db.test-helper";

const writeLog = vi.fn();
vi.mock("@/lib/logger", () => ({ writeLog: (...a: unknown[]) => writeLog(...a) }));
vi.mock("@/lib/whatsapp/encryption", () => ({ decryptStoredSecret: (v: string) => v }));

import { handleChannelHealthChange, isChannelHealthField, pollChannelHealth, recordChannelHealth, snapshotFromGraph } from "./channel-health";
import { forecastCampaign, cronItemsPerMinute } from "./dispatch-forecast";

const ACCOUNT = "acc-1";
const A = { id: "aaaaaaaa-0000-0000-0000-000000000001", account_id: ACCOUNT, provider: "meta", habilitado: true, waba_id: "waba-1", phone_number_id: "pnA", access_token: "tok", display_phone_number: "+55 11 99999-0001" };
const B = { id: "bbbbbbbb-0000-0000-0000-000000000002", account_id: ACCOUNT, provider: "meta", habilitado: true, waba_id: "waba-1", phone_number_id: "pnB", access_token: "tok", display_phone_number: "+55 11 99999-0002" };

const graph = (quality: string, tier = "TIER_10K") => async () => ({ quality_rating: quality, messaging_limit_tier: tier, throughput: { level: "STANDARD" } });

function seed() {
  return fakeDb({ whatsapp_config: [{ ...A }, { ...B }], channel_health: [], dispatch_channel_rate: [], dispatch_rate_policy: [], dispatch_channel_rate_history: [] });
}

beforeEach(() => writeLog.mockClear());

describe("webhook de qualidade (fixture assumida)", () => {
  it("campos reconhecidos", () => {
    expect(isChannelHealthField("phone_number_quality_update")).toBe(true);
    expect(isChannelHealthField("account_update")).toBe(true);
    expect(isChannelHealthField("message_template_status_update")).toBe(false);
  });

  it("DOWNGRADE re-consulta só o número do evento e cai o automático para vermelho", async () => {
    const { db, tables } = seed();
    const fetchHealth = vi.fn(graph("RED"));
    const out = await handleChannelHealthChange(
      db,
      { wabaId: "waba-1", accountId: ACCOUNT, field: "phone_number_quality_update", value: { display_phone_number: "5511999990002", event: "DOWNGRADE", current_limit: "TIER_1K" } },
      { fetchHealth },
    );
    expect(out).toEqual({ refreshed: [B.id], matched: true });
    expect(fetchHealth).toHaveBeenCalledTimes(1);
    expect(tables.channel_health[0]).toMatchObject({ session_id: B.id, quality_rating: "RED", source: "webhook" });
    expect(tables.dispatch_channel_rate[0]).toMatchObject({ session_id: B.id, auto_rate_per_second: 8 });
    expect(tables.dispatch_channel_rate_history[0]).toMatchObject({ quality_new: "RED", source: "webhook" });
  });

  it("sem display do evento re-consulta todos os números da WABA", async () => {
    const { db } = seed();
    const out = await handleChannelHealthChange(db, { wabaId: "waba-1", accountId: ACCOUNT, field: "account_update", value: { event: "ACCOUNT_RESTRICTION" } }, { fetchHealth: graph("YELLOW") });
    expect(out.refreshed.sort()).toEqual([A.id, B.id].sort());
    expect(out.matched).toBe(false);
  });
});

describe("recordChannelHealth", () => {
  it("queda de qualidade grava aviso warn; subida não salta para 80 (rampa)", async () => {
    const { db, tables } = seed();
    const now = Date.parse("2026-10-07T12:00:00Z");
    // Número já estabilizado em verde (80/s, sem rampa em curso).
    tables.dispatch_channel_rate.push({ session_id: A.id, account_id: ACCOUNT, auto_rate_per_second: 80, auto_ramp_from: null, auto_ramp_started_at: null });
    await recordChannelHealth(db, { channel: A, snapshot: snapshotFromGraph(await graph("GREEN")()), source: "poll", nowMs: now });
    expect(tables.dispatch_channel_rate[0].auto_rate_per_second).toBe(80);
    await recordChannelHealth(db, { channel: A, snapshot: snapshotFromGraph(await graph("RED")()), source: "webhook", nowMs: now + 1000 });
    expect(writeLog.mock.calls.at(-1)?.[0]).toMatchObject({ level: "warn", event: "channel_quality_changed" });
    expect(tables.dispatch_channel_rate[0].auto_rate_per_second).toBe(8);
    await recordChannelHealth(db, { channel: A, snapshot: snapshotFromGraph(await graph("GREEN")()), source: "poll", nowMs: now + 2000 });
    // A coluna guarda o alvo; a rampa parte do valor anterior (8/s) e só sobe em degraus.
    expect(tables.dispatch_channel_rate[0]).toMatchObject({ auto_rate_per_second: 80, auto_ramp_from: 8 });
  });

  it("falha do Graph preserva a cor por 30 min e depois vira desconhecido (5/s)", async () => {
    const { db, tables } = seed();
    const now = Date.parse("2026-10-07T12:00:00Z");
    await recordChannelHealth(db, { channel: A, snapshot: snapshotFromGraph(await graph("YELLOW")()), source: "poll", nowMs: now });
    await recordChannelHealth(db, { channel: A, snapshot: null, error: "timeout", source: "poll", nowMs: now + 10 * 60_000 });
    expect(tables.channel_health[0]).toMatchObject({ quality_rating: "YELLOW", last_error: "timeout" });
    await recordChannelHealth(db, { channel: A, snapshot: null, error: "timeout", source: "poll", nowMs: now + 31 * 60_000 });
    expect(tables.channel_health[0].quality_rating).toBeNull();
    expect(tables.dispatch_channel_rate[0].auto_rate_per_second).toBe(5);
  });

  it("migration 190 ausente é no-op", async () => {
    const { db } = fakeDb({ whatsapp_config: [{ ...A }] }, ["channel_health"]);
    const out = await recordChannelHealth(db, { channel: A, snapshot: snapshotFromGraph(await graph("GREEN")()), source: "poll" });
    expect(out.skipped).toBe("tables_missing");
  });
});

describe("pollChannelHealth", () => {
  it("lê só quem está vencido e relata", async () => {
    const { db, tables } = seed();
    const now = Date.parse("2026-10-07T12:00:00Z");
    tables.channel_health.push({ session_id: A.id, account_id: ACCOUNT, checked_at: new Date(now - 60_000).toISOString() });
    const fetchHealth = vi.fn(graph("GREEN"));
    const report = await pollChannelHealth(db, { fetchHealth, nowMs: now });
    expect(report.considered).toBe(1);
    expect(report.refreshed).toBe(1);
    expect(fetchHealth).toHaveBeenCalledTimes(1);
  });
  it("tabelas ausentes", async () => {
    const { db } = fakeDb({ whatsapp_config: [{ ...A }] }, ["channel_health"]);
    expect((await pollChannelHealth(db)).skipped_tables_missing).toBe(true);
  });
});

describe("previsão com limite por segundo", () => {
  it("cap por rate reduz envios/min; ausente = comportamento antigo", () => {
    const free = cronItemsPerMinute(1000, 0.85, null, { slots: 150, budgetSeconds: 35 });
    expect(cronItemsPerMinute(1000, 0.85, null, { slots: 150, budgetSeconds: 35, ratePerSecond: 5 })).toBe(300);
    expect(free).toBeGreaterThan(300);
    expect(cronItemsPerMinute(1000, 0.85, null, { slots: 150, budgetSeconds: 35, ratePerSecond: undefined })).toBe(free);
    expect(typeof forecastCampaign).toBe("function");
  });
});

describe("nome e telefone da Meta (migration 193)", () => {
  it("grava verified_name/display_phone_number e corrige whatsapp_config quando a Meta devolve outro número", async () => {
    const { db, tables } = seed();
    const fetchHealth = async () => ({ quality_rating: "GREEN", messaging_limit_tier: "TIER_10K", display_phone_number: "+55 11 99999-7777", verified_name: "Grupo DDM Assessoria" });
    const { refreshChannelHealth } = await import("./channel-health");
    await refreshChannelHealth(db, A, "poll", { fetchHealth });
    expect(tables.channel_health[0]).toMatchObject({ verified_name: "Grupo DDM Assessoria", display_phone_number: "+55 11 99999-7777" });
    expect(tables.whatsapp_config.find((c) => c.id === A.id)?.display_phone_number).toBe("+55 11 99999-7777");
    expect(writeLog.mock.calls.some((c) => (c[0] as { event: string }).event === "channel_phone_updated")).toBe(true);
  });

  it("número igual ao gravado não gera atualização nem log", async () => {
    const { db } = seed();
    const fetchHealth = async () => ({ quality_rating: "GREEN", display_phone_number: A.display_phone_number, verified_name: "X" });
    const { refreshChannelHealth } = await import("./channel-health");
    await refreshChannelHealth(db, A, "poll", { fetchHealth });
    expect(writeLog.mock.calls.some((c) => (c[0] as { event: string }).event === "channel_phone_updated")).toBe(false);
  });

  it("falha do Graph preserva nome e telefone já conhecidos", async () => {
    const { db, tables } = seed();
    const { refreshChannelHealth } = await import("./channel-health");
    await refreshChannelHealth(db, A, "poll", { fetchHealth: async () => ({ quality_rating: "GREEN", display_phone_number: "+55 1", verified_name: "Nome Bom" }) });
    await refreshChannelHealth(db, A, "poll", { fetchHealth: async () => { throw new Error("timeout"); } });
    expect(tables.channel_health[0]).toMatchObject({ verified_name: "Nome Bom", last_error: "timeout" });
  });

  it("atualização manual da conta usa source 'manual' (histórico como 'admin') e só os números da conta", async () => {
    const { db, tables } = seed();
    tables.whatsapp_config.push({ id: "cccccccc-0000-0000-0000-000000000003", account_id: "outra", provider: "meta", habilitado: true, phone_number_id: "pnC", access_token: "t" });
    const { refreshAccountChannelHealth } = await import("./channel-health");
    const report = await refreshAccountChannelHealth(db, ACCOUNT, { fetchHealth: graph("RED") });
    expect(report).toMatchObject({ considered: 2, refreshed: 2 });
    expect(tables.channel_health.every((h) => h.source === "manual")).toBe(true);
    expect(tables.dispatch_channel_rate_history.every((h) => h.source === "admin")).toBe(true);
  });
});
