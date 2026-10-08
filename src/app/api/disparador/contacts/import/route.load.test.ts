// Teste de carga local da importação (B10) com um Supabase em memória:
// cada ida ao banco custa IMPORT_LOAD_LATENCY_MS (padrão 0, para o CI). Medição manual:
//   IMPORT_LOAD_ROWS=50000 IMPORT_LOAD_LATENCY_MS=3 npx vitest run route.load.test.ts
// O tempo medido é só de round trips + lógica do servidor (o custo real do Postgres não entra).

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;
const LATENCY_MS = Number(process.env.IMPORT_LOAD_LATENCY_MS ?? 0);
const TOTAL_ROWS = Number(process.env.IMPORT_LOAD_ROWS ?? 3000);
const BLOCK_ROWS = Number(process.env.IMPORT_LOAD_BLOCK ?? 1000);
const ACCOUNT = "account-a";

const state = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  calls: [] as string[],
  seq: 0,
  rpcMissing: false,
}));

const digits = (v: unknown) => String(v ?? "").replace(/\D/g, "");
const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

function uniqueKey(table: string, row: Row): string | null {
  if (table === "contacts") return row.phone_normalized ? `${row.account_id}|${row.phone_normalized}` : null;
  if (table === "disp_import_contacts") return row.draft_id ? `${row.draft_id}|${row.contact_id}` : null;
  return null;
}

// Índices (o fake precisa ser O(1) por operação para medir o servidor, não o fake).
const uniq = new Map<string, Set<string>>();
const byIdIdx = new Map<string, Map<string, Row>>();
function indexes(table: string) {
  const rows = (state.tables[table] ??= []);
  let u = uniq.get(table);
  let ids = byIdIdx.get(table);
  if (!u || !ids || (ids as any).__len !== rows.length) {
    u = new Set();
    ids = new Map();
    for (const r of rows) {
      const k = uniqueKey(table, r);
      if (k) u.add(k);
      if (r.id !== undefined) ids.set(r.id, r);
    }
    (ids as any).__len = rows.length;
    uniq.set(table, u);
    byIdIdx.set(table, ids);
  }
  return { u, ids, bump: () => ((ids as any).__len = rows.length) };
}

function makeBuilder(table: string) {
  const rows = (state.tables[table] ??= []);
  let idEq: unknown = undefined;
  const filters: Array<(r: Row) => boolean> = [];
  let op: "select" | "insert" | "upsert" | "update" | "delete" = "select";
  let payload: any = null;
  let upsertOpts: { onConflict?: string } = {};
  let wantRows = false;
  let single = false;
  let limit = Infinity;
  const b: any = {
    select() { wantRows = true; return b; },
    eq(c: string, v: unknown) { if (c === "id") idEq = v; filters.push((r) => r[c] === v); return b; },
    neq(c: string, v: unknown) { filters.push((r) => (c.includes(".") ? false : r[c] !== v)); return b; },
    in(c: string, vs: unknown[]) { const s = new Set(vs); filters.push((r) => s.has(r[c])); return b; },
    is(c: string, v: unknown) { filters.push((r) => (r[c] ?? null) === v); return b; },
    gt(c: string, v: any) { filters.push((r) => r[c] > v); return b; },
    not() { return b; },
    order() { return b; },
    range(a: number, z: number) { limit = z - a + 1; return b; },
    limit(n: number) { limit = n; return b; },
    insert(v: any) { op = "insert"; payload = v; return b; },
    upsert(v: any, o: any) { op = "upsert"; payload = v; upsertOpts = o ?? {}; return b; },
    update(v: any) { op = "update"; payload = v; return b; },
    delete() { op = "delete"; return b; },
    single() { single = true; return b; },
    maybeSingle() { single = true; return b; },
    then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
      return (async () => {
        state.calls.push(`${table}.${op}`);
        await sleep(LATENCY_MS);
        const match = () => {
          if (idEq !== undefined) {
            const hit = indexes(table).ids.get(idEq as string);
            return hit && filters.every((f) => f(hit)) ? [hit] : [];
          }
          return rows.filter((r) => filters.every((f) => f(r)));
        };
        let data: Row[] = [];
        let error: { code?: string; message: string } | null = null;
        if (op === "select") data = match().slice(0, limit);
        else if (op === "delete") {
          const del = new Set(match());
          const kept = rows.filter((r) => !del.has(r));
          rows.length = 0;
          rows.push(...kept);
          uniq.delete(table);
          byIdIdx.delete(table);
        } else if (op === "update") {
          for (const r of match()) Object.assign(r, payload);
          data = match();
        } else {
          const batch: Row[] = (Array.isArray(payload) ? payload : [payload]).map((r: Row) => ({ ...r }));
          const seen = new Set<string>();
          const idx = indexes(table);
          for (const r of batch) {
            if (table === "contacts") r.phone_normalized = digits(r.phone);
            const key = uniqueKey(table, r);
            const clash = key && (seen.has(key) || idx.u.has(key));
            if (key) seen.add(key);
            if (op === "insert" && clash) { error = { code: "23505", message: "duplicate key" }; break; }
          }
          if (!error) {
            if (op === "upsert") {
              const cols = (upsertOpts.onConflict ?? "id").split(",");
              for (const r of batch) {
                const hit = rows.find((x) => cols.every((c) => x[c] === r[c]));
                if (hit) Object.assign(hit, r);
                else rows.push({ id: `${table}-${++state.seq}`, ...r });
              }
            } else {
              for (const r of batch) {
                r.id = r.id ?? `${table}-${++state.seq}`;
                rows.push(r);
                const k = uniqueKey(table, r);
                if (k) idx.u.add(k);
                idx.ids.set(r.id, r);
              }
              idx.bump();
            }
            data = batch;
          }
        }
        const out = error
          ? { data: null, error }
          : { data: single ? (data[0] ?? null) : wantRows || op === "select" ? data : null, error: null };
        return resolve(out);
      })().catch(reject as any);
    },
  };
  return b;
}

vi.mock("@/lib/disparador/route-auth", () => ({
  requireDisparadorAccess: async () => ({ accountId: ACCOUNT, userId: "user-a" }),
}));
vi.mock("@/lib/logger", () => ({ writeLog: vi.fn() }));
vi.mock("@/lib/disparador/admin-client", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => makeBuilder(table),
    rpc: async (fn: string, args: Record<string, any>) => {
      state.calls.push(`rpc.${fn}`);
      await sleep(LATENCY_MS);
      if (state.rpcMissing) return { data: null, error: { message: `function ${fn} does not exist` } };
      if (fn === "blacklisted_phone_keys") {
        const { phoneKey } = await import("@/lib/disparador/phone-key");
        const wanted = new Set<string>(args.p_keys);
        const hit = new Set<string>();
        for (const r of state.tables.blacklist ?? []) {
          const k = phoneKey(String(r.telefone));
          if (wanted.has(k)) hit.add(k);
        }
        return { data: [...hit].map((key) => ({ key })), error: null };
      }
      if (fn === "import_backfill_contacts") {
        const byId = new Map((state.tables.contacts ?? []).map((c) => [c.id, c]));
        let n = 0;
        for (const item of args.p_items as Array<{ id: string; name?: string; cpf?: string }>) {
          const c = byId.get(item.id);
          if (!c || c.account_id !== args.p_account_id) continue;
          if (item.name) c.name = item.name;
          if (item.cpf && !c.cpf) c.cpf = item.cpf;
          n++;
        }
        return { data: n, error: null };
      }
      return { data: null, error: { message: `rpc desconhecida ${fn}` } };
    },
  }),
}));

import { POST } from "./route";
import { resetBlacklistFallbackCache } from "@/lib/disparador/blacklist-keys";

const DRAFT = "22222222-2222-4222-8222-222222222222";
const phoneOf = (i: number) => `119${String(10_000_000 + i)}`;
const cpfOf = (i: number) => String(10_000_000_000 + i);
const makeRows = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, k) => ({ nome: `Contato ${from + k}`, telefone: phoneOf(from + k), cpf: cpfOf(from + k) }));
const post = (rows: unknown[], chunk: number, extra: Record<string, unknown> = {}) =>
  POST(new Request("https://crm.test/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      rows, draft_id: DRAFT, chunk_index: chunk, mapping_confirmed: true,
      column_map: { name: "nome", phone: "telefone", cpf: "cpf" }, ...extra,
    }),
  }));

async function importAll(total: number) {
  const t0 = Date.now();
  for (let i = 0, chunk = 0; i < total; i += BLOCK_ROWS, chunk++) {
    const res = await post(makeRows(i, Math.min(total, i + BLOCK_ROWS)), chunk);
    expect(res.status).toBe(200);
  }
  return Date.now() - t0;
}

const countCalls = () => {
  const out: Record<string, number> = {};
  for (const c of state.calls) out[c] = (out[c] ?? 0) + 1;
  return out;
};

describe("import em lote — carga local", () => {
  beforeEach(() => {
    state.tables = { blacklist: [] };
    uniq.clear();
    byIdIdx.clear();
    state.calls = [];
    state.seq = 0;
    state.rpcMissing = false;
    resetBlacklistFallbackCache();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it(`importa ${TOTAL_ROWS} linhas novas e reimporta preenchendo nome/CPF (medição)`, async () => {
    const fresh = await importAll(TOTAL_ROWS);
    expect(state.tables.contacts).toHaveLength(TOTAL_ROWS);
    const freshCalls = countCalls();

    // Reimportação: contatos já existem sem nome/CPF → backfill de TODOS.
    for (const c of state.tables.contacts) { c.name = null; c.cpf = null; }
    state.calls = [];
    const reimport = await importAll(TOTAL_ROWS);
    expect(state.tables.contacts).toHaveLength(TOTAL_ROWS);
    expect(state.tables.contacts.every((c) => c.name && c.cpf)).toBe(true);
    const reCalls = countCalls();
    const total = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0);
    process.stderr.write(
      `[carga] ${TOTAL_ROWS} linhas, blocos de ${BLOCK_ROWS}, latência ${LATENCY_MS}ms/chamada\n` +
        `  novos:     ${fresh} ms, ${total(freshCalls)} chamadas\n` +
        `  reimport:  ${reimport} ms, ${total(reCalls)} chamadas (contacts.update=${reCalls["contacts.update"] ?? 0}, rpc.import_backfill_contacts=${reCalls["rpc.import_backfill_contacts"] ?? 0}, rpc.blacklisted_phone_keys=${reCalls["rpc.blacklisted_phone_keys"] ?? 0}, blacklist.select=${reCalls["blacklist.select"] ?? 0})
`,
    );
  }, 600_000);
});

describe("import em lote — correção", () => {
  beforeEach(() => {
    state.tables = { blacklist: [] };
    uniq.clear();
    byIdIdx.clear();
    state.calls = [];
    state.seq = 0;
    state.rpcMissing = false;
    resetBlacklistFallbackCache();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("XLSX com telefone e CPF numéricos (células number) importa sem TypeError", async () => {
    const XLSX = await import("xlsx");
    const sheet = XLSX.utils.aoa_to_sheet([
      ["nome", "telefone", "cpf"],
      ["Ana", 11999990001, 12345678901],
      ["Bia", 11999990002, 10987654321],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, "Planilha1");
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const form = new FormData();
    form.set("file", new File([new Uint8Array(buffer)], "contatos.xlsx"));
    const res = await POST(new Request("https://crm.test/api", { method: "POST", body: form }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.results.importados).toBe(2);
    expect(state.tables.contacts.map((c) => c.cpf).sort()).toEqual(["10987654321", "12345678901"]);
  });

  it("backfill de nome/CPF vai em lote (1 chamada por 1.000 contatos), não linha a linha", async () => {
    const n = 2500;
    await post(makeRows(0, n).map((r) => ({ telefone: r.telefone })), 0);
    expect(state.tables.contacts).toHaveLength(n);
    state.calls = [];
    const res = await post(makeRows(0, n), 1);
    expect(res.status).toBe(200);
    const calls = countCalls();
    expect(calls["rpc.import_backfill_contacts"]).toBe(3);
    expect(calls["contacts.update"] ?? 0).toBe(0);
    expect(state.tables.contacts.every((c) => c.name && c.cpf)).toBe(true);
  });

  it("sem a RPC (migration 181 não aplicada) o backfill cai no caminho linha a linha e continua correto", async () => {
    await post(makeRows(0, 30).map((r) => ({ telefone: r.telefone })), 0);
    state.rpcMissing = true;
    state.calls = [];
    expect((await post(makeRows(0, 30), 1)).status).toBe(200);
    expect(countCalls()["contacts.update"]).toBe(60); // 30 nomes + 30 CPFs
    expect(state.tables.contacts.every((c) => c.name && c.cpf)).toBe(true);
  });

  it("blacklist: só as chaves do bloco são consultadas (sem carregar a lista inteira)", async () => {
    state.tables.blacklist = [{ id: 1, telefone: phoneOf(1) }, { id: 2, telefone: "21988887777" }];
    const res = await post(makeRows(0, 5), 0);
    const json = await res.json();
    expect(json.results.blacklisted).toBe(1);
    expect(json.results.importados).toBe(4);
    const calls = countCalls();
    expect(calls["rpc.blacklisted_phone_keys"]).toBe(1);
    expect(calls["blacklist.select"] ?? 0).toBe(0);
  });

  it("blacklist: sem a RPC cai na lista inteira e ainda bloqueia", async () => {
    state.tables.blacklist = [{ id: 1, telefone: phoneOf(1) }];
    state.rpcMissing = true;
    const json = await (await post(makeRows(0, 3), 0)).json();
    expect(json.results.blacklisted).toBe(1);
    expect(json.results.importados).toBe(2);
  });

  it("reenvio do mesmo bloco é idempotente: sem duplicar contatos nem vínculos, sem INSERT linha a linha", async () => {
    const block = makeRows(0, 1500);
    expect((await (await post(block, 0)).json()).linked).toBe(1500);
    expect((await (await post(makeRows(1500, 3000), 1)).json()).linked).toBe(1500);
    state.calls = [];
    const again = await (await post(makeRows(1500, 3000), 1)).json();
    expect(again.linked).toBe(1500);
    expect(state.tables.contacts).toHaveLength(3000);
    expect(state.tables.disp_import_contacts).toHaveLength(3000);
    const calls = countCalls();
    expect(calls["disp_import_contacts.insert"] ?? 0).toBe(0); // nada novo a vincular
    expect(calls["contacts.insert"] ?? 0).toBe(0);
  });
});
