// Cron de reatribuição: segredo, contagem só do que o guard (assigned_agent_id IS NULL) de fato atualizou e erro do
// banco fora da resposta.
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  pending: { data: [] as unknown[] | null, error: null as { message: string } | null },
  updates: [] as Array<{ data: unknown[] | null; error: { message: string } | null }>,
  agent: "agent-1" as string | null,
}));

vi.mock("@/lib/flows/engine", () => ({
  selectAgentForTeam: vi.fn(async () => state.agent),
  selectAnyAgentForAccount: vi.fn(async () => state.agent),
}));
vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({
    from: () => {
      let isUpdate = false;
      const b: Record<string, unknown> = {};
      for (const op of ["select", "eq", "is", "or", "lte", "order", "limit"]) b[op] = () => b;
      b.update = () => ((isUpdate = true), b);
      b.then = (ok: (v: unknown) => unknown) =>
        Promise.resolve(isUpdate ? (state.updates.shift() ?? { data: [], error: null }) : state.pending).then(ok);
      return b;
    },
  }),
}));

const { POST } = await import("./route");
const call = (secret = "s3cr3t") => POST(new Request("http://x", { method: "POST", headers: { "x-cron-secret": secret } }));

beforeEach(() => {
  vi.stubEnv("AUTOMATION_CRON_SECRET", "s3cr3t");
  state.pending = { data: [], error: null };
  state.updates = [];
  state.agent = "agent-1";
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("POST /api/conversations/retry-assignment", () => {
  it("sem o segredo certo: 401", async () => {
    expect((await call("errado")).status).toBe(401);
  });

  it("conta só as conversas que o guard atualizou (a outra já tinha sido pega)", async () => {
    state.pending = { data: [{ id: "c1", team_id: "t", account_id: "a" }, { id: "c2", team_id: null, account_id: "a" }], error: null };
    state.updates = [{ data: [{ id: "c1" }], error: null }, { data: [], error: null }];
    const res = await call();
    expect(await res.json()).toEqual({ retried: 2, assigned: 1 });
  });

  it("erro do banco na leitura: 500 sem o detalhe do Postgres", async () => {
    state.pending = { data: null, error: { message: 'relation "wacrm.conversations" does not exist' } };
    const res = await call();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("wacrm");
  });
});
