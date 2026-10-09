// Importação em segundo plano: validações do pedido/blocos/início, processamento em ordem, retomada, retry/falha, abandono.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelStaleImportJobs,
  createImportJob,
  emptyTotals,
  IMPORT_JOB_MAX_BLOCKS,
  IMPORT_MAX_ERRORS,
  normalizeBlockRows,
  processImportJob,
  putImportBlock,
  startImportJob,
  toPublicImportJob,
  type ImportJob,
  type ProcessBlock,
} from "./import-jobs";

vi.mock("@/lib/disparador/admin-client", () => ({ supabaseAdmin: () => ({}) }));
vi.mock("@/lib/logger", () => ({ writeLog: vi.fn() }));

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
const ACC = "acc-1";
const CAMP = "11111111-1111-1111-1111-111111111111";

function fakeEnv(opts: { jobs?: Row[]; campaignAccount?: string } = {}) {
  const tables: Record<string, Row[]> = { dispatch_import_jobs: opts.jobs ?? [], campaigns: [{ id: CAMP, account_id: opts.campaignAccount ?? ACC }] };
  const files = new Map<string, string>();
  const db: any = {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const lt: Array<[string, string]> = [];
      let patch: Row | null = null;
      let insertRow: Row | null = null;
      let limit = Infinity;
      const b: any = {};
      b.select = () => b;
      b.eq = (c: string, v: unknown) => (filters.push([c, v]), b);
      b.lt = (c: string, v: string) => (lt.push([c, v]), b);
      b.limit = (n: number) => ((limit = n), b);
      b.update = (p: Row) => ((patch = p), b);
      b.insert = (r: Row) => ((insertRow = r), b);
      b.then = (resolve: (v: unknown) => void) => {
        if (insertRow) {
          const row = { id: "job-1", state: "receiving", blocks: {}, next_block: 0, rows_total: 0, rows_done: 0, totals: emptyTotals(), linked: 0, errors: [], attempts: 0, created_at: "2026-10-08T12:00:00Z", ...insertRow };
          tables[table].push(row);
          return resolve({ data: [row], error: null });
        }
        let rows = (tables[table] ?? []).filter((r) => filters.every(([c, v]) => r[c] === v) && lt.every(([c, v]) => String(r[c]) < v));
        rows = rows.slice(0, limit);
        if (patch) {
          rows.forEach((r) => Object.assign(r, patch));
          return resolve({ data: rows.map((r) => ({ ...r })), error: null });
        }
        return resolve({ data: rows.map((r) => ({ ...r })), error: null });
      };
      return b;
    },
    storage: {
      from: () => ({
        upload: async (path: string, body: Buffer) => (files.set(path, body.toString("utf8")), { error: null }),
        download: async (path: string) => (files.has(path) ? { data: new Blob([files.get(path)!]), error: null } : { data: null, error: { message: "não existe" } }),
        remove: async (paths: string[]) => (paths.forEach((p) => files.delete(p)), { error: null }),
      }),
    },
  };
  return { db, tables, files };
}

const COLUMN_MAP = { phone: "telefone", name: "nome" };
const row = (n: number) => ({ nome: `P${n}`, telefone: `1199${String(n).padStart(7, "0")}` });
const job = (over: Partial<ImportJob> = {}): ImportJob & { owner_id: string } => ({
  id: "job-1", account_id: ACC, requested_by: "u1", campaign_id: null, draft_id: null, column_map: COLUMN_MAP, state: "running", blocks: { "0": 2, "1": 2, "2": 1 },
  blocks_total: 3, next_block: 0, rows_total: 5, rows_done: 0, totals: emptyTotals(), linked: 0, errors: [], attempts: 0, last_error: null, created_at: "2026-10-08T12:00:00Z",
  started_at: null, finished_at: null, owner_id: "o", ...over,
});
const ok = (n: number, over: Record<string, number> = {}) => ({ results: { ...emptyTotals(), importados: n, erros: [] as string[], ...over }, linked: n });

beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));

describe("createImportJob", () => {
  it("exige mapeamento confirmado com a coluna de contato; id inválido = 400; campanha de outra conta = 404", async () => {
    const { db } = fakeEnv();
    expect(await createImportJob(db, { accountId: ACC, userId: "u", campaignId: null, draftId: null, columnMap: {}, mappingConfirmed: true })).toMatchObject({ ok: false, code: "mapping_required" });
    expect(await createImportJob(db, { accountId: ACC, userId: "u", campaignId: null, draftId: null, columnMap: COLUMN_MAP, mappingConfirmed: false })).toMatchObject({ ok: false, status: 400 });
    expect(await createImportJob(db, { accountId: ACC, userId: "u", campaignId: "x", draftId: null, columnMap: COLUMN_MAP, mappingConfirmed: true })).toMatchObject({ ok: false, code: "invalid_id" });
    const other = fakeEnv({ campaignAccount: "outra" });
    expect(await createImportJob(other.db, { accountId: ACC, userId: "u", campaignId: CAMP, draftId: null, columnMap: COLUMN_MAP, mappingConfirmed: true })).toMatchObject({ ok: false, status: 404 });
    const good = await createImportJob(db, { accountId: ACC, userId: "u", campaignId: CAMP, draftId: null, columnMap: COLUMN_MAP, mappingConfirmed: true });
    expect(good).toMatchObject({ ok: true });
  });

  it("sem a tabela (migration 197 ausente): 503 claro", async () => {
    const db: any = { from: () => ({ insert: () => ({ select: () => ({ limit: async () => ({ data: null, error: { code: "42P01", message: "relation does not exist" } }) }) }) }) };
    expect(await createImportJob(db, { accountId: ACC, userId: "u", campaignId: null, draftId: null, columnMap: COLUMN_MAP, mappingConfirmed: true })).toMatchObject({ ok: false, code: "unavailable", status: 503 });
  });
});

describe("putImportBlock / startImportJob", () => {
  it("guarda o bloco (linhas como texto) e soma as linhas; reenvio do mesmo bloco substitui (idempotente)", async () => {
    const env = fakeEnv({ jobs: [job({ state: "receiving", blocks: {}, blocks_total: null, rows_total: 0 })] });
    const first = await putImportBlock(env.db, env.tables.dispatch_import_jobs[0] as ImportJob, 0, [row(1), { nome: null, telefone: 119, extra: 3 }]);
    expect(first).toMatchObject({ ok: true });
    const stored = JSON.parse([...env.files.values()][0]) as Row[];
    expect(stored[1]).toEqual({ nome: "", telefone: "119", extra: "3" });
    const again = await putImportBlock(env.db, env.tables.dispatch_import_jobs[0] as ImportJob, 0, [row(1)]);
    expect((again as { job: ImportJob }).job.rows_total).toBe(1);
    expect(env.files.size).toBe(1);
  });

  it("recusa bloco inválido/vazio/grande, coluna de contato inexistente no 1º bloco e job que não recebe mais", async () => {
    const env = fakeEnv({ jobs: [job({ state: "receiving", blocks: {}, blocks_total: null })] });
    const j = () => env.tables.dispatch_import_jobs[0] as ImportJob;
    expect(await putImportBlock(env.db, j(), -1, [row(1)])).toMatchObject({ code: "invalid_block" });
    expect(await putImportBlock(env.db, j(), IMPORT_JOB_MAX_BLOCKS, [row(1)])).toMatchObject({ code: "invalid_block" });
    expect(await putImportBlock(env.db, j(), 0, [])).toMatchObject({ code: "no_rows" });
    expect(await putImportBlock(env.db, j(), 0, Array.from({ length: 10_001 }, (_, i) => row(i)))).toMatchObject({ code: "block_too_large" });
    expect(await putImportBlock(env.db, j(), 0, [{ nome: "sem telefone", telefone: "" }])).toMatchObject({ code: "no_phone_column", status: 400 });
    j().state = "pending";
    expect(await putImportBlock(env.db, j(), 1, [row(1)])).toMatchObject({ code: "not_receiving", status: 409 });
  });

  it("start: só libera quando TODOS os blocos 0..total-1 chegaram", async () => {
    const env = fakeEnv({ jobs: [job({ state: "receiving", blocks: { "0": 2, "2": 1 }, blocks_total: null })] });
    const j = () => env.tables.dispatch_import_jobs[0] as ImportJob;
    expect(await startImportJob(env.db, j(), 3)).toMatchObject({ ok: false, code: "blocks_missing", status: 409 });
    expect(await startImportJob(env.db, j(), 0)).toMatchObject({ ok: false, code: "invalid_total" });
    j().blocks = { "0": 2, "1": 2, "2": 1 };
    const started = await startImportJob(env.db, j(), 3);
    expect(started).toMatchObject({ ok: true });
    expect(j()).toMatchObject({ state: "pending", blocks_total: 3 });
    expect(await startImportJob(env.db, j(), 3)).toMatchObject({ code: "not_receiving" });
  });

  it("com a RPC atômica (migration 196): usa dispatch_import_set_block e NÃO faz ler-modificar-gravar da linha", async () => {
    const env = fakeEnv({ jobs: [job({ state: "receiving", blocks: {}, blocks_total: null, rows_total: 0 })] });
    const updated = { ...job({ state: "receiving", blocks_total: null }), blocks: { "0": 1, "1": 5 }, rows_total: 6 };
    const rpc = vi.fn(async () => ({ data: updated, error: null }));
    (env.db as any).rpc = rpc;
    const spy = vi.spyOn(env.db, "from");
    const result = await putImportBlock(env.db, env.tables.dispatch_import_jobs[0] as ImportJob, 0, [row(1)]);
    expect(rpc).toHaveBeenCalledWith("dispatch_import_set_block", { p_job_id: "job-1", p_n: 0, p_rows: 1 });
    expect((result as { job: ImportJob }).job.rows_total).toBe(6); // o total vem do banco (inclui o bloco concorrente), não do objeto local
    expect(spy).not.toHaveBeenCalled(); // nenhum UPDATE de blocks no cliente
  });

  it("RPC devolve NULL (job não recebe mais): 409; RPC com erro (função ausente): cai no caminho antigo e grava", async () => {
    const env = fakeEnv({ jobs: [job({ state: "receiving", blocks: {}, blocks_total: null, rows_total: 0 })] });
    (env.db as any).rpc = async () => ({ data: null, error: null });
    expect(await putImportBlock(env.db, env.tables.dispatch_import_jobs[0] as ImportJob, 0, [row(1)])).toMatchObject({ ok: false, code: "not_receiving", status: 409 });
    (env.db as any).rpc = async () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function wacrm.dispatch_import_set_block" } });
    const fallback = await putImportBlock(env.db, env.tables.dispatch_import_jobs[0] as ImportJob, 0, [row(1)]);
    expect(fallback).toMatchObject({ ok: true });
    expect(env.tables.dispatch_import_jobs[0]).toMatchObject({ blocks: { "0": 1 }, rows_total: 1 });
  });

  it("normalizeBlockRows: só objetos, valores viram texto", () => {
    expect(normalizeBlockRows([{ a: 1, b: null }, "x", null, [1], { c: true }])).toEqual([{ a: "1", b: "" }, { c: "true" }]);
  });
});

describe("processImportJob", () => {
  function envWithBlocks(blocks = 3) {
    const env = fakeEnv({ jobs: [job({ blocks_total: blocks })] });
    for (let n = 0; n < blocks; n++) env.files.set(`${ACC}/disparador-imports/job-1/blocks/${String(n).padStart(5, "0")}.json`, JSON.stringify([row(n * 2), row(n * 2 + 1)]));
    return env;
  }

  it("processa os blocos EM ORDEM com chunkIndex = número do bloco, soma os totais e apaga os blocos ao concluir", async () => {
    const env = envWithBlocks();
    const seen: number[] = [];
    const processBlock: ProcessBlock = async (input) => (seen.push(input.chunkIndex), ok(2, { duplicados: input.chunkIndex }) as never);
    const result = await processImportJob(env.db, env.tables.dispatch_import_jobs[0] as ImportJob, { owner: "o", processBlock });
    expect(result).toBe("done");
    expect(seen).toEqual([0, 1, 2]);
    expect(env.tables.dispatch_import_jobs[0]).toMatchObject({ state: "done", next_block: 3, rows_done: 6, linked: 6, totals: { importados: 6, duplicados: 3 } });
    expect(env.files.size).toBe(0);
  });

  it("passa conta, usuário, campanha/rascunho e mapeamento do job para a função do bloco", async () => {
    const env = envWithBlocks(1);
    Object.assign(env.tables.dispatch_import_jobs[0], { campaign_id: CAMP, draft_id: "d1" });
    const processBlock = vi.fn(async () => ok(2) as never);
    await processImportJob(env.db, env.tables.dispatch_import_jobs[0] as ImportJob, { owner: "o", processBlock });
    expect(processBlock).toHaveBeenCalledWith(expect.objectContaining({ accountId: ACC, userId: "u1", campaignId: CAMP, draftId: "d1", columnMap: COLUMN_MAP, chunkIndex: 0 }));
  });

  it("orçamento de tempo: salva o progresso e devolve 'continue'; o tick seguinte retoma do próximo bloco (sem repetir)", async () => {
    const env = envWithBlocks();
    const seen: number[] = [];
    const processBlock: ProcessBlock = async (input) => (seen.push(input.chunkIndex), ok(2) as never);
    let t = 0;
    const first = await processImportJob(env.db, env.tables.dispatch_import_jobs[0] as ImportJob, { owner: "o", processBlock, budgetMs: 50, clock: () => (t += 100) });
    expect(first).toBe("continue");
    expect(seen).toEqual([0]);
    expect(env.tables.dispatch_import_jobs[0]).toMatchObject({ state: "running", next_block: 1, rows_done: 2 });
    const second = await processImportJob(env.db, { ...(env.tables.dispatch_import_jobs[0] as ImportJob) }, { owner: "o", processBlock });
    expect(second).toBe("done");
    expect(seen).toEqual([0, 1, 2]);
    expect(env.tables.dispatch_import_jobs[0].totals.importados).toBe(6);
  });

  it("erros por linha dos blocos vão para o job (limitados)", async () => {
    const env = envWithBlocks(2);
    const processBlock: ProcessBlock = async () =>
      ({ results: { ...emptyTotals(), importados: 1, erros: Array.from({ length: 150 }, (_, i) => `11999990${i}: não foi possível salvar o contato.`) }, linked: 1 }) as never;
    await processImportJob(env.db, env.tables.dispatch_import_jobs[0] as ImportJob, { owner: "o", processBlock });
    const errors = env.tables.dispatch_import_jobs[0].errors as string[];
    expect(errors).toHaveLength(IMPORT_MAX_ERRORS);
    expect(errors[0]).toContain("não foi possível salvar o contato");
  });

  it("falha do bloco ou do Storage: volta a pendente com backoff, sem perder o que já foi; na 3ª vez vira failed", async () => {
    const env = envWithBlocks();
    const processBlock: ProcessBlock = async (input) => {
      if (input.chunkIndex === 1) throw new Error("banco indisponível");
      return ok(2) as never;
    };
    expect(await processImportJob(env.db, env.tables.dispatch_import_jobs[0] as ImportJob, { owner: "o", processBlock })).toBe("retry");
    expect(env.tables.dispatch_import_jobs[0]).toMatchObject({ state: "pending", attempts: 1, next_block: 1, rows_done: 2 }); // o bloco 0 ficou
    expect(env.tables.dispatch_import_jobs[0].last_error).toContain("banco indisponível");
    Object.assign(env.tables.dispatch_import_jobs[0], { state: "running", owner_id: "o", attempts: 2 });
    expect(await processImportJob(env.db, { ...(env.tables.dispatch_import_jobs[0] as ImportJob) }, { owner: "o", processBlock })).toBe("failed");
    expect(env.tables.dispatch_import_jobs[0]).toMatchObject({ state: "failed", attempts: 3 });
    expect(toPublicImportJob(env.tables.dispatch_import_jobs[0] as ImportJob).error).toContain("banco indisponível");
  });

  it("falha reportada pela função (ex.: vínculo com a campanha não gravou) também vira retry do bloco", async () => {
    const env = envWithBlocks(1);
    const processBlock: ProcessBlock = async () => ({ failure: { error: "Contatos importados, mas não foi possível vinculá-los à campanha.", status: 500 } }) as never;
    expect(await processImportJob(env.db, env.tables.dispatch_import_jobs[0] as ImportJob, { owner: "o", processBlock })).toBe("retry");
    expect(env.tables.dispatch_import_jobs[0].last_error).toContain("vinculá-los");
  });

  it("job sem usuário solicitante falha sem processar nada", async () => {
    const env = envWithBlocks(1);
    env.tables.dispatch_import_jobs[0].requested_by = null;
    const processBlock = vi.fn();
    expect(await processImportJob(env.db, env.tables.dispatch_import_jobs[0] as ImportJob, { owner: "o", processBlock: processBlock as never })).toBe("failed");
    expect(processBlock).not.toHaveBeenCalled();
  });
});

describe("limpeza e formato público", () => {
  it("job recebendo há mais de 24 h é cancelado e os blocos guardados são apagados; o recente fica", async () => {
    const env = fakeEnv({
      jobs: [
        job({ id: "velho", state: "receiving", blocks: { "0": 1 }, blocks_total: null, created_at: "2026-10-06T00:00:00Z" }),
        job({ id: "novo", state: "receiving", blocks: { "0": 1 }, blocks_total: null, created_at: "2026-10-08T11:00:00Z" }),
      ],
    });
    env.files.set(`${ACC}/disparador-imports/velho/blocks/00000.json`, "[]");
    env.files.set(`${ACC}/disparador-imports/novo/blocks/00000.json`, "[]");
    expect(await cancelStaleImportJobs(env.db, new Date("2026-10-08T12:00:00Z"))).toBe(1);
    expect(env.tables.dispatch_import_jobs.map((j) => [j.id, j.state])).toEqual([["velho", "cancelled"], ["novo", "receiving"]]);
    expect([...env.files.keys()]).toEqual([`${ACC}/disparador-imports/novo/blocks/00000.json`]);
  });

  it("contrato público: progresso e totais, sem dono/lease/mapeamento", () => {
    const pub = toPublicImportJob(job({ state: "running", rows_total: 40, rows_done: 10, next_block: 1 }));
    expect(pub).toMatchObject({ state: "running", blocks_received: 3, blocks_total: 3, rows_total: 40, rows_done: 10, progress: 0.25, error: null });
    expect(pub).not.toHaveProperty("owner_id");
    expect(pub).not.toHaveProperty("column_map");
  });
});
