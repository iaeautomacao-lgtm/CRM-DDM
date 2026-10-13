import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/push/service", () => ({ sendOpsAlertPush: vi.fn(async () => ({ sent: 1, failed: 0, removed: 0 })) }));

import { alertKey, claimAlertSlot, emitActiveAlert, hourBucket, shouldAlertQualityChange } from "./active-alerts";

type Call = { fn: string; args: Record<string, unknown> };

// rpc fake: claim_alert_slot guarda (conta|chave|hora) em memória como o banco faria; enqueue_webhook_event devolve 2 entregas.
function fakeDb(opts: { claimMissing?: boolean; webhookError?: boolean } = {}) {
  const calls: Call[] = [];
  const seen = new Set<string>();
  const db = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (fn === "claim_alert_slot") {
        if (opts.claimMissing) return { data: null, error: { code: "PGRST202", message: "not found" } };
        const k = `${args.p_account}|${args.p_key}|${args.p_bucket}`;
        if (seen.has(k)) return { data: false, error: null };
        seen.add(k);
        return { data: true, error: null };
      }
      if (fn === "enqueue_webhook_event") {
        return opts.webhookError ? { data: null, error: { code: "XX000", message: "boom" } } : { data: 2, error: null };
      }
      return { data: null, error: null };
    },
  };
  return { db, calls };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("helpers", () => {
  it("hourBucket trunca para a hora cheia em UTC", () => {
    expect(hourBucket(new Date("2026-10-13T12:47:31.123Z"))).toBe("2026-10-13T12:00:00.000Z");
  });
  it("alertKey junta evento e assunto", () => {
    expect(alertKey("campaign.auto_paused", "c1")).toBe("campaign.auto_paused:c1");
  });
  it("só mudança real de cor alerta (não a 1ª leitura nem UNKNOWN)", () => {
    expect(shouldAlertQualityChange(null, "RED")).toBe(false);
    expect(shouldAlertQualityChange("GREEN", "GREEN")).toBe(false);
    expect(shouldAlertQualityChange("GREEN", "UNKNOWN")).toBe(false);
    expect(shouldAlertQualityChange("UNKNOWN", "GREEN")).toBe(false);
    expect(shouldAlertQualityChange("GREEN", "YELLOW")).toBe(true);
    expect(shouldAlertQualityChange("RED", "GREEN")).toBe(true);
  });
});

describe("emitActiveAlert", () => {
  const input = {
    accountId: "A",
    event: "campaign.auto_paused" as const,
    subjectId: "c1",
    data: { campaign_id: "c1", reason: "taxa de erro" },
    now: new Date("2026-10-13T12:10:00Z"),
  };

  it("enfileira o webhook com o evento e o dado e avisa por push (admin/proprietário)", async () => {
    const { db, calls } = fakeDb();
    const push = vi.fn(async () => ({ sent: 3, failed: 0, removed: 0 }));
    const r = await emitActiveAlert(db, input, { push });
    expect(r).toEqual({ emitted: true, webhooks: 2, pushSent: 3 });
    const hook = calls.find((c) => c.fn === "enqueue_webhook_event")!;
    expect(hook.args).toMatchObject({ p_account: "A", p_event: "campaign.auto_paused", p_data: { campaign_id: "c1", reason: "taxa de erro" } });
    expect(String(hook.args.p_event_id)).toMatch(/^[0-9a-f-]{36}$/);
    expect(push).toHaveBeenCalledWith(db, { accountId: "A", kind: "campaign_auto_paused", tag: "campaign.auto_paused:c1" });
  });

  it("agrupa por campanha e por hora: repetido da mesma hora não reenvia; outra hora/campanha envia", async () => {
    const { db, calls } = fakeDb();
    const push = vi.fn(async () => ({ sent: 1, failed: 0, removed: 0 }));
    expect((await emitActiveAlert(db, input, { push })).emitted).toBe(true);
    expect((await emitActiveAlert(db, { ...input, now: new Date("2026-10-13T12:55:00Z") }, { push })).emitted).toBe(false);
    expect((await emitActiveAlert(db, { ...input, now: new Date("2026-10-13T13:01:00Z") }, { push })).emitted).toBe(true);
    expect((await emitActiveAlert(db, { ...input, subjectId: "c2" }, { push })).emitted).toBe(true);
    expect(calls.filter((c) => c.fn === "enqueue_webhook_event")).toHaveLength(3);
    expect(push).toHaveBeenCalledTimes(3);
  });

  it("sem a migration 337 usa o dedupe em memória (1 por hora) e ainda envia", async () => {
    const { db } = fakeDb({ claimMissing: true });
    const push = vi.fn(async () => ({ sent: 0, failed: 0, removed: 0 }));
    const x = { ...input, accountId: "mem-A", subjectId: "mem-c" };
    expect((await emitActiveAlert(db, x, { push })).emitted).toBe(true);
    expect((await emitActiveAlert(db, x, { push })).emitted).toBe(false);
  });

  it("falha do webhook não impede o push e nada lança", async () => {
    const { db } = fakeDb({ webhookError: true });
    const push = vi.fn(async () => ({ sent: 1, failed: 0, removed: 0 }));
    const r = await emitActiveAlert(db, { ...input, subjectId: "c9" }, { push });
    expect(r).toEqual({ emitted: true, webhooks: 0, pushSent: 1 });
  });

  it("erro inesperado no banco não lança", async () => {
    const db = {
      rpc: () => {
        throw new Error("queda");
      },
    };
    await expect(emitActiveAlert(db, input)).resolves.toMatchObject({ emitted: false });
  });
});

describe("claimAlertSlot", () => {
  it("erro que não é função ausente não envia (evita spam)", async () => {
    const db = { rpc: async () => ({ data: null, error: { code: "XX000", message: "x" } }) };
    expect(await claimAlertSlot(db, "A", "k", "b")).toBe(false);
  });
});
