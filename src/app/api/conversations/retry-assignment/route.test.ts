// Cron de reatribuição: segredo, contagem só do que o guard (assigned_agent_id IS NULL) de fato atualizou e erro do
// banco fora da resposta.
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  pending: { data: [] as unknown[] | null, error: null as { message: string } | null },
  updates: [] as Array<{ data: unknown[] | null; error: { message: string } | null }>,
  agent: "agent-1" as string | null,
  isCalls: [] as Array<[string, unknown]>,
  noReservationColumn: false,
  searches: [] as boolean[],
}));

vi.mock("@/lib/flows/engine", () => ({
  selectAgentForTeam: vi.fn(async () => state.agent),
  selectAnyAgentForAccount: vi.fn(async () => state.agent),
}));
vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({
    from: () => {
      let isUpdate = false;
      let withReservationFilter = false;
      const b: Record<string, unknown> = {};
      for (const op of ["select", "eq", "or", "lte", "order", "limit"]) b[op] = () => b;
      b.is = (col: string, val: unknown) => (state.isCalls.push([col, val]), col === "requested_agent_id" && (withReservationFilter = true), b);
      b.update = () => ((isUpdate = true), b);
      b.then = (ok: (v: unknown) => unknown) =>
        Promise.resolve(
          isUpdate
            ? (state.updates.shift() ?? { data: [], error: null })
            : (state.searches.push(withReservationFilter), withReservationFilter && state.noReservationColumn)
              ? { data: null, error: { code: "42703", message: "column conversations.requested_agent_id does not exist" } }
              : state.pending,
        ).then(ok);
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
  state.isCalls = [];
  state.noReservationColumn = false;
  state.searches = [];
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
    expect(await res.json()).toEqual({ retried: 2, assigned: 1, reservations_expired: 0 });
  });

  it("erro do banco na leitura: 500 sem o detalhe do Postgres", async () => {
    state.pending = { data: null, error: { message: 'relation "wacrm.conversations" does not exist' } };
    const res = await call();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("wacrm");
  });
});

describe("@operador (migration 376)", () => {
  it("a busca ignora conversa reservada a um operador (requested_agent_id IS NULL): o rodízio não a redistribui", async () => {
    await call();
    expect(state.isCalls).toContainEqual(["requested_agent_id", null]);
    expect(state.isCalls).toContainEqual(["assigned_agent_id", null]);
  });
});

describe("sem a migration 376 (coluna requested_agent_id inexistente)", () => {
  it("refaz a busca sem o filtro de reserva e segue distribuindo (sem 376 não existe reserva)", async () => {
    state.noReservationColumn = true;
    state.pending = { data: [{ id: "c1", team_id: "t", account_id: "a" }], error: null };
    state.updates = [{ data: [{ id: "c1" }], error: null }];
    const res = await call();
    expect(res.status).toBe(200);
    expect(state.searches).toEqual([true, false]); // 1ª com o filtro (falhou), 2ª sem
    expect(await res.json()).toMatchObject({ assigned: 1 });
  });

  it("com a coluna, uma só busca (com o filtro)", async () => {
    await call();
    expect(state.searches).toEqual([true]);
  });
});

describe("guarda da reserva (@operador, 376) nas gravações do cron — revisão de segurança 16/10, M6", () => {
  const reservedGuards = () => state.isCalls.filter(([col, val]) => col === "requested_agent_id" && val === null).length;
  const pendingOne = () => {
    state.pending = { data: [{ id: "c1", team_id: "t", account_id: "a", contact_id: "ct" }], error: null };
  };

  it("o UPDATE de atribuição leva .is('requested_agent_id', null) (além da busca): reserva que chega depois da escolha não é desfeita", async () => {
    pendingOne();
    state.updates = [{ data: [{ id: "c1" }], error: null }];
    const res = await call();
    expect(await res.json()).toMatchObject({ assigned: 1 });
    expect(reservedGuards()).toBe(2); // busca + gravação
  });

  it("reserva apareceu entre a leitura e a gravação: o UPDATE não atualiza nada, não conta como atribuída", async () => {
    pendingOne();
    state.updates = [{ data: [], error: null }];
    const res = await call();
    expect(await res.json()).toMatchObject({ retried: 1, assigned: 0 });
  });

  it("sem a 376 na gravação (coluna ausente): refaz sem o guarda e atribui", async () => {
    pendingOne();
    state.updates = [{ data: null, error: { code: "42703", message: "column does not exist" } as never }, { data: [{ id: "c1" }], error: null }];
    const res = await call();
    expect(await res.json()).toMatchObject({ assigned: 1 });
    expect(reservedGuards()).toBe(2); // busca + 1ª gravação (a 2ª, de reserva, vai sem o guarda)
  });

  it("sem agente disponível: o adiamento (assignment_retry_at) também leva o guarda e não conta atribuição", async () => {
    pendingOne();
    state.agent = null;
    state.updates = [{ data: [{ id: "c1" }], error: null }];
    const res = await call();
    expect(await res.json()).toMatchObject({ retried: 1, assigned: 0 });
    expect(reservedGuards()).toBe(2); // busca + adiamento
  });
});
