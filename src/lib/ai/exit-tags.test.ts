import { describe, expect, it } from "vitest";
import {
  extractAiExitTag,
  normalizeExitTag,
  shouldLegacyAssignHuman,
  stripAiExitTag,
} from "./exit-tags";

describe("AI exit tags", () => {
  it("extracts new structured exit codes", () => {
    expect(extractAiExitTag("Entendi. #RECUSA_CONFIRMADA")).toBe(
      "#RECUSA_CONFIRMADA",
    );
    expect(extractAiExitTag("#RECUPERADO")).toBe("#RECUPERADO");
    expect(extractAiExitTag("ok #OPT_OUT")).toBe("#OPT_OUT");
    expect(extractAiExitTag("#CONTATO_DIVERGENTE")).toBe("#CONTATO_DIVERGENTE");
  });

  it("strips the complete detected tag without leaking suffixes", () => {
    expect(
      stripAiExitTag(
        "Entendi sua decisão. #RECUSA_CONFIRMADA",
        "#RECUSA_CONFIRMADA",
      ),
    ).toBe("Entendi sua decisão.");
  });

  it("ignora # que não é tag de controle", () => {
    expect(extractAiExitTag("Escolha a opção #2 do menu")).toBeNull();
    expect(extractAiExitTag("Seu boleto #123 foi gerado")).toBeNull();
    expect(extractAiExitTag("Aqui é da #DDM, tudo bem?")).toBeNull();
    expect(extractAiExitTag("Fale com a #DDM sobre a opção #2")).toBeNull();
  });

  it("prefere a última tag conhecida", () => {
    expect(extractAiExitTag("#RECUSA ... na verdade #RECUPERADO")).toBe("#RECUPERADO");
    expect(extractAiExitTag("Ok #DDM #EQUIPEHUMANA #XPTO")).toBe("#EQUIPEHUMANA");
  });

  it("aceita tag customizada só quando o fluxo a usa", () => {
    expect(extractAiExitTag("Pronto #MINHA_TAG")).toBeNull();
    expect(extractAiExitTag("Pronto #MINHA_TAG", ["MINHA_TAG"])).toBe("#MINHA_TAG");
    expect(extractAiExitTag("Pronto #MINHA_TAG", ["#minha_tag"])).toBe("#MINHA_TAG");
  });

  it("remove todas as tags de controle e mantém o resto do texto", () => {
    expect(
      stripAiExitTag("Entendi. #RECUSA\nVou te passar. #EQUIPEHUMANA", "#EQUIPEHUMANA"),
    ).toBe("Entendi.\nVou te passar.");
    expect(stripAiExitTag("Opção #2 enviada pela #DDM. #RECUSA", "#RECUSA")).toBe(
      "Opção #2 enviada pela #DDM.",
    );
    expect(
      stripAiExitTag("Acordo ok #ACORDOFORMALIZADO(finalização)", "#ACORDOFORMALIZADO"),
    ).toBe("Acordo ok");
    expect(stripAiExitTag("Fim #MINHA_TAG", "#MINHA_TAG")).toBe("Fim");
  });

  it("normaliza tags configuradas no fluxo", () => {
    expect(normalizeExitTag("recusa")).toBe("#RECUSA");
    expect(normalizeExitTag(" #OPT_OUT ")).toBe("#OPT_OUT");
    expect(normalizeExitTag("123")).toBeNull();
    expect(normalizeExitTag("tem espaço")).toBeNull();
    expect(normalizeExitTag(undefined)).toBeNull();
  });

  it("never assigns a human directly when a Flow Builder node owns routing", () => {
    expect(
      shouldLegacyAssignHuman({
        tag: "#RECUSA",
        flowControlled: true,
        hasAgreedAcordo: false,
      }),
    ).toBe(false);
    expect(
      shouldLegacyAssignHuman({
        tag: "#CLIENTE_PEDIU_HUMANO",
        flowControlled: true,
        hasAgreedAcordo: false,
      }),
    ).toBe(false);
  });

  it("preserves legacy standalone transfer behavior", () => {
    expect(
      shouldLegacyAssignHuman({
        tag: "#RECUSA",
        flowControlled: false,
        hasAgreedAcordo: false,
      }),
    ).toBe(true);
    expect(
      shouldLegacyAssignHuman({
        tag: null,
        flowControlled: false,
        hasAgreedAcordo: true,
      }),
    ).toBe(true);
  });

  it("does not treat recovery success as human handoff", () => {
    expect(
      shouldLegacyAssignHuman({
        tag: "#RECUPERADO",
        flowControlled: false,
        hasAgreedAcordo: false,
      }),
    ).toBe(false);
  });
});
