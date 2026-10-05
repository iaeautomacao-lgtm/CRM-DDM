import { describe, expect, it } from "vitest";
import { computeAudience } from "./audience";

const all = ["a", "b", "c", "d", "e"];

describe("computeAudience", () => {
  it("CSV sem tabulação: só os contatos do import (nunca a conta)", () => {
    const r = computeAudience({ allContactIds: all, importIds: new Set(["a", "b"]), tagIds: null, mode: "csv" });
    expect(r).toMatchObject({ ok: true, source: "csv" });
    if (r.ok) expect([...r.ids]).toEqual(["a", "b"]);
  });

  it("CSV + tabulação: interseção (antes o CSV era ignorado)", () => {
    const r = computeAudience({
      allContactIds: all,
      importIds: new Set(["a", "b", "c"]),
      tagIds: new Set(["b", "c", "e"]),
      mode: "csv",
    });
    expect(r).toMatchObject({ ok: true, source: "csv+tags" });
    if (r.ok) expect([...r.ids]).toEqual(["b", "c"]);
  });

  it("campanha marcada como CSV sem vínculo: erro, não envia para a conta", () => {
    const r = computeAudience({ allContactIds: all, importIds: new Set(), tagIds: null, mode: "csv" });
    expect(r.ok).toBe(false);
    const r2 = computeAudience({ allContactIds: all, importIds: null, tagIds: null, mode: "csv" });
    expect(r2.ok).toBe(false);
  });

  it("só tabulação e conta inteira", () => {
    const tags = computeAudience({ allContactIds: all, importIds: null, tagIds: new Set(["d"]), mode: "tags" });
    expect(tags).toMatchObject({ ok: true, source: "tags" });
    const account = computeAudience({ allContactIds: all, importIds: null, tagIds: null, mode: "account" });
    expect(account).toMatchObject({ ok: true, source: "account" });
    if (account.ok) expect(account.ids.size).toBe(5);
  });

  it("interseção vazia vira erro com a causa", () => {
    const r = computeAudience({ allContactIds: all, importIds: new Set(["a"]), tagIds: new Set(["e"]), mode: "csv" });
    expect(r).toEqual({ ok: false, error: "Nenhum contato do CSV tem as tabulações selecionadas." });
  });

  it("contato do import que não é da conta não entra", () => {
    const r = computeAudience({ allContactIds: all, importIds: new Set(["a", "zz"]), tagIds: null, mode: null });
    if (r.ok) expect([...r.ids]).toEqual(["a"]);
  });
});
