import { describe, expect, it } from "vitest";

import {
  PauseApiError,
  buildAgentReport,
  decodePauseCursor,
  encodePauseCursor,
  overlapSeconds,
  parseReasonCreate,
  parseReasonPatch,
  parseReportPeriod,
  pauseSeconds,
  toPauseView,
  type PauseRow,
} from "./pure";

const NOW = Date.parse("2026-10-15T15:00:00Z");
const U1 = "00000000-0000-4000-8000-000000000001";
const U2 = "00000000-0000-4000-8000-000000000002";
const row = (over: Partial<PauseRow> = {}): PauseRow => ({
  id: "00000000-0000-4000-8000-0000000000a1",
  user_id: U1,
  reason_id: null,
  reason_name: "Almoço",
  max_minutes: 60,
  started_at: "2026-10-15T14:00:00Z",
  ended_at: null,
  end_kind: null,
  started_by: U1,
  ended_by: null,
  alerted_at: null,
  ...over,
});
const fails = (fn: () => unknown, code: string, status = 400) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PauseApiError);
    expect((e as PauseApiError).code).toBe(code);
    expect((e as PauseApiError).status).toBe(status);
    return;
  }
  throw new Error("deveria falhar");
};

describe("motivos: validação", () => {
  it("cria: nome 1–40, tempo inteiro 1–1440 ou vazio", () => {
    expect(parseReasonCreate({ name: "  Reunião ", max_minutes: 30 })).toEqual({ name: "Reunião", max_minutes: 30 });
    expect(parseReasonCreate({ name: "Outro" })).toEqual({ name: "Outro", max_minutes: null });
    expect(parseReasonCreate({ name: "Outro", max_minutes: null }).max_minutes).toBeNull();
    for (const bad of [{}, { name: "" }, { name: "   " }, { name: "x".repeat(41) }, { name: "ok", max_minutes: 0 }, { name: "ok", max_minutes: 1441 }, { name: "ok", max_minutes: 1.5 }, { name: "ok", max_minutes: "10" }]) {
      fails(() => parseReasonCreate(bad), "invalid_reason");
    }
    fails(() => parseReasonCreate(null), "invalid_request");
    fails(() => parseReasonCreate([]), "invalid_request");
  });

  it("edita: campos opcionais; null limpa o limite; vazio recusa", () => {
    expect(parseReasonPatch({ max_minutes: null })).toEqual({ max_minutes: null });
    expect(parseReasonPatch({ name: "Novo", active: false, sort_order: 5 })).toEqual({ name: "Novo", active: false, sort_order: 5 });
    fails(() => parseReasonPatch({}), "invalid_reason");
    fails(() => parseReasonPatch({ active: "sim" }), "invalid_reason");
    fails(() => parseReasonPatch({ sort_order: -1 }), "invalid_reason");
  });
});

describe("visão da pausa", () => {
  const names = new Map([[U1, "Ana"], [U2, "Carlos"]]);
  it("tempo decorrido, estouro e quem pausou", () => {
    const v = toPauseView(row(), names, NOW);
    expect(v).toMatchObject({ user_name: "Ana", elapsed_seconds: 3600, exceeded: false, by_supervisor: false, started_by_name: "Ana" });
    expect(toPauseView(row({ started_at: "2026-10-15T13:59:00Z" }), names, NOW).exceeded).toBe(true); // 61 min > 60
    expect(toPauseView(row({ max_minutes: null, started_at: "2026-10-14T00:00:00Z" }), names, NOW).exceeded).toBe(false); // sem limite
    expect(toPauseView(row({ started_by: U2 }), names, NOW)).toMatchObject({ by_supervisor: true, started_by_name: "Carlos" });
  });
  it("pausa encerrada conta até o fim", () => {
    expect(pauseSeconds(row({ ended_at: "2026-10-15T14:10:00Z" }), NOW)).toBe(600);
    expect(pauseSeconds(row({ started_at: "2026-10-15T16:00:00Z" }), NOW)).toBe(0);
  });
});

describe("período do relatório (calendário de Brasília, inclusivo, até 92 dias)", () => {
  it("padrão = últimos 7 dias; ate inclusivo", () => {
    const p = parseReportPeriod(null, null, NOW);
    expect(p.to).toBe("2026-10-15");
    expect(p.from).toBe("2026-10-09");
    expect(p.toMs - p.fromMs).toBe(7 * 86_400_000);
  });
  it("de/ate explícitos; fuso -03:00", () => {
    const p = parseReportPeriod("2026-10-01", "2026-10-01", NOW);
    expect(new Date(p.fromMs).toISOString()).toBe("2026-10-01T03:00:00.000Z");
    expect(p.toMs - p.fromMs).toBe(86_400_000);
  });
  it("recusa data inválida, ate antes de de e mais de 92 dias", () => {
    fails(() => parseReportPeriod("01/10/2026", "2026-10-02", NOW), "invalid_period");
    fails(() => parseReportPeriod("2026-10-05", "2026-10-01", NOW), "invalid_period");
    fails(() => parseReportPeriod("2026-01-01", "2026-10-01", NOW), "invalid_period");
    expect(() => parseReportPeriod("2026-07-02", "2026-10-01", NOW)).not.toThrow(); // 92 dias inclusivos: ok
    fails(() => parseReportPeriod("2026-07-01", "2026-10-01", NOW), "invalid_period"); // 93: recusa
  });
});

describe("relatório por atendente", () => {
  const period = { fromMs: Date.parse("2026-10-15T03:00:00Z"), toMs: Date.parse("2026-10-16T03:00:00Z") };
  const names = new Map([[U1, "Ana"], [U2, "Bia"]]);
  it("soma, média, maior, estouros, por motivo e % do tempo logado", () => {
    const pauses = [
      row({ id: "a", started_at: "2026-10-15T12:00:00Z", ended_at: "2026-10-15T13:10:00Z", max_minutes: 60, end_kind: "manual" }), // 70 min: estourou
      row({ id: "b", reason_name: "Banheiro", max_minutes: 10, started_at: "2026-10-15T13:30:00Z", ended_at: "2026-10-15T13:35:00Z", end_kind: "manual" }), // 5 min
      row({ id: "c", user_id: U2, reason_name: "Outro", max_minutes: null, started_at: "2026-10-15T14:00:00Z", ended_at: "2026-10-15T14:30:00Z", end_kind: "manual" }),
    ];
    const sessions = [{ user_id: U1, logged_in_at: "2026-10-15T10:00:00Z", logged_out_at: "2026-10-15T18:00:00Z" }]; // 8 h
    const out = buildAgentReport(pauses, sessions, names, period, NOW);
    expect(out.map((a) => a.user_id)).toEqual([U1, U2]); // mais tempo em pausa primeiro
    expect(out[0]).toMatchObject({ name: "Ana", pauses: 2, total_seconds: 4500, avg_seconds: 2250, longest_seconds: 4200, exceeded_count: 1, open_count: 0, logged_seconds: 28800, pct_of_logged: 15.63 });
    expect(out[0].by_reason).toEqual([
      { reason_name: "Almoço", pauses: 1, total_seconds: 4200, exceeded_count: 1 },
      { reason_name: "Banheiro", pauses: 1, total_seconds: 300, exceeded_count: 0 },
    ]);
    expect(out[1]).toMatchObject({ pauses: 1, total_seconds: 1800, exceeded_count: 0, logged_seconds: null, pct_of_logged: null });
  });

  it("pausa que cruza o período é recortada; a aberta conta até agora; fora do período não entra", () => {
    const pauses = [
      row({ id: "a", started_at: "2026-10-14T23:00:00Z", ended_at: "2026-10-15T04:00:00Z", end_kind: "manual", max_minutes: null }), // só 1 h dentro (03:00–04:00)
      row({ id: "b", user_id: U2, started_at: "2026-10-15T14:00:00Z", ended_at: null }), // aberta: 1 h até NOW
      row({ id: "c", user_id: U2, started_at: "2026-10-10T10:00:00Z", ended_at: "2026-10-10T11:00:00Z", end_kind: "manual" }), // fora
    ];
    const out = buildAgentReport(pauses, [], names, period, NOW);
    expect(out.find((a) => a.user_id === U1)).toMatchObject({ total_seconds: 3600, pauses: 1 });
    expect(out.find((a) => a.user_id === U2)).toMatchObject({ total_seconds: 3600, pauses: 1, open_count: 1 });
  });

  it("estouro considera a pausa INTEIRA (não só o pedaço do período)", () => {
    const pauses = [row({ id: "a", started_at: "2026-10-14T20:00:00Z", ended_at: "2026-10-15T04:00:00Z", end_kind: "manual", max_minutes: 60 })];
    expect(buildAgentReport(pauses, [], names, period, NOW)[0].exceeded_count).toBe(1);
  });

  it("sessão ainda aberta conta até agora; sem pausas = lista vazia", () => {
    expect(buildAgentReport([], [], names, period, NOW)).toEqual([]);
    const out = buildAgentReport([row({ ended_at: "2026-10-15T14:30:00Z", end_kind: "manual" })], [{ user_id: U1, logged_in_at: "2026-10-15T12:00:00Z", logged_out_at: null }], names, period, NOW);
    expect(out[0].logged_seconds).toBe(3 * 3600);
  });

  it("overlapSeconds", () => {
    expect(overlapSeconds(0, 10_000, 5_000, 20_000)).toBe(5);
    expect(overlapSeconds(0, 1_000, 5_000, 20_000)).toBe(0);
  });
});

describe("cursor do detalhe", () => {
  it("ida e volta; lixo = 400", () => {
    const c = encodePauseCursor({ started_at: "2026-10-15T14:00:00.123456+00:00", id: "00000000-0000-4000-8000-0000000000a1" });
    expect(decodePauseCursor(c)).toEqual(["2026-10-15T14:00:00.123456+00:00", "00000000-0000-4000-8000-0000000000a1"]);
    expect(decodePauseCursor(null)).toBeNull();
    fails(() => decodePauseCursor("lixo"), "invalid_cursor");
    fails(() => decodePauseCursor(Buffer.from(JSON.stringify(["x", "y"])).toString("base64url")), "invalid_cursor");
  });
});
