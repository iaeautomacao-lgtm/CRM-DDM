import { describe, expect, it } from "vitest";
import { maskPersonalData, maskPersonalText } from "./mask";

describe("maskPersonalText", () => {
  it("mascara CPF formatado e sem formatação, mantendo os 2 últimos dígitos", () => {
    expect(maskPersonalText("meu cpf é 123.456.789-12 ok")).toBe("meu cpf é ***.***.***-12 ok");
    expect(maskPersonalText("cpf 12345678912")).toBe("cpf ***.***.***-12");
  });

  it("mascara CNPJ", () => {
    expect(maskPersonalText("CNPJ 12.345.678/0001-90")).toBe("CNPJ **.***.***/****-90");
    expect(maskPersonalText("12345678000190")).toBe("**.***.***/****-90");
  });

  it("mascara telefones mantendo DDI, DDD e os 4 últimos", () => {
    expect(maskPersonalText("liga +55 (11) 91234-5678")).toBe("liga +55 11 9****-5678");
    expect(maskPersonalText("(11) 91234-5678")).toBe("11 9****-5678");
    expect(maskPersonalText("11 91234-5678")).toBe("11 9****-5678");
    expect(maskPersonalText("5511912345678")).toBe("+55 11 9****-5678");
    expect(maskPersonalText("+5511912345678")).toBe("+55 11 9****-5678");
    expect(maskPersonalText("fixo 1132345678")).toBe("fixo 11 ****-5678");
    expect(maskPersonalText("91234-5678")).toBe("9****-5678");
  });

  it("não toca em UUIDs, datas ISO, valores e textos comuns", () => {
    const keep = [
      "00000000-0000-4000-8000-000000000123",
      "12345678-1234-4000-8000-123456789012",
      "2026-10-05T15:00:00.000Z",
      "R$ 1.234,56 em 3x",
      "acordo 2026",
      "wacrm_live_12345678901",
    ];
    for (const s of keep) expect(maskPersonalText(s), s).toBe(s);
  });
});

describe("maskPersonalData", () => {
  it("percorre objetos e listas, sem mexer em números nem chaves", () => {
    const input = {
      total: 12345678912,
      messages: [{ text: "cpf 123.456.789-12", at: "2026-10-05T15:00:00.000Z" }],
      notes: ["tel (11) 91234-5678"],
      nothing: null,
    };
    expect(maskPersonalData(input)).toEqual({
      total: 12345678912,
      messages: [{ text: "cpf ***.***.***-12", at: "2026-10-05T15:00:00.000Z" }],
      notes: ["tel 11 9****-5678"],
      nothing: null,
    });
  });
});
