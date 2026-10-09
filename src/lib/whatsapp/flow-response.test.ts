// PRD 21, PR-21.1 — parser da resposta de WhatsApp Flow (nfm_reply) e variáveis entregues ao fluxo.
import { describe, expect, it } from "vitest";

import { deliverFlowResponseToActiveRun } from "@/lib/flows/flow-response-vars";

import { flowResponseVars, MAX_RESPONSE_JSON_CHARS, parseNfmReply } from "./flow-response";

describe("parseNfmReply", () => {
  it("payload oficial: preserva o JSON decodificado e deixa o texto legível", () => {
    const out = parseNfmReply({
      name: "renegociacao",
      body: "Opção selecionada",
      response_json: '{"parcelas":3,"valor":150.00,"vencimento":"2026-10-25","flow_token":"tok-1"}',
    });
    expect(out.flowName).toBe("renegociacao");
    expect(out.data).toEqual({ parcelas: 3, valor: 150, vencimento: "2026-10-25", flow_token: "tok-1" });
    expect(out.issue).toBeNull();
    expect(out.text).toBe("Opção selecionada: parcelas: 3; valor: 150; vencimento: 2026-10-25"); // flow_token fica fora do texto
  });

  it("sem body usa o rótulo padrão", () => {
    expect(parseNfmReply({ response_json: '{"ok":true}' }).text).toBe("Formulário respondido: ok: true");
  });

  it("JSON inválido não perde a mensagem: texto legível e issue, sem data", () => {
    const out = parseNfmReply({ name: "x", body: "Enviado", response_json: "{parcelas:" });
    expect(out).toMatchObject({ data: null, issue: "invalid_json", text: "Enviado" });
  });

  it("vazio, array e valor simples não viram data", () => {
    expect(parseNfmReply({ response_json: "" })).toMatchObject({ data: null, issue: "empty" });
    expect(parseNfmReply(undefined)).toMatchObject({ data: null, issue: "empty", text: "Formulário respondido" });
    expect(parseNfmReply({ response_json: "[1,2]" })).toMatchObject({ data: null, issue: "not_object" });
    expect(parseNfmReply({ response_json: '"texto"' })).toMatchObject({ data: null, issue: "not_object" });
  });

  it("resposta enorme não é parseada (teto)", () => {
    const big = JSON.stringify({ a: "x".repeat(MAX_RESPONSE_JSON_CHARS) });
    expect(parseNfmReply({ response_json: big })).toMatchObject({ data: null, issue: "too_large" });
  });

  it("texto da conversa tem teto e ignora objetos aninhados", () => {
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`campo${i}`, "v".repeat(200)]));
    const out = parseNfmReply({ response_json: JSON.stringify({ ...many, aninhado: { a: 1 } }) });
    expect(out.text.length).toBeLessThanOrEqual(500);
    expect(out.text).not.toContain("aninhado");
  });
});

describe("flowResponseVars", () => {
  it("gera flow_name, flow_response_json e flow_<campo> (chaves seguras para {{vars.x}})", () => {
    const parsed = parseNfmReply({ name: "renegociacao", response_json: '{"num parcelas":3,"data-vencimento":"2026-10-20","flow_token":"t","obj":{"a":1}}' });
    expect(flowResponseVars(parsed)).toEqual({
      flow_name: "renegociacao",
      flow_response_json: expect.stringContaining('"num parcelas":3'),
      flow_num_parcelas: "3",
      flow_data_vencimento: "2026-10-20",
    });
  });

  it("sem data devolve só o nome do flow", () => {
    expect(flowResponseVars(parseNfmReply({ name: "f", response_json: "lixo" }))).toEqual({ flow_name: "f" });
  });
});

describe("deliverFlowResponseToActiveRun", () => {
  function fakeDb(rows: unknown[] | null, opts: { selectError?: boolean; updateError?: boolean } = {}) {
    const updates: unknown[] = [];
    const db = {
      from: () => {
        const b: Record<string, unknown> = {};
        for (const m of ["select", "eq", "order", "limit"]) b[m] = () => b;
        b.update = (payload: unknown) => {
          updates.push(payload);
          return { eq: async () => ({ error: opts.updateError ? { message: "x" } : null }) };
        };
        b.then = (resolve: (v: unknown) => void) => resolve({ data: rows, error: opts.selectError ? { message: "x" } : null });
        return b;
      },
    };
    return { db: db as never, updates };
  }
  const input = { accountId: "A", contactId: "C", vars: { flow_parcelas: "3" } };

  it("mescla nas variáveis do run ativo sem apagar as existentes", async () => {
    const { db, updates } = fakeDb([{ id: "run-1", vars: { nome: "Maria" } }]);
    expect(await deliverFlowResponseToActiveRun(db, input)).toBe(true);
    expect(updates).toEqual([{ vars: { nome: "Maria", flow_parcelas: "3" } }]);
  });

  it("sem run ativo, sem variáveis ou com erro de banco: false e nunca lança", async () => {
    expect(await deliverFlowResponseToActiveRun(fakeDb([]).db, input)).toBe(false);
    expect(await deliverFlowResponseToActiveRun(fakeDb([{ id: "r", vars: {} }]).db, { ...input, vars: {} })).toBe(false);
    expect(await deliverFlowResponseToActiveRun(fakeDb(null, { selectError: true }).db, input)).toBe(false);
    expect(await deliverFlowResponseToActiveRun(fakeDb([{ id: "r", vars: {} }], { updateError: true }).db, input)).toBe(false);
    expect(await deliverFlowResponseToActiveRun({ from: () => { throw new Error("boom"); } } as never, input)).toBe(false);
  });
});
