import { describe, expect, it } from "vitest";
import { isBuilderDirty, type DirtyComparable } from "./dirty";

const base: DirtyComparable = {
  name: "Boas-vindas",
  description: null,
  trigger_type: "new_conversation",
  trigger_config: { keywords: ["oi"] },
  is_active: false,
  line_ids: ["b", "a"],
  steps: [{ cid: "s1", step_type: "send_message", step_config: { text: "Olá" } }],
};

describe("isBuilderDirty", () => {
  it("é falso para o mesmo estado, mesmo com a ordem das linhas diferente", () => {
    expect(isBuilderDirty(base, { ...base, line_ids: ["a", "b"] })).toBe(false);
  });

  it("trata null e vazio igual na descrição", () => {
    expect(isBuilderDirty(base, { ...base, description: "" })).toBe(false);
  });

  it("detecta mudança de nome, gatilho, ativação, linhas e etapas", () => {
    expect(isBuilderDirty(base, { ...base, name: "Outro" })).toBe(true);
    expect(isBuilderDirty(base, { ...base, trigger_config: { keywords: ["olá"] } })).toBe(true);
    expect(isBuilderDirty(base, { ...base, is_active: true })).toBe(true);
    expect(isBuilderDirty(base, { ...base, line_ids: ["a"] })).toBe(true);
    expect(isBuilderDirty(base, { ...base, steps: [] })).toBe(true);
  });
});
