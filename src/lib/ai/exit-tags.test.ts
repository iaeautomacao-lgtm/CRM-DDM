import { describe, expect, it } from "vitest";
import {
  extractAiExitTag,
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
