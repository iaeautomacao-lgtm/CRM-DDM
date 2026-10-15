import { beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/conversations/[id]/transfer — atribuição manual a atendente EM PAUSA exige confirmação decidida no servidor (decisão do dono 15/10).

const AGENT = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000a2";
const CONV = "00000000-0000-4000-8000-0000000000c1";
const TEAM = "00000000-0000-4000-8000-0000000000e1";

const s = vi.hoisted(() => ({
  paused: new Set<string>(),
  pausesError: null as { code?: string; message: string } | null,
  updates: [] as Array<Record<string, unknown>>,
  notes: [] as unknown[],
  assignmentUpdates: [] as Array<Record<string, unknown>>,
}));

function chain(table: string, userScoped: boolean) {
  let op = "select";
  let payload: Record<string, unknown> | undefined;
  const filters: Record<string, unknown> = {};
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "in", "gte", "order", "limit"]) b[m] = (...a: unknown[]) => ((filters[`${m}:${String(a[0])}`] = a[1] ?? true), b);
  b.update = (p: Record<string, unknown>) => ((op = "update"), (payload = p), b);
  b.then = (ok: (v: unknown) => unknown) => {
    let result: { data: unknown; error: unknown } = { data: [], error: null };
    if (table === "agent_pauses") {
      if (s.pausesError) result = { data: null, error: s.pausesError };
      else {
        const id = filters["in:user_id"] ? [...s.paused].find((u) => Array.isArray(filters["in:user_id"]) && (filters["in:user_id"] as string[]).includes(u)) : [...s.paused].find((u) => u === filters["eq:user_id"]);
        result = { data: id ? [{ user_id: id, reason_name: "Almoço", started_at: "2026-10-15T14:00:00Z" }] : [], error: null };
      }
    } else if (table === "profiles") result = { data: [{ user_id: AGENT, full_name: "Ana Souza" }], error: null };
    else if (table === "teams") result = { data: [{ id: TEAM }], error: null };
    else if (table === "conversations" && op === "select") result = { data: [{ id: CONV }], error: null };
    else if (table === "conversations" && op === "update") {
      s.updates.push(payload!);
      result = { data: [{ id: CONV, assigned_agent_id: payload!.assigned_agent_id ?? null, team_id: null }], error: null };
    } else if (table === "conversation_assignments" && op === "select") result = { data: [{ id: "as1" }], error: null };
    else if (table === "conversation_assignments" && op === "update") {
      s.assignmentUpdates.push(payload!);
      result = { data: [], error: null };
    }
    void userScoped;
    return Promise.resolve(result).then(ok);
  };
  return b;
}

vi.mock("@/lib/auth/account", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/account")>()),
  requirePermission: async () => ({ supabase: { from: (t: string) => chain(t, true) }, accountId: "acc-1", userId: "supervisor-1" }),
}));
vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: () => ({ from: (t: string) => chain(t, false) }) }));
vi.mock("@/lib/audit/context", () => ({ registerAuditActor: async (a: unknown) => void s.notes.push(a) }));

const { POST } = await import("./route");
const call = (body: unknown) =>
  POST(new Request(`http://x/api/conversations/${CONV}/transfer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: CONV }),
  });

beforeEach(() => {
  s.paused = new Set();
  s.pausesError = null;
  s.updates = [];
  s.notes = [];
  s.assignmentUpdates = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("transferir para atendente em pausa", () => {
  it("sem confirmação: 409 agent_paused com o atendente e a pausa; NADA é gravado", async () => {
    s.paused.add(AGENT);
    const res = await call({ agent_id: AGENT });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "Ana Souza está em pausa. Atribuir mesmo assim?",
      code: "agent_paused",
      agent: { id: AGENT, name: "Ana Souza" },
      pause: { reason_name: "Almoço", started_at: "2026-10-15T14:00:00Z" },
    });
    expect(s.updates).toHaveLength(0);
  });

  it("confirm_paused:true atribui e a auditoria leva a marca; só `true` confirma", async () => {
    s.paused.add(AGENT);
    expect((await call({ agent_id: AGENT, confirm_paused: "true" })).status).toBe(409);
    expect((await call({ agent_id: AGENT, confirm_paused: 1 })).status).toBe(409);
    const res = await call({ agent_id: AGENT, confirm_paused: true, reason: "cliente VIP" });
    expect(res.status).toBe(200);
    expect(s.updates).toEqual([{ assigned_agent_id: AGENT }]);
    expect(s.notes[0]).toEqual({ note: "(atendente em pausa, confirmado) cliente VIP" });
    expect(s.assignmentUpdates[0]).toMatchObject({ actor_id: "supervisor-1", reason: "(atendente em pausa, confirmado) cliente VIP" });
  });

  it("quem não está em pausa: atribui direto, sem marca na auditoria (e confirm_paused é inócuo)", async () => {
    const res = await call({ agent_id: AGENT, reason: "pedido do cliente" });
    expect(res.status).toBe(200);
    expect(s.notes[0]).toEqual({ note: "pedido do cliente" });
    s.paused.add(OTHER);
    expect((await call({ agent_id: AGENT, confirm_paused: true })).status).toBe(200);
  });

  it("só transferir de equipe ou remover o atendente não pergunta nada", async () => {
    s.paused.add(AGENT);
    expect((await call({ team_id: TEAM })).status).toBe(200);
    expect((await call({ agent_id: null })).status).toBe(200);
  });

  it("FAIL-CLOSED: sem conseguir ler as pausas o servidor pede a confirmação em vez de atribuir", async () => {
    s.pausesError = { code: "XX000", message: "boom" };
    const res = await call({ agent_id: AGENT });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("agent_paused");
    expect(s.updates).toHaveLength(0);
  });

  it("sem a migration 370 (tabela inexistente): atribui como sempre", async () => {
    s.pausesError = { code: "42P01", message: "relation does not exist" };
    expect((await call({ agent_id: AGENT })).status).toBe(200);
  });
});
