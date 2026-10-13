// Falha de autenticação de webhook → system_logs, amostrada e sem segredo (revisão de segurança 13/10).
import { beforeEach, describe, expect, it, vi } from "vitest";

const writeLog = vi.hoisted(() => vi.fn<(p: unknown) => Promise<undefined>>(async () => undefined));
vi.mock("@/lib/logger", () => ({ writeLog: (p: unknown) => writeLog(p) }));

const { __resetWebhookRejectionLogForTests, logWebhookRejection, shouldLogWebhookRejection } = await import("./webhook-rejection-log");

beforeEach(() => {
  writeLog.mockClear();
  __resetWebhookRejectionLogForTests();
});

describe("logWebhookRejection", () => {
  it("registra origem e motivo, sem segredo nem assinatura", () => {
    logWebhookRejection("webhook_meta", "malformed_signature");
    expect(writeLog).toHaveBeenCalledWith({
      level: "warn",
      source: "webhook_meta",
      event: "webhook_auth_rejected",
      message: "Webhook recusado: assinatura ausente ou mal formada",
      payload: { reason: "malformed_signature" },
    });
  });

  it("Instagram/Messenger sai como webhook_meta com via meta_social; WAHA com o canal", () => {
    logWebhookRejection("webhook_meta_social", "invalid_signature");
    logWebhookRejection("webhook_waha", "invalid_channel_secret", { channel: "cfg-1" });
    expect(writeLog.mock.calls[0][0]).toMatchObject({ source: "webhook_meta", payload: { reason: "invalid_signature", via: "meta_social" } });
    expect(writeLog.mock.calls[1][0]).toMatchObject({ source: "webhook_waha", payload: { reason: "invalid_channel_secret", channel: "cfg-1" } });
  });

  it("amostragem: 1 por minuto por origem+motivo+canal", () => {
    for (let i = 0; i < 50; i++) logWebhookRejection("webhook_waha", "invalid_legacy_secret");
    expect(writeLog).toHaveBeenCalledTimes(1);
    expect(shouldLogWebhookRejection("k", 0)).toBe(true);
    expect(shouldLogWebhookRejection("k", 59_000)).toBe(false);
    expect(shouldLogWebhookRejection("k", 61_000)).toBe(true);
  });
});
