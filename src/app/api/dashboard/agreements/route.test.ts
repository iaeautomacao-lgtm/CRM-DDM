import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  supabaseAdmin: vi.fn(),
  loadAgreementDashboardMetrics: vi.fn(),
}));

vi.mock("@/lib/auth/account", () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: (error: Error) =>
    Response.json(
      { error: error.message === "Unauthorized" ? "Unauthorized" : error.message === "Forbidden" ? "Forbidden" : "Internal server error" },
      { status: error.message === "Unauthorized" ? 401 : error.message === "Forbidden" ? 403 : 500 },
    ),
}));

vi.mock("@/lib/account/admin-client", () => ({
  supabaseAdmin: mocks.supabaseAdmin,
}));

vi.mock("@/lib/dashboard/agreement-data", () => ({
  loadAgreementDashboardMetrics: mocks.loadAgreementDashboardMetrics,
}));

import { GET } from "./route";

describe("GET /api/dashboard/agreements", () => {
  const accountId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  const db = { name: "service-client" };
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRole.mockResolvedValue({ accountId, userId: "staff-user" });
    mocks.supabaseAdmin.mockReturnValue(db);
    mocks.loadAgreementDashboardMetrics.mockResolvedValue({
      total: 15, ai: 2, human: 10, unknown: 3,
      attributed: 12, aiShareOfAttributed: 17, attributionCoverage: 80,
      closedToday: 0, closedLast7Days: 0, closedLast30Days: 15,
    });
  });

  it("requires an authenticated account before querying the privileged database", async () => {
    mocks.requireRole.mockRejectedValue(new Error("Unauthorized"));
    const response = await GET();
    expect(response.status).toBe(401);
    expect(mocks.supabaseAdmin).not.toHaveBeenCalled();
    expect(mocks.loadAgreementDashboardMetrics).not.toHaveBeenCalled();
  });

  it("rejects agents or supervisors requesting account-wide totals", async () => {
    mocks.requireRole.mockRejectedValue(new Error("Forbidden"));
    const response = await GET();
    expect(response.status).toBe(403);
    expect(mocks.supabaseAdmin).not.toHaveBeenCalled();
    expect(mocks.loadAgreementDashboardMetrics).not.toHaveBeenCalled();
  });

  it("passes ONLY the authenticated account id and returns aggregates without PII", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.loadAgreementDashboardMetrics).toHaveBeenCalledWith(db, accountId);
    expect(mocks.requireRole).toHaveBeenCalledWith("admin");
    const body = await response.json();
    expect(body.data).toMatchObject({ total: 15, ai: 2, human: 10, unknown: 3 });
    expect(JSON.stringify(body)).not.toContain("staff-user");
    expect(JSON.stringify(body)).not.toContain("resource_id");
  });

  it("never exposes internal database error details", async () => {
    mocks.loadAgreementDashboardMetrics.mockRejectedValue(new Error("private database credentials"));
    const response = await GET();
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("Internal server error");
  });
});
