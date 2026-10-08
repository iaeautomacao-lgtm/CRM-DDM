import { beforeEach, describe, expect, it, vi } from "vitest";

import { SYSTEM_ROLE_PERMISSIONS } from "@/lib/auth/permissions";
import { ACCOUNT_ROLES, hasMinRole } from "@/lib/auth/roles";

// PRD 20, 20.3c: o gate do disparador é permissão (campaigns.manage / campaigns.rate_limit), com o MESMO
// resultado do papel de antes (owner/admin).

const mocks = vi.hoisted(() => ({ getCurrentAccount: vi.fn() }));
vi.mock("@/lib/auth/account", async () => {
  class ForbiddenError extends Error {
    readonly status = 403 as const;
    constructor(message = "Forbidden", readonly permission?: string) {
      super(message);
    }
  }
  return { ForbiddenError, getCurrentAccount: mocks.getCurrentAccount };
});

const { canManageCampaigns, requireDisparadorAccess } = await import("./route-auth");

const ctx = (role: (typeof ACCOUNT_ROLES)[number], permissions?: ReadonlySet<string>) => ({
  userId: "u1",
  accountId: "a1",
  role,
  permissions: permissions ?? SYSTEM_ROLE_PERMISSIONS[role],
});

beforeEach(() => mocks.getCurrentAccount.mockReset());

describe("canManageCampaigns / requireDisparadorAccess", () => {
  it.each(ACCOUNT_ROLES)("%s: campaigns.manage e campaigns.rate_limit == admin+ (como antes)", async (role) => {
    const expected = hasMinRole(role, "admin");
    expect(canManageCampaigns(role)).toBe(expected);
    for (const permission of ["campaigns.manage", "campaigns.rate_limit"] as const) {
      mocks.getCurrentAccount.mockResolvedValue(ctx(role));
      const ok = await requireDisparadorAccess(permission).then(() => true, () => false);
      expect(ok, `${role} ${permission}`).toBe(expected);
    }
  });

  it("papel nulo/indefinido não gerencia", () => {
    expect(canManageCampaigns(null)).toBe(false);
    expect(canManageCampaigns(undefined)).toBe(false);
  });

  it("403 informa a permissão que faltou; a lista efetiva vale sobre o papel", async () => {
    mocks.getCurrentAccount.mockResolvedValue(ctx("admin", new Set(["campaigns.manage"])));
    await expect(requireDisparadorAccess("campaigns.manage")).resolves.toBeTruthy();
    const err = await requireDisparadorAccess("campaigns.rate_limit").catch((e) => e);
    expect(err.status).toBe(403);
    expect(err.permission).toBe("campaigns.rate_limit");
  });
});
