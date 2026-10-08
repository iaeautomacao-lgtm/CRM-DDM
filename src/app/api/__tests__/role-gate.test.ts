import { beforeEach, describe, expect, it, vi } from "vitest";

// Papel mínimo nas rotas que escreviam com service role sem checar papel
// (flows, WAHA start/stop/qr/pairing-code, ai-config, automações, exports,
// templates, channel-test, UTM, import do disparador, queue-details).
// Papel baixo → 403 ANTES de qualquer leitura/escrita; fluxo de outra conta → 404.

const state = vi.hoisted(() => ({
  role: "viewer" as string,
  flowFound: true,
  adminTouched: vi.fn(),
  adminProxy: (): unknown => null,
}));
state.adminProxy = () => ({
  from: (t: string) => {
    state.adminTouched(t);
    throw new Error("service role não deveria ser usado");
  },
  storage: { from: () => state.adminTouched("storage") },
});

vi.mock("@/lib/auth/account", async () => {
  const roles = await import("@/lib/auth/roles");
  class UnauthorizedError extends Error {
    readonly status = 401 as const;
  }
  class ForbiddenError extends Error {
    readonly status = 403 as const;
  }
  const chain = (result: unknown): unknown => {
    const p: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "is", "not", "limit", "order", "or", "range"]) {
      p[m] = () => chain(result);
    }
    p.maybeSingle = async () => result;
    p.single = async () => result;
    p.then = (resolve: (v: unknown) => unknown) => resolve(result);
    return p;
  };
  // can()/permissionsForRole reais: o gate por permissão (PRD 20.3) é testado com o catálogo de verdade.
  const perms = await import("@/lib/auth/permissions");
  const getCurrentAccount = async () => ({
    supabase: {
      from: () => chain({ data: state.flowFound ? [{ id: "flow-1" }] : [], error: null }),
    },
    userId: "user-1",
    accountId: "acc-1",
    role: state.role,
    permissions: perms.permissionsForRole(state.role as never),
    account: { id: "acc-1", name: "Conta" },
  });
  const requireRole = async (min: string) => {
    const ctx = await getCurrentAccount();
    if (!roles.hasMinRole(ctx.role as never, min as never)) {
      throw new ForbiddenError("This action requires the '" + min + "' role or higher");
    }
    return ctx;
  };
  const requirePermission = async (permission: string) => {
    const ctx = await getCurrentAccount();
    if (!perms.can(ctx as never, permission as never)) {
      throw new ForbiddenError("This action requires the '" + permission + "' permission");
    }
    return ctx;
  };
  return {
    UnauthorizedError,
    ForbiddenError,
    getCurrentAccount,
    requireRole,
    requirePermission,
    toErrorResponse: (err: unknown) =>
      new Response(JSON.stringify({ error: String(err) }), {
        status: (err as { status?: number })?.status ?? 500,
      }),
  };
});

// Qualquer toque no service role depois do guard é um bug nestes testes.
vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: () => state.adminProxy() }));
vi.mock("@/lib/disparador/admin-client", () => ({ supabaseAdmin: () => state.adminProxy() }));
vi.mock("@/lib/automations/admin-client", () => ({ supabaseAdmin: () => state.adminProxy() }));
vi.mock("@/lib/relatorios/admin-client", () => ({ supabaseAdmin: () => state.adminProxy() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    throw new Error("cliente de sessão não deveria ser usado antes do guard");
  },
}));

import { POST as flowsPost, GET as flowsGet } from "../flows/route";
import { PUT as flowPut, DELETE as flowDelete, GET as flowGet } from "../flows/[id]/route";
import { POST as flowActivate } from "../flows/[id]/activate/route";
import { POST as flowImport } from "../flows/import/route";
import { GET as flowTemplates } from "../flows/templates/route";
import { GET as flowExport } from "../flows/[id]/export/route";
import { GET as flowRuns, DELETE as flowRunsDelete } from "../flows/[id]/runs/route";
import { POST as wahaStart } from "../whatsapp/waha/start/route";
import { POST as wahaStop } from "../whatsapp/waha/stop/route";
import { GET as wahaQr } from "../whatsapp/waha/qr/route";
import { POST as wahaPairing } from "../whatsapp/waha/pairing-code/route";
import { GET as aiGet, POST as aiPost } from "../account/ai-config/route";
import { POST as autoPost, GET as autoList } from "../automations/route";
import { PATCH as autoPatch, DELETE as autoDelete, GET as autoGet } from "../automations/[id]/route";
import { POST as autoDuplicate } from "../automations/[id]/duplicate/route";
import { POST as autoEngine } from "../automations/engine/route";
import { POST as exportsPost, DELETE as exportsDelete } from "../relatorios/exports/route";
import { POST as tplSubmit } from "../whatsapp/templates/submit/route";
import { POST as tplSync } from "../whatsapp/templates/sync/route";
import { PATCH as tplPatch, DELETE as tplDelete } from "../whatsapp/templates/[id]/route";
import { POST as channelTest } from "../whatsapp/channel-test/route";
import { GET as channelTestTemplates } from "../whatsapp/channel-test/templates/route";
import { POST as syncAvatars } from "../whatsapp/contacts/sync-avatars/route";
import { POST as utmPost } from "../disparador/utm/route";
import { GET as utmMetricas } from "../disparador/utm/metricas/route";
import { POST as contactsImport } from "../disparador/contacts/import/route";
import { GET as queueDetails } from "../disparador/campaigns/[id]/queue-details/route";
import { POST as send } from "../whatsapp/send/route";
import { POST as react } from "../whatsapp/react/route";
import { POST as sentiment } from "../conversations/[id]/sentiment/route";

const UUID = "11111111-1111-4111-8111-111111111111";
const idParams = { params: Promise.resolve({ id: UUID }) };
const req = (method = "POST", body: unknown = {}) =>
  new Request("https://crm.test/x?session=s&id=1", {
    method,
    headers: { "content-type": "application/json" },
    body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify(body),
  });

type Case = [string, () => Promise<Response>];

// Cada handler chamado como um papel abaixo do mínimo.
const ADMIN_ONLY: Case[] = [
  ["POST /api/flows", () => flowsPost(req())],
  ["GET /api/flows", () => flowsGet()],
  ["GET /api/flows/[id]", () => flowGet(req("GET"), idParams)],
  ["PUT /api/flows/[id]", () => flowPut(req("PUT"), idParams)],
  ["DELETE /api/flows/[id]", () => flowDelete(req("DELETE"), idParams)],
  ["POST /api/flows/[id]/activate", () => flowActivate(req(), idParams)],
  ["GET /api/flows/[id]/export", () => flowExport(req("GET"), idParams)],
  ["GET /api/flows/[id]/runs", () => flowRuns(req("GET"), idParams)],
  ["DELETE /api/flows/[id]/runs", () => flowRunsDelete(req("DELETE"), idParams)],
  ["POST /api/flows/import", () => flowImport(req())],
  ["GET /api/flows/templates", () => flowTemplates()],
  ["POST waha/start", () => wahaStart(req())],
  ["POST waha/stop", () => wahaStop(req())],
  ["GET waha/qr", () => wahaQr(req("GET"))],
  ["POST waha/pairing-code", () => wahaPairing(req())],
  ["GET account/ai-config", () => aiGet()],
  ["POST account/ai-config", () => aiPost(req())],
  ["POST /api/automations", () => autoPost(req())],
  ["PATCH /api/automations/[id]", () => autoPatch(req("PATCH"), idParams)],
  ["DELETE /api/automations/[id]", () => autoDelete(req("DELETE"), idParams)],
  ["POST /api/automations/[id]/duplicate", () => autoDuplicate(req(), idParams)],
  ["POST /api/automations/engine", () => autoEngine(req())],
  ["DELETE relatorios/exports", () => exportsDelete(req("DELETE"))],
  ["POST templates/submit", () => tplSubmit(req())],
  ["POST templates/sync", () => tplSync()],
  ["PATCH templates/[id]", () => tplPatch(req("PATCH"), idParams)],
  ["DELETE templates/[id]", () => tplDelete(req("DELETE"), idParams)],
  ["POST channel-test", () => channelTest(req())],
  ["GET channel-test/templates", () => channelTestTemplates(req("GET"))],
  ["POST sync-avatars", () => syncAvatars(req())],
  ["POST disparador/utm", () => utmPost(req())],
  ["GET disparador/utm/metricas", () => utmMetricas(req("GET"))],
  ["POST disparador/contacts/import", () => contactsImport(req())],
  ["GET queue-details", () => queueDetails(req("GET"), idParams)],
];

describe("papel mínimo nas rotas (service role só depois do guard)", () => {
  beforeEach(() => {
    state.role = "viewer";
    state.flowFound = true;
    state.adminTouched.mockClear();
  });

  const AGENT_ONLY: Case[] = [
    ["GET automations", () => autoList()],
    ["GET automations/[id]", () => autoGet(req("GET"), idParams)],
    ["POST whatsapp/send", () => send(req())],
    ["POST whatsapp/react", () => react(req())],
    ["POST sentiment", () => sentiment(req(), idParams)],
  ];
  for (const [name, call] of AGENT_ONLY) {
    it(name + " bloqueia viewer antes de qualquer escrita", async () => {
      const res = await call();
      expect(res.status).toBe(403);
      expect(state.adminTouched).not.toHaveBeenCalled();
    });
  }

  it.each(["constructor", "toString", "__proto__"])("exports recusa extensão %s", async (ext) => {
    state.role = "admin";
    const res = await exportsPost(req("POST", {
      exportType: "conversas", description: "x", fileName: `a.${ext}`, fileBase64: "aGk=",
    }));
    expect(res.status).toBe(400);
    expect(state.adminTouched).not.toHaveBeenCalled();
  });

  for (const role of ["viewer", "agent", "supervisor"]) {
    describe("como " + role, () => {
      for (const [name, call] of ADMIN_ONLY) {
        it(name + " → 403", async () => {
          state.role = role;
          const res = await call();
          expect(res.status).toBe(403);
          expect(state.adminTouched).not.toHaveBeenCalled();
        });
      }
    });
  }

  it("exports: POST exige ao menos supervisor", async () => {
    state.role = "agent";
    const res = await exportsPost(req());
    expect(res.status).toBe(403);
    expect(state.adminTouched).not.toHaveBeenCalled();
  });

  it("exports: supervisor passa do guard (payload inválido → 400, não 403)", async () => {
    state.role = "supervisor";
    const res = await exportsPost(req("POST", {}));
    expect(res.status).toBe(400);
  });

  it("exports: extensão fora da whitelist é recusada", async () => {
    state.role = "admin";
    const res = await exportsPost(
      req("POST", {
        exportType: "conversas",
        description: "x",
        fileName: "../../etc/passwd.html",
        fileBase64: "aGk=",
        fileSize: 2,
      }),
    );
    expect(res.status).toBe(400);
    expect(state.adminTouched).not.toHaveBeenCalled();
  });

  it("exports: arquivo acima do teto → 413", async () => {
    state.role = "admin";
    const res = await exportsPost(
      req("POST", {
        exportType: "conversas",
        description: "x",
        fileName: "a.xlsx",
        fileBase64: "A".repeat(40 * 1024 * 1024),
        fileSize: 1,
      }),
    );
    expect(res.status).toBe(413);
  });

  describe("fluxo de outra conta → 404", () => {
    const FLOW_CASES: Case[] = [
      ["GET /api/flows/[id]", () => flowGet(req("GET"), idParams)],
      ["PUT /api/flows/[id]", () => flowPut(req("PUT"), idParams)],
      ["DELETE /api/flows/[id]", () => flowDelete(req("DELETE"), idParams)],
      ["POST /api/flows/[id]/activate", () => flowActivate(req(), idParams)],
      ["GET /api/flows/[id]/export", () => flowExport(req("GET"), idParams)],
      ["GET /api/flows/[id]/runs", () => flowRuns(req("GET"), idParams)],
      ["DELETE /api/flows/[id]/runs", () => flowRunsDelete(req("DELETE"), idParams)],
    ];
    for (const [name, call] of FLOW_CASES) {
      it(name + " → 404", async () => {
        state.role = "admin";
        state.flowFound = false;
        const res = await call();
        expect(res.status).toBe(404);
        expect(state.adminTouched).not.toHaveBeenCalled();
      });
    }
  });

});
