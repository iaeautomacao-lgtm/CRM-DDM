import { describe, expect, it } from "vitest";

import { parseUtmBatchBody } from "./utm-body";

const ok = {
  canal: "whatsapp",
  campanha: "Black Friday",
  url_destino: "https://exemplo.com.br/pagar",
  alunos: ["12345678901"],
};

describe("parseUtmBatchBody", () => {
  it("aceita o corpo que o wizard envia e descarta campos extras", () => {
    expect(parseUtmBatchBody({ ...ok, extra: "x" })).toEqual(ok);
  });

  it("recusa corpo ausente ou não objeto", () => {
    expect(parseUtmBatchBody(null)).toBeNull();
    expect(parseUtmBatchBody("x")).toBeNull();
  });

  it("recusa url_destino que não é http(s)", () => {
    expect(parseUtmBatchBody({ ...ok, url_destino: "file:///etc/passwd" })).toBeNull();
    expect(parseUtmBatchBody({ ...ok, url_destino: "javascript:alert(1)" })).toBeNull();
    expect(parseUtmBatchBody({ ...ok, url_destino: "sem-esquema" })).toBeNull();
  });

  it("recusa alunos vazio, grande demais ou com item inválido", () => {
    expect(parseUtmBatchBody({ ...ok, alunos: [] })).toBeNull();
    expect(parseUtmBatchBody({ ...ok, alunos: [1] })).toBeNull();
    expect(parseUtmBatchBody({ ...ok, alunos: Array.from({ length: 5001 }, () => "1") })).toBeNull();
  });

  it("recusa campanha/canal vazios ou longos demais", () => {
    expect(parseUtmBatchBody({ ...ok, campanha: " " })).toBeNull();
    expect(parseUtmBatchBody({ ...ok, campanha: "a".repeat(201) })).toBeNull();
    expect(parseUtmBatchBody({ ...ok, canal: "" })).toBeNull();
  });
});
