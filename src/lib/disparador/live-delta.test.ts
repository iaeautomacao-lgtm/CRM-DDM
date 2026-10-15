import { describe, expect, it } from "vitest";

import { applyDeltaToLive, applyDeltaToMetrics, applyDeltaToSnapshot, latencyMs, livePollMs, parseLiveDelta } from "./live-delta";

const payload = { ts: "2026-10-15T12:00:00.000Z", campaigns: { c1: { total_enviados: 2, total_erros: 1, lixo: 9 }, c2: { total_lidos: 3 }, c3: {} } };

describe("parseLiveDelta", () => {
  it("lê o payload do broadcast (com ou sem o envelope {payload}) e ignora campo desconhecido/vazio", () => {
    const d = parseLiveDelta({ event: "delta", payload })!;
    expect(d.campaigns).toEqual({ c1: { total_enviados: 2, total_erros: 1 }, c2: { total_lidos: 3 } });
    expect(d.ts).toBe(Date.parse("2026-10-15T12:00:00.000Z"));
    expect(parseLiveDelta(payload)).toEqual(d);
  });
  it("lixo devolve null", () => {
    for (const bad of [null, undefined, 1, {}, { campaigns: 3 }, { campaigns: { a: { x: 1 } } }]) expect(parseLiveDelta(bad)).toBeNull();
  });
});

describe("applyDeltaToLive", () => {
  const live = { queued: 10, sending: 1, errors: 0, blocked: 0, remaining: 11, sentLast60s: 5, extra: "x" };
  it("enviados/erros saem de em voo e depois da fila; erros e vazão sobem", () => {
    const next = applyDeltaToLive(live, parseLiveDelta(payload)!, new Set(["c1"]));
    expect(next).toMatchObject({ sending: 0, queued: 8, remaining: 8, errors: 1, sentLast60s: 7, blocked: 0, extra: "x" });
  });
  it("só conta as campanhas pedidas; sem efeito devolve o mesmo objeto", () => {
    const d = parseLiveDelta(payload)!;
    expect(applyDeltaToLive(live, d, new Set(["outra"]))).toBe(live);
    expect(applyDeltaToLive(live, d, new Set(["c2"]))).toBe(live);
  });
  it("a fila nunca fica negativa", () => {
    const next = applyDeltaToLive({ ...live, queued: 0, sending: 0, remaining: 0 }, parseLiveDelta(payload)!);
    expect(next.queued).toBe(0);
    expect(next.sentLast60s).toBe(7);
  });
});

describe("applyDeltaToMetrics / latência / ritmo", () => {
  it("soma os campos da campanha certa e não mexe nas outras", () => {
    const m = { total_enviados: 10, total_entregues: 0, total_lidos: 0, total_respostas: 0, total_blacklist: 0, total_erros: 0, outro: 1 };
    expect(applyDeltaToMetrics(m, "c1", parseLiveDelta(payload)!)).toMatchObject({ total_enviados: 12, total_erros: 1, outro: 1 });
    expect(applyDeltaToMetrics(m, "zzz", parseLiveDelta(payload)!)).toBe(m);
  });
  it("latência = agora − ts (ms); relógio adiantado ou sem ts = null", () => {
    const d = parseLiveDelta(payload)!;
    expect(latencyMs(d, d.ts! + 120)).toBe(120);
    expect(latencyMs(d, d.ts! - 5)).toBeNull();
    expect(latencyMs({ ts: null, campaigns: {} })).toBeNull();
  });
  it("com o canal ao vivo reconcilia a cada 45 s; sem ele, a cada 3 s", () => {
    expect(livePollMs(true)).toBe(45_000);
    expect(livePollMs(false)).toBe(3_000);
    expect(livePollMs(true, 10_000)).toBe(10_000);
  });
});

describe("applyDeltaToSnapshot", () => {
  const snap = {
    generatedAt: "x",
    totals: { queueRemaining: 50, sentPerMin: 9 },
    campaigns: [
      { id: "c1", total: 100, sent: 40, errors: 5, blocked: 5, remaining: 50, progressPct: 50 },
      { id: "c9", total: 10, sent: 0, errors: 0, blocked: 0, remaining: 10, progressPct: 0 },
    ],
  };
  it("atualiza só a campanha do delta (sent, errors, restante, progresso) e o total da fila; taxas ficam", () => {
    const next = applyDeltaToSnapshot(snap, parseLiveDelta(payload)!);
    expect(next.campaigns[0]).toMatchObject({ sent: 42, errors: 6, remaining: 47, progressPct: 53 });
    expect(next.campaigns[1]).toBe(snap.campaigns[1]);
    expect(next.totals).toEqual({ queueRemaining: 47, sentPerMin: 9 });
  });
  it("delta de campanha que não está no painel não muda nada (mesmo objeto)", () => {
    expect(applyDeltaToSnapshot(snap, parseLiveDelta({ campaigns: { zzz: { total_enviados: 1 } } })!)).toBe(snap);
  });
});
