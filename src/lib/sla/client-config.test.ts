import { describe, expect, it } from "vitest";
import { buildSlaConfig, parseSlaMinutes, SLA_FALLBACK_MINUTES } from "./client-config";

describe("buildSlaConfig", () => {
  it("sem resposta (sem migration 381 ou erro): tudo usa 15", () => {
    const cfg = buildSlaConfig(null);
    expect(cfg.defaultMin).toBe(SLA_FALLBACK_MINUTES);
    expect(cfg.limitFor("t1")).toBe(15);
    expect(cfg.limitFor(null)).toBe(15);
    expect(cfg.ownFor("t1")).toBeNull();
  });

  it("equipe usa o efetivo; sem equipe ou equipe desconhecida usa o padrão da conta", () => {
    const cfg = buildSlaConfig({
      default_min: 20,
      default_source: "account",
      teams: { t1: 5, t2: null },
      effective: { t1: 5, t2: 20 },
    });
    expect(cfg.defaultSource).toBe("account");
    expect(cfg.limitFor("t1")).toBe(5);
    expect(cfg.limitFor("t2")).toBe(20);
    expect(cfg.limitFor("outra")).toBe(20);
    expect(cfg.limitFor(undefined)).toBe(20);
    expect(cfg.ownFor("t1")).toBe(5);
    expect(cfg.ownFor("t2")).toBeNull();
  });

  it("valor fora da faixa ou quebrado cai no padrão (nunca limite 0 ou NaN)", () => {
    const cfg = buildSlaConfig({ default_min: 0, effective: { t1: 0, t2: 2000, t3: 1.5 } });
    expect(cfg.defaultMin).toBe(15);
    for (const id of ["t1", "t2", "t3"]) expect(cfg.limitFor(id)).toBe(15);
  });
});

describe("parseSlaMinutes", () => {
  it("vazio = usar padrão", () => {
    expect(parseSlaMinutes("")).toEqual({ ok: true, value: null });
    expect(parseSlaMinutes("  ")).toEqual({ ok: true, value: null });
  });

  it("aceita inteiros de 1 a 1440", () => {
    expect(parseSlaMinutes("1")).toEqual({ ok: true, value: 1 });
    expect(parseSlaMinutes(" 30 ")).toEqual({ ok: true, value: 30 });
    expect(parseSlaMinutes("1440")).toEqual({ ok: true, value: 1440 });
  });

  it("recusa 0, acima de 1440, decimal, negativo e texto", () => {
    for (const bad of ["0", "1441", "2.5", "2,5", "-3", "abc", "1e3", "15min"]) {
      expect(parseSlaMinutes(bad).ok, bad).toBe(false);
    }
  });
});
