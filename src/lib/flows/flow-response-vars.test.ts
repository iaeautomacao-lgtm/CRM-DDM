// Revisão de fluxos — a resposta do WhatsApp Flow vai para o run que ENVIOU o formulário (token fr:<run>), com o comportamento de antes como fallback.
import { beforeEach, describe, expect, it } from "vitest";

import { deliverFlowResponse as deliverFlowResponseToActiveRun } from "./flow-response-vars";

const A = "00000000-0000-0000-0000-00000000000a";
const R_OLD = "11111111-1111-4111-8111-111111111111"; // run que enviou o formulário
const R_NEW = "22222222-2222-4222-8222-222222222222"; // run mais recente do mesmo contato
const R_ENDED = "33333333-3333-4333-8333-333333333333";
const R_OTHER_CONTACT = "44444444-4444-4444-8444-444444444444";

type Row = Record<string, unknown>;
let runs: Row[] = [];
let updates: Array<{ id: unknown; vars: unknown }> = [];
let failUpdate = false;

function fakeDb() {
  return {
    from: () => {
      const eqs: Array<[string, unknown]> = [];
      let payload: Row | null = null;
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = (c: string, v: unknown) => (eqs.push([c, v]), b);
      b.order = () => b;
      b.limit = () => b;
      b.update = (p: Row) => ((payload = p), b);
      b.then = (resolve: (v: unknown) => void) => {
        const rows = runs.filter((r) => eqs.every(([c, v]) => r[c] === v)).sort((x, y) => String(y.started_at).localeCompare(String(x.started_at)));
        if (payload) {
          if (failUpdate) return resolve({ data: null, error: { message: "boom" } });
          updates.push({ id: rows[0]?.id, vars: payload.vars });
          return resolve({ data: null, error: null });
        }
        resolve({ data: rows.slice(0, 1).map((r) => ({ id: r.id, vars: r.vars })), error: null });
      };
      return b;
    },
  } as never;
}

const base = { accountId: A, contactId: "C1", vars: { flow_parcelas: "3" } };

describe("deliverFlowResponseToActiveRun", () => {
  beforeEach(() => {
    updates = [];
    failUpdate = false;
    runs = [
      { id: R_OLD, account_id: A, contact_id: "C1", status: "active", started_at: "2026-10-01T10:00:00Z", vars: { nome: "Maria" } },
      { id: R_NEW, account_id: A, contact_id: "C1", status: "active", started_at: "2026-10-02T10:00:00Z", vars: {} },
      { id: R_ENDED, account_id: A, contact_id: "C1", status: "completed", started_at: "2026-09-30T10:00:00Z", vars: {} },
      { id: R_OTHER_CONTACT, account_id: A, contact_id: "C2", status: "active", started_at: "2026-10-03T10:00:00Z", vars: {} },
    ];
  });


  it("token fr:<run>: entrega no run que enviou o formulário, mesmo havendo um run mais recente do contato", async () => {
    expect(await deliverFlowResponseToActiveRun(fakeDb(), { ...base, flowToken: `fr:${R_OLD}` })).toBe("token_run");
    expect(updates).toEqual([{ id: R_OLD, vars: { nome: "Maria", flow_parcelas: "3" } }]);
  });

  it("sem token, token de campanha (dq:) ou token inválido: o run ativo MAIS RECENTE (comportamento de antes)", async () => {
    for (const flowToken of [undefined, `dq:${R_OLD}`, "lixo", 42]) {
      updates = [];
      expect(await deliverFlowResponseToActiveRun(fakeDb(), { ...base, flowToken })).toBe("latest_active");
      expect(updates[0].id).toBe(R_NEW);
    }
  });

  it("o run do token já terminou ou é de OUTRO contato: cai no mais recente ativo (nunca entrega em run de outro contato)", async () => {
    expect(await deliverFlowResponseToActiveRun(fakeDb(), { ...base, flowToken: `fr:${R_ENDED}` })).toBe("latest_active");
    updates = [];
    expect(await deliverFlowResponseToActiveRun(fakeDb(), { ...base, flowToken: `fr:${R_OTHER_CONTACT}` })).toBe("latest_active");
    expect(updates[0].id).toBe(R_NEW);
  });

  it("sem run ativo, sem variáveis ou falha ao gravar ⇒ null (e nunca lança)", async () => {
    runs = [];
    expect(await deliverFlowResponseToActiveRun(fakeDb(), { ...base, flowToken: `fr:${R_OLD}` })).toBeNull();
    expect(await deliverFlowResponseToActiveRun(fakeDb(), { ...base, vars: {} })).toBeNull();
    runs = [{ id: R_OLD, account_id: A, contact_id: "C1", status: "active", started_at: "2026-10-01", vars: {} }];
    failUpdate = true;
    expect(await deliverFlowResponseToActiveRun(fakeDb(), base)).toBeNull();
    expect(await deliverFlowResponseToActiveRun({ from: () => { throw new Error("x"); } } as never, base)).toBeNull();
  });
});

