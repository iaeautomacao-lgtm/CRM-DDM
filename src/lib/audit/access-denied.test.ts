import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// PRD 20, 20.8 — `access.denied`: amostragem (por combinação e por conta), gate de ambiente e o formato do evento.

const logAuditEvent = vi.fn(async () => {});
vi.mock("./log-event", () => ({ logAuditEvent: (...a: unknown[]) => (logAuditEvent as unknown as (...x: unknown[]) => unknown)(...a) }));

const { recordAccessDenied, resetAccessDeniedLimits, shouldRecordAccessDenied } = await import("./access-denied");

const ctx = { accountId: "acc-1", userId: "user-1", role: "agent" };
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  resetAccessDeniedLimits();
  logAuditEvent.mockClear();
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
});
afterEach(() => vi.unstubAllEnvs());

describe("shouldRecordAccessDenied (limites)", () => {
  it("a mesma conta+usuário+permissão: 1× a cada 10 min; outra permissão ou outro usuário passam", () => {
    const t0 = 1_000_000;
    expect(shouldRecordAccessDenied("a", "u", "members.manage", t0)).toBe(true);
    expect(shouldRecordAccessDenied("a", "u", "members.manage", t0 + 1_000)).toBe(false);
    expect(shouldRecordAccessDenied("a", "u", "members.manage", t0 + 9 * 60_000)).toBe(false);
    expect(shouldRecordAccessDenied("a", "u", "audit.view", t0 + 1_000)).toBe(true);
    expect(shouldRecordAccessDenied("a", "u2", "members.manage", t0 + 1_000)).toBe(true);
    expect(shouldRecordAccessDenied("a", "u", "members.manage", t0 + 10 * 60_000 + 1)).toBe(true);
  });

  it("teto por conta: 20 por minuto (varredura de permissões não inunda); outra conta não é afetada; volta no minuto seguinte", () => {
    const t0 = 5_000_000;
    let recorded = 0;
    for (let i = 0; i < 50; i++) if (shouldRecordAccessDenied("acc", `u${i}`, "campaigns.manage", t0)) recorded++;
    expect(recorded).toBe(20);
    expect(shouldRecordAccessDenied("outra", "u", "campaigns.manage", t0)).toBe(true);
    expect(shouldRecordAccessDenied("acc", "novo", "campaigns.manage", t0 + 60_001)).toBe(true);
  });
});

describe("recordAccessDenied", () => {
  it("grava o evento com a permissão que faltou, o usuário como recurso e o papel no metadata", async () => {
    recordAccessDenied(ctx, "members.manage");
    await flush();
    expect(logAuditEvent).toHaveBeenCalledTimes(1);
    expect(logAuditEvent).toHaveBeenCalledWith({
      accountId: "acc-1",
      eventType: "action",
      resourceType: "access",
      resourceId: "user-1",
      resourceLabel: "members.manage",
      action: "access.denied",
      summary: "Acesso negado: faltou a permissão members.manage",
      metadata: { permission: "members.manage", role: "agent" },
    });
  });

  it("repetição dentro da janela não grava de novo", async () => {
    recordAccessDenied(ctx, "members.manage");
    recordAccessDenied(ctx, "members.manage");
    recordAccessDenied(ctx, "members.manage");
    await flush();
    expect(logAuditEvent).toHaveBeenCalledTimes(1);
  });

  it("sem o service role configurado (testes/ambiente sem banco) não faz nada", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    recordAccessDenied(ctx, "members.manage");
    await flush();
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it("falha ao gravar nunca lança para quem chamou", async () => {
    logAuditEvent.mockRejectedValueOnce(new Error("banco fora"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => recordAccessDenied(ctx, "audit.view")).not.toThrow();
    await flush();
    await flush();
    spy.mockRestore();
  });
});
