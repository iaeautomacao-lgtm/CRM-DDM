// PRD 21.4 — handler de dados DDM do Data Exchange: token → conta/contato → dívidas da DDM; nada de proposta/desconto/efetivação.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDdmFlowDataHandler, ensureDdmFlowDataHandler, resetDdmFlowDataRegistration } from "./flows-data-ddm";
import { FLOW_UNAVAILABLE_MESSAGE, handleFlowData } from "./flows-data";

const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
const CH = "00000000-0000-4000-8000-0000000000c1";
const RUN = "11111111-1111-4111-8111-111111111111";
const ITEM = "22222222-2222-4222-8222-222222222222";
const RUN_B = "33333333-3333-4333-8333-333333333333";
const RUN_C2 = "44444444-4444-4444-8444-444444444444";

type Row = Record<string, unknown>;
let tables: Record<string, Row[]> = {};
let reads: string[] = [];

function fakeDb() {
  return {
    from: (table: string) => {
      const eqs: Array<[string, unknown]> = [];
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = (c: string, v: unknown) => (eqs.push([c, v]), b);
      b.limit = () => b;
      b.then = (resolve: (v: unknown) => void) => {
        reads.push(table);
        resolve({ data: (tables[table] ?? []).filter((r) => eqs.every(([c, v]) => r[c] === v)), error: null });
      };
      return b;
    },
  } as never;
}

const ctx = { accountId: A, channelId: CH };
const req = (over: Record<string, unknown> = {}) => ({ action: "INIT", flow_token: `fr:${RUN}`, screen: "SELECAO", version: "3.0", ...over });
const debts = [{ external_ref: "10:cruzeiro", label: "Cruzeiro" }, { external_ref: "11:outra", label: "" }];

beforeEach(() => {
  reads = [];
  resetDdmFlowDataRegistration();
  tables = {
    flow_runs: [
      { id: RUN, account_id: A, contact_id: "C1", vars: { _flow_screen: "TELA_INICIAL" } },
      { id: RUN_B, account_id: B, contact_id: "C9", vars: {} },
      { id: RUN_C2, account_id: A, contact_id: "C2", vars: {} },
    ],
    disp_message_queue: [{ id: ITEM, account_id: A, contact_id: "C1" }],
    contacts: [
      { id: "C1", account_id: A, cpf: "123.456.789-09" },
      { id: "C2", account_id: A, cpf: null },
      { id: "C9", account_id: B, cpf: "98765432100" },
    ],
  };
});

describe("createDdmFlowDataHandler", () => {
  it("INIT com token do run: dados neutros da DDM (has_debt, debts_count, debts {id,title}) usando só os dígitos do CPF", async () => {
    const listDebts = vi.fn(async () => debts);
    const out = await createDdmFlowDataHandler({ db: fakeDb, listDebts })(req(), ctx);
    expect(out).toEqual({ screen: "SELECAO", data: { has_debt: true, debts_count: 2, debts: [{ id: "10:cruzeiro", title: "Cruzeiro" }, { id: "11:outra", title: "11:outra" }] } });
    expect(listDebts).toHaveBeenCalledWith(A, "12345678909");
  });

  it("não inventa proposta: nenhum campo de desconto/parcela/valor/acordo na resposta", async () => {
    const out = await createDdmFlowDataHandler({ db: fakeDb, listDebts: async () => debts })(req(), ctx);
    expect(JSON.stringify(out)).not.toMatch(/desconto|parcela|valor|acordo|entrada|efetiv/i);
  });

  it("token do item da fila (template do disparador) também resolve; sem tela no pedido usa a tela do nó", async () => {
    const h = createDdmFlowDataHandler({ db: fakeDb, listDebts: async () => debts });
    expect(await h(req({ flow_token: `dq:${ITEM}` }), ctx)).toMatchObject({ screen: "SELECAO" });
    expect(await h(req({ screen: undefined }), ctx)).toMatchObject({ screen: "TELA_INICIAL" });
    expect(await h(req({ screen: undefined, flow_token: `dq:${ITEM}` }), ctx)).toBeNull(); // sem tela para responder: erro padrão
  });

  it("token de OUTRA conta, inexistente ou que não é nosso ⇒ null (erro padrão), sem consultar a DDM", async () => {
    const listDebts = vi.fn(async () => debts);
    const h = createDdmFlowDataHandler({ db: fakeDb, listDebts });
    expect(await h(req({ flow_token: `fr:${RUN_B}` }), ctx)).toBeNull();
    expect(await h(req({ flow_token: "fr:99999999-9999-4999-8999-999999999999" }), ctx)).toBeNull();
    expect(await h(req({ flow_token: "qualquer" }), ctx)).toBeNull();
    expect(await h(req({ action: "ping" }), ctx)).toBeNull();
    expect(listDebts).not.toHaveBeenCalled();
  });

  it("contato sem CPF ⇒ has_debt false + lookup no_document (sem consultar a DDM)", async () => {
    const listDebts = vi.fn();
    const out = await createDdmFlowDataHandler({ db: fakeDb, listDebts })(req({ flow_token: `fr:${RUN_C2}` }), ctx);
    expect(out).toEqual({ screen: "SELECAO", data: { has_debt: false, debts_count: 0, debts: [], lookup: "no_document" } });
    expect(listDebts).not.toHaveBeenCalled();
  });

  it("DDM fora do ar ⇒ erro padrão da tela (nunca valor inventado) e a falha não vira exceção", async () => {
    const out = await createDdmFlowDataHandler({
      db: fakeDb,
      listDebts: async () => {
        throw new Error("ddm");
      },
    })(req(), ctx);
    expect(out).toEqual({ screen: "SELECAO", data: { error_message: FLOW_UNAVAILABLE_MESSAGE } });
  });

  it("cache de 5 min por contato (telas seguintes não repetem a consulta) e expira depois", async () => {
    const listDebts = vi.fn(async () => debts);
    let t = 0;
    const h = createDdmFlowDataHandler({ db: fakeDb, listDebts, now: () => t });
    await h(req(), ctx);
    t += 60_000;
    await h(req({ action: "data_exchange" }), ctx);
    expect(listDebts).toHaveBeenCalledTimes(1);
    t += 5 * 60_000;
    await h(req(), ctx);
    expect(listDebts).toHaveBeenCalledTimes(2);
  });
});

describe("registro no despacho", () => {
  it("ensureDdmFlowDataHandler registra uma vez; token que não é nosso cai no erro padrão sem tocar no banco", async () => {
    ensureDdmFlowDataHandler(fakeDb as never);
    ensureDdmFlowDataHandler(fakeDb as never);
    const bad = await handleFlowData(req({ flow_token: "xx" }), ctx);
    expect(bad.response).toEqual({ screen: "SELECAO", data: { error_message: FLOW_UNAVAILABLE_MESSAGE } });
    expect(reads).toEqual([]);
  });
});
