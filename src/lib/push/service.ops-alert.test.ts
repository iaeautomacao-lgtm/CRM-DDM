import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/whatsapp/encryption", () => ({ encrypt: (t: string) => `enc(${t})`, decrypt: (t: string) => t.replace(/^enc\(|\)$/g, "") }));

import { OPS_ALERT_PUSH_TYPE, sendOpsAlertPush } from "./service";
import { generateVapidKeys } from "./web-push";

type Row = Record<string, unknown>;

function fakeDb(tables: Record<string, Row[]>, opts: { noDeactivatedColumn?: boolean } = {}) {
  return {
    from(table: string) {
      const rows = tables[table] ?? [];
      const filters: Array<(r: Row) => boolean> = [];
      let del = false;
      let usedDeactivated = false;
      const run = () => {
        if (table === "profiles" && usedDeactivated && opts.noDeactivatedColumn) return { data: null, error: { code: "42703", message: "no column" } };
        const hit = rows.filter((r) => filters.every((f) => f(r)));
        if (del) {
          tables[table] = rows.filter((r) => !hit.includes(r));
          return { error: null };
        }
        return { data: hit, error: null };
      };
      const b: Record<string, unknown> = {
        select: () => b,
        delete: () => ((del = true), b),
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
        in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), b),
        is: (c: string, v: unknown) => ((usedDeactivated = c === "deactivated_at"), filters.push((r) => (r[c] ?? null) === v), b),
        limit: () => b,
        then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, ko),
      };
      return b;
    },
  } as never;
}

const pair = generateVapidKeys();
const sub = (n: number) => ({ account_id: "A", user_id: `u${n}`, endpoint: `https://fcm.googleapis.com/fcm/send/${n}-aaaaaaaaaaaaaaaaaaaa`, p256dh: "p", auth: "a" });

function seed() {
  return {
    push_vapid_keys: [{ account_id: "A", public_key: pair.publicKey, private_key_enc: `enc(${pair.privateKeyPem})` }],
    profiles: [
      { user_id: "u1", account_id: "A", account_role: "owner", deactivated_at: null },
      { user_id: "u2", account_id: "A", account_role: "admin", deactivated_at: null },
      { user_id: "u3", account_id: "A", account_role: "agent", deactivated_at: null },
      { user_id: "u4", account_id: "A", account_role: "admin", deactivated_at: "2026-10-01T00:00:00Z" },
      { user_id: "u5", account_id: "B", account_role: "admin", deactivated_at: null },
    ] as Row[],
    push_subscriptions: [sub(1), sub(2), sub(3), sub(4), { ...sub(5), account_id: "B" }] as Row[],
  };
}

describe("sendOpsAlertPush", () => {
  it("notifica só admin e proprietário ativos da conta, com payload sem dado pessoal", async () => {
    const calls: Array<[{ endpoint: string }, unknown]> = [];
    const sender = async (s: { endpoint: string }, payload: unknown) => {
      calls.push([s, payload]);
      return { status: 201, gone: false };
    };
    const r = await sendOpsAlertPush(fakeDb(seed()), { accountId: "A", kind: "campaign_auto_paused", tag: "campaign.auto_paused:c1" }, sender as never);
    expect(r.sent).toBe(2);
    const endpoints = calls.map((c) => c[0].endpoint).sort();
    expect(endpoints).toEqual([sub(1).endpoint, sub(2).endpoint]);
    expect(calls[0][1]).toEqual({ type: OPS_ALERT_PUSH_TYPE, kind: "campaign_auto_paused", tag: "campaign.auto_paused:c1" });
  });

  it("sem a coluna deactivated_at (migration 311) repete sem o filtro", async () => {
    const sender = vi.fn(async () => ({ status: 201, gone: false }));
    const r = await sendOpsAlertPush(fakeDb(seed(), { noDeactivatedColumn: true }), { accountId: "A", kind: "cron_stalled", tag: "t" }, sender);
    expect(r.sent).toBe(3); // u1, u2 e u4 (sem o filtro de desativado)
  });

  it("remove a inscrição que o provedor diz que não existe mais", async () => {
    const tables = seed();
    const sender = vi.fn(async (s: { endpoint: string }) => ({ status: s.endpoint === sub(1).endpoint ? 410 : 201, gone: s.endpoint === sub(1).endpoint }));
    const r = await sendOpsAlertPush(fakeDb(tables), { accountId: "A", kind: "channel_quality_changed", tag: "t" }, sender as never);
    expect(r).toEqual({ sent: 1, failed: 0, removed: 1 });
    expect(tables.push_subscriptions.some((s) => s.endpoint === sub(1).endpoint)).toBe(false);
  });

  it("sem chave VAPID da conta ou sem inscrições não envia nada e não lança", async () => {
    const sender = vi.fn(async () => ({ status: 201, gone: false }));
    const noKey = { ...seed(), push_vapid_keys: [] };
    expect(await sendOpsAlertPush(fakeDb(noKey), { accountId: "A", kind: "cron_stalled", tag: "t" }, sender)).toEqual({ sent: 0, failed: 0, removed: 0 });
    const noSubs = { ...seed(), push_subscriptions: [] };
    expect(await sendOpsAlertPush(fakeDb(noSubs), { accountId: "A", kind: "cron_stalled", tag: "t" }, sender)).toEqual({ sent: 0, failed: 0, removed: 0 });
    expect(sender).not.toHaveBeenCalled();
  });

  it("falha de envio conta como falha e não derruba os demais", async () => {
    const sender = vi.fn(async (s: { endpoint: string }) => {
      if (s.endpoint === sub(1).endpoint) throw new Error("rede");
      return { status: 201, gone: false };
    });
    const r = await sendOpsAlertPush(fakeDb(seed()), { accountId: "A", kind: "cron_stalled", tag: "t" }, sender as never);
    expect(r).toMatchObject({ sent: 1, failed: 1 });
  });
});
