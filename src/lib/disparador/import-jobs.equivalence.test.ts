// A12/A13: a importação por JOB (blocos guardados no Storage, processados pelo cron) dá EXATAMENTE o mesmo resultado que a
// importação de hoje (um bloco por requisição, em ordem): mesmos contatos criados/atualizados, mesmo dedupe, mesmas tags,
// mesmo opt-out, mesmos vínculos, mesmas VAR1–3 e telefones alternativos, mesmos totais.
// Roda a função REAL (importContactBlock) sobre um Supabase em memória, com um arquivo sintético que exercita cada regra.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createImportFake } from "./import-fake-supabase.test-helper";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
const ACC = "acc-1";
const USER = "user-1";
const DRAFT = "22222222-2222-4222-8222-222222222222";

let fake = createImportFake();
vi.mock("@/lib/logger", () => ({ writeLog: vi.fn() }));
vi.mock("@/lib/disparador/admin-client", () => ({ supabaseAdmin: () => fake.client }));

import { importContactBlock, type ImportBlockResults } from "./import-block";
import { createImportJob, emptyTotals, putImportBlock, runImportCron, startImportJob, type ImportJob, type ImportTotals } from "./import-jobs";
import { resetBlacklistFallbackCache } from "./blacklist-keys";

const COLUMN_MAP = { name: "nome", phone: "telefone", cpf: "cpf", var1: "var1", var2: "var2" };

/** Arquivo sintético: cada linha exercita uma regra do importador. 2.350 linhas em 3 blocos de 1.000/1.000/350. */
function syntheticFile(): Row[] {
  const rows: Row[] = [];
  const phone = (i: number) => `119${String(10_000_000 + i)}`;
  for (let i = 0; i < 2000; i++) rows.push({ nome: `Contato ${i}`, telefone: phone(i), cpf: String(10_000_000_000 + i), var1: `v${i}`, var2: i % 3 === 0 ? `w${i}` : "", tags: i % 50 === 0 ? "vip, devedor" : "" });
  // inválidos e vazios
  rows.push({ nome: "Sem telefone", telefone: "", cpf: "" }, { nome: "Telefone curto", telefone: "123" }, { nome: "Letras", telefone: "abc" });
  // duplicados DENTRO do arquivo: mesmo telefone (com/sem 9º dígito e com/sem 55) e mesmo CPF com outro telefone
  rows.push({ nome: "Dup tel", telefone: phone(5) }, { nome: "Dup tel formatado", telefone: `+55 (11) 9${String(10_000_000 + 7).slice(1)}`.replace(/\D/g, "") });
  rows.push({ nome: "Dup cpf", telefone: "11988880001", cpf: String(10_000_000_000 + 9) });
  // contato JÁ EXISTENTE sem nome (backfill de nome/CPF) e outro com nome real (não sobrescreve)
  rows.push({ nome: "Maria Preenchida", telefone: "11977770001", cpf: "98765432100" }, { nome: "Outro Nome", telefone: "11977770002" });
  // telefones alternativos (TELEFONE2/3) e e-mail/empresa
  rows.push({ nome: "Com alternativos", telefone: "11966660001", telefone2: "11966660002", telefone3: "11966660003", email: "a@b.com", empresa: "Acme" });
  // opt-out: números na blacklist
  rows.push({ nome: "Opt-out 1", telefone: "11955550001" }, { nome: "Opt-out 2", telefone: "11955550002" });
  // completa até 2.350 com contatos novos (cruzam a fronteira dos blocos: repetem telefones do bloco anterior)
  for (let i = 0; rows.length < 2350; i++) rows.push({ nome: `Extra ${i}`, telefone: i % 10 === 0 ? phone(i) : `1194${String(1_000_000 + i)}`, cpf: "" });
  return rows;
}

const BLOCK = 1000;
const blocksOf = (rows: Row[]) => Array.from({ length: Math.ceil(rows.length / BLOCK) }, (_, n) => rows.slice(n * BLOCK, (n + 1) * BLOCK));

function seedAccount() {
  fake.state.tables = {
    blacklist: [{ id: 1, telefone: "11955550001" }, { id: 2, telefone: "11955550002" }],
    contacts: [
      { id: "pre-1", account_id: ACC, user_id: USER, phone: "11977770001", phone_normalized: "5511977770001", name: null, cpf: null },
      { id: "pre-2", account_id: ACC, user_id: USER, phone: "11977770002", phone_normalized: "5511977770002", name: "Nome Que Já Existe", cpf: null },
    ],
  };
}

/** Estado do banco sem ids/ordem (o que importa para "mesmo resultado"). */
function snapshot() {
  const t = fake.state.tables;
  const byId = new Map<string, Row>((t.contacts ?? []).map((c) => [c.id, c]));
  const key = (id: string) => byId.get(id)?.phone_normalized ?? id;
  const sortBy = <T,>(rows: T[], f: (r: T) => string) => [...rows].sort((a, b) => (f(a) < f(b) ? -1 : 1));
  return {
    contacts: sortBy((t.contacts ?? []).map((c) => ({ phone: c.phone_normalized, name: c.name, cpf: c.cpf, email: c.email ?? null, company: c.company ?? null, account: c.account_id })), (c) => c.phone),
    links: sortBy((t.disp_import_contacts ?? []).map((l) => ({ contact: key(l.contact_id), draft: l.draft_id, campaign: l.campaign_id ?? null, account: l.account_id })), (l) => l.contact),
    vars: sortBy((t.contact_import_variables ?? []).map((v) => ({ contact: key(v.contact_id), idx: v.var_index, value: v.value, draft: v.draft_id ?? null })), (v) => `${v.contact}|${v.idx}`),
    alts: sortBy((t.contact_phones ?? []).map((p) => ({ contact: key(p.contact_id), ordem: p.ordem, phone: p.phone_normalized })), (p) => `${p.contact}|${p.ordem}`),
    tags: sortBy((t.tags ?? []).map((g) => String(g.name).toLowerCase()), (g) => g),
    contactTags: sortBy((t.contact_tags ?? []).map((ct) => `${key(ct.contact_id)}|${(t.tags ?? []).find((g) => g.id === ct.tag_id)?.name?.toLowerCase()}`), (x) => x),
  };
}

const sumTotals = (rs: ImportBlockResults[]): ImportTotals =>
  rs.reduce<ImportTotals>(
    (acc, r) => ({ importados: acc.importados + r.importados, duplicados: acc.duplicados + r.duplicados, invalidos: acc.invalidos + r.invalidos, blacklisted: acc.blacklisted + r.blacklisted, variaveis_falhas: acc.variaveis_falhas + r.variaveis_falhas }),
    emptyTotals(),
  );

/** Storage + tabela de jobs sobre o MESMO banco em memória. */
function wireJobBackend() {
  const files = new Map<string, Buffer>();
  const base = fake.client;
  const claim = async (owner: string) => {
    const jobs = (fake.state.tables.dispatch_import_jobs ??= []);
    const job = jobs.find((j) => j.state === "pending" || (j.state === "running" && j.lease_until < new Date().toISOString()));
    if (!job) return { data: [], error: null };
    Object.assign(job, { state: "running", owner_id: owner, lease_until: new Date(Date.now() + 120_000).toISOString() });
    return { data: [{ ...job }], error: null };
  };
  const db: any = {
    from: (table: string) => {
      const b: any = base.from(table);
      if (table === "dispatch_import_jobs") {
        const insert = b.insert.bind(b);
        b.insert = (v: Row) => insert({ id: "job-1", state: "receiving", blocks: {}, next_block: 0, rows_total: 0, rows_done: 0, totals: emptyTotals(), linked: 0, errors: [], attempts: 0, created_at: new Date().toISOString(), ...v });
      }
      return b;
    },
    rpc: (fn: string, args: Row) => (fn === "claim_dispatch_import_job" ? claim(args.p_owner) : base.rpc(fn, args)),
    storage: {
      from: () => ({
        upload: async (path: string, body: Buffer) => (files.set(path, Buffer.from(body)), { error: null }),
        download: async (path: string) => (files.has(path) ? { data: new Blob([new Uint8Array(files.get(path)!)]), error: null } : { data: null, error: { message: "não existe" } }),
        remove: async (paths: string[]) => (paths.forEach((p) => files.delete(p)), { error: null }),
      }),
    },
  };
  return { db, files };
}

beforeEach(() => {
  fake = createImportFake();
  resetBlacklistFallbackCache();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("importação por job × importação de hoje (um bloco por requisição)", () => {
  it("MESMO resultado: contatos, dedupe, tags, opt-out, vínculos, VARs, alternativos e totais", async () => {
    const blocks = blocksOf(syntheticFile());
    expect(blocks).toHaveLength(3);

    // A) como hoje: um bloco por requisição, em ordem, somando os resultados (é o que o wizard faz).
    seedAccount();
    const sequential: ImportBlockResults[] = [];
    let linkedSeq = 0;
    for (const [n, rows] of blocks.entries()) {
      const out = await importContactBlock({ accountId: ACC, userId: USER, rows, columnMap: COLUMN_MAP, campaignId: null, draftId: DRAFT, chunkIndex: n });
      expect(out.failure).toBeUndefined();
      sequential.push(out.results!);
      linkedSeq += out.linked!;
    }
    const expected = snapshot();
    const expectedTotals = sumTotals(sequential);

    // B) pelo JOB: cria, grava os blocos, libera e o cron processa.
    fake = createImportFake();
    resetBlacklistFallbackCache();
    seedAccount();
    const { db } = wireJobBackend();
    const created = await createImportJob(db, { accountId: ACC, userId: USER, campaignId: null, draftId: DRAFT, columnMap: COLUMN_MAP, mappingConfirmed: true });
    expect(created.ok).toBe(true);
    let job = (created as { job: ImportJob }).job;
    for (const [n, rows] of blocks.entries()) {
      const put = await putImportBlock(db, job, n, rows);
      expect(put.ok).toBe(true);
      job = (put as { job: ImportJob }).job;
    }
    const started = await startImportJob(db, job, blocks.length);
    expect(started, JSON.stringify(started)).toMatchObject({ ok: true });
    const summary = await runImportCron(db, { owner: "cron-1" });
    expect(summary).toMatchObject({ processed: 1, done: 1, failed: 0 });

    const finished = fake.state.tables.dispatch_import_jobs[0] as ImportJob;
    expect(finished.state).toBe("done");
    expect(finished.totals).toEqual(expectedTotals);
    expect(finished.linked).toBe(linkedSeq);
    expect(finished.rows_done).toBe(2350);
    expect(snapshot()).toEqual(expected);

    // sanidade: o arquivo exercitou as regras (senão a igualdade seria vazia)
    expect(expectedTotals.invalidos).toBeGreaterThanOrEqual(3);
    expect(expectedTotals.blacklisted).toBe(2);
    expect(expectedTotals.duplicados).toBeGreaterThan(5);
    expect(expected.tags).toEqual(["devedor", "vip"]);
    expect(expected.contactTags.length).toBeGreaterThan(0);
    expect(expected.alts.length).toBe(2);
    expect(expected.contacts.find((c) => c.phone === "5511977770001")).toMatchObject({ name: "Maria Preenchida", cpf: "98765432100" });
    expect(expected.contacts.find((c) => c.phone === "5511977770002")?.name).toBe("Nome Que Já Existe");
  }, 60_000);

  it("retomável: o cron para no meio (orçamento) e o tick seguinte termina com o MESMO resultado de uma execução contínua", async () => {
    const blocks = blocksOf(syntheticFile());
    const runWith = async (budget: number | undefined) => {
      fake = createImportFake();
      resetBlacklistFallbackCache();
      seedAccount();
      const { db } = wireJobBackend();
      let job = ((await createImportJob(db, { accountId: ACC, userId: USER, campaignId: null, draftId: DRAFT, columnMap: COLUMN_MAP, mappingConfirmed: true })) as { job: ImportJob }).job;
      for (const [n, rows] of blocks.entries()) job = ((await putImportBlock(db, job, n, rows)) as { job: ImportJob }).job;
      await startImportJob(db, job, blocks.length);
      if (budget === undefined) {
        await runImportCron(db, { owner: "c" });
      } else {
        let t = 0;
        const first = await runImportCron(db, { owner: "c", budgetMs: budget, clock: () => (t += 1000) });
        expect(first.continued).toBe(1);
        const mid = fake.state.tables.dispatch_import_jobs[0];
        expect(mid.state).toBe("running");
        expect(mid.next_block).toBeGreaterThan(0);
        expect(mid.next_block).toBeLessThan(blocks.length);
        mid.lease_until = new Date(Date.now() - 1000).toISOString(); // o processo morreu: o lease venceu
        await runImportCron(db, { owner: "c2" });
      }
      return { snap: snapshot(), job: fake.state.tables.dispatch_import_jobs[0] as ImportJob };
    };
    const continuous = await runWith(undefined);
    const resumed = await runWith(1500);
    expect(resumed.job.state).toBe("done");
    expect(resumed.snap).toEqual(continuous.snap);
    expect(resumed.job.totals).toEqual(continuous.job.totals);
    expect(resumed.job.linked).toBe(continuous.job.linked);
  }, 60_000);
});
