import { describe, expect, it } from "vitest";
import {
  findVariableProblems,
  placeholderNumbers,
  previewCampaignMessage,
  synthesizeWahaVariableMap,
  type MessagePreview,
  type PreviewableMessage,
} from "./preview-message";

const TODAY = "05/10/2026";

function text(p: MessagePreview): string {
  return p.segments
    .map((s) => (s.kind === "text" ? s.text : s.pending ? `[${s.label}]` : s.empty ? "<vazio>" : s.value))
    .join("");
}

describe("placeholderNumbers", () => {
  it("lista {{n}} distintos em ordem", () => {
    expect(placeholderNumbers("Oi {{2}}, {{1}} e {{2}} {{nome}}")).toEqual([1, 2]);
    expect(placeholderNumbers(undefined)).toEqual([]);
  });
});

describe("synthesizeWahaVariableMap", () => {
  it("aponta {{n}} para as colunas VAR mapeadas (mesma regra do handleSubmit)", () => {
    const input: PreviewableMessage = { conteudo: "Oi {{1}}" };
    const msg = synthesizeWahaVariableMap(input, { phone: "tel", var1: "VAR1" });
    expect(msg.template_variable_map).toEqual([
      { type: "csv_var", index: 0 },
      { type: "static", value: "" },
      { type: "static", value: "" },
    ]);
  });
  it("não mexe em template, mapa existente, texto sem {{ ou CSV sem VAR", () => {
    const tpl = { conteudo: "Oi {{1}}", template_name: "x", template_variable_map: [] };
    expect(synthesizeWahaVariableMap(tpl, { var1: "a" })).toBe(tpl);
    const plain = { conteudo: "Oi" };
    expect(synthesizeWahaVariableMap(plain, { var1: "a" })).toBe(plain);
    const semVar = { conteudo: "Oi {{1}}" };
    expect(synthesizeWahaVariableMap(semVar, { phone: "tel" })).toBe(semVar);
  });
});

describe("previewCampaignMessage — texto (WAHA)", () => {
  const msg = {
    conteudo: "Olá {{nome}}, seu débito é {{1}} — vence {{2}}.",
    template_variable_map: [
      { type: "csv_var" as const, index: 0 as const },
      { type: "csv_var" as const, index: 1 as const },
    ],
  };

  it("substitui {{n}} pelos valores da linha do CSV", () => {
    const p = previewCampaignMessage(msg, { name: "Maria", csvVars: ["R$ 10", "amanhã", ""] }, {
      isMetaChannel: false,
      today: TODAY,
    });
    expect(p.mode).toBe("texto");
    expect(text(p)).toBe("Olá Maria, seu débito é R$ 10 — vence amanhã.");
    expect(p.willSkip).toBe(false);
  });

  it("marca variável vazia e indica que o contato não será enviado", () => {
    const p = previewCampaignMessage(msg, { name: "Maria", csvVars: ["R$ 10", "", ""] }, {
      isMetaChannel: false,
      today: TODAY,
    });
    expect(p.emptyVars).toEqual([2]);
    expect(p.willSkip).toBe(true);
  });

  it("{{n}} sem mapa sai vazio (backend: sem valor mapeado)", () => {
    const p = previewCampaignMessage({ conteudo: "Oi {{1}}" }, { csvVars: ["x"] }, { isMetaChannel: false });
    expect(p.emptyVars).toEqual([1]);
  });

  it("{{empresa}} vazio não bloqueia; {{data_hoje}} usa a data", () => {
    const p = previewCampaignMessage(
      { conteudo: "{{empresa}} {{data_hoje}}" },
      { company: "" },
      { isMetaChannel: false, today: TODAY }
    );
    expect(p.willSkip).toBe(false);
    expect(text(p)).toBe(` ${TODAY}`);
  });

  it("sem CSV: valores de contato ficam pendentes (preenchidos no envio)", () => {
    const p = previewCampaignMessage(msg, {}, { isMetaChannel: false, today: TODAY });
    expect(p.willSkip).toBe(false);
    expect(text(p)).toBe("Olá [nome do contato], seu débito é [VAR1 do CSV] — vence [VAR2 do CSV].");
  });

  it("canal Meta com mensagem sem template segue o caminho de texto", () => {
    const p = previewCampaignMessage(msg, { name: "A", csvVars: ["1", "2"] }, { isMetaChannel: true });
    expect(p.mode).toBe("texto");
  });
});

describe("previewCampaignMessage — template Meta", () => {
  const tpl = {
    conteudo: "Olá {{1}}, pague {{2}}.",
    template_name: "cobranca_1",
    template_variable_map: [
      { type: "contact_field" as const, field: "name" as const },
      { type: "utm_link" as const },
      { type: "static" as const, value: "" },
    ],
  };

  it("usa o corpo do template com as variáveis do contato", () => {
    const p = previewCampaignMessage(
      { ...tpl, template_variable_map: tpl.template_variable_map.slice(0, 2) },
      { name: "João", utmLink: "https://l.ink/a" },
      { isMetaChannel: true }
    );
    expect(p.mode).toBe("template");
    expect(text(p)).toBe("Olá João, pague https://l.ink/a.");
    expect(p.willSkip).toBe(false);
  });

  it("variável vazia fora do corpo também derruba o contato (Meta confere todas)", () => {
    const p = previewCampaignMessage(tpl, { name: "João", utmLink: "x" }, { isMetaChannel: true });
    expect(p.emptyVars).toEqual([3]);
    expect(p.willSkip).toBe(true);
  });

  it("UTM não gerado sai vazio; UTM pendente não", () => {
    const naoGerado = previewCampaignMessage(tpl, { name: "J", utmLink: null }, { isMetaChannel: true });
    expect(naoGerado.emptyVars).toContain(2);
    const pendente = previewCampaignMessage(
      { ...tpl, template_variable_map: tpl.template_variable_map.slice(0, 2) },
      { name: "J" },
      { isMetaChannel: true }
    );
    expect(pendente.willSkip).toBe(false);
  });
});

describe("findVariableProblems", () => {
  it("texto com {{n}} sem coluna VAR mapeada", () => {
    expect(findVariableProblems({ tipo: "texto", conteudo: "Oi {{1}}" }, { columnMap: {}, hasCsv: true })).toHaveLength(1);
    expect(
      findVariableProblems({ tipo: "texto", conteudo: "Oi {{2}}" }, { columnMap: { var1: "VAR1" }, hasCsv: true })[0]
    ).toMatch(/\{\{2\}\}/);
    expect(findVariableProblems({ tipo: "texto", conteudo: "Oi {{1}}" }, { columnMap: { var1: "VAR1" }, hasCsv: true })).toEqual([]);
  });

  it("template com valor fixo vazio ou VAR não mapeada", () => {
    const msg = {
      tipo: "texto",
      conteudo: "Oi {{1}}",
      template_name: "t",
      template_variable_map: [
        { type: "csv_var" as const, index: 0 as const },
        { type: "static" as const, value: " " },
      ],
    };
    const problems = findVariableProblems(msg, { columnMap: {}, hasCsv: true });
    expect(problems).toHaveLength(2);
    // Sem CSV nesta sessão (edição): csv_var é aceito.
    expect(findVariableProblems(msg, { columnMap: {}, hasCsv: false })).toHaveLength(1);
  });

  it("IA e texto sem variáveis não têm problemas", () => {
    expect(findVariableProblems({ tipo: "ia", prompt: "{{1}}" }, { columnMap: {}, hasCsv: false })).toEqual([]);
    expect(findVariableProblems({ tipo: "texto", conteudo: "Oi {{nome}}" }, { columnMap: {}, hasCsv: false })).toEqual([]);
  });
});

describe("placeholder com espaço (texto livre)", () => {
  it("é apontado como problema e não conta como variável", () => {
    const problems = findVariableProblems(
      { tipo: "texto", conteudo: "Olá {{ 1 }}" } as never,
      { columnMap: {} as never, hasCsv: true },
    );
    expect(problems.some((p) => p.includes("sem espaços"))).toBe(true);
    expect(placeholderNumbers("Olá {{ 1 }} e {{2}}")).toEqual([2]);
  });
});
