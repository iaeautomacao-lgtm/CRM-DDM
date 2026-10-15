import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/whatsapp/encryption", () => ({ decrypt: () => "pem", encrypt: (s: string) => s }));

import { DISCONNECT_MINUTES, alertRecipients, runPauseCron } from "./alerts";
import { PAUSE_ALERT_PUSH_TYPE, sendPauseExceededPush } from "@/lib/push/service";

const ACC = "acc-1";

type Tables = Record<string, Array<Record<string, unknown>>>;

/** Banco falso: filtros eq/in/is/neq aplicados de verdade; rpc por nome. */
function fakeDb(tables: Tables, rpc: Record<string, unknown> = {}) {
  const calls: Array<{ fn: string; args: unknown }> = [];
  return {
    calls,
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = (c: string, v: unknown) => ((rows = rows.filter((r) => r[c] === v)), b);
      b.neq = (c: string, v: unknown) => ((rows = rows.filter((r) => r[c] !== v)), b);
      b.in = (c: string, vs: unknown[]) => ((rows = rows.filter((r) => vs.includes(r[c]))), b);
      b.is = (c: string, v: unknown) => ((rows = rows.filter((r) => (r[c] ?? null) === v)), b);
      b.limit = () => b;
      b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(ok);
      return b;
    },
    async rpc(fn: string, args: unknown) {
      calls.push({ fn, args });
      return (rpc[fn] as { data: unknown; error: unknown }) ?? { data: null, error: null };
    },
  };
}

const profile = (user_id: string, account_role: string, deactivated_at: string | null = null) => ({ user_id, account_id: ACC, account_role, deactivated_at });

describe("alertRecipients: quem recebe o aviso de pausa estourada", () => {
  const base: Tables = {
    team_members: [
      { team_id: "t1", user_id: "ag1" }, { team_id: "t1", user_id: "sup1" }, { team_id: "t1", user_id: "ag2" },
      { team_id: "t2", user_id: "sup2" }, { team_id: "t2", user_id: "ag3" },
    ],
    profiles: [profile("ag1", "agent"), profile("ag2", "agent"), profile("sup1", "supervisor"), profile("sup2", "supervisor"), profile("ag3", "agent"), profile("adm", "admin"), profile("own", "owner"), profile("adm-off", "admin", "2026-01-01")],
  };
  it("os supervisores da equipe do atendente — só eles (não os de outra equipe, nem colegas)", async () => {
    expect(await alertRecipients(fakeDb(base), { account_id: ACC, user_id: "ag1" })).toEqual(["sup1"]);
    expect(await alertRecipients(fakeDb(base), { account_id: ACC, user_id: "ag3" })).toEqual(["sup2"]);
  });
  it("supervisor em duas equipes do atendente recebe uma vez; supervisor desativado não recebe", async () => {
    const t: Tables = { ...base, team_members: [...base.team_members, { team_id: "t2", user_id: "ag1" }, { team_id: "t2", user_id: "sup1" }], profiles: [...base.profiles, profile("sup3", "supervisor", "2026-02-01")] };
    t.team_members.push({ team_id: "t1", user_id: "sup3" });
    expect((await alertRecipients(fakeDb(t), { account_id: ACC, user_id: "ag1" })).sort()).toEqual(["sup1", "sup2"]);
  });
  it("sem equipe ou sem supervisor: owner/admin ativos da conta (para o aviso não se perder), nunca o próprio", async () => {
    const lonely = await alertRecipients(fakeDb({ ...base, team_members: [] }), { account_id: ACC, user_id: "ag1" });
    expect(lonely.sort()).toEqual(["adm", "own"]);
    const noSup = { ...base, profiles: base.profiles.filter((p) => p.account_role !== "supervisor") };
    expect((await alertRecipients(fakeDb(noSup), { account_id: ACC, user_id: "ag1" })).sort()).toEqual(["adm", "own"]);
    expect(await alertRecipients(fakeDb({ ...base, team_members: [] }), { account_id: ACC, user_id: "adm" })).toEqual(["own"]);
  });
});

describe("runPauseCron", () => {
  it("fecha as desconectadas (15 min) e avisa UMA vez cada estouro, ao supervisor", async () => {
    const db = fakeDb(
      { team_members: [{ team_id: "t1", user_id: "ag1" }, { team_id: "t1", user_id: "sup1" }], profiles: [profile("sup1", "supervisor")] },
      {
        close_disconnected_pauses: { data: 2, error: null },
        claim_exceeded_pauses: { data: [{ pause_id: "p1", account_id: ACC, user_id: "ag1", reason_name: "Banheiro", max_minutes: 10 }], error: null },
      },
    );
    const push = vi.fn(async () => ({ sent: 1, failed: 0, removed: 0 }));
    const out = await runPauseCron(db as never, { push });
    expect(out).toEqual({ closedByDisconnect: 2, exceeded: 1, notified: 1 });
    expect(db.calls[0]).toEqual({ fn: "close_disconnected_pauses", args: { p_minutes: DISCONNECT_MINUTES } });
    expect(DISCONNECT_MINUTES).toBe(15);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(db, { accountId: ACC, userIds: ["sup1"], tag: "pause-p1" });
  });

  it("falha no aviso não quebra o cron (a pausa já foi marcada, não repete); sem migration 371 lança para virar 503", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = fakeDb({}, { close_disconnected_pauses: { data: 0, error: null }, claim_exceeded_pauses: { data: [{ pause_id: "p1", account_id: ACC, user_id: "ag1", reason_name: "x", max_minutes: 5 }], error: null } });
    const out = await runPauseCron(db as never, { push: async () => { throw new Error("push fora"); } });
    expect(out).toMatchObject({ exceeded: 1, notified: 0 });
    const missing = fakeDb({}, { close_disconnected_pauses: { data: null, error: { code: "PGRST202", message: "nope" } } });
    await expect(runPauseCron(missing as never)).rejects.toMatchObject({ code: "PGRST202" });
  });
});

describe("sendPauseExceededPush", () => {
  const vapid = { public_key: "pub", private_key_enc: "x" };
  it("payload só com tipo e tag (sem nome de atendente), para as inscrições dos supervisores; remove as inscrições mortas", async () => {
    const sent: unknown[] = [];
    const sender = vi.fn(async (sub: { endpoint: string }, payload: unknown) => {
      sent.push(payload);
      return sub.endpoint === "gone" ? { status: 410, gone: true } : { status: 201, gone: false };
    });
    const deleted: unknown[] = [];
    const db = {
      from(table: string) {
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.eq = () => b;
        b.in = (_c: string, v: unknown) => (table === "push_subscriptions" && deleted.push(v), b);
        b.limit = () => b;
        b.delete = () => b;
        b.then = (ok: (v: unknown) => unknown) =>
          Promise.resolve({ data: table === "push_subscriptions" ? [{ endpoint: "ok", p256dh: "a", auth: "b" }, { endpoint: "gone", p256dh: "a", auth: "b" }] : [vapid], error: null }).then(ok);
        return b;
      },
    };
    const out = await sendPauseExceededPush(db as never, { accountId: ACC, userIds: ["sup1", "sup1"], tag: "pause-p1" }, sender as never);
    expect(out).toEqual({ sent: 1, failed: 0, removed: 1 });
    expect(sent[0]).toEqual({ type: PAUSE_ALERT_PUSH_TYPE, tag: "pause-p1" });
    expect(JSON.stringify(sent)).not.toMatch(/Ana|Banheiro|nome/);
    expect(await sendPauseExceededPush(db as never, { accountId: ACC, userIds: [], tag: "x" }, sender as never)).toEqual({ sent: 0, failed: 0, removed: 0 });
  });
});
