// Rotas /api/v1/webhooks: autenticação por chave e escopos (PRD 15, 15.14). A lógica de negócio está em endpoints.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";

const requireApiKey = vi.fn();
vi.mock("@/lib/auth/api-context", () => ({ requireApiKey: (...a: unknown[]) => requireApiKey(...a) }));
const listEndpoints = vi.fn(async () => [{ id: "e1" }]);
const createEndpoint = vi.fn(async () => ({ id: "e1", secret: "whsec_x" }));
const replayDelivery = vi.fn(async () => {});
vi.mock("@/lib/webhooks-out/endpoints", () => ({
  listEndpoints: (...a: unknown[]) => (listEndpoints as unknown as (...x: unknown[]) => unknown)(...a),
  createEndpoint: (...a: unknown[]) => (createEndpoint as unknown as (...x: unknown[]) => unknown)(...a),
  replayDelivery: (...a: unknown[]) => (replayDelivery as unknown as (...x: unknown[]) => unknown)(...a),
  getEndpoint: vi.fn(),
  updateEndpoint: vi.fn(),
  deleteEndpoint: vi.fn(),
  listDeliveries: vi.fn(),
  rotateSecret: vi.fn(),
  enqueueTest: vi.fn(),
}));
vi.mock("@/lib/api/v1/log", () => ({ logPublicApiCall: () => {} }));

const { ApiError } = await import("@/lib/api/v1/respond");
const list = await import("./route");
const replay = await import("./[id]/deliveries/[deliveryId]/replay/route");
const one = await import("./[id]/route");

const ID = "11111111-1111-4111-8111-111111111111";
const ctx = { supabase: {}, accountId: "A", keyId: "K1", scopes: ["webhooks:write"] };
const req = (method: string, body?: unknown) => new Request("https://crm.example/api/v1/webhooks", { method, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(() => {
  requireApiKey.mockReset();
  requireApiKey.mockResolvedValue(ctx);
  listEndpoints.mockClear();
  createEndpoint.mockClear();
  replayDelivery.mockClear();
});

describe("/api/v1/webhooks", () => {
  it("GET aceita webhooks:read OU webhooks:write; POST exige webhooks:write", async () => {
    await list.GET(req("GET"));
    expect(requireApiKey).toHaveBeenLastCalledWith(expect.anything(), ["webhooks:read", "webhooks:write"]);
    await list.POST(req("POST", { url: "https://x.example/h", events: ["message.received"] }));
    expect(requireApiKey).toHaveBeenLastCalledWith(expect.anything(), "webhooks:write");
  });

  it("chave sem escopo / inválida: 403 / 401 no envelope v1 e NADA é lido nem gravado", async () => {
    requireApiKey.mockRejectedValueOnce(new ApiError("forbidden", "missing scope", 403));
    const res = await list.POST(req("POST", { url: "https://x.example/h", events: ["message.received"] }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "forbidden", message: "missing scope" } });
    requireApiKey.mockRejectedValueOnce(new ApiError("unauthorized", "Missing or invalid API key", 401));
    expect((await list.GET(req("GET"))).status).toBe(401);
    expect(createEndpoint).not.toHaveBeenCalled();
    expect(listEndpoints).not.toHaveBeenCalled();
  });

  it("POST devolve 201 com o segredo (só aqui) e usa a conta/chave do contexto, nunca do corpo", async () => {
    const res = await list.POST(req("POST", { url: "https://x.example/h", events: ["message.received"], account_id: "OUTRA" }));
    expect(res.status).toBe(201);
    expect((await res.json()).data.secret).toBe("whsec_x");
    expect(createEndpoint).toHaveBeenCalledWith(ctx.supabase, expect.objectContaining({ accountId: "A", keyId: "K1" }));
  });

  it("corpo inválido → 400; corpo grande → 413", async () => {
    const bad = await list.POST(new Request("https://crm.example/api/v1/webhooks", { method: "POST", body: "{nao json" }));
    expect(bad.status).toBe(400);
    const big = await list.POST(new Request("https://crm.example/api/v1/webhooks", { method: "POST", body: JSON.stringify({ x: "y".repeat(20_000) }) }));
    expect(big.status).toBe(413);
    const arr = await list.POST(req("POST", [1]));
    expect(arr.status).toBe(400);
  });

  it("id que não é UUID → 404 sem consultar o banco", async () => {
    const res = await one.GET(req("GET"), { params: Promise.resolve({ id: "nao-e-uuid" }) });
    expect(res.status).toBe(404);
    const r2 = await replay.POST(req("POST"), { params: Promise.resolve({ id: ID, deliveryId: "x" }) });
    expect(r2.status).toBe(404);
    expect(replayDelivery).not.toHaveBeenCalled();
  });

  it("replay responde 202 e escopa pela conta do contexto", async () => {
    const res = await replay.POST(req("POST"), { params: Promise.resolve({ id: ID, deliveryId: ID }) });
    expect(res.status).toBe(202);
    expect(replayDelivery).toHaveBeenCalledWith(ctx.supabase, "A", ID, ID);
  });
});
