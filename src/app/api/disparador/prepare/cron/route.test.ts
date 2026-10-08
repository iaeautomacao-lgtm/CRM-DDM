import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  prepare: vi.fn(),
  recover: vi.fn(),
}));
vi.mock("@/lib/disparador/admin-client", () => ({ supabaseAdmin: () => ({ rpc: mocks.rpc }) }));
vi.mock("@/lib/audit/context", () => ({ registerAuditActor: vi.fn() }));
vi.mock("@/lib/disparador/prepare-campaigns", () => ({
  prepareDueCampaigns: mocks.prepare,
  recoverStuckPreparing: mocks.recover,
}));

import { POST } from "./route";

const post = (secret: string | null = "test-secret") =>
  POST(
    new Request("https://crm.test/api/disparador/prepare/cron", {
      method: "POST",
      headers: secret ? { "x-cron-secret": secret } : {},
    }),
  );

describe("POST /api/disparador/prepare/cron", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("sem CRON_SECRET configurado: 503; segredo errado ou ausente: 401 — nada é preparado", async () => {
    expect((await post()).status).toBe(503);
    vi.stubEnv("CRON_SECRET", "test-secret");
    expect((await post("errado")).status).toBe(401);
    expect((await post(null)).status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("adquire o lock próprio disparador_prepare, recupera presas, prepara e libera o lock", async () => {
    vi.stubEnv("CRON_SECRET", "test-secret");
    mocks.rpc.mockResolvedValue({ data: true, error: null });
    mocks.recover.mockResolvedValue({ toAgendado: 1, toRascunho: 0 });
    mocks.prepare.mockResolvedValue({ attempted: 2, prepared: 2, failed: 0, results: [] });
    const response = await post();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: "prepared", attempted: 2, prepared: 2, recovered: { toAgendado: 1 } });

    const acquire = mocks.rpc.mock.calls.find(([name]) => name === "try_acquire_cron_lock");
    expect(acquire?.[1]).toMatchObject({ p_name: "disparador_prepare" });
    const release = mocks.rpc.mock.calls.find(([name]) => name === "release_cron_lock");
    expect(release?.[1]).toMatchObject({ p_name: "disparador_prepare", p_owner_id: acquire?.[1].p_owner_id });
    // O tick de envio usa outro lock: nunca toca em 'disparador_cron'.
    expect(mocks.rpc.mock.calls.every(([, args]) => args?.p_name !== "disparador_cron")).toBe(true);
  });

  it("lock ocupado por outra preparação: already_running, sem preparar nem liberar o lock alheio", async () => {
    vi.stubEnv("CRON_SECRET", "test-secret");
    mocks.rpc.mockImplementation(async (name: string) => ({ data: name === "try_acquire_cron_lock" ? false : true, error: null }));
    const response = await post();
    expect(await response.json()).toEqual({ status: "already_running" });
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.recover).not.toHaveBeenCalled();
    expect(mocks.rpc.mock.calls.some(([name]) => name === "release_cron_lock")).toBe(false);
  });

  it("falha na preparação: 503 genérico e o lock é liberado", async () => {
    vi.stubEnv("CRON_SECRET", "test-secret");
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.rpc.mockResolvedValue({ data: true, error: null });
    mocks.recover.mockResolvedValue({ toAgendado: 0, toRascunho: 0 });
    mocks.prepare.mockRejectedValue(new Error("banco fora"));
    const response = await post();
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("banco fora");
    expect(mocks.rpc.mock.calls.some(([name]) => name === "release_cron_lock")).toBe(true);
  });
});
