import { beforeEach, describe, expect, it, vi } from "vitest";

// PRD 20, lacunas G1–G3: papel mínimo em rotas que só conferiam sessão.
//   G1  whatsapp/config      DELETE/PATCH admin+ (GET segue aberto a qualquer membro, sem segredos)
//   G2  disparador/campaigns/[id]/info e /audience   owner/admin (como o resto do disparador)
//   G3  flows/end-run        viewer → 403; demais papéis como antes, só em conversa visível pela RLS

const state = vi.hoisted(() => ({
  role: "viewer" as string,
  conversationVisible: true,
  endRun: vi.fn(),
  adminTables: [] as string[],
}));

function chain(result: unknown): unknown {
  const p: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "is", "not", "limit", "order", "delete", "update", "or", "range"]) {
    p[m] = () => chain(result);
  }
  p.maybeSingle = async () => result;
  p.single = async () => result;
  p.then = (resolve: (v: unknown) => unknown) => resolve(result);
  return p;
}

// Cliente de SESSÃO (RLS): perfil do chamador + conversa visível ou não.
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
    from: (table: string) => {
      if (table === "profiles") return chain({ data: { account_id: "acc-1", account_role: state.role }, error: null });
      if (table === "conversations") {
        return chain({ data: state.conversationVisible ? { id: "conv-1" } : null, error: null });
      }
      return chain({ data: [], error: null });
    },
  }),
}));

// getCurrentAccount/requireRole para as rotas do disparador (requireDisparadorAccess).
vi.mock("@/lib/auth/account", async () => {
  class ForbiddenError extends Error {
    readonly status = 403 as const;
  }
  return {
    ForbiddenError,
    getCurrentAccount: async () => ({
      supabase: {},
      userId: "user-1",
      accountId: "acc-1",
      role: state.role,
      account: { id: "acc-1", name: "Conta" },
    }),
    toErrorResponse: (err: unknown) =>
      new Response(JSON.stringify({ error: String(err) }), { status: (err as { status?: number })?.status ?? 500 }),
  };
});

// Service roles (nunca devem ser tocados quando o papel é negado).
vi.mock("@/lib/disparador/admin-client", () => ({
  supabaseAdmin: () => ({
    from: (t: string) => {
      state.adminTables.push(t);
      return chain({ data: null, error: null });
    },
  }),
}));
vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({
    from: (t: string) => {
      state.adminTables.push(t);
      return chain({ data: { id: "conv-1", status: "open" }, error: null });
    },
  }),
}));
vi.mock("@/lib/flows/engine", () => ({ endActiveRunForConversation: (...a: unknown[]) => state.endRun(...a) }));
vi.mock("@/lib/whatsapp/channel-config", () => ({ fetchChannelConfigs: async () => ({ data: [], error: null }) }));
vi.mock("@/lib/audit/context", () => ({ auditFetch: fetch }));

import { GET as CONFIG_GET, DELETE as CONFIG_DELETE, PATCH as CONFIG_PATCH } from "../whatsapp/config/route";
import { GET as INFO } from "../disparador/campaigns/[id]/info/route";
import { GET as AUDIENCE } from "../disparador/campaigns/[id]/audience/route";
import { POST as END_RUN } from "../flows/end-run/route";

const ROLES = ["owner", "admin", "supervisor", "agent", "viewer"] as const;
const ADMIN_UP = new Set(["owner", "admin"]);
const AGENT_UP = new Set(["owner", "admin", "supervisor", "agent"]);

const params = { params: Promise.resolve({ id: "camp-1" }) };
const req = (method: string, url = "http://x/api", body?: unknown) =>
  new Request(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(() => {
  state.role = "viewer";
  state.conversationVisible = true;
  state.adminTables.length = 0;
  state.endRun.mockReset();
});

describe("G1 — /api/whatsapp/config", () => {
  it.each(ROLES)("GET segue aberto a qualquer membro (%s) — o inbox depende dele", async (role) => {
    state.role = role;
    const res = await CONFIG_GET();
    expect(res.status).toBe(200);
  });

  it.each(ROLES)("DELETE: %s", async (role) => {
    state.role = role;
    const res = await CONFIG_DELETE(req("DELETE", "http://x/api/whatsapp/config?id=cfg-1"));
    if (ADMIN_UP.has(role)) expect(res.status, role).not.toBe(403);
    else expect(res.status, role).toBe(403);
  });

  it.each(ROLES)("PATCH: %s", async (role) => {
    state.role = role;
    const res = await CONFIG_PATCH(req("PATCH", "http://x/api/whatsapp/config", { id: "cfg-1", habilitado: false }));
    if (ADMIN_UP.has(role)) expect(res.status, role).not.toBe(403);
    else expect(res.status, role).toBe(403);
  });

  it("papel baixo é barrado ANTES de qualquer escrita (nem lê o corpo)", async () => {
    state.role = "agent";
    const res = await CONFIG_PATCH(new Request("http://x", { method: "PATCH", body: "{ não é json" }));
    expect(res.status).toBe(403);
  });
});

describe("G2 — disparador/campaigns/[id]/info e /audience", () => {
  it.each(ROLES)("info: %s", async (role) => {
    state.role = role;
    const res = await INFO(req("GET"), params);
    if (ADMIN_UP.has(role)) expect(res.status, role).toBe(404); // passou o portão: campanha inexistente no mock
    else expect(res.status, role).toBe(403);
  });

  it.each(ROLES)("audience: %s", async (role) => {
    state.role = role;
    const res = await AUDIENCE(req("GET"), params);
    if (ADMIN_UP.has(role)) expect(res.status, role).toBe(404);
    else expect(res.status, role).toBe(403);
  });

  it("papel negado não toca o service role (nem decifra token de canal)", async () => {
    for (const role of ["supervisor", "agent", "viewer"]) {
      state.role = role;
      await INFO(req("GET"), params);
      await AUDIENCE(req("GET"), params);
    }
    expect(state.adminTables).toHaveLength(0);
  });
});

describe("G3 — flows/end-run", () => {
  it.each(ROLES)("%s", async (role) => {
    state.role = role;
    const res = await END_RUN(req("POST", "http://x/api/flows/end-run", { conversation_id: "conv-1" }));
    if (AGENT_UP.has(role)) {
      expect(res.status, role).toBe(200);
      expect(state.endRun).toHaveBeenCalledWith("conv-1", "ended_manually");
    } else {
      expect(res.status, role).toBe(403);
      expect(state.endRun).not.toHaveBeenCalled();
      expect(state.adminTables).toHaveLength(0);
    }
  });

  it("conversa que a RLS não deixa o usuário ver: 404 e o service role nem é tocado", async () => {
    state.role = "agent";
    state.conversationVisible = false;
    const res = await END_RUN(req("POST", "http://x/api/flows/end-run", { conversation_id: "conv-de-outro-operador" }));
    expect(res.status).toBe(404);
    expect(state.adminTables).toHaveLength(0);
    expect(state.endRun).not.toHaveBeenCalled();
  });

  it("sem conversation_id: 400 (inalterado)", async () => {
    state.role = "agent";
    expect((await END_RUN(req("POST", "http://x/api/flows/end-run", {}))).status).toBe(400);
  });
});
