import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AUTO_PAUSE_DEFAULTS, AUTO_PAUSE_META_CODES, autoPauseConfigFromEnv,
  checkCampaignAutoPause, decideAutoPause, decideUncertainPause, isCampaignPermanentError, recentAttempts, type AttemptRow,
} from "./auto-pause";
import { UNCERTAIN_OUTCOME_ERROR } from "./provider-outcome";

const log = vi.hoisted(() => vi.fn());
vi.mock("@/lib/logger", () => ({ writeLog: log }));
const success: AttemptRow = { status: "enviado", erro_permanente: false, erro: null };
const failure = (code: number): AttemptRow => ({ status: "erro", erro_permanente: true, erro: `(#${code}) falha` });
const rows = (errors: number, attempts: number) => [
  ...Array.from({ length: errors }, () => failure(132001)),
  ...Array.from({ length: attempts - errors }, () => success),
];

describe("decisão de pausa", () => {
  it("exige 50 tentativas e 30% de erros, inclusive nos limites", () => {
    expect(decideAutoPause(rows(49, 49)).pause).toBe(false);
    expect(decideAutoPause(rows(14, 50)).pause).toBe(false);
    expect(decideAutoPause(rows(15, 50))).toMatchObject({ pause: true, attempts: 50, errors: 15, percent: 30, topCode: 132001 });
  });
  it("usa só as últimas 100 e ignora tentativas transitórias", () => {
    expect(decideAutoPause([...rows(0, 100), ...rows(100, 100)]).pause).toBe(false);
    expect(decideAutoPause(Array.from({ length: 100 }, () => ({ ...failure(130429), erro_permanente: false }))).attempts).toBe(0);
  });
  it("131026 em erro ou bloqueado não entra no numerador nem causa pausa", () => {
    for (const status of ["erro", "bloqueado"]) {
      const invalid = Array.from({ length: 100 }, () => ({ ...failure(131026), status }));
      expect(decideAutoPause(invalid)).toEqual({ pause: false, attempts: 100, errors: 0 });
    }
    expect(decideAutoPause([...rows(29, 29), ...Array.from({ length: 71 }, () => failure(131026))]).pause).toBe(false);
  });
  it("template pausado (132015) em erro NÃO permanente já conta e pausa, sem esperar a 5ª tentativa (F3)", () => {
    const retryable = (code: number): AttemptRow => ({ status: "erro", erro_permanente: false, erro: `(#${code}) template pausado` });
    const sixtySeven = [...Array.from({ length: 50 }, () => retryable(132015)), ...Array.from({ length: 20 }, () => success)];
    expect(decideAutoPause(sixtySeven)).toMatchObject({ pause: true, attempts: 70, errors: 50, topCode: 132015 });
    // 130429 (limite) não permanente continua fora de tentativas e de erros.
    expect(decideAutoPause(Array.from({ length: 100 }, () => retryable(130429)))).toEqual({ pause: false, attempts: 0, errors: 0 });
  });
  it("env off desliga e parâmetros inválidos usam os padrões", () => {
    const config = autoPauseConfigFromEnv({ DISPARADOR_AUTO_PAUSE: "OFF" });
    expect(decideAutoPause(rows(100, 100), config).pause).toBe(false);
    expect(autoPauseConfigFromEnv({ DISPARADOR_AUTO_PAUSE_WINDOW: "NaN", DISPARADOR_AUTO_PAUSE_ERROR_RATE: "2" })).toEqual(AUTO_PAUSE_DEFAULTS);
    expect(autoPauseConfigFromEnv({ DISPARADOR_AUTO_PAUSE_WINDOW: "20", DISPARADOR_AUTO_PAUSE_MIN_ATTEMPTS: "30", DISPARADOR_AUTO_PAUSE_ERROR_RATE: "0.5" })).toMatchObject({ window: 20, minAttempts: 20, errorRate: 0.5 });
  });
  it("lista fechada de erros de template/canal, sempre permanentes", () => {
    for (const code of AUTO_PAUSE_META_CODES) {
      expect(isCampaignPermanentError(failure(code))).toBe(true);
      // REVISAO F3: código de nível campanha conta mesmo sem erro_permanente (item ainda será retentado).
      expect(isCampaignPermanentError({ ...failure(code), erro_permanente: false })).toBe(true);
    }
    // Sem código de campanha, erro não permanente continua sem contar.
    expect(isCampaignPermanentError({ ...failure(130429), erro_permanente: false })).toBe(false);
    expect(isCampaignPermanentError({ ...failure(0), erro: "Canal não encontrado para esta conta", erro_permanente: false })).toBe(false);
    for (const code of [131026, 131030, 131045, 131021, 131049, 131056, 130429, 131000, 999999])
      expect(isCampaignPermanentError(failure(code))).toBe(false);
    for (const erro of ["Chamada não atendida", "WAHA sendText failed (400): destinatário inválido", "timeout", "Variável {{1}} vazia para este contato — não enviado"])
      expect(isCampaignPermanentError({ ...failure(0), erro })).toBe(false);
    expect(isCampaignPermanentError({ ...failure(0), erro: "Canal Meta sem token de acesso configurado (session_id: canal)" })).toBe(true);
  });
  it("ordena por tentativa efetiva, sem contar leitura tardia como envio novo", () => {
    const old = { ...failure(132001), sent_at: "2026-10-01T12:00:00Z", updated_at: "2026-10-06T13:00:00Z" };
    const sent = { ...success, sent_at: "2026-10-06T12:00:00Z", updated_at: "2026-10-06T12:01:00Z" };
    const rejected = { ...failure(190), sent_at: null, updated_at: "2026-10-06T12:02:00Z" };
    expect(recentAttempts([old, sent, rejected], 2)).toEqual([rejected, sent]);
  });
});

function database(attempts = rows(15, 50), paused = true) {
  const calls: Array<[string, ...unknown[]]> = [];
  const from = vi.fn((table: string) => {
    const builder: Record<string, unknown> = {};
    let sentOnly = false;
    builder.not = (...args: unknown[]) => { sentOnly = true; calls.push(["not", ...args]); return builder; };
    for (const method of ["select", "eq", "limit", "in", "gt", "or", "order", "update", "gte", "is"])
      builder[method] = (...args: unknown[]) => { calls.push([method, ...args]); return builder; };
    builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve({
      data: table === "campaigns" ? [{ status: "em_execucao", auto_pausa_avaliar_desde: "2026-10-06T12:00:00Z" }]
        : sentOnly ? [] : attempts.map((row) => ({ ...row, sent_at: null, updated_at: "2026-10-06T12:01:00Z" })),
      error: null,
    }).then(resolve);
    return builder;
  });
  const rpc = vi.fn().mockResolvedValue({ data: paused, error: null });
  return { db: { from, rpc } as unknown as SupabaseClient, from, rpc, calls };
}

describe("pausa pelo mesmo contrato da pausa manual", () => {
  it("faz RPC, grava motivo e log e corta envios anteriores à retomada", async () => {
    const { db, rpc, calls } = database();
    expect(await checkCampaignAutoPause(db, { id: "camp", account_id: "acc" })).toBe(true);
    expect(rpc).toHaveBeenCalledWith("stop_dispatch_campaign", { p_campaign_id: "camp", p_account_id: "acc", p_action: "pause" });
    expect(calls).toContainEqual(["gte", "sent_at", "2026-10-06T12:00:00Z"]);
    // A consulta inclui erros não permanentes de código de campanha (F3).
    expect(calls.some(([m, f]) => m === "or" && String(f).includes("erro.ilike.*132015*"))).toBe(true);
    expect(calls).toContainEqual(["gte", "updated_at", "2026-10-06T12:00:00Z"]);
    expect(calls).toContainEqual(["order", "updated_at", { ascending: false }]);
    expect(calls).toContainEqual(["update", { pausa_automatica_motivo: expect.stringContaining("30%") }]);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "campaign_auto_paused", account_id: "acc" }));
  });
  it("não grava motivo quando a RPC recusa, nem consulta quando desligado", async () => {
    const { db, from } = database(rows(15, 50), false);
    expect(await checkCampaignAutoPause(db, { id: "camp", account_id: "acc" })).toBe(false);
    expect(from).toHaveBeenCalledTimes(3);
    from.mockClear();
    expect(await checkCampaignAutoPause(db, { id: "camp", account_id: "acc" }, { ...AUTO_PAUSE_DEFAULTS, enabled: false })).toBe(false);
    expect(from).not.toHaveBeenCalled();
  });
});

describe("resultado incerto (502/503/504/timeout) conta para a pausa (P0-3)", () => {
  it("regra pura: pausa a partir de uncertainCount (padrão 20 em 60 s)", () => {
    expect(AUTO_PAUSE_DEFAULTS).toMatchObject({ uncertainCount: 20, uncertainWindowSeconds: 60 });
    expect(decideUncertainPause(19)).toEqual({ pause: false, count: 19 });
    expect(decideUncertainPause(20)).toMatchObject({ pause: true, count: 20, reason: expect.stringContaining("NÃO são reenviados") });
    expect(decideUncertainPause(500, { ...AUTO_PAUSE_DEFAULTS, enabled: false }).pause).toBe(false);
    expect(autoPauseConfigFromEnv({ DISPARADOR_AUTO_PAUSE_UNCERTAIN_COUNT: "5", DISPARADOR_AUTO_PAUSE_UNCERTAIN_WINDOW_SECONDS: "30" }))
      .toMatchObject({ uncertainCount: 5, uncertainWindowSeconds: 30 });
  });

  function uncertainDb(count: number) {
    const calls: Array<[string, ...unknown[]]> = [];
    const from = vi.fn((table: string) => {
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq", "limit", "in", "gt", "or", "order", "update", "gte", "is", "not", "like"])
        builder[method] = (...args: unknown[]) => { calls.push([`${table}.${method}`, ...args]); return builder; };
      builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve(
        table === "campaigns" ? { data: [{ status: "em_execucao", auto_pausa_avaliar_desde: null }], error: null }
          : calls.some(([m]) => m === "disp_message_queue.like") ? { count, data: null, error: null }
          : { data: [], error: null },
      ).then(resolve);
      return builder;
    });
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
    return { db: { from, rpc } as unknown as SupabaseClient, rpc, calls };
  }

  it("20 incertos na janela pausam a campanha e registram o motivo (kind uncertain_outcome)", async () => {
    log.mockClear();
    const { db, rpc, calls } = uncertainDb(20);
    expect(await checkCampaignAutoPause(db, { id: "camp", account_id: "acc" })).toBe(true);
    expect(rpc).toHaveBeenCalledWith("stop_dispatch_campaign", { p_campaign_id: "camp", p_account_id: "acc", p_action: "pause" });
    expect(calls).toContainEqual(["disp_message_queue.like", "erro", `${UNCERTAIN_OUTCOME_ERROR}%`]);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      event: "campaign_auto_paused",
      payload: expect.objectContaining({ kind: "uncertain_outcome", uncertain_count: 20, threshold: 20 }),
    }));
  });

  it("19 incertos não pausam", async () => {
    const { db, rpc } = uncertainDb(19);
    expect(await checkCampaignAutoPause(db, { id: "camp", account_id: "acc" })).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });
});
