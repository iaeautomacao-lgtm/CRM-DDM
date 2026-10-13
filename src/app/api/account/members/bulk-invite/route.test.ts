// POST /api/account/members/bulk-invite — revisão de segurança 13/10: sem senha padrão compartilhada. Cada usuário nasce
// com uma senha aleatória que ninguém vê e a resposta traz um link de definição de senha por pessoa.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  created: [] as Array<{ email: string; password: string }>,
  linkError: null as { message: string } | null,
}));

vi.mock("@/lib/auth/account", () => ({
  requirePermission: async () => ({ userId: "owner-1", accountId: "acc-1", role: "owner" }),
  toErrorResponse: (e: unknown) => new Response(JSON.stringify({ error: String(e) }), { status: 500 }),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ success: true }),
  rateLimitResponse: () => new Response(null, { status: 429 }),
  RATE_LIMITS: { adminAction: {} },
}));
vi.mock("@/lib/account/admin-client", () => ({
  supabaseAdmin: () => ({
    auth: {
      admin: {
        createUser: async (attrs: { email: string; password: string }) => {
          mocks.created.push({ email: attrs.email, password: attrs.password });
          return { data: { user: { id: `u-${mocks.created.length}` } }, error: null };
        },
        generateLink: async ({ email }: { email: string }) =>
          mocks.linkError
            ? { data: null, error: mocks.linkError }
            : { data: { properties: { hashed_token: `hash-${email}` } }, error: null },
        deleteUser: async () => ({ error: null }),
      },
    },
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "update", "delete"]) b[m] = () => b;
      b.maybeSingle = async () => ({ data: table === "profiles" ? { account_id: "orphan-acc" } : null, error: null });
      b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(ok);
      return b;
    },
  }),
}));

const { POST } = await import("./route");
const post = (body: unknown) =>
  POST(new Request("https://interno.local/api/account/members/bulk-invite", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const members = [
  { name: "Ana", email: "ana@exemplo.com", role: "operador" },
  { name: "Bia", email: "bia@exemplo.com", role: "supervisor" },
];

const saved = process.env.NEXT_PUBLIC_APP_URL;
beforeEach(() => {
  mocks.created.length = 0;
  mocks.linkError = null;
  process.env.NEXT_PUBLIC_APP_URL = "https://crm.exemplo.com";
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  if (saved === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = saved;
});

describe("POST /api/account/members/bulk-invite — senha", () => {
  it("cada usuário nasce com senha aleatória própria; a senha do corpo (front antigo) é ignorada", async () => {
    const res = await post({ members, password: "senha-padrao-compartilhada" });
    expect(res.status).toBe(200);
    expect(mocks.created).toHaveLength(2);
    const [a, b] = mocks.created;
    expect(a.password).not.toBe("senha-padrao-compartilhada");
    expect(a.password).not.toBe(b.password);
    expect(a.password.length).toBeGreaterThanOrEqual(40);
    // a senha aleatória nunca volta na resposta
    const json = (await res.json()) as Record<string, unknown>;
    expect(JSON.stringify(json)).not.toContain(a.password);
  });

  it("devolve um link de definição de senha por pessoa, pela URL do servidor", async () => {
    const json = (await (await post({ members })).json()) as { imported: number; links: Array<{ email: string; name: string; link: string }> };
    expect(json.imported).toBe(2);
    expect(json.links).toEqual([
      { email: "ana@exemplo.com", name: "Ana", link: "https://crm.exemplo.com/auth/callback?token_hash=hash-ana%40exemplo.com&type=recovery&next=/reset-password" },
      { email: "bia@exemplo.com", name: "Bia", link: "https://crm.exemplo.com/auth/callback?token_hash=hash-bia%40exemplo.com&type=recovery&next=/reset-password" },
    ]);
  });

  it("falha ao gerar o link: o usuário fica importado com link null (usa 'Esqueci minha senha')", async () => {
    mocks.linkError = { message: "boom" };
    const json = (await (await post({ members: [members[0]] })).json()) as { imported: number; links: Array<{ link: string | null }> };
    expect(json.imported).toBe(1);
    expect(json.links[0].link).toBeNull();
  });

  it("sem URL confiável do app: 500 ANTES de criar qualquer usuário", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    const res = await post({ members });
    expect(res.status).toBe(500);
    expect(mocks.created).toHaveLength(0);
  });
});
