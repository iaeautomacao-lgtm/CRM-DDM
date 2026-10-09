import { describe, expect, it, vi } from "vitest";

import { internalErrorResponse } from "./internal-error";

describe("internalErrorResponse", () => {
  it("500 com mensagem genérica; o detalhe do banco só vai para o log do servidor", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = internalErrorResponse("automations", { code: "42P01", message: 'relation "wacrm.automations" does not exist' });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "Erro interno. Tente novamente." });
    expect(JSON.stringify(body)).not.toContain("wacrm");
    expect(log).toHaveBeenCalledWith("[automations]", "42P01", 'relation "wacrm.automations" does not exist');
  });
});
