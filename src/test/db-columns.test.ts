import { describe, expect, it } from "vitest";

import { assertColumns, assertRowColumns, columnsOf, selectColumns } from "./db-columns";

// PRD 14, 14.12: o mock de banco não aceita mais coluna inventada (#143: phone_number / display_name).

describe("assertColumns", () => {
  it("aceita colunas reais de whatsapp_config e channel_health", () => {
    expect(() => assertColumns("whatsapp_config", "id, display_phone_number, phone_number_id, waha_session, provider, habilitado")).not.toThrow();
    expect(() => assertColumns("channel_health", ["session_id", "verified_name", "quality_rating", "checked_at"])).not.toThrow();
  });

  it("REJEITA as colunas que quebraram o #143", () => {
    expect(() => assertColumns("whatsapp_config", "id, phone_number, display_name")).toThrow(/phone_number, display_name/);
    expect(() => assertColumns("channel_health", ["session_id", "nome_inventado"])).toThrow(/nome_inventado/);
  });

  it("alias e relação do select: conta a coluna real; * e x(...) são ignorados", () => {
    expect(selectColumns("id, nome:display_phone_number, contacts!fk(id,name), *")).toEqual(["id", "display_phone_number"]);
    expect(() => assertColumns("whatsapp_config", "id, nome:display_phone_number, *")).not.toThrow();
    expect(() => assertColumns("whatsapp_config", "id, apelido:coluna_que_nao_existe")).toThrow(/coluna_que_nao_existe/);
  });

  it("tabela sem coluna extraída lança (não aprova tudo em silêncio)", () => {
    expect(columnsOf("tabela_que_nao_existe").size).toBe(0);
    expect(() => assertColumns("tabela_que_nao_existe", "id")).toThrow(/nenhuma coluna/);
  });
});

describe("assertRowColumns", () => {
  it("valida as chaves de cada linha e devolve a MESMA estrutura (uso inline em mocks)", () => {
    const rows = [{ id: "a", provider: "meta" }, { id: "b", habilitado: true }];
    expect(assertRowColumns("whatsapp_config", rows)).toBe(rows);
    const single = { session_id: "s1", quality_rating: "GREEN" };
    expect(assertRowColumns("channel_health", single)).toBe(single);
  });

  it("linha com coluna inexistente derruba o teste na hora", () => {
    expect(() => assertRowColumns("whatsapp_config", [{ id: "a" }, { id: "b", phone_number: "5511" }])).toThrow(/phone_number/);
  });
});
