import { afterEach, describe, expect, it, vi } from "vitest";

import { SYSTEM_ROLE_PERMISSIONS } from "@/lib/auth/permissions";

const mocks = vi.hoisted(() => ({ getCurrentAccount: vi.fn() }));

vi.mock("@/lib/auth/account", async () => {
  class UnauthorizedError extends Error {
    readonly status = 401 as const;
  }
  class ForbiddenError extends Error {
    readonly status = 403 as const;
  }
  const { NextResponse } = await import("next/server");
  return {
    UnauthorizedError,
    ForbiddenError,
    getCurrentAccount: mocks.getCurrentAccount,
    toErrorResponse: (err: unknown) =>
      err instanceof UnauthorizedError || err instanceof ForbiddenError
        ? NextResponse.json({ error: err.message }, { status: err.status })
        : NextResponse.json({ error: "Internal server error" }, { status: 500 }),
  };
});

const { UnauthorizedError } = await import("@/lib/auth/account");
const me = await import("./route");
const catalog = await import("../../account/permission-catalog/route");

const ctx = (role: "owner" | "agent") => ({
  account: { id: "acc-1", name: "Acme" },
  role,
  permissions: SYSTEM_ROLE_PERMISSIONS[role],
});

afterEach(() => vi.clearAllMocks());

describe("GET /api/me/permissions", () => {
  it("devolve o contrato e Cache-Control: no-store", async () => {
    mocks.getCurrentAccount.mockResolvedValue(ctx("agent"));
    const res = await me.GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({
      organization: { id: "acc-1", name: "Acme" },
      role: { key: "agent", name: "Operador", kind: "system", rank: 2 },
      status: "active",
      scopes: { inbox: "own" },
    });
    expect(body.permissions).toContain("inbox.reply");
    expect(body.permissions).not.toContain("campaigns.manage");
    expect(body.pages).toContain("/inbox");
    expect(body.pages).not.toContain("/disparador");
  });

  it("sem sessão: 401", async () => {
    mocks.getCurrentAccount.mockRejectedValue(new UnauthorizedError());
    expect((await me.GET()).status).toBe(401);
  });
});

describe("GET /api/account/permission-catalog", () => {
  it("devolve os grupos para qualquer papel com members.view (todos hoje)", async () => {
    mocks.getCurrentAccount.mockResolvedValue(ctx("agent"));
    const res = await catalog.GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.groups.length).toBeGreaterThan(5);
    expect(body.groups[0].permissions[0]).toHaveProperty("grantable");
  });

  it("papel personalizado sem members.view nem roles.manage: 403", async () => {
    mocks.getCurrentAccount.mockResolvedValue({ ...ctx("agent"), permissions: new Set(["inbox.view"]) });
    expect((await catalog.GET()).status).toBe(403);
  });

  it("sem sessão: 401", async () => {
    mocks.getCurrentAccount.mockRejectedValue(new UnauthorizedError());
    expect((await catalog.GET()).status).toBe(401);
  });
});
