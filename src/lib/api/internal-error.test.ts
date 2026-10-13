import { describe, expect, it, vi } from "vitest";

import { internalErrorResponse } from "./internal-error";

describe("internalErrorResponse", () => {
  it("500 com mensagem genérica e código; o detalhe do banco só vai para o log do servidor, com a mesma ref", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = internalErrorResponse("automations", { code: "42P01", message: 'relation "wacrm.automations" does not exist' });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({ error: "Erro interno. Tente novamente.", code: "internal_error" });
    expect(body.ref).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.stringify(body)).not.toContain("wacrm");
    expect(log).toHaveBeenCalledWith("[automations]", "42P01", 'relation "wacrm.automations" does not exist', `ref=${body.ref}`);
  });

  it("aceita texto próprio, status e código; nunca devolve a mensagem interna", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = internalErrorResponse("flows", { message: 'duplicate key value violates unique constraint "flows_pkey"' }, { message: "Falha ao salvar o fluxo.", status: 400, code: "flow_save_failed" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ error: "Falha ao salvar o fluxo.", code: "flow_save_failed" });
    expect(JSON.stringify(body)).not.toContain("flows_pkey");
  });

  it("erro nulo ou sem mensagem também responde genérico", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await internalErrorResponse("x", null).json()).error).toBe("Erro interno. Tente novamente.");
    expect(internalErrorResponse("x", undefined, "Texto.").status).toBe(500);
  });

  it("mascara CPF no log (a mensagem do Postgres pode trazer trecho da linha)", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    internalErrorResponse("contacts", { code: "23505", message: "Key (cpf)=(123.456.789-09) already exists." });
    expect(JSON.stringify(log.mock.calls)).not.toContain("123.456.789-09");
  });
});
