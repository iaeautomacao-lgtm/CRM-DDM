// Rotas da importação em segundo plano: criar, enviar blocos, iniciar, acompanhar e o cron.
import { beforeEach, describe, expect, it, vi } from "vitest";

/* eslint-disable @typescript-eslint/no-explicit-any */
const jobs: any[] = [];
const files = new Map<string, string>();
let draftForeign = false;
let tableMissing = false;
const audit = vi.fn();

vi.mock("@/lib/disparador/route-auth", () => ({ requireDisparadorAccess: async () => ({ accountId: "acc-1", userId: "u1" }) }));
vi.mock("@/lib/audit/log-event", () => ({ logAuditEvent: (...a: unknown[]) => audit(...a) }));
vi.mock("@/lib/audit/context", () => ({ registerAuditActor: async () => {} }));
vi.mock("@/lib/disparador/admin-client", () => ({
  supabaseAdmin: () => ({
    rpc: async (fn: string) => (fn === "dispatch_import_set_block" ? { data: null, error: { message: "function does not exist" } } : { data: [], error: null }),
    storage: {
      from: () => ({
        upload: async (path: string, body: Buffer) => (files.set(path, body.toString("utf8")), { error: null }),
        remove: async () => ({ error: null }),
        download: async () => ({ data: null, error: { message: "x" } }),
      }),
    },
    from: (table: string) => {
      const filters: Array<[string, unknown]> = [];
      const neq: Array<[string, unknown]> = [];
      let insert: any = null;
      let patch: any = null;
      const b: any = {};
      for (const m of ["select", "order", "in", "limit", "lt"]) b[m] = () => b;
      b.eq = (c: string, v: unknown) => (filters.push([c, v]), b);
      b.neq = (c: string, v: unknown) => (neq.push([c, v]), b);
      b.insert = (r: any) => ((insert = r), b);
      b.update = (p: any) => ((patch = p), b);
      b.maybeSingle = async () => ({ data: jobs.find((j) => filters.every(([c, v]) => j[c] === v)) ?? null, error: null });
      b.then = (resolve: (v: unknown) => void) => {
        if (table === "campaigns") return resolve({ data: neq.length ? (draftForeign ? [{ id: "x" }] : []) : [{ id: "11111111-1111-1111-1111-111111111111" }], error: null });
        if (table !== "dispatch_import_jobs") return resolve({ data: neq.length && draftForeign ? [] : [], error: null });
        if (tableMissing) return resolve({ data: null, error: { code: "42P01", message: "relation does not exist" } });
        if (insert) {
          const row = { id: "33333333-3333-3333-3333-333333333333", state: "receiving", blocks: {}, next_block: 0, rows_total: 0, rows_done: 0, totals: {}, linked: 0, errors: [], attempts: 0, created_at: "x", ...insert };
          jobs.push(row);
          return resolve({ data: [row], error: null });
        }
        const rows = jobs.filter((j) => filters.every(([c, v]) => j[c] === v));
        if (patch) rows.forEach((r) => Object.assign(r, patch));
        return resolve({ data: rows, error: null });
      };
      return b;
    },
  }),
}));

const JOB = "33333333-3333-3333-3333-333333333333";
const call = (path: string, init?: RequestInit) => new Request(`http://x/api/disparador/imports${path}`, init);
const json = (body: unknown, method = "POST") => ({ method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const goodBody = { draft_id: "22222222-2222-4222-8222-222222222222", column_map: { phone: "telefone", name: "nome" }, mapping_confirmed: true };

beforeEach(() => {
  jobs.length = 0;
  files.clear();
  draftForeign = false;
  tableMissing = false;
  audit.mockClear();
});

describe("POST /api/disparador/imports", () => {
  it("201 com o job (sem dono/lease/mapeamento)", async () => {
    const { POST } = await import("./route");
    const res = await POST(call("", json(goodBody)));
    expect(res.status).toBe(201);
    const { job } = (await res.json()) as { job: Record<string, unknown> };
    expect(job).toMatchObject({ state: "receiving", blocks_received: 0, rows_total: 0 });
    expect(job).not.toHaveProperty("column_map");
    expect(jobs[0].column_map).toEqual({ phone: "telefone", name: "nome" });
  });

  it("400 sem mapeamento confirmado; 404 para rascunho de outra conta; 503 sem a migration", async () => {
    const { POST } = await import("./route");
    expect((await POST(call("", json({ ...goodBody, mapping_confirmed: false })))).status).toBe(400);
    expect((await POST(call("", json({ ...goodBody, column_map: {} })))).status).toBe(400);
    draftForeign = true;
    expect((await POST(call("", json(goodBody)))).status).toBe(404);
    draftForeign = false;
    tableMissing = true;
    const res = await POST(call("", json(goodBody)));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe("unavailable");
  });
});

describe("blocos, início e acompanhamento", () => {
  const seedJob = (over: Record<string, unknown> = {}) =>
    jobs.push({ id: JOB, account_id: "acc-1", requested_by: "u1", campaign_id: null, draft_id: "d", column_map: { phone: "telefone" }, state: "receiving", blocks: {}, blocks_total: null, next_block: 0, rows_total: 0, rows_done: 0, totals: {}, linked: 0, errors: [], attempts: 0, created_at: "x", ...over });
  const rows = [{ nome: "Ana", telefone: "11999990001" }];

  it("PUT bloco guarda as linhas; start exige todos os blocos e audita; GET mostra o progresso; outra conta = 404", async () => {
    seedJob();
    const { PUT } = await import("./[id]/blocks/[n]/route");
    const put = await PUT(call(`/${JOB}/blocks/0`, json({ rows }, "PUT")), { params: Promise.resolve({ id: JOB, n: "0" }) });
    expect(put.status).toBe(200);
    expect(files.size).toBe(1);

    const { POST: start } = await import("./[id]/start/route");
    const early = await start(call(`/${JOB}/start`, json({ total_blocks: 2 })), { params: Promise.resolve({ id: JOB }) });
    expect(early.status).toBe(409);
    expect(((await early.json()) as { code: string }).code).toBe("blocks_missing");
    const okRes = await start(call(`/${JOB}/start`, json({ total_blocks: 1 })), { params: Promise.resolve({ id: JOB }) });
    expect(okRes.status).toBe(202);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "contacts.import_requested", accountId: "acc-1" }));

    const { GET } = await import("./[id]/route");
    const status = await GET(call(`/${JOB}`), { params: Promise.resolve({ id: JOB }) });
    expect(((await status.json()) as { job: { state: string; blocks_total: number } }).job).toMatchObject({ state: "pending", blocks_total: 1 });
    jobs[0].account_id = "outra";
    expect((await GET(call(`/${JOB}`), { params: Promise.resolve({ id: JOB }) })).status).toBe(404);
    expect((await GET(call("/lixo"), { params: Promise.resolve({ id: "lixo" }) })).status).toBe(404);
  });

  it("PUT bloco com job que não recebe mais = 409; bloco vazio = 400", async () => {
    seedJob();
    const { PUT } = await import("./[id]/blocks/[n]/route");
    expect((await PUT(call(`/${JOB}/blocks/0`, json({ rows: [] }, "PUT")), { params: Promise.resolve({ id: JOB, n: "0" }) })).status).toBe(400);
    jobs[0].state = "pending";
    expect((await PUT(call(`/${JOB}/blocks/0`, json({ rows }, "PUT")), { params: Promise.resolve({ id: JOB, n: "0" }) })).status).toBe(409);
  });
});

describe("POST /api/disparador/imports/cron", () => {
  it("exige o segredo do cron; com ele devolve o resumo", async () => {
    const { POST } = await import("./cron/route");
    process.env.CRON_SECRET = "segredo-do-cron-0123456789abcdef";
    expect((await POST(new Request("http://x", { method: "POST" }))).status).toBe(401);
    const res = await POST(new Request("http://x", { method: "POST", headers: { "x-cron-secret": process.env.CRON_SECRET } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "idle", processed: 0 });
    delete process.env.CRON_SECRET;
    expect((await POST(new Request("http://x", { method: "POST" }))).status).toBe(503);
  });
});
