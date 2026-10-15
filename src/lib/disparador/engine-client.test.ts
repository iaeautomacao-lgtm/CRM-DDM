import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("@/lib/api-fetch", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import { ENGINE_COPY, describeAccount, describeSource, fetchEngine, parseEngineView, saveEngine, stillOnMessage, wouldTurnOn, type EngineView } from "./engine-client";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const view = (over: Partial<EngineView> = {}): EngineView => ({
  account: { batch_claim: null, tick_chain: null },
  effective: { batch_claim: { enabled: false, source: "default" }, tick_chain: { enabled: false, source: "default" } },
  env: { batch_claim: false, tick_chain: false },
  ...over,
});
beforeEach(() => apiFetch.mockReset());

describe("Chaves do motor · leitura", () => {
  it("lê o contrato (account/effective/env) e tolera lixo", () => {
    const v = parseEngineView({
      account: { batch_claim: true, tick_chain: null },
      effective: { batch_claim: { enabled: true, source: "account" }, tick_chain: { enabled: false, source: "env" } },
      env: { batch_claim: false, tick_chain: true },
    });
    expect(v.account).toEqual({ batch_claim: true, tick_chain: null });
    expect(v.effective.tick_chain).toEqual({ enabled: false, source: "env" });
    expect(v.env.tick_chain).toBe(true);
    const lixo = parseEngineView(null);
    expect(lixo.effective.batch_claim).toEqual({ enabled: false, source: "default" });
    expect(parseEngineView({ effective: { batch_claim: { enabled: true, source: "xyz" } } }).effective.batch_claim.source).toBe("default");
  });
});

describe("Chaves do motor · de onde vem o valor", () => {
  it("decisão desta conta, de outra conta, do servidor e padrão", () => {
    expect(describeSource("batch_claim", view({ account: { batch_claim: true, tick_chain: null }, effective: { ...view().effective, batch_claim: { enabled: true, source: "account" } } })).label).toBe("Decisão desta conta");
    // efetivo ligado por conta, mas esta conta não ligou: veio de OUTRA conta
    const outra = describeSource("batch_claim", view({ effective: { ...view().effective, batch_claim: { enabled: true, source: "account" } } }));
    expect(outra.label).toBe("Decisão de outra conta");
    expect(outra.detail).toMatch(/compartilhado/);
    expect(describeSource("tick_chain", view({ effective: { ...view().effective, tick_chain: { enabled: true, source: "env" } } })).label).toBe("Configuração do servidor");
    expect(describeSource("tick_chain", view()).label).toBe("Padrão do sistema");
  });
  it("decisão da conta em palavras", () => {
    expect(describeAccount("batch_claim", view())).toMatch(/segue o servidor/);
    expect(describeAccount("batch_claim", view({ account: { batch_claim: true, tick_chain: null } }))).toMatch(/ligar/);
    expect(describeAccount("batch_claim", view({ account: { batch_claim: false, tick_chain: null } }))).toMatch(/desligar/);
  });
});

describe("Chaves do motor · confirmação e avisos", () => {
  it("pede confirmação ao ligar (inclusive ao voltar ao padrão se o servidor está ligado), não ao desligar", () => {
    expect(wouldTurnOn("batch_claim", view(), true)).toBe(true);
    expect(wouldTurnOn("batch_claim", view(), false)).toBe(false);
    expect(wouldTurnOn("batch_claim", view({ env: { batch_claim: true, tick_chain: false } }), null)).toBe(true);
    expect(wouldTurnOn("batch_claim", view(), null)).toBe(false);
    const ligado = view({ effective: { ...view().effective, batch_claim: { enabled: true, source: "env" } } });
    expect(wouldTurnOn("batch_claim", ligado, true)).toBe(false);
  });
  it("depois de desligar, avisa quando o motor continua ligado por outra origem", () => {
    expect(stillOnMessage("batch_claim", view())).toBeNull();
    const m = stillOnMessage("batch_claim", view({ effective: { ...view().effective, batch_claim: { enabled: true, source: "env" } } }));
    expect(m).toMatch(/Envio em lote continua ligado/);
    expect(m).toMatch(/servidor/);
  });
  it("textos sem jargão", () => {
    const tudo = Object.values(ENGINE_COPY).flatMap((c) => [c.title, c.what, c.advice]).join(" ");
    expect(tudo).not.toMatch(/claim|tick|RPC|cron|batch|webhook/i);
  });
});

describe("Chaves do motor · chamadas", () => {
  it("GET lê a visão; 403 vira erro com status", async () => {
    apiFetch.mockResolvedValue(json(200, { account: { batch_claim: null, tick_chain: null }, effective: {}, env: {} }));
    expect((await fetchEngine()).account.batch_claim).toBeNull();
    expect(apiFetch.mock.calls[0][0]).toBe("/api/disparador/engine");
    apiFetch.mockResolvedValue(json(403, { error: "Sem permissão" }));
    await expect(fetchEngine()).rejects.toMatchObject({ status: 403, message: "Sem permissão" });
  });
  it("PUT manda só as chaves pedidas (null = voltar ao padrão)", async () => {
    apiFetch.mockResolvedValue(json(200, { account: { batch_claim: true, tick_chain: null }, effective: {}, env: {} }));
    await saveEngine({ batch_claim: true });
    expect(apiFetch.mock.calls[0][1].method).toBe("PUT");
    expect(JSON.parse(apiFetch.mock.calls[0][1].body)).toEqual({ batch_claim: true });
    await saveEngine({ tick_chain: null });
    expect(JSON.parse(apiFetch.mock.calls[1][1].body)).toEqual({ tick_chain: null });
  });
});
