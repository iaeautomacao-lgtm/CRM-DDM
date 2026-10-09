import { describe, expect, it, vi } from "vitest";

import { buildSystemHealth, cronLevel, loadRequiredMigrations, CRON_LATE_AFTER_S, CRON_STOPPED_AFTER_S } from "./system-health";

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
function fakeDb(rpc: Rpc, tick: { created_at?: string; error?: boolean } = {}) {
  return {
    rpc: vi.fn(async (name: string) => ({ data: rpc[name]?.data ?? null, error: rpc[name]?.error ?? null })),
    from: () => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order"]) b[m] = () => b;
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
