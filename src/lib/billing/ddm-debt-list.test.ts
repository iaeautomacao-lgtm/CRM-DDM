// PRD 21.4 — lista de dívidas ativas da DDM para o Data Exchange (mesma consulta localiza_dev da régua).
import { describe, expect, it, vi } from "vitest";

import { DebtSourceError } from "./debt-source";
import { interpretDebtList, listDdmDebts } from "./ddm-source";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("interpretDebtList", () => {
  it("id = iddev:sistema; rótulo = apelido → instituição → sistema; ignora sem id e repetidas", () => {
    expect(
      interpretDebtList([
        { iddev: 1, sistema: "cruzeiro", apelido: "Cruzeiro do Sul" },
        { iddev: 1, sistema: "cruzeiro" }, // repetida
        { iddev: 2, sistema: "outra", instituicao: "Outra Inst." },
        { iddev: 3, sistema: "x" },
        { iddev: 4 }, // sem sistema
        null,
      ]),
    ).toEqual([
      { external_ref: "1:cruzeiro", label: "Cruzeiro do Sul" },
      { external_ref: "2:outra", label: "Outra Inst." },
      { external_ref: "3:x", label: "x" },
    ]);
    expect(interpretDebtList([])).toEqual([]);
  });

  it("formato inesperado vira erro", () => {
    for (const bad of [null, {}, "ok", { erro: "token" }]) expect(() => interpretDebtList(bad)).toThrow(DebtSourceError);
  });
});

describe("listDdmDebts", () => {
  it("consulta pelo CPF só em dígitos e devolve a lista; token/CPF nunca aparecem no erro", async () => {
    const fetcher = vi.fn(async () => json([{ iddev: 9, sistema: "s", apelido: "A" }]));
    expect(await listDdmDebts("123.456.789-09", { token: "TOK", fetcher })).toEqual([{ external_ref: "9:s", label: "A" }]);
    expect((fetcher.mock.calls[0] as unknown as [string])[0]).toContain("cpf=12345678909");

    const boom = vi.fn(async () => json({}, 500));
    const err = await listDdmDebts("12345678909", { token: "TOK", fetcher: boom }).catch((e) => e);
    expect(err).toBeInstanceOf(DebtSourceError);
    expect(String(err.message)).not.toMatch(/TOK|12345678909/);
    await expect(listDdmDebts("123", { token: "TOK", fetcher })).rejects.toThrow(DebtSourceError); // CPF inválido
    await expect(listDdmDebts("12345678909", { token: null, fetcher })).rejects.toThrow(DebtSourceError); // sem token
  });

  it("respeita o teto de consultas da conta (allow=false ⇒ nem chama a DDM)", async () => {
    const fetcher = vi.fn(async () => json([]));
    await expect(listDdmDebts("12345678909", { token: "T", fetcher, allow: async () => false })).rejects.toThrow(DebtSourceError);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
