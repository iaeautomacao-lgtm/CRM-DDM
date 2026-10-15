import { describe, expect, it, vi } from "vitest";

import {
  deterministicEventId,
  emitCampaignCancelled,
  emitCampaignCompleted,
  emitCampaignPaused,
  emitCampaignResumed,
  emitCampaignStarted,
  lifecycleEventId,
  occurrenceKey,
  summaryFromCounts,
} from "./campaign-events";

const A = "00000000-0000-0000-0000-00000000000a";
const C = "00000000-0000-0000-0000-0000000000c1";

// Banco falso: registra as RPCs e responde às leituras da campanha.
function fakeDb(opts: { listens?: boolean; campaign?: Record<string, unknown> | null; rpcError?: string | null; counts?: Array<{ status: string; qty: number }> } = {}) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const campaign = opts.campaign === undefined ? { id: C, account_id: A, nome: "Cobrança", idempotency_key: "erp-1", source: "api_v1", status: "em_execucao", session_ids: ["ch1"], updated_at: "2026-10-15T10:00:00Z" } : opts.campaign;
  const table = (name: string) => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "limit"]) b[m] = () => b;
    b.then = (resolve: (v: unknown) => void) =>
      resolve({
        data:
          name === "campaigns" ? (campaign ? [campaign] : []) : name === "whatsapp_config" ? [{ provider: "meta" }] : name === "campaign_metrics" ? [{ total_contatos: 120 }] : [],
        error: null,
      });
    return b;
  };
  const db = {
    from: table,
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (fn === "webhook_endpoint_listens") return { data: opts.listens ?? true, error: null };
      if (fn === "get_campaign_stats") return { data: opts.counts ?? [], error: null };
      if (fn === "enqueue_webhook_event") return opts.rpcError ? { data: null, error: { message: opts.rpcError } } : { data: 1, error: null };
      return { data: null, error: null };
    },
  };
  return { db: db as never, calls, enqueued: () => calls.filter((c) => c.fn === "enqueue_webhook_event") };
}

describe("campaign-events (webhooks de saída do ciclo de vida)", () => {
  it("event_id é determinístico: started/completed uma vez; paused/resumed/cancelled por ocorrência (janela de 5 s)", () => {
    expect(deterministicEventId("x")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(lifecycleEventId("campaign.started", C, "1")).toBe(lifecycleEventId("campaign.started", C, "2"));
    expect(lifecycleEventId("campaign.completed", C, "1")).toBe(lifecycleEventId("campaign.completed", C, "2"));
    expect(lifecycleEventId("campaign.paused", C, "1")).not.toBe(lifecycleEventId("campaign.paused", C, "2"));
    expect(lifecycleEventId("campaign.paused", C, "1")).not.toBe(lifecycleEventId("campaign.resumed", C, "1"));
    expect(occurrenceKey(10_000)).toBe(occurrenceKey(14_999));
    expect(occurrenceKey(10_000)).not.toBe(occurrenceKey(15_000));
  });

  it("started: só enfileira se há assinante; payload com nome, external_id, origem, total e canal", async () => {
    const none = fakeDb({ listens: false });
    expect(await emitCampaignStarted(none.db, { accountId: A, campaignId: C, by: "api" })).toBe(0);
    expect(none.enqueued()).toHaveLength(0);
    const f = fakeDb();
    expect(await emitCampaignStarted(f.db, { accountId: A, campaignId: C, by: "api" })).toBe(1);
    const [call] = f.enqueued();
    expect(call.args).toMatchObject({
      p_account: A,
      p_event: "campaign.started",
      p_data: { campaign_id: C, name: "Cobrança", external_id: "erp-1", source: "api_v1", total_contacts: 120, provider: "meta" },
    });
    expect(call.args.p_event_id).toBe(lifecycleEventId("campaign.started", C));
  });

  it("paused/resumed/cancelled: quem agiu, motivo, contagens e a MESMA ação simultânea não duplica", async () => {
    const f = fakeDb({ counts: [{ status: "enviado", qty: 5 }, { status: "entregue", qty: 3 }, { status: "lido", qty: 2 }, { status: "erro", qty: 1 }, { status: "cancelado", qty: 4 }] });
    await emitCampaignPaused(f.db, { accountId: A, campaignId: C, by: "api", reason: "cliente pagou", itemsPendingMove: true, occurrence: "k1" });
    await emitCampaignPaused(f.db, { accountId: A, campaignId: C, by: "user", occurrence: "k1" });
    await emitCampaignResumed(f.db, { accountId: A, campaignId: C, by: "api", resumedItems: 40 });
    await emitCampaignCancelled(f.db, { accountId: A, campaignId: C, by: "api", reason: "cancelled_api", cancelledItems: 4 });
    const [p1, p2, r, c] = f.enqueued().map((x) => x.args);
    expect(p1.p_data).toMatchObject({ automatic: false, by: "api", reason: "cliente pagou", items_pending_move: true });
    expect(p1.p_event_id).toBe(p2.p_event_id); // mesma ocorrência: o banco deduplica
    expect(r.p_data).toMatchObject({ by: "api", resumed_items: 40 });
    expect(c.p_data).toMatchObject({ by: "api", reason: "cancelled_api", cancelled_items: 4, summary: { total: 15, sent: 10, delivered: 5, read: 2, errors: 1, cancelled: 4 } });
  });

  it("completed acha a conta pela campanha (watchdog) e leva o resumo", async () => {
    const f = fakeDb({ counts: [{ status: "enviado", qty: 2 }, { status: "erro", qty: 1 }] });
    expect(await emitCampaignCompleted(f.db, { campaignId: C })).toBe(1);
    expect(f.enqueued()[0].args).toMatchObject({ p_event: "campaign.completed", p_data: { completed_at: "2026-10-15T10:00:00Z", summary: { total: 3, sent: 2, errors: 1 } } });
  });

  it("NUNCA lança: campanha inexistente, erro no enfileiramento ou banco quebrado", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await emitCampaignStarted(fakeDb({ campaign: null }).db, { accountId: A, campaignId: C })).toBe(0);
    expect(await emitCampaignStarted(fakeDb({ rpcError: "boom" }).db, { accountId: A, campaignId: C })).toBe(0);
    const broken = { from: () => { throw new Error("x"); }, rpc: async () => { throw new Error("y"); } } as never;
    expect(await emitCampaignPaused(broken, { accountId: A, campaignId: C })).toBe(0);
    expect(await emitCampaignCompleted(broken, { accountId: A, campaignId: C })).toBe(0);
  });

  it("resumo: enviados inclui entregues e lidos; entregues inclui lidos", () => {
    expect(summaryFromCounts({ enviado: 1, entregue: 2, lido: 3, erro: 4, bloqueado: 5, cancelado: 6, agendado: 7 })).toEqual({ total: 28, sent: 6, delivered: 5, read: 3, errors: 4, blocked: 5, cancelled: 6 });
  });
});
