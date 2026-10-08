// Supabase em memória para os testes da importação de contatos (copiado do fake de route.load.test.ts — o teste de carga
// segue com o dele). Cada chamada a createImportFake() devolve um banco ISOLADO.
/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

export function createImportFake() {
  const state = { tables: {} as Record<string, Row[]>, calls: [] as string[], seq: 0, rpcMissing: false };
  const LATENCY_MS = 0;
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
    lt(c: string, v: any) { filters.push((r) => String(r[c]) < String(v)); return b; },
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
            // Como o PostgREST: devolve as linhas ATUALIZADAS (reavaliar os filtros depois do UPDATE perderia as que mudaram de estado).
            const hit = match();
            for (const r of hit) Object.assign(r, payload);
            data = hit;
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
  

  const client = {
    from: (table: string) => makeBuilder(table),
    rpc: async (fn: string, args: Record<string, any>) => {
      state.calls.push(`rpc.${fn}`);
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
  };

  return { state, client };
}
