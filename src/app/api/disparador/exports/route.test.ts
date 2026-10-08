// Rotas da exportação assíncrona: POST/GET /api/disparador/exports, GET [id] (estado e link) e o cron.
import { beforeEach, describe, expect, it, vi } from "vitest";

/* eslint-disable @typescript-eslint/no-explicit-any */
const jobs: any[] = [];
let campaignAccount = "acc-1";
let unavailable = false;
const audit = vi.fn();

vi.mock("@/lib/disparador/route-auth", () => ({ requireDisparadorAccess: async () => ({ accountId: "acc-1", userId: "u1" }) }));
vi.mock("@/lib/audit/log-event", () => ({ logAuditEvent: (...a: unknown[]) => audit(...a) }));
vi.mock("@/lib/audit/context", () => ({ registerAuditActor: async () => {} }));
vi.mock("@/lib/disparador/campaign-status-counts", () => ({ loadCampaignStatusCounts: async () => ({ enviado: 30, entregue: 20, lido: 5, erro: 2 }) }));
vi.mock("@/lib/disparador/admin-client", () => ({
  supabaseAdmin: () => ({
    storage: { from: () => ({ createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://s.test/${path}` }, error: null }) }) },
    rpc: async () => ({ data: [], error: null }),
    from: (table: string) => {
      const filters: Array<[string, unknown]> = [];
      let insert: any = null;
      const b: any = {};
      for (const m of ["select", "order", "in", "lt", "limit"]) b[m] = () => b;
      b.eq = (c: string, v: unknown) => (filters.push([c, v]), b);
      b.insert = (r: any) => ((insert = r), b);
      b.maybeSingle = async () => {
        if (table === "campaigns") return { data: { id: "11111111-1111-1111-1111-111111111111", account_id: campaignAccount }, error: null };
        const row = jobs.find((j) => filters.every(([c, v]) => j[c] === v));
        return { data: row ?? null, error: null };
      };
      b.then = (resolve: (v: unknown) => void) => {
        if (table !== "dispatch_export_jobs") return resolve({ data: [], error: null });
        if (unavailable) return resolve({ data: null, error: { code: "42P01", message: "relation does not exist" } });
        if (insert) {
          const row = { id: "22222222-2222-2222-2222-222222222222", state: "pending", rows_done: 0, truncated: false, format: "csv", created_at: "x", ...insert };
          jobs.push(row);
          return resolve({ data: [row], error: null });
        }
        return resolve({ data: jobs.filter((j) => filters.every(([c, v]) => j[c] === v || c === "state")), error: null });
      };
      return b;
    },
  }),
}));

const CAMP = "11111111-1111-1111-1111-111111111111";
const post = (body: unknown) => new Request("http://x/api/disparador/exports", { method: "POST", body: JSON.stringify(body) });

beforeEach(() => {
  jobs.length = 0;
  campaignAccount = "acc-1";
  unavailable = false;
  audit.mockClear();
});

describe("POST /api/disparador/exports", () => {
  it("202 com o job (progresso e estimativa), sem expor caminho de arquivo; audita o pedido", async () => {
    const { POST } = await import("./route");
    const res = await POST(post({ campaign_id: CAMP, status: "enviado" }));
    expect(res.status).toBe(202);
    const { job } = (await res.json()) as { job: Record<string, unknown> };
    expect(job).toMatchObject({ state: "pending", status_key: "enviado", total_rows: 55, rows_done: 0 });
    expect(job).not.toHaveProperty("file_path");
    expect(job).not.toHaveProperty("owner_id");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "campaign.export_requested", accountId: "acc-1" }));
  });

  it("400 sem campanha/métrica ou com métrica inválida; 404 para campanha de outra conta", async () => {
    const { POST } = await import("./route");
    expect((await POST(post({ campaign_id: "x", status: "enviado" }))).status).toBe(400);
    expect((await POST(post({ campaign_id: CAMP }))).status).toBe(400);
    expect((await POST(post({ campaign_id: CAMP, status: "; drop" }))).status).toBe(400);
    campaignAccount = "outra-conta";
    expect((await POST(post({ campaign_id: CAMP, status: "enviado" }))).status).toBe(404);
    expect(jobs).toHaveLength(0);
  });

  it("migration 203 ausente: 503 com mensagem clara", async () => {
    const { POST } = await import("./route");
    unavailable = true;
    const res = await POST(post({ campaign_id: CAMP, status: "enviado" }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe("unavailable");
  });
});

describe("GET /api/disparador/exports/[id]", () => {
  const call = async (id: string, qs = "") => {
    const { GET } = await import("./[id]/route");
    return GET(new Request(`http://x/api/disparador/exports/${id}${qs}`), { params: Promise.resolve({ id }) });
  };
  const JOB = "22222222-2222-2222-2222-222222222222";
  const base = { id: JOB, account_id: "acc-1", campaign_id: CAMP, status_key: "enviado", format: "csv", rows_done: 55, total_rows: 55, truncated: false, created_at: "x" };

  it("estado e progresso; job de outra conta = 404", async () => {
    jobs.push({ ...base, state: "running", rows_done: 10, total_rows: 40 });
    const res = await call(JOB);
    expect(((await res.json()) as { job: { progress: number } }).job.progress).toBe(0.25);
    jobs[0].account_id = "outra";
    expect((await call(JOB)).status).toBe(404);
  });

  it("download: 409 enquanto roda, 410 vencido, 200 com link assinado quando pronto", async () => {
    jobs.push({ ...base, state: "running" });
    expect((await call(JOB, "?download=1")).status).toBe(409);
    jobs[0] = { ...base, state: "done", file_path: "acc-1/disparador-exports/x/export.csv", expires_at: "2000-01-01T00:00:00Z" };
    expect((await call(JOB, "?download=1")).status).toBe(410);
    jobs[0] = { ...base, state: "done", file_path: "acc-1/disparador-exports/x/export.csv", expires_at: "2999-01-01T00:00:00Z" };
    const ok = await call(JOB, "?download=1");
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { download: { url: string; expires_in_seconds: number }; job: Record<string, unknown> };
    expect(body.download.url).toContain("acc-1/disparador-exports/x/export.csv");
    expect(body.download.expires_in_seconds).toBe(600);
    expect(body.job).not.toHaveProperty("file_path");
    jobs[0].state = "expired";
    expect((await call(JOB, "?download=1")).status).toBe(410);
  });
});

describe("POST /api/disparador/exports/cron", () => {
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
