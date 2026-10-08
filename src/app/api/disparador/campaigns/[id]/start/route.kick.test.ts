import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// SG-4: o "kick" que acorda o cron depois de iniciar uma campanha manda o CRON_SECRET em x-cron-secret.
// A URL de destino vem do ambiente da plataforma — nunca do Host/URL da requisição do usuário.

const mocks = vi.hoisted(() => ({
  after: [] as Array<() => Promise<void>>,
  start: vi.fn(),
  log: vi.fn(),
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: (cb: () => Promise<void>) => void mocks.after.push(cb) };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: { account_id: "acc-1", account_role: "admin" }, error: null }) }),
      }),
    }),
  }),
}));

function chain(result: unknown): unknown {
  const proxy: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "is", "not", "limit", "update", "delete", "order"]) proxy[m] = () => chain(result);
  proxy.single = async () => result;
  proxy.maybeSingle = async () => result;
  proxy.then = (resolve: (v: unknown) => unknown) => resolve(result);
  return proxy;
}
vi.mock("@/lib/disparador/admin-client", () => ({
  supabaseAdmin: () => ({
    from: () => chain({ data: { id: "camp-1", created_by: "user-1", account_id: "acc-1" }, error: null }),
    rpc: async () => ({ data: 1, error: null }),
  }),
}));
vi.mock("@/lib/disparador/worker", () => ({ ensureQueueWorkerRunning: () => undefined }));
vi.mock("@/lib/disparador/startCampaign", () => ({ startCampaign: mocks.start }));
vi.mock("@/lib/logger", () => ({ writeLog: mocks.log }));

import { POST } from "./route";

const params = { params: Promise.resolve({ id: "camp-1" }) };
// URL com um Host forjado (o que um chamador mal-intencionado faria o proxy repassar).
const forged = () =>
  new Request("https://atacante.example/api/disparador/campaigns/camp-1/start", {
    method: "POST",
    headers: { "Content-Type": "application/json", host: "atacante.example", "x-forwarded-host": "atacante.example" },
    body: JSON.stringify({ agora: true }),
  });

describe("start → kick do cron (SG-4)", () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: "processed" }), { status: 200 }));

  beforeEach(() => {
    mocks.after.length = 0;
    mocks.start.mockResolvedValue({ ok: true, enqueued: 3 });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("CRON_SECRET", "segredo-do-cron");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  const runAfter = async () => {
    for (const cb of mocks.after) await cb();
  };
  const calledUrls = () => (fetchMock.mock.calls as unknown as Array<[string | URL]>).map((c) => String(c[0]));

  it("Host forjado não recebe o x-cron-secret: o POST vai para a URL do ambiente", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://crm.real.example");
    vi.stubEnv("DISPARADOR_CHAIN_URL", "");
    expect((await POST(forged(), params)).status).toBe(200);
    await runAfter();

    expect(calledUrls()).toEqual(["https://crm.real.example/api/disparador/cron"]);
    const init = (fetchMock.mock.calls[0] as unknown as [unknown, RequestInit])[1];
    expect(new Headers(init.headers).get("x-cron-secret")).toBe("segredo-do-cron");
    expect(calledUrls().some((u) => u.includes("atacante.example"))).toBe(false);
  });

  it("DISPARADOR_CHAIN_URL tem precedência sobre NEXT_PUBLIC_APP_URL (mesma regra do tick encadeado)", async () => {
    vi.stubEnv("DISPARADOR_CHAIN_URL", "http://localhost:3000");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://crm.real.example");
    await POST(forged(), params);
    await runAfter();
    expect(calledUrls()).toEqual(["http://localhost:3000/api/disparador/cron"]);
  });

  it("sem URL do app no ambiente, NADA é chamado (o segredo não vai para o Host da requisição)", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    vi.stubEnv("DISPARADOR_CHAIN_URL", "");
    expect((await POST(forged(), params)).status).toBe(200);
    await runAfter();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("x-internal-cron (SG-10): segredo em tempo constante, fail-closed", () => {
  beforeEach(() => {
    mocks.after.length = 0;
    mocks.start.mockResolvedValue({ ok: true, enqueued: 1 });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });
  const withHeader = (value: string) =>
    new Request("https://crm.real.example/api/disparador/campaigns/camp-1/start", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-cron": value },
      body: "{}",
    });

  it("segredo certo é chamada interna (não agenda o kick); errado cai no fluxo de sessão (agenda)", async () => {
    vi.stubEnv("CRON_SECRET", "segredo-do-cron");
    expect((await POST(withHeader("segredo-do-cron"), params)).status).toBe(200);
    expect(mocks.after).toHaveLength(0);

    expect((await POST(withHeader("segredo-do-cronX"), params)).status).toBe(200);
    expect(mocks.after).toHaveLength(1);
  });

  it("sem CRON_SECRET configurado o header nunca vale como interno", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await POST(withHeader(""), params)).status).toBe(200);
    expect(mocks.after).toHaveLength(1);
  });
});
