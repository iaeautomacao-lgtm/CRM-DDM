// queue-details: com filtro só por status a página sai SEM `count: exact` e o total vem da agregação por status
// (A20/A21). Busca por contato continua contando exato. Formato da resposta inalterado.
import { beforeEach, describe, expect, it, vi } from "vitest";

const selects: Array<{ table: string; columns: string; options: unknown }> = [];
let statusRows: Array<{ status: string; qty: number }> = [];
let rpcError = false;
/** Fila "grande": cada página do export devolve 1000 linhas (para o teto da exportação síncrona). */
let bigQueueRows = 0;

vi.mock("@/lib/disparador/route-auth", () => ({ requireDisparadorAccess: async () => ({ accountId: "acc-1", userId: "u1" }) }));
vi.mock("@/lib/audit/log-event", () => ({ logAuditEvent: async () => {} }));
vi.mock("@/lib/disparador/admin-client", () => ({
  supabaseAdmin: () => ({
    rpc: async (fn: string) => {
      if (fn !== "get_campaign_stats" || rpcError) return { data: null, error: { message: "indisponível" } };
      return { data: statusRows.map((r) => ({ campaign_id: "camp-1", ...r })), error: null };
    },
    from: (table: string) => {
      const b: any = {};
      const chain = () => b;
      for (const m of ["eq", "in", "or", "not", "order", "ilike", "gte", "lte", "is", "neq"]) b[m] = chain;
      b.select = (columns: string, options?: unknown) => {
        selects.push({ table, columns, options });
        return b;
      };
      b.maybeSingle = async () => ({ data: { id: "camp-1", account_id: "acc-1", import_draft_id: null }, error: null });
      b.range = () => b;
      b.then = (resolve: (v: unknown) => void) => {
        const opts = selects[selects.length - 1]?.options as { head?: boolean; count?: string } | undefined;
        // Como o PostgREST: só devolve count quando foi pedido.
        if (table === "disp_message_queue") {
          const data = opts?.head ? null : bigQueueRows > 0 ? Array.from({ length: 1000 }, (_, i) => ({ id: `q${i}`, status: "enviado", contacts: { name: "N", phone: "1" } })) : [];
          return resolve({ data, error: null, count: opts?.count ? 7 : null });
        }
        return resolve({ data: [], error: null });
      };
      return b;
    },
  }),
}));

const { GET } = await import("./route");
const call = (qs: string) => GET(new Request(`http://x/api/disparador/campaigns/camp-1/queue-details?${qs}`), { params: Promise.resolve({ id: "camp-1" }) });
const queuePageSelects = () => selects.filter((s) => s.table === "disp_message_queue");

beforeEach(() => {
  bigQueueRows = 0;
  selects.length = 0;
  rpcError = false;
  statusRows = [
    { status: "agendado", qty: 40 },
    { status: "enviado", qty: 10 },
    { status: "entregue", qty: 25 },
    { status: "lido", qty: 5 },
    { status: "erro", qty: 3 },
  ];
});

describe("GET queue-details — total sem count exact", () => {
  it("filtro por status: página sem count; total = soma dos status da métrica (mesmo número do card)", async () => {
    const res = await call("status=enviado&page=2&pageSize=20");
    const body = (await res.json()) as { total: number; page: number; pageSize: number; rows: unknown[] };
    expect(body).toMatchObject({ total: 40, page: 2, pageSize: 20, rows: [] }); // enviado+entregue+lido = 10+25+5
    expect(queuePageSelects().every((s) => !(s.options as { count?: string } | undefined)?.count)).toBe(true);
  });

  it("'total' soma todos os status; 'erro' só os erros", async () => {
    expect(((await (await call("status=total")).json()) as { total: number }).total).toBe(83);
    expect(((await (await call("status=erro")).json()) as { total: number }).total).toBe(3);
  });

  it("agregação indisponível: último recurso é o count exato de antes (nunca total errado)", async () => {
    rpcError = true;
    const res = await call("status=erro");
    expect(((await res.json()) as { total: number }).total).toBe(7);
    expect(queuePageSelects().some((s) => (s.options as { count?: string } | undefined)?.count === "exact")).toBe(true);
  });

  it("'respondido' e 'aguardando_confirmacao' (filtros próprios) seguem com count exato", async () => {
    await call("status=aguardando_confirmacao");
    expect(queuePageSelects().some((s) => (s.options as { count?: string } | undefined)?.count === "exact")).toBe(true);
  });
});

describe("GET queue-details?export=xlsx — teto da exportação síncrona (A22)", () => {
  it("fila grande (mais de 10.000 linhas): 409 com o código e o endpoint do job; nada de XLSX gigante na requisição", async () => {
    bigQueueRows = 1;
    const res = await call("status=enviado&export=xlsx");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "export_too_large", async_endpoint: "/api/disparador/exports", max_sync_rows: 10000 });
  });

  it("fila pequena: segue gerando o XLSX na hora", async () => {
    const res = await call("status=enviado&export=xlsx");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("spreadsheetml");
  });
});
