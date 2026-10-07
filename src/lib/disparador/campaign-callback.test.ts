import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  queueFromCalls: [] as string[],
  rangeCalls: 0,
  fetched: [] as Array<{ url: string; body: string }>,
}));

vi.mock("@/lib/disparador/admin-client", () => ({
  supabaseAdmin: () => ({
    rpc: mocks.rpc,
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      const result =
        table === "campaigns"
          ? { data: { id: "camp", nome: "Black Friday", status: "concluida", callback_url: "https://hook.exemplo.com/x", updated_at: "2026-10-07T12:00:00Z" }, error: null }
          : table === "campaign_metrics_live"
            ? { data: { total_entregues: 7, total_lidos: 3 }, error: null }
            : { data: [], count: 0, error: null };
      if (table === "disp_message_queue") mocks.queueFromCalls.push(table);
      for (const m of ["select", "eq"]) builder[m] = () => builder;
      builder.range = () => {
        mocks.rangeCalls++;
        return builder;
      };
      builder.maybeSingle = async () => result;
      builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
      return builder;
    },
  }),
}));
vi.mock("@/lib/whatsapp/waha-api", () => ({
  assertWahaUrlIsSafe: async () => {},
  sendWahaTextMessage: vi.fn(),
  sendWahaMediaMessage: vi.fn(),
  sendWahaVoiceMessage: vi.fn(),
  startWacallsCall: vi.fn(),
  playWacallsAudio: vi.fn(),
  getWacallsCallStatus: vi.fn(),
}));
vi.mock("@/lib/security/ssrf-guard", () => ({
  safeFetch: async (url: string, init: { body: string }) => {
    mocks.fetched.push({ url, body: init.body });
    return new Response("ok", { status: 200 });
  },
}));
vi.mock("@/lib/logger", () => ({ writeLog: vi.fn(), maskPhone: () => "masked" }));

import { sendCampaignCallback } from "./processQueue";
import { loadCampaignStatusCounts, summarizeStatusCounts } from "./campaign-status-counts";

describe("callback de fim de campanha (P0-5 / F6b + F19)", () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
    mocks.queueFromCalls.length = 0;
    mocks.rangeCalls = 0;
    mocks.fetched.length = 0;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("resume a fila com UMA chamada a get_campaign_stats, sem paginar a fila por OFFSET", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        { campaign_id: "camp", status: "enviado", qty: 40000 },
        { campaign_id: "camp", status: "entregue", qty: "30000" },
        { campaign_id: "camp", status: "lido", qty: 20000 },
        { campaign_id: "camp", status: "erro", qty: 9000 },
        { campaign_id: "camp", status: "bloqueado", qty: 500 },
        { campaign_id: "camp", status: "cancelado", qty: 500 },
      ],
      error: null,
    });
    expect(await sendCampaignCallback("camp")).toBe(true);
    expect(mocks.rpc).toHaveBeenCalledWith("get_campaign_stats", { p_campaign_ids: ["camp"] });
    expect(mocks.rangeCalls).toBe(0);
    expect(mocks.queueFromCalls).toHaveLength(0);
    const payload = JSON.parse(mocks.fetched[0].body);
    expect(payload.summary).toEqual({
      total_enfileirados: 100000,
      enviados: 90000,
      entregues: 7,
      lidos: 3,
      erros: 9000,
      bloqueados: 500,
      cancelados: 500,
    });
  });

  it("sem a RPC: contagens exatas por status (nunca OFFSET)", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "function does not exist" } });
    expect(await sendCampaignCallback("camp")).toBe(true);
    expect(mocks.rangeCalls).toBe(0);
    expect(mocks.queueFromCalls.length).toBe(10);
  });

  it("loadCampaignStatusCounts soma linhas repetidas e summarize agrega os status finais", async () => {
    const db = {
      rpc: async () => ({ data: [{ status: "enviado", qty: 2 }, { status: "enviado", qty: "3" }, { status: "erro", qty: 1 }], error: null }),
      from: () => ({}),
    } as never;
    const counts = await loadCampaignStatusCounts(db, "camp");
    expect(counts).toEqual({ enviado: 5, erro: 1 });
    expect(summarizeStatusCounts(counts!)).toEqual({ total_enfileirados: 6, enviados: 5, erros: 1, bloqueados: 0, cancelados: 0 });
  });
});
