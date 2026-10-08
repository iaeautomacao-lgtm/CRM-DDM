import { describe, expect, it, vi } from "vitest";
import { kickDispatchCron } from "./dispatch-kick";
import { resolveCronBaseUrl } from "./tick-chain";

describe("kickDispatchCron", () => {
  it("dispara o POST do cron imediatamente", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://crm.test/api/disparador/cron");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("x-cron-secret")).toBe("secret");
      return new Response(JSON.stringify({ status: "processed" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await kickDispatchCron({
      baseUrl: "https://crm.test",
      secret: "secret",
      fetchImpl,
      retryDelaysMs: [0],
    });

    expect(result).toMatchObject({ outcome: "triggered", attempts: 1, cronStatus: "processed" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("se o cron já estiver rodando, espera curto e tenta de novo", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "already_running" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "processed" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ) as unknown as typeof fetch;
    const sleep = vi.fn(async () => {});

    const result = await kickDispatchCron({
      baseUrl: "https://crm.test",
      secret: "secret",
      fetchImpl,
      sleep,
      retryDelaysMs: [0, 1_000],
    });

    expect(result).toMatchObject({ outcome: "triggered", attempts: 2 });
    expect(sleep).toHaveBeenCalledWith(1_000);
  });

  it("não tenta criar um segundo motor se o cron continuar ocupado", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ status: "already_running" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    const result = await kickDispatchCron({
      baseUrl: "https://crm.test",
      secret: "secret",
      fetchImpl,
      sleep: async () => {},
      retryDelaysMs: [0, 1, 1],
    });

    expect(result).toEqual({ outcome: "busy", attempts: 3, cronStatus: "already_running" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("sem CRON_SECRET faz fail-safe e deixa o cron agendado como fallback", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await kickDispatchCron({
      baseUrl: "https://crm.test",
      secret: "",
      fetchImpl,
    });

    expect(result.outcome).toBe("skipped");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sem origem confiável do app o segredo não sai: nada é chamado (SG-4)", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    for (const baseUrl of [null, undefined, "", "   "]) {
      const result = await kickDispatchCron({ baseUrl, secret: "segredo-do-cron", fetchImpl });
      expect(result).toMatchObject({ outcome: "skipped", attempts: 0 });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("resolveCronBaseUrl", () => {
  it("usa só variáveis da plataforma (DISPARADOR_CHAIN_URL, senão NEXT_PUBLIC_APP_URL), normalizadas para a origem", () => {
    expect(resolveCronBaseUrl({ NEXT_PUBLIC_APP_URL: "https://crm.exemplo.com/qualquer/caminho" })).toBe("https://crm.exemplo.com");
    expect(resolveCronBaseUrl({ DISPARADOR_CHAIN_URL: "http://localhost:3000", NEXT_PUBLIC_APP_URL: "https://crm.exemplo.com" })).toBe("http://localhost:3000");
    expect(resolveCronBaseUrl({})).toBeNull();
  });
  it("rejeita valor inválido, esquema estranho e URL com credenciais", () => {
    for (const bad of ["crm.exemplo.com", "ftp://crm.exemplo.com", "javascript:alert(1)", "https://user:pass@crm.exemplo.com", "  "]) {
      expect(resolveCronBaseUrl({ NEXT_PUBLIC_APP_URL: bad }), bad).toBeNull();
    }
  });
});
