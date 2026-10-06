import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateApiKey } from "@/lib/api-keys/keys";
import type { ApiKeyRow } from "@/lib/api-keys/store";
import { ApiError } from "@/lib/api/v1/respond";
import { __resetRateLimitForTests } from "@/lib/rate-limit";
import { fakeDb, type Tables } from "./__tests__/fake-db";

// requireApiKey real, com o store simulado (controla qual linha o hash acha).
vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: () => ({ __isMockAdminClient: true }) }));
const findActiveKeyByHash = vi.fn<(hash: string) => Promise<ApiKeyRow | null>>();
vi.mock("@/lib/api-keys/store", () => ({
  findActiveKeyByHash: (hash: string) => findActiveKeyByHash(hash),
  touchLastUsed: () => {},
}));

const { requireIntelligenceApiKey } = await import("./api-key");

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const T1 = "11111111-0000-4000-8000-000000000001";
const T2 = "22222222-0000-4000-8000-000000000002";
const TB = "33333333-0000-4000-8000-000000000003";
const KEY = generateApiKey().plaintext;

function req(): Request {
  return new Request("https://crm.example.com/api/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}` },
  });
}

function keyRow(overrides: Partial<ApiKeyRow> = {}): ApiKeyRow {
  return {
    id: "key-1",
    account_id: A,
    created_by: "sup",
    user_id: "sup",
    name: "Claude",
    scopes: ["intelligence:read"],
    expires_at: null,
    revoked_at: null,
    ...overrides,
  };
}

function tables(role: string, account = A): Tables {
  return {
    profiles: [{ user_id: "sup", account_id: account, account_role: role }],
    team_members: [
      { user_id: "sup", team_id: T1 },
      { user_id: "sup", team_id: TB },
    ],
    teams: [
      { id: T1, account_id: A },
      { id: T2, account_id: A },
      { id: TB, account_id: B },
    ],
  };
}

async function expectApiError(p: Promise<unknown>, status: number) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).status).toBe(status);
}

beforeEach(() => {
  __resetRateLimitForTests();
  findActiveKeyByHash.mockReset();
});

describe("requireIntelligenceApiKey", () => {
  it("chave revogada/expirada/desconhecida → 401 (store não devolve linha)", async () => {
    findActiveKeyByHash.mockResolvedValue(null);
    const { db } = fakeDb(tables("supervisor"));
    await expectApiError(requireIntelligenceApiKey(req(), { db }), 401);
  });

  it("chave sem intelligence:read → 403", async () => {
    findActiveKeyByHash.mockResolvedValue(keyRow({ scopes: ["messages:send"] }));
    const { db } = fakeDb(tables("owner"));
    await expectApiError(requireIntelligenceApiKey(req(), { db }), 403);
  });

  it("chave sem dono (user_id null) é recusada para o Intelligence", async () => {
    findActiveKeyByHash.mockResolvedValue(keyRow({ user_id: null }));
    const { db } = fakeDb(tables("owner"));
    await expectApiError(requireIntelligenceApiKey(req(), { db }), 403);
  });

  it("supervisor: escopo restrito às equipes dele nesta conta", async () => {
    findActiveKeyByHash.mockResolvedValue(keyRow());
    const { db } = fakeDb(tables("supervisor"));
    const ctx = await requireIntelligenceApiKey(req(), { db });
    expect(ctx).toEqual({
      keyId: "key-1",
      scope: { accountId: A, userId: "sup", role: "supervisor", teamIds: [T1] },
    });
  });

  it("owner/admin: conta toda", async () => {
    findActiveKeyByHash.mockResolvedValue(keyRow());
    const { db } = fakeDb(tables("admin"));
    const ctx = await requireIntelligenceApiKey(req(), { db });
    expect(ctx.scope.teamIds).toBeNull();
  });

  it("papel recalculado a cada requisição: rebaixado a agente → 403", async () => {
    findActiveKeyByHash.mockResolvedValue(keyRow());
    const { db } = fakeDb(tables("agent"));
    await expectApiError(requireIntelligenceApiKey(req(), { db }), 403);
  });

  it("dono removido da conta (perfil em outra conta ou sem perfil) → 403", async () => {
    findActiveKeyByHash.mockResolvedValue(keyRow());
    await expectApiError(requireIntelligenceApiKey(req(), { db: fakeDb(tables("owner", B)).db }), 403);
    await expectApiError(requireIntelligenceApiKey(req(), { db: fakeDb({ profiles: [] }).db }), 403);
  });
});
