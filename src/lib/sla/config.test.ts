import { describe, expect, it } from "vitest";
import { DEFAULT_SLA_CONFIG, SLA_FALLBACK_MINUTES, effectiveByTeam, effectiveSlaMinutes, isValidSlaMinutes, slaMinutesOrNull } from "./config";
import { loadSlaConfig } from "./load";

describe("regras do SLA (ponto único)", () => {
  it("faixa 1..1440, só inteiros", () => {
    for (const ok of [1, 15, 1440]) expect(isValidSlaMinutes(ok)).toBe(true);
    for (const bad of [0, -1, 1441, 1.5, NaN, "15", null, undefined, true]) expect(isValidSlaMinutes(bad)).toBe(false);
    expect(slaMinutesOrNull(30)).toBe(30);
    expect(slaMinutesOrNull(9999)).toBeNull(); // lixo no banco cai no próximo nível
  });
  it("precedência: equipe > padrão da conta > 15", () => {
    expect(SLA_FALLBACK_MINUTES).toBe(15);
    const config = { defaultMin: 20, defaultSource: "account" as const, teams: { a: 45, b: null } };
    expect(effectiveSlaMinutes(config, "a")).toBe(45);
    expect(effectiveSlaMinutes(config, "b")).toBe(20);
    expect(effectiveSlaMinutes(config, "desconhecida")).toBe(20);
    expect(effectiveSlaMinutes(config, null)).toBe(20);
    expect(effectiveSlaMinutes(DEFAULT_SLA_CONFIG, "a")).toBe(15);
    expect(effectiveByTeam(config)).toEqual({ a: 45, b: 20 });
  });
});

type Reply = { data?: unknown; error?: { code?: string } | null };
function fakeDb(replies: { account_settings?: Reply; teams?: Reply }, calls: Array<[string, unknown[]]> = []) {
  return {
    from: (table: "account_settings" | "teams") => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "limit"]) b[m] = () => b;
      b.eq = (...a: unknown[]) => {
        calls.push([table, a]);
        return b;
      };
      b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: replies[table]?.data ?? [], error: replies[table]?.error ?? null }).then(ok);
      return b;
    },
  } as never;
}

describe("loadSlaConfig", () => {
  it("lê o padrão da conta e o valor próprio de cada equipe, sempre filtrando pela conta", async () => {
    const calls: Array<[string, unknown[]]> = [];
    const db = fakeDb({ account_settings: { data: [{ value: 25 }] }, teams: { data: [{ id: "t1", first_response_sla_min: 40 }, { id: "t2", first_response_sla_min: null }] } }, calls);
    expect(await loadSlaConfig(db, "acc-1")).toEqual({ defaultMin: 25, defaultSource: "account", teams: { t1: 40, t2: null } });
    expect(calls.filter(([, a]) => a[0] === "account_id" && a[1] === "acc-1")).toHaveLength(2);
  });
  it("sem configuração ou com valor inválido gravado: 15", async () => {
    expect(await loadSlaConfig(fakeDb({ teams: { data: [{ id: "t1", first_response_sla_min: 0 }] } }), "a")).toEqual({ defaultMin: 15, defaultSource: "default", teams: { t1: null } });
    expect((await loadSlaConfig(fakeDb({ account_settings: { data: [{ value: 5000 }] } }), "a")).defaultMin).toBe(15);
    expect((await loadSlaConfig(fakeDb({ account_settings: { data: [{ value: null }] } }), "a")).defaultSource).toBe("default");
  });
  it("sem a migration 381 (coluna) ou a 231 (tabela): tolera e usa 15 para todos", async () => {
    expect(await loadSlaConfig(fakeDb({ teams: { error: { code: "42703" } } }), "a")).toEqual({ defaultMin: 15, defaultSource: "default", teams: {} });
    expect(await loadSlaConfig(fakeDb({ account_settings: { error: { code: "42P01" } }, teams: { data: [{ id: "t", first_response_sla_min: 10 }] } }), "a")).toEqual({ defaultMin: 15, defaultSource: "default", teams: { t: 10 } });
  });
  it("exceção na leitura nunca quebra o painel", async () => {
    const boom = { from: () => { throw new Error("rede"); } } as never;
    expect(await loadSlaConfig(boom, "a")).toEqual({ defaultMin: 15, defaultSource: "default", teams: {} });
  });
});
