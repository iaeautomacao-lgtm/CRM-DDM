import { beforeEach, describe, expect, it, vi } from "vitest";

const requirePermission = vi.fn();
vi.mock("@/lib/auth/account", () => ({
  requirePermission: (...a: unknown[]) => requirePermission(...a),
  toErrorResponse: (e: unknown) => Response.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 500 }),
}));
const buildSystemHealth = vi.fn();
vi.mock("@/lib/ops/system-health", () => ({ buildSystemHealth: (...a: unknown[]) => buildSystemHealth(...a) }));
vi.mock("@/lib/disparador/admin-client", () => ({ supabaseAdmin: () => ({ marker: "admin" }) }));

const { GET } = await import("./route");

beforeEach(() => {
  requirePermission.mockReset();
  buildSystemHealth.mockReset();
});

describe("GET /api/ops/status", () => {
  it("exige audit.view e devolve o relatório com no-store", async () => {
    requirePermission.mockResolvedValue({ accountId: "A" });
    buildSystemHealth.mockResolvedValue({ ok: true });
    const res = await GET();
    expect(requirePermission).toHaveBeenCalledWith("audit.view");
    expect(buildSystemHealth).toHaveBeenCalledWith({ marker: "admin" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ data: { ok: true } });
  });

  it("sem permissão: 403 e NADA é lido com service role", async () => {
    requirePermission.mockRejectedValue(Object.assign(new Error("forbidden"), { status: 403 }));
    const res = await GET();
    expect(res.status).toBe(403);
    expect(buildSystemHealth).not.toHaveBeenCalled();
  });
});
