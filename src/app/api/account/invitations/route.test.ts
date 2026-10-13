// POST /api/account/invitations — o host do link vem só de configuração do servidor (falha fechado).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const inserts: unknown[] = [];
vi.mock("@/lib/auth/account", () => ({
  requirePermission: async () => ({
    userId: "u1",
    accountId: "acc-1",
    supabase: {
      from: () => ({
        insert: (row: unknown) => {
          inserts.push(row);
          return { select: () => ({ single: async () => ({ data: { id: "i1", role: "agent", label: null, expires_at: "x", created_at: "y" }, error: null }) }) };
        },
      }),
    },
  }),
  toErrorResponse: (e: unknown) => new Response(JSON.stringify({ error: String(e) }), { status: 500 }),
}));
const roleCalls = vi.hoisted(() => [] as unknown[]);
const roleResult = vi.hoisted(() => ({ value: { roleId: "r-agent", role: "agent" } as unknown, error: null as unknown }));
vi.mock("@/lib/account/admin-client", () => ({ supabaseAdmin: () => ({}) }));
vi.mock("@/lib/roles/invite-role", () => ({
  resolveInviteRole: async (_db: unknown, input: unknown) => {
    roleCalls.push(input);
    if (roleResult.error) throw roleResult.error;
    return roleResult.value;
  },
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => new Response(null, { status: 429 }),
  RATE_LIMITS: { adminAction: {} },
}));

const { POST } = await import("./route");

const post = (headers: Record<string, string> = {}) =>
  POST(new Request("https://interno.local/api/account/invitations", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ role: "agent" }) }));

const saved = { app: process.env.NEXT_PUBLIC_APP_URL, site: process.env.NEXT_PUBLIC_SITE_URL, hosts: process.env.ALLOWED_INVITE_HOSTS };
beforeEach(() => {
  inserts.length = 0;
  roleCalls.length = 0;
  roleResult.error = null;
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.NEXT_PUBLIC_SITE_URL;
  delete process.env.ALLOWED_INVITE_HOSTS;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  for (const [k, v] of [["NEXT_PUBLIC_APP_URL", saved.app], ["NEXT_PUBLIC_SITE_URL", saved.site], ["ALLOWED_INVITE_HOSTS", saved.hosts]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("POST /api/account/invitations — host do link", () => {
  it("com a URL do app, o link usa ela — mesmo com Host malicioso", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://crm.exemplo.com";
    const res = await post({ host: "phishing.example", "x-forwarded-host": "phishing.example" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { url: string };
    expect(body.url.startsWith("https://crm.exemplo.com/join/")).toBe(true);
    expect(body.url).not.toContain("phishing.example");
  });

  it("host fora da lista (sem URL do app): erro 500 claro e NENHUM convite é criado", async () => {
    process.env.ALLOWED_INVITE_HOSTS = "crm.exemplo.com,staging.exemplo.com";
    const res = await post({ host: "phishing.example" });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toMatch(/ALLOWED_INVITE_HOSTS/);
    expect(inserts).toHaveLength(0);
  });

  it("nada configurado: 500 com mensagem clara, sem link para host arbitrário nem wacrm.tech", async () => {
    const res = await post({ host: "crm.exemplo.com" });
    expect(res.status).toBe(500);
    const { error } = (await res.json()) as { error: string };
    expect(error).toMatch(/NEXT_PUBLIC_APP_URL/);
    expect(error).not.toContain("wacrm.tech");
    expect(inserts).toHaveLength(0);
  });
});

describe("POST /api/account/invitations — cargo do convite (TASK5, 318/319)", () => {
  const send = (body: unknown) =>
    POST(new Request("https://interno.local/api/account/invitations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = "https://crm.exemplo.com";
  });

  it("role_id escolhido: conferido pela regra de nível e gravado com o compat em `role`", async () => {
    const ROLE = "00000000-0000-0000-0000-0000000000c3";
    roleResult.value = { roleId: ROLE, role: "supervisor" };
    expect((await send({ role_id: ROLE })).status).toBe(201);
    expect(roleCalls[0]).toEqual({ accountId: "acc-1", actorId: "u1", roleId: ROLE, role: null });
    expect(inserts[0]).toMatchObject({ role: "supervisor", role_id: ROLE, account_id: "acc-1" });
  });

  it("formato antigo (role) também passa pela regra; cargo acima do seu = 403 role_level, sem criar convite", async () => {
    const { CustomRoleError } = await import("@/lib/roles/custom-roles");
    roleResult.error = new CustomRoleError("Esse cargo é do seu nível ou acima", 403, "role_level");
    const res = await send({ role: "admin" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "role_level" });
    expect(roleCalls[0]).toMatchObject({ roleId: null, role: "admin" });
    expect(inserts).toHaveLength(0);
  });

  it("role_id inválido ou sem cargo: 400", async () => {
    expect((await send({ role_id: "x" })).status).toBe(400);
    expect((await send({})).status).toBe(400);
    expect(inserts).toHaveLength(0);
  });
});
