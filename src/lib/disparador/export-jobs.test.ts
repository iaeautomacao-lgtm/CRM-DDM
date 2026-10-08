// A22: exportação assíncrona da fila — blocos retomáveis por keyset, arquivo no Storage, link que expira, nada em memória.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createExportJob,
  csvCell,
  csvLine,
  EXPORT_BLOCK_ROWS,
  exportColumns,
  expireExportJobs,
  isValidExportStatusKey,
  processExportJob,
  runExportCron,
  signedDownloadUrl,
  type ExportJob,
} from "./export-jobs";

vi.mock("@/lib/disparador/admin-client", () => ({ supabaseAdmin: () => ({ from: () => emptyChain() }) }));
function emptyChain(): any {
  const b: any = {};
  for (const m of ["select", "eq", "in", "lt", "limit"]) b[m] = () => b;
  b.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
  return b;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
const ACC = "acc-1";
const CAMP = "camp-1";

/** Banco + Storage em memória com o que o job usa (select/eq/in/or/not/gt/order/limit, insert/update, rpc, storage). */
function fakeEnv(queue: Row[], opts: { jobs?: Row[]; failUploadsAfter?: number } = {}) {
  const tables: Record<string, Row[]> = {
    campaigns: [{ id: CAMP, account_id: ACC, import_draft_id: null }],
    disp_message_queue: queue,
    dispatch_export_jobs: opts.jobs ?? [],
    contact_import_variables: [],
  };
  const files = new Map<string, Buffer>();
  const calls = { queueSelects: [] as Array<{ filters: Array<[string, string, unknown]>; limit: number | null }>, uploads: [] as string[] };
  let uploads = 0;
  let seq = 0;

  const db: any = {
    from(table: string) {
      const filters: Array<[string, string, unknown]> = [];
      let limit: number | null = null;
      let order: boolean | null = null;
      let patch: Row | null = null;
      let insertRow: Row | null = null;
      let single = false;
      const b: any = {};
      b.select = () => b;
      b.eq = (c: string, v: unknown) => (filters.push(["eq", c, v]), b);
      b.in = (c: string, v: unknown) => (filters.push(["in", c, v]), b);
      b.lt = (c: string, v: unknown) => (filters.push(["lt", c, v]), b);
      b.gt = (c: string, v: unknown) => (filters.push(["gt", c, v]), b);
      b.or = (v: unknown) => (filters.push(["or", "", v]), b);
      b.not = (c: string, _op: string, v: unknown) => (filters.push(["not", c, v]), b);
      b.order = (_c: string, o?: { ascending?: boolean }) => ((order = o?.ascending !== false), b);
      b.limit = (n: number) => ((limit = n), b);
      b.maybeSingle = () => ((single = true), b);
      b.update = (p: Row) => ((patch = p), b);
      b.insert = (r: Row) => ((insertRow = r), b);
      b.then = (resolve: (v: unknown) => void) => {
        if (insertRow) {
          const row = { id: `job-${++seq}`, state: "pending", rows_done: 0, parts_count: 0, attempts: 0, truncated: false, format: "csv", created_at: "2026-10-08T12:00:00Z", ...insertRow };
          tables[table].push(row);
          return resolve({ data: [row], error: null });
        }
        let rows = (tables[table] ?? []).filter((r) =>
          filters.every(([op, c, v]) => {
            if (op === "eq") return r[c] === v;
            if (op === "in") return (v as unknown[]).includes(r[c]);
            if (op === "gt") return String(r[c]) > String(v);
            if (op === "lt") return String(r[c]) < String(v);
            if (op === "not") return r[c] != null;
            return true; // or(): o filtro de status é conferido nos testes pelos `filters` registrados
          }),
        );
        if (table === "disp_message_queue") calls.queueSelects.push({ filters: [...filters], limit });
        if (order !== null) rows = [...rows].sort((a, z) => (String(a.id) < String(z.id) ? -1 : 1) * (order ? 1 : -1));
        if (limit !== null) rows = rows.slice(0, limit);
        if (patch) {
          rows.forEach((r) => Object.assign(r, patch));
          return resolve({ data: rows, error: null });
        }
        return resolve({ data: single ? (rows[0] ?? null) : rows, error: null });
      };
      return b;
    },
    rpc: async (fn: string) => {
      if (fn !== "claim_dispatch_export_job") return { data: null, error: { message: "?" } };
      const job = tables.dispatch_export_jobs.find((j) => j.state === "pending" || (j.state === "running" && j.lease_until < new Date().toISOString()));
      if (!job) return { data: [], error: null };
      Object.assign(job, { state: "running", owner_id: "test-owner", lease_until: new Date(Date.now() + 120_000).toISOString() });
      return { data: [{ ...job }], error: null };
    },
    storage: {
      from: () => ({
        upload: async (path: string, body: Buffer) => {
          uploads++;
          if (opts.failUploadsAfter !== undefined && uploads > opts.failUploadsAfter) return { error: { message: "storage fora" } };
          files.set(path, Buffer.from(body));
          calls.uploads.push(path);
          return { error: null };
        },
        download: async (path: string) => {
          const f = files.get(path);
          return f ? { data: new Blob([new Uint8Array(f)]), error: null } : { data: null, error: { message: "não existe" } };
        },
        remove: async (paths: string[]) => (paths.forEach((p) => files.delete(p)), { data: null, error: null }),
        createSignedUrl: async (path: string, seconds: number) => ({ data: { signedUrl: `https://storage.test/${path}?exp=${seconds}` }, error: null }),
      }),
    },
  };
  return { db, tables, files, calls };
}

const item = (n: number, over: Row = {}): Row => ({
  id: `q-${String(n).padStart(6, "0")}`,
  campaign_id: CAMP,
  contact_id: `c-${n}`,
  mensagem_final: `Olá ${n}`,
  erro: null,
  status: "enviado",
  scheduled_at: "2026-10-08T10:00:00Z",
  sent_at: "2026-10-08T10:01:00Z",
  contacts: { name: `Pessoa ${n}`, phone: `+55119${String(n).padStart(8, "0")}` },
  ...over,
});
const queueOf = (n: number, over: Row = {}) => Array.from({ length: n }, (_, i) => item(i + 1, over));

const newJob = (over: Partial<ExportJob> = {}): ExportJob => ({
  id: "job-x", account_id: ACC, campaign_id: CAMP, requested_by: "u1", status_key: "enviado", format: "csv", state: "running",
  rows_done: 0, total_rows: null, parts_count: 0, cursor_id: null, truncated: false, file_path: null, file_size: null, attempts: 0,
  last_error: null, created_at: "2026-10-08T12:00:00Z", started_at: null, finished_at: null, expires_at: null, ...over,
});
const withOwner = <T extends object>(job: T) => ({ ...job, owner_id: "test-owner" });
const finalFile = (env: ReturnType<typeof fakeEnv>) => [...env.files.entries()].find(([p]) => p.endsWith("export.csv"));
const text = (b?: Buffer) => b?.toString("utf8") ?? "";

beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));

describe("CSV", () => {
  it("escapa aspas/; e quebra de linha; protege contra fórmula no Excel", () => {
    expect(csvCell('a;b "c"')).toBe('"a;b ""c"""');
    expect(csvCell("linha1\nlinha2")).toBe('"linha1\nlinha2"');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("@cmd")).toBe("'@cmd");
    expect(csvCell("+5511999990000")).toBe("+5511999990000"); // telefone não é fórmula
    expect(csvCell("-texto")).toBe("'-texto");
    expect(csvLine(["a", 1, null])).toBe("a;1;\r\n");
  });
  it("colunas iguais às do XLSX do detalhamento", () => {
    expect(exportColumns("enviado")).toEqual(["Contato", "Telefone", "Status", "Mensagem Final", "Data/Hora"]);
    expect(exportColumns("erro")).toContain("Tipo de Erro");
    expect(exportColumns("aguardando_confirmacao")).toContain("Motivo");
  });
  it("só métricas conhecidas", () => {
    expect(isValidExportStatusKey("total")).toBe(true);
    expect(isValidExportStatusKey("erro")).toBe(true);
    expect(isValidExportStatusKey("; drop table")).toBe(false);
  });
});

describe("createExportJob", () => {
  it("cria o job pendente; pedido igual em andamento é reaproveitado (sem duplicar)", async () => {
    const env = fakeEnv([]);
    const a = await createExportJob(env.db, { accountId: ACC, campaignId: CAMP, userId: "u1", statusKey: "erro", totalRows: 500 });
    const b = await createExportJob(env.db, { accountId: ACC, campaignId: CAMP, userId: "u1", statusKey: "erro", totalRows: 500 });
    expect(a.ok && b.ok && a.job.id === b.job.id).toBe(true);
    expect(env.tables.dispatch_export_jobs).toHaveLength(1);
    expect(env.tables.dispatch_export_jobs[0]).toMatchObject({ state: "pending", status_key: "erro", total_rows: 500 });
  });
  it("métrica inválida é recusada", async () => {
    const env = fakeEnv([]);
    expect(await createExportJob(env.db, { accountId: ACC, campaignId: CAMP, userId: null, statusKey: "x", totalRows: null })).toMatchObject({ ok: false, code: "invalid_status" });
  });
  it("sem a tabela (migration 203 ausente): erro claro, nunca exceção", async () => {
    const db: any = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ in: () => ({ limit: async () => ({ data: null, error: { code: "42P01", message: "relation does not exist" } }) }) }) }) }) }) }) };
    expect(await createExportJob(db, { accountId: ACC, campaignId: CAMP, userId: null, statusKey: "erro", totalRows: null })).toMatchObject({ ok: false, code: "unavailable" });
  });
});

describe("processExportJob — blocos, keyset e arquivo final", () => {
  it("exporta todas as linhas em blocos de 2000 (keyset por id, nunca OFFSET) e junta num CSV com BOM e cabeçalho", async () => {
    const n = EXPORT_BLOCK_ROWS * 2 + 345;
    const env = fakeEnv(queueOf(n));
    env.tables.dispatch_export_jobs.push(withOwner(newJob()));
    const result = await processExportJob(env.db, newJob(), { owner: "test-owner" });
    expect(result).toBe("done");

    const job = env.tables.dispatch_export_jobs[0];
    expect(job).toMatchObject({ state: "done", rows_done: n, parts_count: 3 });
    expect(job.expires_at).toBeTruthy();
    const [path, file] = finalFile(env)!;
    expect(path).toBe(`${ACC}/disparador-exports/job-x/export.csv`);
    const lines = text(file).split("\r\n").filter(Boolean);
    expect(lines[0]).toBe("﻿Contato;Telefone;Status;Mensagem Final;Data/Hora");
    expect(lines).toHaveLength(n + 1);
    expect(lines[1]).toContain("Pessoa 1;+5511900000001;enviado;Olá 1;");
    // partes apagadas; só o arquivo final fica
    expect([...env.files.keys()].every((p) => p.endsWith("export.csv"))).toBe(true);
    // keyset: a 1ª consulta sem cursor, as seguintes com gt(id) — nenhuma com offset
    const gtCalls = env.calls.queueSelects.map((c) => c.filters.some(([op]) => op === "gt"));
    expect(gtCalls).toEqual([false, true, true]);
    expect(env.calls.queueSelects.every((c) => c.limit !== null && c.limit <= EXPORT_BLOCK_ROWS)).toBe(true);
  });

  it("filtra pela métrica do pedido (status do detalhamento) e só na campanha do job", async () => {
    const env = fakeEnv([...queueOf(3), item(4, { status: "erro", erro: "x" }), item(5, { campaign_id: "outra" })]);
    env.tables.dispatch_export_jobs.push(withOwner(newJob({ status_key: "enviado" })));
    await processExportJob(env.db, newJob({ status_key: "enviado" }), { owner: "test-owner" });
    const filters = env.calls.queueSelects[0].filters;
    expect(filters).toContainEqual(["eq", "campaign_id", CAMP]);
    expect(filters).toContainEqual(["in", "status", ["enviado", "entregue", "lido"]]);
  });

  it("retomável: parar no meio (orçamento de tempo) e continuar dá EXATAMENTE o mesmo arquivo de uma execução contínua", async () => {
    const n = EXPORT_BLOCK_ROWS * 3 + 10;
    const continuous = fakeEnv(queueOf(n));
    continuous.tables.dispatch_export_jobs.push(withOwner(newJob()));
    await processExportJob(continuous.db, newJob(), { owner: "test-owner" });

    const split = fakeEnv(queueOf(n));
    split.tables.dispatch_export_jobs.push(withOwner(newJob()));
    let t = 0;
    // 1º tick: orçamento só dá para 1 bloco → 'continue' com o cursor salvo no banco
    const first = await processExportJob(split.db, newJob(), { owner: "test-owner", budgetMs: 50, clock: () => (t += 100) });
    expect(first).toBe("continue");
    const saved = split.tables.dispatch_export_jobs[0];
    expect(saved).toMatchObject({ state: "running", parts_count: 1, rows_done: EXPORT_BLOCK_ROWS });
    expect(saved.cursor_id).toBe(`q-${String(EXPORT_BLOCK_ROWS).padStart(6, "0")}`);
    // 2º tick (outro processo): relê o job do banco e segue do cursor
    const second = await processExportJob(split.db, { ...(saved as ExportJob) }, { owner: "test-owner" });
    expect(second).toBe("done");
    expect(text(finalFile(split)?.[1])).toBe(text(finalFile(continuous)?.[1]));
  });

  it("queda ENTRE gravar a parte e avançar o cursor repete a mesma parte (sobrescreve): sem linha duplicada nem perdida", async () => {
    const env = fakeEnv(queueOf(EXPORT_BLOCK_ROWS + 50));
    env.tables.dispatch_export_jobs.push(withOwner(newJob()));
    // simula o crash: a parte 1 foi gravada mas o job ainda está com parts_count 0 / cursor nulo
    await env.db.storage.from("x").upload(`${ACC}/disparador-exports/job-x/parts/00001.csv`, Buffer.from("LIXO\r\n"));
    await processExportJob(env.db, newJob(), { owner: "test-owner" });
    const lines = text(finalFile(env)?.[1]).split("\r\n").filter(Boolean);
    expect(lines).toHaveLength(EXPORT_BLOCK_ROWS + 50 + 1);
    expect(lines.join("\n")).not.toContain("LIXO");
  });

  it("falha do Storage: volta para pendente com backoff; na 3ª tentativa vira failed (sem loop infinito)", async () => {
    const env = fakeEnv(queueOf(5), { failUploadsAfter: 0 });
    env.tables.dispatch_export_jobs.push(withOwner(newJob({ attempts: 0 })));
    env.tables.dispatch_export_jobs[0].owner_id = "test-owner";
    expect(await processExportJob(env.db, newJob({ attempts: 0 }), { owner: "test-owner" })).toBe("retry");
    expect(env.tables.dispatch_export_jobs[0]).toMatchObject({ state: "pending", attempts: 1 });
    expect(env.tables.dispatch_export_jobs[0].last_error).toContain("storage fora");
    // 3ª tentativa: outro tick reservou de novo (dono e estado de execução) e falhou outra vez.
    Object.assign(env.tables.dispatch_export_jobs[0], { state: "running", owner_id: "test-owner", attempts: 2 });
    expect(await processExportJob(env.db, newJob({ attempts: 2 }), { owner: "test-owner" })).toBe("failed");
    expect(env.tables.dispatch_export_jobs[0]).toMatchObject({ state: "failed", attempts: 3 });
  });

  it("campanha de OUTRA conta: o job falha sem ler nada da fila", async () => {
    const env = fakeEnv(queueOf(3));
    env.tables.campaigns[0].account_id = "outra-conta";
    env.tables.dispatch_export_jobs.push(withOwner(newJob()));
    expect(await processExportJob(env.db, newJob(), { owner: "test-owner" })).toBe("failed");
    expect(env.calls.queueSelects).toHaveLength(0);
  });
});

describe("cron, expiração e link", () => {
  it("runExportCron reserva e processa jobs pendentes e informa o resumo", async () => {
    const env = fakeEnv(queueOf(10));
    env.tables.dispatch_export_jobs.push({ ...newJob({ state: "pending" }), next_attempt_at: "2026-01-01T00:00:00Z" });
    const summary = await runExportCron(env.db, { owner: "test-owner" });
    expect(summary).toMatchObject({ processed: 1, done: 1, failed: 0 });
    expect(env.tables.dispatch_export_jobs[0].state).toBe("done");
    expect(await runExportCron(env.db, { owner: "test-owner" })).toMatchObject({ processed: 0 }); // nada pendente
  });

  it("função de reserva ausente (migration 203 pendente): resumo 'unavailable', sem lançar", async () => {
    const db: any = { rpc: async () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function" } }), from: () => emptyChain() };
    expect(await runExportCron(db, { owner: "x" })).toMatchObject({ processed: 0, unavailable: true });
  });

  it("arquivo vencido: o cron apaga o arquivo do Storage e marca expired; o que não venceu fica", async () => {
    const env = fakeEnv([], {
      jobs: [
        { id: "velho", account_id: ACC, state: "done", file_path: `${ACC}/disparador-exports/velho/export.csv`, parts_count: 0, expires_at: "2026-10-07T00:00:00Z" },
        { id: "novo", account_id: ACC, state: "done", file_path: `${ACC}/disparador-exports/novo/export.csv`, parts_count: 0, expires_at: "2026-10-09T12:00:00Z" },
      ],
    });
    env.files.set(`${ACC}/disparador-exports/velho/export.csv`, Buffer.from("x"));
    env.files.set(`${ACC}/disparador-exports/novo/export.csv`, Buffer.from("y"));
    const expired = await expireExportJobs(env.db, new Date("2026-10-08T12:00:00Z"));
    expect(expired).toBe(1);
    expect(env.tables.dispatch_export_jobs.map((j) => [j.id, j.state])).toEqual([["velho", "expired"], ["novo", "done"]]);
    expect([...env.files.keys()]).toEqual([`${ACC}/disparador-exports/novo/export.csv`]);
  });

  it("link assinado só para job concluído e não vencido (curto: 10 min)", async () => {
    const env = fakeEnv([]);
    const done = { state: "done" as const, file_path: "a/b.csv", expires_at: "2026-10-09T00:00:00Z" };
    const link = await signedDownloadUrl(env.db, done, new Date("2026-10-08T12:00:00Z"));
    expect(link).toMatchObject({ expiresInSeconds: 600 });
    expect(link!.url).toContain("exp=600");
    expect(await signedDownloadUrl(env.db, { ...done, expires_at: "2026-10-08T11:00:00Z" }, new Date("2026-10-08T12:00:00Z"))).toBeNull();
    expect(await signedDownloadUrl(env.db, { ...done, state: "running" as never }, new Date())).toBeNull();
    expect(await signedDownloadUrl(env.db, { state: "done", file_path: null, expires_at: null })).toBeNull();
  });
});
