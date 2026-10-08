// POST /api/account/invitations — o host do link vem só de configuração do servidor (falha fechado).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const inserts: unknown[] = [];
vi.mock("@/lib/auth/account", () => ({
  requireRole: async () => ({
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
