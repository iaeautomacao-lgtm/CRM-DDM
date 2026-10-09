// PRD 21.3 — template com botão FLOW no disparador: token por envio, linha do template em cache e Flow PUBLISHED (FLOW-03).
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  flowButtonsOf,
  flowPublishProblems,
  flowTokenForQueueItem,
  loadFlowTemplate,
  queueItemIdFromFlowToken,
  resetFlowButtonCaches,
} from "./flow-button";

vi.mock("@/lib/whatsapp/encryption", () => ({ decryptStoredSecret: (v: string) => (v === "ruim" ? (() => { throw new Error("x"); })() : `tok:${v}`) }));
vi.mock("@/lib/whatsapp/meta-api", () => ({ getFlowStatus: vi.fn() }));

const A = "00000000-0000-0000-0000-00000000000a";
const Q = "11111111-1111-4111-8111-111111111111";

type Row = Record<string, unknown>;
let tables: Record<string, Row[]> = {};
let reads: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
let failRead = false;

function fakeDb() {
  return {
    from: (table: string) => {
      const eqs: Array<[string, unknown]> = [];
      const ins: Array<[string, unknown[]]> = [];
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = (c: string, v: unknown) => (eqs.push([c, v]), b);
      b.in = (c: string, v: unknown[]) => (ins.push([c, v]), b);
      b.limit = () => b;
      b.then = (resolve: (v: unknown) => void) => {
        reads.push({ table, filters: eqs });
        if (failRead) return resolve({ data: null, error: { message: "boom" } });
        const rows = (tables[table] ?? []).filter((r) => eqs.every(([c, v]) => r[c] === v) && ins.every(([c, v]) => v.includes(r[c])));
        resolve({ data: rows, error: null });
      };
      return b;
    },
  } as never;
}

const flowTpl = (over: Row = {}): Row => ({
  id: "T1", account_id: A, name: "cobranca_flow", language: "pt_BR", status: "APPROVED", waba_id: "W1", body_text: "Olá {{1}}",
  buttons: [{ type: "FLOW", text: "Negociar", flow_id: "F1" }], ...over,
});

beforeEach(() => {
  resetFlowButtonCaches();
  reads = [];
  failRead = false;
  tables = {
    message_templates: [flowTpl()],
    whatsapp_config: [{ id: "CH1", account_id: A, access_token: "abc" }, { id: "CH2", account_id: A, access_token: "ruim" }, { id: "CH3", account_id: A, access_token: null }],
  };
});

describe("flow_token por envio", () => {
  it("dq:<id do item>; ida e volta; outros formatos não viram id de fila", () => {
    expect(flowTokenForQueueItem(Q)).toBe(`dq:${Q}`);
    expect(queueItemIdFromFlowToken(`dq:${Q}`)).toBe(Q);
    expect(queueItemIdFromFlowToken("dq:xyz")).toBeNull();
    expect(queueItemIdFromFlowToken(Q)).toBeNull();
    expect(queueItemIdFromFlowToken(undefined)).toBeNull();
  });

  it("flowButtonsOf acha só os botões FLOW (sem diferenciar maiúsculas)", () => {
    expect(flowButtonsOf([{ type: "URL" }, { type: "flow" }, { type: "FLOW" }])).toHaveLength(2);
    expect(flowButtonsOf(null)).toEqual([]);
  });
});

describe("loadFlowTemplate", () => {
  it("devolve a linha APROVADA da WABA do canal quando o template tem botão FLOW; filtra por conta, nome, idioma e WABA", async () => {
    const row = await loadFlowTemplate(fakeDb(), A, "W1", "cobranca_flow", "pt_BR");
    expect(row?.id).toBe("T1");
    expect(reads[0].filters).toEqual([["account_id", A], ["name", "cobranca_flow"], ["language", "pt_BR"], ["status", "APPROVED"], ["waba_id", "W1"]]);
  });

  it("template sem botão FLOW ⇒ null (o envio segue o caminho de sempre); e o resultado fica em cache (1 consulta só)", async () => {
    tables.message_templates = [flowTpl({ buttons: [{ type: "QUICK_REPLY", text: "ok" }] })];
    expect(await loadFlowTemplate(fakeDb(), A, "W1", "cobranca_flow", "pt_BR", 1000)).toBeNull();
    expect(await loadFlowTemplate(fakeDb(), A, "W1", "cobranca_flow", "pt_BR", 2000)).toBeNull();
    expect(reads).toHaveLength(1);
    await loadFlowTemplate(fakeDb(), A, "W1", "cobranca_flow", "pt_BR", 1000 + 6 * 60_000); // TTL de 5 min vencido
    expect(reads).toHaveLength(2);
  });

  it("template de outra WABA ou outra conta não vale; erro de leitura ⇒ null e NÃO fica em cache", async () => {
    expect(await loadFlowTemplate(fakeDb(), A, "W2", "cobranca_flow", "pt_BR")).toBeNull();
    expect(await loadFlowTemplate(fakeDb(), "outra", "W1", "cobranca_flow", "pt_BR")).toBeNull();
    failRead = true;
    expect(await loadFlowTemplate(fakeDb(), A, "W1", "cobranca_flow", "pt_BR", 5)).toBeNull();
    failRead = false;
    expect((await loadFlowTemplate(fakeDb(), A, "W1", "cobranca_flow", "pt_BR", 6))?.id).toBe("T1");
  });
});

describe("flowPublishProblems (FLOW-03)", () => {
  const rows = () => tables.message_templates as never[];

  it("Flow PUBLISHED ⇒ sem problema; confere com o token do canal", async () => {
    const getStatus = vi.fn(async () => ({ status: "published" }));
    expect(await flowPublishProblems(fakeDb(), A, ["CH1"], rows(), { getStatus })).toEqual([]);
    expect(getStatus).toHaveBeenCalledWith({ flowId: "F1", accessToken: "tok:abc" });
  });

  it("Flow em DRAFT ⇒ problema que cita o código 131009; em cache por 60 s (uma chamada à Meta)", async () => {
    const getStatus = vi.fn(async () => ({ status: "DRAFT" }));
    let t = 1_000;
    const deps = { getStatus, now: () => t };
    const p1 = await flowPublishProblems(fakeDb(), A, ["CH1"], rows(), deps);
    expect(p1[0]).toMatch(/DRAFT.*não PUBLISHED.*131009/);
    await flowPublishProblems(fakeDb(), A, ["CH1"], rows(), deps);
    expect(getStatus).toHaveBeenCalledTimes(1);
    t += 61_000;
    await flowPublishProblems(fakeDb(), A, ["CH1"], rows(), deps);
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it("falha FECHADO: Graph API fora do ar ⇒ a campanha não começa; nunca 'assume publicado'", async () => {
    const getStatus = vi.fn(async () => {
      throw new Error("timeout");
    });
    const p = await flowPublishProblems(fakeDb(), A, ["CH1"], rows(), { getStatus });
    expect(p[0]).toMatch(/não foi possível confirmar/);
  });

  it("canal sem token (ou token ilegível) e botão sem flow_id ⇒ problema; template sem FLOW, não aprovado ou sem canal ⇒ nada a conferir", async () => {
    const getStatus = vi.fn(async () => ({ status: "PUBLISHED" }));
    expect((await flowPublishProblems(fakeDb(), A, ["CH2"], rows(), { getStatus }))[0]).toMatch(/token de acesso legível/);
    expect((await flowPublishProblems(fakeDb(), A, ["CH3"], rows(), { getStatus }))[0]).toMatch(/token de acesso legível/);
    const semId = [flowTpl({ buttons: [{ type: "FLOW", text: "x", flow_name: "so_nome" }] })] as never[];
    expect((await flowPublishProblems(fakeDb(), A, ["CH1"], semId, { getStatus }))[0]).toMatch(/sem o id do Flow/);
    expect(await flowPublishProblems(fakeDb(), A, ["CH1"], [flowTpl({ buttons: [{ type: "URL" }] })] as never[], { getStatus })).toEqual([]);
    expect(await flowPublishProblems(fakeDb(), A, ["CH1"], [flowTpl({ status: "PENDING" })] as never[], { getStatus })).toEqual([]);
    expect(await flowPublishProblems(fakeDb(), A, [], rows(), { getStatus })).toEqual([]);
    expect(getStatus).not.toHaveBeenCalled();
  });

  it("erro ao ler os canais ⇒ problema (fecha), não passa", async () => {
    failRead = true;
    const p = await flowPublishProblems(fakeDb(), A, ["CH1"], rows(), { getStatus: vi.fn() });
    expect(p[0]).toMatch(/Não foi possível ler os canais/);
  });
});
