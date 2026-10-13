// Decisão do dono (13/10, item 11): GET /api/flows/[id] aceita flows.view_runs em leitura (modo leitura do editor); PUT/DELETE continuam pedindo flows.edit.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

type Perm = "flows.edit" | "flows.view_runs";
const state = vi.hoisted(() => ({ perms: new Set<string>(), notFound: false, asked: [] as string[], unauthenticated: false }));

vi.mock("@/lib/flows/route-auth", () => ({
  guardFlow: async (_id: string, permission: Perm = "flows.edit") => {
    state.asked.push(permission);
    if (state.unauthenticated) return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
    if (!state.perms.has(permission)) return { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
    if (state.notFound) return { ok: false, response: NextResponse.json({ error: "Não encontrado" }, { status: 404 }) };
    return {
      ok: true,
      ctx: {
        accountId: "acc",
        userId: "u",
        supabase: {
          from: (table: string) => {
            const b: Record<string, unknown> = {};
            for (const m of ["select", "eq", "order"]) b[m] = () => b;
            b.maybeSingle = async () => ({ data: table === "flows" ? { id: "F1", account_id: "acc", name: "Fluxo" } : null, error: null });
            b.then = (resolve: (v: unknown) => void) =>
              resolve({ data: [{ node_key: "h", node_type: "http_fetch", config: { url: "https://x.test", headers: { Authorization: "Bearer segredo-999" } } }, { node_key: "s", node_type: "start", config: {} }], error: null });
            return b;
          },
        },
      },
    };
  },
}));
vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: () => ({ from: () => { throw new Error("service role não deve ser tocado"); } }) }));
vi.mock("@/lib/ai-tools/runtime", () => ({ listAccountTools: vi.fn() }));
vi.mock("@/lib/ai/agents/runtime", () => ({ listAccountAgents: vi.fn() }));
vi.mock("@/lib/ai/prompt-versions", () => ({ recordFlowNodePromptVersions: vi.fn() }));

import { DELETE, GET, PUT } from "./route";

const ctx = { params: Promise.resolve({ id: "F1" }) };
const req = (body?: unknown) => new Request("http://x/api/flows/F1", { method: "PUT", body: body ? JSON.stringify(body) : undefined });

beforeEach(() => {
  state.perms = new Set();
  state.notFound = false;
  state.unauthenticated = false;
  state.asked = [];
});

describe("GET /api/flows/[id]", () => {
  it("flows.edit: lê normalmente, read_only false e SEM mascarar nada", async () => {
    state.perms = new Set(["flows.edit"]);
    const res = await GET(req(), ctx);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.read_only).toBe(false);
    expect(body.nodes[0].config.headers.Authorization).toBe("Bearer segredo-999");
    expect(state.asked).toEqual(["flows.edit"]); // não faz a segunda consulta quando já pode editar
  });

  it("só flows.view_runs: lê em MODO LEITURA (read_only true) e sem os valores de cabeçalho do http_fetch", async () => {
    state.perms = new Set(["flows.view_runs"]);
    const res = await GET(req(), ctx);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.read_only).toBe(true);
    expect(body.flow).toMatchObject({ id: "F1" });
    expect(body.nodes).toHaveLength(2);
    expect(JSON.stringify(body)).not.toContain("segredo-999");
    expect(state.asked).toEqual(["flows.edit", "flows.view_runs"]);
  });

  it("sem nenhuma das duas: 403; 401 e 404 do guard passam como são (sem tentar a segunda permissão)", async () => {
    expect((await GET(req(), ctx)).status).toBe(403);
    state.unauthenticated = true;
    state.asked = [];
    expect((await GET(req(), ctx)).status).toBe(401);
    expect(state.asked).toEqual(["flows.edit"]);
    state.unauthenticated = false;
    state.perms = new Set(["flows.edit"]);
    state.notFound = true;
    expect((await GET(req(), ctx)).status).toBe(404);
  });
});

describe("salvar, publicar e apagar continuam exigindo flows.edit", () => {
  it("quem só tem flows.view_runs recebe 403 no PUT e no DELETE (nada vai ao banco de serviço)", async () => {
    state.perms = new Set(["flows.view_runs"]);
    expect((await PUT(req({ name: "novo" }), ctx)).status).toBe(403);
    expect((await DELETE(req(), ctx)).status).toBe(403);
    expect(state.asked).toEqual(["flows.edit", "flows.edit"]);
  });
});
