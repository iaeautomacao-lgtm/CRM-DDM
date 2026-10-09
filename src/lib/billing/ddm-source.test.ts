import { describe, expect, it, vi } from "vitest";

import { DebtSourceError, normalizeDocument, parseMoneyToCents, stopReasonFor } from "./debt-source";
import { createDdmDebtSource, externalRefOf, interpretLocaliza, resolveDdmToken } from "./ddm-source";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const CPF = "123.456.789-01";

describe("interpretLocaliza (função pura)", () => {
  it("lista vazia = sem dívida ativa ⇒ paid (premissa do dono, sinalizada)", () => {
    expect(interpretLocaliza([])).toEqual({ state: "paid", flags: { no_debt_found: true } });
  });

  it("dívida na lista ⇒ open; sem referência, qualquer item vale", () => {
    expect(interpretLocaliza([{ iddev: 7, sistema: "cruzeiro" }])).toEqual({ state: "open", flags: { no_debt_found: false } });
    expect(interpretLocaliza([{ iddev: 7, sistema: "cruzeiro" }], "7:cruzeiro").state).toBe("open");
  });

  it("a dívida pedida sumiu mas há outras do CPF ⇒ paid só dela", () => {
    expect(interpretLocaliza([{ iddev: 8, sistema: "cruzeiro" }], "7:cruzeiro")).toEqual({ state: "paid", flags: { no_debt_found: true } });
  });

  it("formato inesperado vira erro (nunca 'open' por engano)", () => {
    for (const bad of [null, {}, { erro: "token inválido" }, "ok", 42]) {
      expect(() => interpretLocaliza(bad)).toThrow(DebtSourceError);
    }
  });

  it("externalRefOf exige iddev e sistema", () => {
    expect(externalRefOf({ iddev: 7, sistema: "x" })).toBe("7:x");
    expect(externalRefOf({ iddev: 7 })).toBeNull();
  });
});

describe("createDdmDebtSource", () => {
  const source = (fetcher: (u: string, i: { signal: AbortSignal }) => Promise<Response>, extra: Record<string, unknown> = {}) =>
    createDdmDebtSource({ fetcher, token: "tk-secreto", ...extra });

  it("chama localiza_dev com o CPF só em dígitos e o token codificado; nome estável 'ddm'", async () => {
    const fetcher = vi.fn(async () => json([{ iddev: 1, sistema: "s" }]));
    const s = source(fetcher);
    expect(s.name).toBe("ddm");
    expect(await s.getStatus({ cpf: CPF, externalRef: "1:s" })).toEqual({ state: "open", flags: { no_debt_found: false } });
    const [url] = fetcher.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://www.ddmacordos.com/calc/localiza_dev.php?tk=tk-secreto&cpf=12345678901");
  });

  it("quitada: lista vazia ⇒ paid", async () => {
    expect((await source(async () => json([])).getStatus({ cpf: CPF })).state).toBe("paid");
  });

  it.each([[500, true], [503, true], [429, true], [408, true], [401, false], [403, false], [404, false]])("HTTP %i ⇒ erro (retryable=%s), sem URL/token/CPF na mensagem", async (status, retryable) => {
    const err = await source(async () => new Response("segredo tk-secreto 12345678901", { status })).getStatus({ cpf: CPF }).catch((e) => e);
    expect(err).toBeInstanceOf(DebtSourceError);
    expect(err.retryable).toBe(retryable);
    expect(err.message).toBe(`API DDM respondeu HTTP ${status}`);
    expect(err.message).not.toMatch(/tk-secreto|12345678901|ddmacordos/);
  });

  it("rede, timeout e JSON ruim viram erro genérico", async () => {
    const net = await source(async () => { throw new Error("ECONNRESET https://www.ddmacordos.com/?tk=tk-secreto&cpf=12345678901"); }).getStatus({ cpf: CPF }).catch((e) => e);
    expect(net.message).toBe("Falha de rede na API DDM");
    const timeout = await source(async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); }).getStatus({ cpf: CPF }).catch((e) => e);
    expect(timeout.message).toBe("Tempo esgotado na API DDM");
    const bad = await source(async () => new Response("<html>", { status: 200 })).getStatus({ cpf: CPF }).catch((e) => e);
    expect(bad).toMatchObject({ message: "Resposta da DDM não é JSON", retryable: false });
  });

  it("documento inválido e token ausente não chegam à rede", async () => {
    const fetcher = vi.fn();
    await expect(source(fetcher as never).getStatus({ cpf: "123" })).rejects.toMatchObject({ message: "Documento do devedor inválido", retryable: false });
    await expect(createDdmDebtSource({ fetcher: fetcher as never, token: null }).getStatus({ cpf: CPF })).rejects.toMatchObject({ message: "Token da API DDM não configurado" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("limite de consultas por conta: estourou ⇒ erro retryable e nenhuma chamada à DDM", async () => {
    const fetcher = vi.fn(async () => json([]));
    const allow = vi.fn(async () => false);
    const err = await source(fetcher, { allow }).getStatus({ cpf: CPF }).catch((e) => e);
    expect(err).toBeInstanceOf(DebtSourceError);
    expect(err.retryable).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("passa um AbortSignal com timeout", async () => {
    const fetcher = vi.fn(async (_u: string, init: { signal: AbortSignal }) => (init.signal.aborted ? json([]) : json([])));
    await source(fetcher).getStatus({ cpf: CPF });
    expect(((fetcher.mock.calls[0] as unknown as [string, { signal: AbortSignal }])[1]).signal).toBeInstanceOf(AbortSignal);
  });
});

describe("token e utilitários", () => {
  it("resolveDdmToken segue a mesma ordem do responder e ignora vazio", () => {
    expect(resolveDdmToken({ DDM_ACORDOS_API_TOKEN: " a ", DDM_TOKEN: "b" } as never)).toBe("a");
    expect(resolveDdmToken({ DDM_ACORDOS_API_TOKEN: "  ", DDM_TOKEN: "b" } as never)).toBe("b");
    expect(resolveDdmToken({ DDM_API_KEY: "c" } as never)).toBe("c");
    expect(resolveDdmToken({} as never)).toBeNull();
  });

  it("normalizeDocument, parseMoneyToCents e stopReasonFor", () => {
    expect(normalizeDocument("123.456.789-01")).toBe("12345678901");
    expect(normalizeDocument("12.345.678/0001-95")).toBe("12345678000195");
    expect(normalizeDocument("123")).toBeNull();
    expect(parseMoneyToCents("1.234,56")).toBe(123456);
    expect(parseMoneyToCents("150")).toBe(15000);
    expect(parseMoneyToCents(12.5)).toBe(1250);
    expect(parseMoneyToCents("abc")).toBeNull();
    expect(parseMoneyToCents(-1)).toBeNull();
    expect(stopReasonFor("paid")).toBe("paid");
    expect(stopReasonFor("agreement")).toBe("agreement");
    expect(stopReasonFor("cancelled")).toBe("cancelled");
    expect(stopReasonFor("open")).toBeNull();
    expect(stopReasonFor("unknown")).toBeNull();
  });
});

describe("ddmAllowance (teto por conta)", () => {
  it("libera até o limite por minuto e depois nega; contas não se misturam", async () => {
    const { __setSharedBackendForTests } = await import("@/lib/rate-limit");
    __setSharedBackendForTests(null); // só o Map do processo
    const { ddmAllowance } = await import("./ddm-source");
    const a = ddmAllowance("conta-a-teste", 2);
    expect([await a(), await a(), await a()]).toEqual([true, true, false]);
    expect(await ddmAllowance("conta-b-teste", 2)()).toBe(true);
    __setSharedBackendForTests(undefined);
  });
});
