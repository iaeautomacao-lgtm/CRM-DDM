import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { generateApiKey } from "@/lib/api-keys/keys";
import type { ApiKeyRow } from "@/lib/api-keys/store";
import { ApiError } from "@/lib/api/v1/respond";
import { __resetRateLimitForTests, RATE_LIMITS } from "@/lib/rate-limit";

// Mock the service-role client factory — requireApiKey only stashes
// the returned client in the context; tests never call through it.
vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({ __isMockAdminClient: true }),
}));

// Mock the store so we control which row a hash resolves to.
const findActiveKeyByHash = vi.fn<(hash: string) => Promise<ApiKeyRow | null>>();
const touchLastUsed = vi.fn();
vi.mock("@/lib/api-keys/store", () => ({
  findActiveKeyByHash: (hash: string) => findActiveKeyByHash(hash),
  touchLastUsed: (id: string) => touchLastUsed(id),
}));

// Import AFTER the mocks are registered.
const { requireApiKey } = await import("./api-context");

const KEY = generateApiKey().plaintext;

function reqWith(authHeader?: string): Request {
  return new Request("https://crm.example.com/api/v1/me", {
    headers: authHeader ? { authorization: authHeader } : {},
  });
}

function row(overrides: Partial<ApiKeyRow> = {}): ApiKeyRow {
  return {
    id: "key-1",
    account_id: "acct-1",
    created_by: "user-1",
    user_id: null,
    name: "Test key",
    scopes: ["messages:send"],
    expires_at: null,
    revoked_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  __resetRateLimitForTests();
  findActiveKeyByHash.mockReset();
  touchLastUsed.mockReset();
});

afterEach(() => {
  __resetRateLimitForTests();
});

async function expectApiError(p: Promise<unknown>, code: string, status: number) {
  await expect(p).rejects.toBeInstanceOf(ApiError);
  await p.catch((e: unknown) => {
    const err = e as ApiError;
    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
  });
}

describe("requireApiKey", () => {
  it("401s when no Authorization header is present", async () => {
    await expectApiError(requireApiKey(reqWith()), "unauthorized", 401);
    expect(findActiveKeyByHash).not.toHaveBeenCalled();
  });

  it("401s on a token that doesn't look like a wacrm key", async () => {
    await expectApiError(
      requireApiKey(reqWith("Bearer some-invite-token")),
      "unauthorized",
      401,
    );
    expect(findActiveKeyByHash).not.toHaveBeenCalled();
  });

  it("401s when the key is unknown / revoked / expired (store returns null)", async () => {
    findActiveKeyByHash.mockResolvedValue(null);
    await expectApiError(
      requireApiKey(reqWith(`Bearer ${KEY}`)),
      "unauthorized",
      401,
    );
  });

  it("returns a context for a valid key with no scope required", async () => {
    findActiveKeyByHash.mockResolvedValue(row());
    const ctx = await requireApiKey(reqWith(`Bearer ${KEY}`));
    expect(ctx.authType).toBe("api_key");
    expect(ctx.accountId).toBe("acct-1");
    expect(ctx.keyId).toBe("key-1");
    expect(ctx.scopes).toEqual(["messages:send"]);
    expect(touchLastUsed).toHaveBeenCalledWith("key-1");
  });

  it("accepts a bare key without the 'Bearer ' prefix", async () => {
    findActiveKeyByHash.mockResolvedValue(row());
    const ctx = await requireApiKey(reqWith(KEY));
    expect(ctx.accountId).toBe("acct-1");
  });

  it("403s when the key lacks the required scope", async () => {
    findActiveKeyByHash.mockResolvedValue(row({ scopes: ["contacts:read"] }));
    await expectApiError(
      requireApiKey(reqWith(`Bearer ${KEY}`), "messages:send"),
      "forbidden",
      403,
    );
  });

  it("passes when the key has the required scope", async () => {
    findActiveKeyByHash.mockResolvedValue(row({ scopes: ["messages:send"] }));
    const ctx = await requireApiKey(reqWith(`Bearer ${KEY}`), "messages:send");
    expect(ctx.accountId).toBe("acct-1");
  });

  it("429s once the per-key budget is exhausted", async () => {
    findActiveKeyByHash.mockResolvedValue(row());
    // Burn the whole window.
    for (let i = 0; i < RATE_LIMITS.publicApi.limit; i++) {
      await requireApiKey(reqWith(`Bearer ${KEY}`));
    }
    await expectApiError(
      requireApiKey(reqWith(`Bearer ${KEY}`)),
      "rate_limited",
      429,
    );
  });
});

// PRD 14, 14.9 (AP-09): chave inválida é barrada por IP ANTES de consultar o banco.
describe("requireApiKey — flood de chave inválida por IP (AP-09)", () => {
  const BAD = generateApiKey().plaintext; // formato válido, mas desconhecido no banco
  const fromIp = (ip: string, key = BAD) =>
    new Request("https://crm.example.com/api/v1/me", { headers: { authorization: `Bearer ${key}`, "x-real-ip": ip } });

  it("depois de 30 tentativas inválidas do mesmo IP, a seguinte vira 429 SEM consultar o banco", async () => {
    findActiveKeyByHash.mockResolvedValue(null);
    for (let i = 0; i < RATE_LIMITS.apiKeyFailures.limit; i++) {
      await expectApiError(requireApiKey(fromIp("203.0.113.7")), "unauthorized", 401);
    }
    expect(findActiveKeyByHash.mock.calls.length).toBe(RATE_LIMITS.apiKeyFailures.limit);
    // a 31ª falha já passa do teto: 429; as seguintes nem chegam ao banco
    await expectApiError(requireApiKey(fromIp("203.0.113.7")), "rate_limited", 429);
    const afterBlock = findActiveKeyByHash.mock.calls.length;
    await expectApiError(requireApiKey(fromIp("203.0.113.7")), "rate_limited", 429);
    await expectApiError(requireApiKey(fromIp("203.0.113.7")), "rate_limited", 429);
    expect(findActiveKeyByHash.mock.calls.length).toBe(afterBlock); // 0 consultas novas
  });

  it("outro IP não é afetado; o IP barrado fica fora mesmo com chave válida", async () => {
    findActiveKeyByHash.mockResolvedValue(null);
    for (let i = 0; i < 40; i++) await requireApiKey(fromIp("198.51.100.1")).catch(() => undefined);
    findActiveKeyByHash.mockResolvedValue(row());
    await expectApiError(requireApiKey(fromIp("198.51.100.1", KEY)), "rate_limited", 429);
    const ok = await requireApiKey(fromIp("198.51.100.2", KEY));
    expect(ok.accountId).toBe("acct-1");
  });

  it("chave válida não conta como falha", async () => {
    findActiveKeyByHash.mockResolvedValue(row());
    for (let i = 0; i < 40; i++) await requireApiKey(fromIp("192.0.2.9", KEY)).catch(() => undefined);
    findActiveKeyByHash.mockResolvedValue(null);
    await expectApiError(requireApiKey(fromIp("192.0.2.9")), "unauthorized", 401);
  });

  it("cabeçalho malformado também conta como tentativa inválida (sem consulta ao banco)", async () => {
    for (let i = 0; i < RATE_LIMITS.apiKeyFailures.limit; i++) {
      await requireApiKey(fromIp("203.0.113.50", "nao-e-uma-chave")).catch(() => undefined);
    }
    await expectApiError(requireApiKey(fromIp("203.0.113.50", "nao-e-uma-chave")), "rate_limited", 429);
    expect(findActiveKeyByHash).not.toHaveBeenCalled();
  });
});
