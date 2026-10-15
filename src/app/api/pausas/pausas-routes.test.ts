import { beforeEach, describe, expect, it, vi } from "vitest";

// /api/pausas/*: mapeamento dos resultados das RPCs (start_pause/end_pause) para status e códigos do contrato, motivos, estado da equipe,
// ids em pausa e relatório. Quem decide permissão/escopo é o banco (testado em pausas.sql.test.ts); aqui se prova o contrato HTTP.

const U1 = "00000000-0000-4000-8000-000000000001";
const U2 = "00000000-0000-4000-8000-000000000002";
const R1 = "00000000-0000-4000-8000-0000000000r1".replace("r", "a");
const T1 = "00000000-0000-4000-8000-0000000000b1";
const ACC = "acc-1";

const s = vi.hoisted(() => ({
  userId: "00000000-0000-4000-8000-000000000001",
  perms: new Set<string>(["presence.pause_self", "presence.reasons_manage", "monitoring.view_team", "reports.view_team", "inbox.transfer"]),
  rpc: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  rpcResult: { data: null as unknown, error: null as { code?: string; message?: string } | null },
  tables: {} as Record<string, { data?: unknown[]; error?: { code?: string; message?: string } | null }>,
  calls: [] as Array<{ table: string; op: string; filters: Record<string, unknown>; payload?: unknown }>,
}));

function chain(table: string) {
  const call = { table, op: "select", filters: {} as Record<string, unknown>, payload: undefined as unknown };
  s.calls.push(call);
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "is", "lt", "or", "order", "limit", "range"]) b[m] = (...a: unknown[]) => ((call.filters[`${m}:${String(a[0])}`] = a[1] ?? true), b);
  b.insert = (p: unknown) => ((call.op = "insert"), (call.payload = p), b);
  b.update = (p: unknown) => ((call.op = "update"), (call.payload = p), b);
  b.then = (ok: (v: unknown) => unknown) => {
    const t = s.tables[`${table}:${call.op}`] ?? s.tables[table] ?? { data: [] };
    return Promise.resolve({ data: t.data ?? [], error: t.error ?? null }).then(ok);
  };
  return b;
}
const client = () => ({
  from: (t: string) => chain(t),
  rpc: async (fn: string, args: Record<string, unknown>) => {
    s.rpc.push({ fn, args });
    if (fn === "ensure_default_pause_reasons") return { data: 0, error: null };
    return s.rpcResult;
  },
});

vi.mock("@/lib/auth/account", async (orig) => {
  const real = await orig<typeof import("@/lib/auth/account")>();
  return {
    ...real,
    requirePermission: async (permission: string) => {
      if (!s.perms.has(permission)) throw new real.ForbiddenError(`Esta ação exige a permissão '${permission}'`, permission as never);
      return { supabase: client(), userId: s.userId, accountId: ACC, role: "agent", permissions: s.perms };
    },
  };
});
vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: () => client() }));

const motivos = await import("./motivos/route");
const motivoId = await import("./motivos/[id]/route");
const atual = await import("./atual/route");
const iniciar = await import("./route");
const retomar = await import("./retomar/route");
const equipe = await import("./equipe/route");
const emPausa = await import("./em-pausa/route");
const relatorio = await import("./relatorio/route");

const req = (url: string, body?: unknown, method = "POST") =>
  new Request(`http://localhost${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async (r: Response) => (await r.json()) as Record<string, any>;
const pauseRow = (over: Record<string, unknown> = {}) => ({
  id: "p1", user_id: U1, reason_id: R1, reason_name: "Almoço", max_minutes: 60, started_at: new Date(Date.now() - 600_000).toISOString(), ended_at: null,
  end_kind: null, started_by: U1, ended_by: null, alerted_at: null, ...over,
});

beforeEach(() => {
  s.userId = U1;
  s.perms = new Set(["presence.pause_self", "presence.reasons_manage", "monitoring.view_team", "reports.view_team", "inbox.transfer"]);
  s.rpc = [];
  s.calls = [];
  s.rpcResult = { data: null, error: null };
  s.tables = { profiles: { data: [{ user_id: U1, full_name: "Ana" }, { user_id: U2, full_name: "Carlos" }] } };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/pausas", () => {
  it("pausa a si mesmo: 201, chama start_pause sem alvo e devolve a visão (nome, tempo, estouro)", async () => {
    s.rpcResult = { data: { ok: true, pause: pauseRow() }, error: null };
    const res = await iniciar.POST(req("/api/pausas", { reason_id: R1 }));
    expect(res.status).toBe(201);
    expect(s.rpc.find((c) => c.fn === "start_pause")!.args).toEqual({ p_reason_id: R1, p_target_user: null });
    expect((await json(res)).pause).toMatchObject({ user_name: "Ana", reason_name: "Almoço", by_supervisor: false, exceeded: false, elapsed_seconds: expect.any(Number) });
  });

  it("pausa outro: manda o alvo; user_id igual ao próprio vale como si mesmo", async () => {
    s.rpcResult = { data: { ok: true, pause: pauseRow({ user_id: U2, started_by: U1 }) }, error: null };
    const res = await iniciar.POST(req("/api/pausas", { reason_id: R1, user_id: U2 }));
    expect(s.rpc.find((c) => c.fn === "start_pause")!.args).toEqual({ p_reason_id: R1, p_target_user: U2 });
    expect((await json(res)).pause).toMatchObject({ user_name: "Carlos", by_supervisor: true, started_by_name: "Ana" });
    await iniciar.POST(req("/api/pausas", { reason_id: R1, user_id: U1 }));
    expect(s.rpc.filter((c) => c.fn === "start_pause").pop()!.args.p_target_user).toBeNull();
  });

  it.each([
    ["already_paused", 409], ["forbidden", 403], ["other_team", 403], ["user_not_found", 404], ["reason_not_found", 404], ["reason_inactive", 409],
  ])("RPC %s → HTTP %i com code estável", async (code, status) => {
    s.rpcResult = { data: { ok: false, code, ...(code === "already_paused" ? { pause: pauseRow() } : {}) }, error: null };
    const res = await iniciar.POST(req("/api/pausas", { reason_id: R1 }));
    expect(res.status).toBe(status);
    const body = await json(res);
    expect(body.code).toBe(code);
    expect(typeof body.error).toBe("string");
    if (code === "already_paused") expect(body.pause).toMatchObject({ reason_name: "Almoço" });
  });

  it("validação: reason_id obrigatório e UUID; user_id UUID (400, sem chamar o banco)", async () => {
    for (const body of [{}, { reason_id: "x" }, { reason_id: R1, user_id: "abc" }]) {
      const res = await iniciar.POST(req("/api/pausas", body));
      expect(res.status).toBe(400);
      expect((await json(res)).code).toBe("invalid_request");
    }
    expect((await iniciar.POST(new Request("http://x/api/pausas", { method: "POST", body: "{ não json" }))).status).toBe(400);
    expect(s.rpc.filter((c) => c.fn === "start_pause")).toHaveLength(0);
  });

  it("sem presence.pause_self: 403 forbidden; função inexistente (sem a 370): 503 unavailable", async () => {
    s.perms = new Set();
    const denied = await iniciar.POST(req("/api/pausas", { reason_id: R1 }));
    expect(denied.status).toBe(403);
    expect((await json(denied)).code).toBe("forbidden");
    s.perms = new Set(["presence.pause_self"]);
    s.rpcResult = { data: null, error: { code: "PGRST202", message: "function not found" } };
    const missing = await iniciar.POST(req("/api/pausas", { reason_id: R1 }));
    expect(missing.status).toBe(503);
    expect((await json(missing)).code).toBe("unavailable");
  });
});

describe("POST /api/pausas/retomar", () => {
  it("volta ao atendimento: devolve a pausa fechada", async () => {
    s.rpcResult = { data: { ok: true, pause: pauseRow({ ended_at: new Date().toISOString(), end_kind: "manual", ended_by: U1 }) }, error: null };
    const res = await retomar.POST(req("/api/pausas/retomar", {}));
    expect(res.status).toBe(200);
    expect((await json(res)).pause).toMatchObject({ end_kind: "manual" });
    expect(s.rpc.find((c) => c.fn === "end_pause")!.args).toEqual({ p_target_user: null });
  });
  it("corpo vazio vale; retomar outro manda o alvo", async () => {
    s.rpcResult = { data: { ok: true, pause: pauseRow({ user_id: U2, ended_at: new Date().toISOString(), end_kind: "supervisor" }) }, error: null };
    expect((await retomar.POST(new Request("http://x/api/pausas/retomar", { method: "POST" }))).status).toBe(200);
    await retomar.POST(req("/api/pausas/retomar", { user_id: U2 }));
    expect(s.rpc.filter((c) => c.fn === "end_pause").pop()!.args).toEqual({ p_target_user: U2 });
  });
  it("pausado por supervisor: 403 paused_by_supervisor com o nome de quem pausou; not_paused 404", async () => {
    s.rpcResult = { data: { ok: false, code: "paused_by_supervisor", pause: pauseRow({ started_by: U2 }) }, error: null };
    const res = await retomar.POST(req("/api/pausas/retomar", {}));
    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({ code: "paused_by_supervisor", started_by_name: "Carlos" });
    s.rpcResult = { data: { ok: false, code: "not_paused" }, error: null };
    expect((await retomar.POST(req("/api/pausas/retomar", {}))).status).toBe(404);
  });
  it("user_id inválido: 400", async () => {
    expect((await retomar.POST(req("/api/pausas/retomar", { user_id: 5 }))).status).toBe(400);
  });
});

describe("GET /api/pausas/atual", () => {
  it("devolve a pausa aberta da conta do usuário (ou null)", async () => {
    s.tables["agent_pauses"] = { data: [pauseRow()] };
    const res = await atual.GET();
    expect((await json(res)).pause).toMatchObject({ id: "p1", user_name: "Ana" });
    const q = s.calls.find((c) => c.table === "agent_pauses")!;
    expect(q.filters).toMatchObject({ "eq:account_id": ACC, "eq:user_id": U1, "is:ended_at": true });
    s.tables["agent_pauses"] = { data: [] };
    expect((await json(await atual.GET())).pause).toBeNull();
  });
});

describe("motivos", () => {
  it("GET: só ativos; ?todos=1 inclui os inativos só para quem gerencia; cria os padrões na 1ª leitura", async () => {
    s.tables["pause_reasons"] = { data: [{ id: R1, name: "Almoço", max_minutes: 60, active: true, sort_order: 10 }] };
    const res = await motivos.GET(req("/api/pausas/motivos", undefined, "GET"));
    expect((await json(res)).reasons).toHaveLength(1);
    expect(s.rpc.some((c) => c.fn === "ensure_default_pause_reasons")).toBe(true);
    expect(s.calls.find((c) => c.table === "pause_reasons")!.filters["eq:active"]).toBe(true);
    s.calls = [];
    await motivos.GET(req("/api/pausas/motivos?todos=1", undefined, "GET"));
    expect(s.calls.find((c) => c.table === "pause_reasons")!.filters["eq:active"]).toBeUndefined();
    s.perms = new Set(["presence.pause_self"]); // sem reasons_manage: ?todos=1 é ignorado
    s.calls = [];
    await motivos.GET(req("/api/pausas/motivos?todos=1", undefined, "GET"));
    expect(s.calls.find((c) => c.table === "pause_reasons")!.filters["eq:active"]).toBe(true);
  });

  it("POST: 201 só com reasons_manage; valida; nome repetido = 409", async () => {
    s.tables["pause_reasons:insert"] = { data: [{ id: R1, name: "Reunião", max_minutes: 30, active: true, sort_order: 50 }] };
    const ok = await motivos.POST(req("/api/pausas/motivos", { name: "Reunião", max_minutes: 30 }));
    expect(ok.status).toBe(201);
    expect((await json(ok)).reason).toMatchObject({ name: "Reunião" });
    expect((await motivos.POST(req("/api/pausas/motivos", { name: "" }))).status).toBe(400);
    s.tables["pause_reasons:insert"] = { error: { code: "23505", message: "dup" } };
    const dup = await motivos.POST(req("/api/pausas/motivos", { name: "Almoço" }));
    expect(dup.status).toBe(409);
    expect((await json(dup)).code).toBe("reason_name_taken");
    s.perms = new Set(["presence.pause_self"]);
    expect((await motivos.POST(req("/api/pausas/motivos", { name: "X" }))).status).toBe(403);
  });

  it("PATCH: edita, desativa, limpa o limite; 404 e 409", async () => {
    const call = (id: string, body: unknown) => motivoId.PATCH(req(`/api/pausas/motivos/${id}`, body, "PATCH"), { params: Promise.resolve({ id }) });
    s.tables["pause_reasons:update"] = { data: [{ id: R1, name: "Almoço", max_minutes: null, active: false, sort_order: 10 }] };
    const ok = await call(R1, { max_minutes: null, active: false });
    expect(ok.status).toBe(200);
    const upd = s.calls.find((c) => c.table === "pause_reasons" && c.op === "update")!;
    expect(upd.payload).toMatchObject({ max_minutes: null, active: false });
    expect(upd.filters["eq:account_id"]).toBe(ACC);
    expect((await call(R1, {})).status).toBe(400);
    expect((await call("não-é-uuid", { active: true })).status).toBe(404);
    s.tables["pause_reasons:update"] = { data: [] };
    expect((await call(R1, { name: "x" })).status).toBe(404);
    s.tables["pause_reasons:update"] = { error: { code: "23505", message: "dup" } };
    expect((await call(R1, { name: "Banheiro" })).status).toBe(409);
  });
});

describe("estado da equipe e ids em pausa", () => {
  it("GET /equipe: pausas abertas do escopo, com equipes; filtra por team_id", async () => {
    s.tables["agent_pauses"] = { data: [pauseRow(), pauseRow({ id: "p2", user_id: U2, started_by: U1 })] };
    s.tables["team_members"] = { data: [{ user_id: U1, team_id: T1 }, { user_id: U2, team_id: "outra" }] };
    const all = await json(await equipe.GET(req("/api/pausas/equipe", undefined, "GET")));
    expect(all.pauses).toHaveLength(2);
    expect(all.pauses[0]).toMatchObject({ team_ids: [T1], user_name: "Ana" });
    expect(s.calls.find((c) => c.table === "agent_pauses")!.filters).toMatchObject({ "eq:account_id": ACC, "is:ended_at": true });
    const one = await json(await equipe.GET(req(`/api/pausas/equipe?team_id=${T1}`, undefined, "GET")));
    expect(one.pauses.map((p: { user_id: string }) => p.user_id)).toEqual([U1]);
    expect((await equipe.GET(req("/api/pausas/equipe?team_id=x", undefined, "GET"))).status).toBe(400);
    s.perms = new Set(["presence.pause_self"]);
    expect((await equipe.GET(req("/api/pausas/equipe", undefined, "GET"))).status).toBe(403);
  });

  it("GET /em-pausa: só os ids da conta; exige inbox.transfer", async () => {
    s.tables["agent_pauses"] = { data: [{ user_id: U1 }, { user_id: U2 }] };
    expect(await json(await emPausa.GET())).toEqual({ user_ids: [U1, U2] });
    expect(s.calls.find((c) => c.table === "agent_pauses")!.filters["eq:account_id"]).toBe(ACC);
    s.perms = new Set();
    expect((await emPausa.GET()).status).toBe(403);
  });
});

describe("GET /api/pausas/relatorio", () => {
  const get = (qs: string) => relatorio.GET(req(`/api/pausas/relatorio${qs}`, undefined, "GET"));
  it("agrega por atendente, com detalhe opcional e escopo pela conta", async () => {
    s.tables["agent_pauses"] = {
      data: [
        pauseRow({ id: "00000000-0000-4000-8000-0000000000c1", started_at: "2026-10-14T13:00:00Z", ended_at: "2026-10-14T14:10:00Z", end_kind: "manual" }),
        pauseRow({ id: "00000000-0000-4000-8000-0000000000c2", started_at: "2026-10-14T15:00:00Z", ended_at: "2026-10-14T15:05:00Z", end_kind: "manual", reason_name: "Banheiro", max_minutes: 10 }),
      ],
    };
    s.tables["agent_sessions"] = { data: [{ user_id: U1, logged_in_at: "2026-10-14T10:00:00Z", logged_out_at: "2026-10-14T18:00:00Z" }] };
    const res = await get("?de=2026-10-14&ate=2026-10-14");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.period).toEqual({ from: "2026-10-14", to: "2026-10-14" });
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0]).toMatchObject({ user_id: U1, name: "Ana", pauses: 2, total_seconds: 4500, exceeded_count: 1, pct_of_logged: 15.63 });
    expect(body.items).toBeUndefined();
    expect(s.calls.find((c) => c.table === "agent_pauses")!.filters["eq:account_id"]).toBe(ACC);
    const detail = await json(await get("?de=2026-10-14&ate=2026-10-14&detalhe=1&limite=1"));
    expect(detail.items).toHaveLength(1);
    expect(detail.next_cursor).toBeTruthy();
    const page2 = await json(await get(`?de=2026-10-14&ate=2026-10-14&detalhe=1&limite=1&cursor=${detail.next_cursor}`));
    expect(page2.items[0].id).toBe("00000000-0000-4000-8000-0000000000c2");
    expect(page2.next_cursor).toBeNull();
  });
  it("filtros de atendente/motivo/equipe vão ao banco; período e ids inválidos = 400; sem permissão = 403", async () => {
    s.tables["agent_pauses"] = { data: [] };
    s.tables["team_members"] = { data: [{ user_id: U1 }] };
    await get(`?de=2026-10-14&ate=2026-10-14&atendente=${U1}&motivo=${R1}&equipe=${T1}`);
    const q = s.calls.filter((c) => c.table === "agent_pauses").pop()!;
    expect(q.filters).toMatchObject({ [`eq:user_id`]: U1, [`eq:reason_id`]: R1 });
    expect((await get("?de=ontem")).status).toBe(400);
    expect((await get("?atendente=x")).status).toBe(400);
    expect((await get("?de=2026-01-01&ate=2026-10-14")).status).toBe(400);
    expect((await get("?limite=0")).status).toBe(400);
    s.perms = new Set();
    expect((await get("")).status).toBe(403);
  });
  it("equipe sem membros devolve vazio sem consultar as pausas", async () => {
    s.tables["team_members"] = { data: [] };
    const body = await json(await get(`?de=2026-10-14&ate=2026-10-14&equipe=${T1}&detalhe=1`));
    expect(body.agents).toEqual([]);
    expect(s.calls.some((c) => c.table === "agent_pauses")).toBe(false);
  });
});
