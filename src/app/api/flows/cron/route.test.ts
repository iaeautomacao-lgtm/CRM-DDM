// POST /api/flows/cron — contrato da resposta e flag FLOWS_CRON_V2 (padrão desligada = caminho atual).
import { beforeEach, describe, expect, it, vi } from "vitest";

const wake = vi.fn();
const rpc = vi.fn();
vi.mock("@/lib/audit/context", () => ({ registerAuditActor: async () => {} }));
vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({ rpc: (...a: unknown[]) => rpc(...a), from: () => ({ select: () => ({ limit: async () => ({ error: null }) }) }) }),
}));
vi.mock("@/lib/flows/wake-runs", () => ({ wakeDelayedRuns: (...a: unknown[]) => wake(...a) }));
vi.mock("@/lib/flows/ai-watchdog", () => ({ sweepStalledAiConversations: async () => 2 }));

const { POST } = await import("./route");

const post = (qs = "", secret = "segredo") =>
  POST(new Request(`http://localhost/api/flows/cron${qs}`, { method: "POST", headers: { "x-cron-secret": secret } }));

beforeEach(() => {
  process.env.AUTOMATION_CRON_SECRET = "segredo";
  wake.mockReset();
  wake.mockResolvedValue({ woken: 3, failed: 1, skipped: 2, path: "legacy" });
  rpc.mockReset();
  rpc.mockResolvedValue({ data: [], error: null });
});

describe("POST /api/flows/cron", () => {
  it("responde com os contadores woken/failed/skipped (e os de sempre: swept, stalled)", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ swept: 0, woken: 3, failed: 1, skipped: 2, stalled: 2 });
  });

  it("repassa o lote configurável (?batch=) e deixa a escolha do caminho para a flag", async () => {
    await post("?batch=120");
    expect(wake.mock.calls[0][1]).toMatchObject({ batch: 120 });
    wake.mockClear();
    await post();
    expect(wake.mock.calls[0][1].batch).toBeUndefined();
    expect(wake.mock.calls[0][1].v2).toBeUndefined(); // flag lida dentro de wakeDelayedRuns (FLOWS_CRON_V2)
  });

  it("segredo errado: 401 e nada é acordado", async () => {
    expect((await post("", "outro")).status).toBe(401);
    expect(wake).not.toHaveBeenCalled();
  });
});
