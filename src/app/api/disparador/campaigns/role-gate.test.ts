import { afterEach, describe, expect, it, vi } from "vitest";

// Papel mínimo nas rotas de campanha (route-auth.ts): os mesmos papéis da
// página /disparador/campanhas (owner/admin). Viewer/agente/supervisor → 403
// antes de qualquer leitura ou escrita da campanha.

const mocks = vi.hoisted(() => ({
  account: vi.fn(),
  profileRole: { value: "admin" as string },
  adminFrom: vi.fn(),
  start: vi.fn(),
  after: vi.fn(),
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    // Este teste chama a rota diretamente, fora do request scope do Next.
    // O comportamento do callback é coberto em dispatch-kick.test.ts.
    after: (callback: () => Promise<void>) => mocks.after(callback),
  };
});

vi.mock("@/lib/auth/account", () => {
  class ForbiddenError extends Error {
    readonly status = 403;
  }
  return {
    ForbiddenError,
    getCurrentAccount: mocks.account,
    toErrorResponse: (err: unknown) =>
      new Response(JSON.stringify({ error: String(err) }), {
        status: (err as { status?: number })?.status ?? 500,
      }),
  };
});

// Cliente de sessão (start/stop leem o perfil por ele).
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { account_id: "acc-1", account_role: mocks.profileRole.value },
            error: null,
          }),
        }),
      }),
    }),
  }),
}));

// Service role: devolve uma campanha do usuário para qualquer consulta.
function chain(result: unknown): unknown {
  const proxy: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "is", "not", "limit", "update", "delete", "order"]) {
    proxy[m] = () => chain(result);
  }
  proxy.single = async () => result;
  proxy.maybeSingle = async () => result;
  proxy.then = (resolve: (v: unknown) => unknown) => resolve(result);
  return proxy;
}
vi.mock("@/lib/disparador/admin-client", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      mocks.adminFrom(table);
      return chain({
        data: { id: "camp-1", created_by: "user-1", account_id: "acc-1", status: "rascunho" },
        error: null,
      });
    },
    rpc: async () => ({ data: 1, error: null }),
  }),
}));
vi.mock("@/lib/disparador/worker", () => ({ ensureQueueWorkerRunning: () => undefined }));
vi.mock("@/lib/disparador/startCampaign", () => ({ startCampaign: mocks.start }));

import { canManageCampaigns } from "@/lib/disparador/route-auth";
import { PATCH, DELETE } from "./[id]/route";
import { POST as UNSCHEDULE } from "./[id]/unschedule/route";
import { POST as START } from "./[id]/start/route";
import { POST as STOP } from "./[id]/stop/route";

const params = { params: Promise.resolve({ id: "camp-1" }) };
const json = (body: unknown) =>
  new Request("https://crm.test/x", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("canManageCampaigns (ROUTE_ALLOWLIST de /disparador)", () => {
  it("owner e admin sim; supervisor, agente e viewer não", () => {
    expect(canManageCampaigns("owner")).toBe(true);
    expect(canManageCampaigns("admin")).toBe(true);
    expect(canManageCampaigns("supervisor")).toBe(false);
    expect(canManageCampaigns("agent")).toBe(false);
    expect(canManageCampaigns("viewer")).toBe(false);
    expect(canManageCampaigns(null)).toBe(false);
  });
});

describe("rotas de campanha exigem o papel do disparador", () => {
  afterEach(() => vi.clearAllMocks());

  it("viewer → 403 em PATCH, DELETE, desagendar, iniciar agora e encerrar", async () => {
    mocks.account.mockResolvedValue({ userId: "user-1", accountId: "acc-1", role: "viewer" });
    mocks.profileRole.value = "viewer";
    expect((await PATCH(json({ nome: "x" }), params)).status).toBe(403);
    expect((await DELETE(new Request("https://crm.test/x", { method: "DELETE" }), params)).status).toBe(403);
    expect((await UNSCHEDULE(new Request("https://crm.test/x", { method: "POST" }), params)).status).toBe(403);
    // PATCH/DELETE/desagendar barram antes de tocar no banco.
    expect(mocks.adminFrom).not.toHaveBeenCalled();
    // Iniciar lê a campanha antes (caminho do cron), mas nunca chega ao início.
    expect((await START(json({ agora: true }), params)).status).toBe(403);
    expect((await STOP(new Request("https://crm.test/x?action=stop", { method: "POST" }), params)).status).toBe(403);
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("admin passa pelo portão (iniciar agora chega ao startCampaign com startNow)", async () => {
    mocks.account.mockResolvedValue({ userId: "user-1", accountId: "acc-1", role: "admin" });
    mocks.profileRole.value = "admin";
    mocks.start.mockResolvedValue({ ok: true, enqueued: 3 });
    const res = await START(json({ agora: true }), params);
    expect(res.status).toBe(200);
    expect(mocks.start).toHaveBeenCalledWith("camp-1", "acc-1", { startNow: true });
    expect(mocks.after).toHaveBeenCalledTimes(1);
    expect((await UNSCHEDULE(new Request("https://crm.test/x", { method: "POST" }), params)).status).not.toBe(403);
    expect((await STOP(new Request("https://crm.test/x?action=pause", { method: "POST" }), params)).status).not.toBe(403);
  });
});
