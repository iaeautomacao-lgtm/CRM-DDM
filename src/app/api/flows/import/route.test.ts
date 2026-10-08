import { beforeEach, describe, expect, it, vi } from "vitest";

const inserted: { nodes: Array<{ config: Record<string, unknown> }> } = { nodes: [] };
vi.mock("@/lib/flows/route-auth", () => ({
  guardFlowAccess: async () => ({ ok: true, ctx: { userId: "u1", accountId: "acc-1" } }),
}));
vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => ({
      insert: (rows: unknown) => {
        if (table === "flow_nodes") {
          inserted.nodes = rows as typeof inserted.nodes;
          return Promise.resolve({ error: null });
        }
        return { select: () => ({ single: async () => ({ data: { id: "f1" }, error: null }) }) };
      },
      delete: () => ({ eq: async () => ({}) }),
    }),
  }),
}));

import { POST } from "./route";

const payload = (url: string) => ({
  version: "1.0",
  flow: { name: "Atendimento", trigger_type: "manual" },
  nodes: [{ node_key: "ia", node_type: "ai_agent", config: { tools: [{ name: "t", http: { url } }] } }],
});
const call = (body: unknown) => POST(new Request("http://x/api/flows/import", { method: "POST", body: JSON.stringify(body) }));
const savedUrl = () => (inserted.nodes[0].config.tools as Array<{ http: { url: string } }>)[0].http.url;

beforeEach(() => {
  inserted.nodes = [];
});

describe("POST /api/flows/import — segredos", () => {
  it("token da DDM com { } no meio é gravado como marcador, sem resíduo", async () => {
    const res = await call(payload("https://www.ddmacordos.com/calc/localiza_dev.php?tk=abc{de}fgh{ij}klmno&cpf={{cpf}}"));
    expect(res.status).toBe(201);
    expect(savedUrl()).toBe("https://www.ddmacordos.com/calc/localiza_dev.php?tk={{secret.DDM_TOKEN}}&cpf={{cpf}}");
  });

  it("duplicar (mode duplicate) passa pelo mesmo saneamento", async () => {
    const res = await call({ ...payload("https://ddmacordos.com/x?tk=zzzzzzzzzzzzzzzz"), mode: "duplicate" });
    expect(res.status).toBe(201);
    expect(savedUrl()).toContain("tk={{secret.DDM_TOKEN}}");
  });

  it("credencial em texto em outro domínio: 400 com explicação e nada é gravado", async () => {
    const res = await call(payload("https://outra-api.com/x?api_key=SEGREDO1234567890"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Importação recusada/);
    expect(body.error).toContain("ia");
    expect(body.error).not.toContain("SEGREDO1234567890");
    expect(inserted.nodes).toEqual([]);
  });
});
