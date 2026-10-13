import { describe, expect, it, vi } from "vitest";

import { buildSystemHealth, cronLevel, cronLevelFor, loadRequiredMigrations, CRON_LATE_AFTER_S, CRON_STOPPED_AFTER_S } from "./system-health";

const NOW = new Date("2026-10-09T15:00:00Z");
const required = {
  minVersion: 183,
  migrations: [
    { version: "202_schema_migrations_registry", kind: "registry" as const },
    { version: "203_dispatch_export_jobs", kind: "registry" as const },
    { version: "187b_disp_queue_erro_codigo_index", kind: "index" as const, index: "idx_dmq_erro_codigo" },
  ],
};

type Rpc = Record<string, { data?: unknown; error?: { code?: string; message?: string } | null }>;
type HeartbeatRow = { job: string; expected_every_seconds: number; last_ok_at: string | null; last_status: "ok" | "error"; last_error: string | null; runs: number; failures: number };
function fakeDb(rpc: Rpc, tick: { created_at?: string; error?: boolean } = {}, heartbeat: HeartbeatRow[] | "missing" = "missing") {
  return {
    rpc: vi.fn(async (name: string) => ({ data: rpc[name]?.data ?? null, error: rpc[name]?.error ?? null })),
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order"]) b[m] = () => b;
      if (table === "cron_heartbeat") {
        // Migration 334: por padrão ausente (cai no cron_tick, como antes); os testes do D-12 a ligam.
        b.limit = async () => (heartbeat === "missing" ? { data: null, error: { code: "PGRST205", message: "relation does not exist" } } : { data: heartbeat, error: null });
        return b;
      }
      b.limit = async () => (tick.error ? { data: null, error: { message: "x" } } : { data: tick.created_at ? [{ created_at: tick.created_at }] : [], error: null });
      return b;
    },
  } as never;
}
const healthy: Rpc = {
  schema_check_report: { data: { applied: ["202_schema_migrations_registry", "203_dispatch_export_jobs"], indexes: [{ name: "idx_dmq_erro_codigo", valid: true }] } },
  message_inbox_stats: { data: { by_state: { pending: 2, processing: 1, done: 500 }, oldest_pending_seconds: 5, dead: 0, shadow_missing: 0 } },
};

describe("buildSystemHealth", () => {
  it("tudo em ordem: migrations aplicadas, tick recente, fila sem dead ⇒ ok", async () => {
    const h = await buildSystemHealth(fakeDb(healthy, { created_at: "2026-10-09T14:59:30Z" }), { now: NOW, required });
    expect(h).toEqual({
      generated_at: NOW.toISOString(),
      migrations: { available: true, total: 3, applied: 3, missing: [], invalid_indexes: [], ok: true },
      crons: [{ job: "disparador", last_ok_at: "2026-10-09T14:59:30Z", age_s: 30, status: "ok" }],
      inbox: { available: true, pending: 3, oldest_pending_s: 5, dead: 0, shadow_missing: 0, ok: true },
      ok: true,
    });
  });

  it("migration faltando e índice inválido aparecem por versão e derrubam o ok geral", async () => {
    const rpc: Rpc = { ...healthy, schema_check_report: { data: { applied: ["202_schema_migrations_registry"], indexes: [{ name: "idx_dmq_erro_codigo", valid: false }] } } };
    const h = await buildSystemHealth(fakeDb(rpc, { created_at: "2026-10-09T14:59:30Z" }), { now: NOW, required });
    expect(h.migrations).toMatchObject({ available: true, applied: 1, missing: ["203_dispatch_export_jobs"], invalid_indexes: ["187b_disp_queue_erro_codigo_index"], ok: false });
    expect(h.ok).toBe(false);
  });

  it("cron atrasado/parado/nunca rodou", async () => {
    const at = async (ageS: number | null) =>
      (await buildSystemHealth(fakeDb(healthy, ageS === null ? {} : { created_at: new Date(NOW.getTime() - ageS * 1000).toISOString() }), { now: NOW, required })).crons[0];
    expect(await at(CRON_LATE_AFTER_S)).toMatchObject({ status: "ok" });
    expect(await at(CRON_LATE_AFTER_S + 1)).toMatchObject({ status: "atrasado" });
    expect(await at(CRON_STOPPED_AFTER_S + 1)).toMatchObject({ status: "parado" });
    expect(await at(null)).toEqual({ job: "disparador", last_ok_at: null, age_s: null, status: "parado" });
    expect(cronLevel(0)).toBe("ok");
  });

  it("fila de mensagens: dead ou pendente há mais de 60 s ⇒ não ok", async () => {
    const dead = await buildSystemHealth(fakeDb({ ...healthy, message_inbox_stats: { data: { by_state: { dead: 2 }, oldest_pending_seconds: null, dead: 2 } } }, { created_at: "2026-10-09T14:59:30Z" }), { now: NOW, required });
    expect(dead.inbox).toMatchObject({ available: true, dead: 2, ok: false });
    const slow = await buildSystemHealth(fakeDb({ ...healthy, message_inbox_stats: { data: { by_state: { pending: 9 }, oldest_pending_seconds: 61, dead: 0 } } }, { created_at: "2026-10-09T14:59:30Z" }), { now: NOW, required });
    expect(slow.inbox).toMatchObject({ pending: 9, oldest_pending_s: 61, ok: false });
    expect(slow.ok).toBe(false);
  });

  it("cada bloco degrada sozinho com motivo curto: 202/201 ausentes, tabela de logs indisponível, JSON ausente", async () => {
    const missing = { code: "PGRST202", message: "Could not find the function" };
    const h = await buildSystemHealth(fakeDb({ schema_check_report: { error: missing }, message_inbox_stats: { error: missing } }, { error: true }), { now: NOW, required });
    expect(h.migrations).toEqual({ available: false, reason: "migration 202 não aplicada" });
    expect(h.inbox).toEqual({ available: false, reason: "migration 201 não aplicada" });
    expect(h.crons[0].status).toBe("indisponivel");
    expect(h.ok).toBe(true); // dado indisponível não vira alarme falso
    const noJson = await buildSystemHealth(fakeDb(healthy, { created_at: "2026-10-09T14:59:30Z" }), { now: NOW, required: null });
    expect(noJson.migrations).toEqual({ available: false, reason: "required-migrations.json ausente no servidor" });
    const boom = await buildSystemHealth(fakeDb({ schema_check_report: { error: { code: "XX000", message: "db down senha=abc" } }, message_inbox_stats: healthy.message_inbox_stats }, { created_at: "2026-10-09T14:59:30Z" }), { now: NOW, required });
    expect(boom.migrations).toEqual({ available: false, reason: "falha ao ler o registro de migrations" });
    expect(JSON.stringify(boom)).not.toContain("senha");
  });

  it("lê o required-migrations.json real do repositório", () => {
    const real = loadRequiredMigrations();
    expect(real?.minVersion).toBe(183);
    expect(real!.migrations.length).toBeGreaterThan(10);
    expect(loadRequiredMigrations("/nao/existe")).toBeNull();
  });
});

describe("D-12: batimento de todos os crons (migration 334)", () => {
  const hb = (job: string, ageS: number | null, over: Partial<HeartbeatRow> = {}): HeartbeatRow => ({
    job, expected_every_seconds: 60, last_ok_at: ageS === null ? null : new Date(NOW.getTime() - ageS * 1000).toISOString(),
    last_status: "ok", last_error: null, runs: 100, failures: 0, ...over,
  });
  const health = (rows: HeartbeatRow[]) => buildSystemHealth(fakeDb(healthy, { created_at: "2026-10-09T14:59:30Z" }, rows), { now: NOW, required });

  it("lista todos os jobs conhecidos; quem nunca registrou fica 'indisponivel' (não é alarme)", async () => {
    const h = await health([hb("disparador_tick", 20), hb("billing", 30)]);
    const byJob = Object.fromEntries(h.crons.map((c) => [c.job, c]));
    expect(Object.keys(byJob)).toEqual(expect.arrayContaining(["disparador_tick", "disparador_prepare", "disparador_health", "disparador_exports", "disparador_imports", "automations", "flows", "webhooks_out", "billing", "channels_refresh_tokens", "conversations_retry_assignment"]));
    expect(byJob.disparador_tick).toMatchObject({ status: "ok", age_s: 20, label: "Disparador (tick de envio)", expected_every_s: 60 })
    expect(byJob.automations).toMatchObject({ status: "indisponivel", last_ok_at: null });
    expect(h.ok).toBe(true);
  });

  it("cron que parou aparece como atrasado e depois parado, pela cadência de cada job", async () => {
    const h = await health([hb("disparador_prepare", 200), hb("webhooks_out", 700), hb("disparador_health", 700, { expected_every_seconds: 600 }), hb("channels_refresh_tokens", 20 * 3600, { expected_every_seconds: 86_400 })]);
    const byJob = Object.fromEntries(h.crons.map((c) => [c.job, c.status]));
    expect(byJob.disparador_prepare).toBe("atrasado"); // 200 s > 180 s
    expect(byJob.webhooks_out).toBe("parado"); // 700 s > 600 s
    expect(byJob.disparador_health).toBe("ok"); // 700 s < 1.500 s (2,5 ciclos de 10 min)
    expect(byJob.channels_refresh_tokens).toBe("ok"); // 20 h de um job diário
    expect(h.ok).toBe(false);
  });

  it("cron que só falha envelhece pelo ÚLTIMO OK (mesmo 'rodando'); o erro aparece sem vazar além do texto curto", async () => {
    const h = await health([hb("billing", 900, { last_status: "error", last_error: "HTTP 503", failures: 40 })]);
    const billing = h.crons.find((c) => c.job === "billing")!;
    expect(billing).toMatchObject({ status: "parado", last_status: "error", last_error: "HTTP 503", failures: 40 });
  });

  it("job que nunca teve um OK (só erros) fica parado", async () => {
    const h = await health([hb("flows", null, { last_status: "error", last_error: "HTTP 500", expected_every_seconds: 300 })]);
    expect(h.crons.find((c) => c.job === "flows")).toMatchObject({ status: "parado", last_ok_at: null });
  });

  it("cronLevelFor mantém os limiares antigos para 1 min e escala com a cadência", () => {
    expect(cronLevelFor(CRON_LATE_AFTER_S, 60)).toBe("ok");
    expect(cronLevelFor(CRON_LATE_AFTER_S + 1, 60)).toBe("atrasado");
    expect(cronLevelFor(CRON_STOPPED_AFTER_S + 1, 60)).toBe("parado");
    expect(cronLevelFor(null, 60)).toBe("parado");
    expect(cronLevelFor(3600, 86_400)).toBe("ok");
  });
});
