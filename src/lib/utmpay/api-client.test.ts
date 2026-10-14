import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("@/lib/api-fetch", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import {
  UtmpayApiError,
  etapaDoRastreio,
  fetchContactRastreio,
  fetchFunil,
  fetchConfig,
  fmtMoney,
  fmtPercent,
  parseFunil,
  parseRastreio,
  saveConfig,
  testConfig,
} from "./api-client";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
beforeEach(() => apiFetch.mockReset());

describe("UTMpay · leitura tolerante (contrato snake_case do Cinzel)", () => {
  it("funil: números, taxas nulas e por_atendente", () => {
    const f = parseFunil({
      available: true, tracking: true, entregues: 940, links: 950, clicou: 310, fechou: 80, pagou: 55,
      taxas: { clicou: 0.33, fechou: 0.085, pagou: null },
      por_atribuicao: { fechou: { direto: 20, ia: 30, humano: 30 }, pagou: { direto: 10, ia: 20, humano: 25 } },
      por_atendente: [{ atendente_id: "u1", atendente_nome: "Ana", fechou: 12, pagou: 9 }],
    });
    expect(f.tracking).toBe(true);
    expect(f.taxas).toEqual({ clicou: 0.33, fechou: 0.085, pagou: null });
    expect(f.por_atribuicao.pagou.humano).toBe(25);
    expect(f.por_atendente[0]).toEqual({ atendente_id: "u1", atendente_nome: "Ana", fechou: 12, pagou: 9 });
  });

  it("funil vazio ou malformado não quebra", () => {
    const f = parseFunil(null);
    expect(f.tracking).toBe(false);
    expect(f.entregues).toBe(0);
    expect(f.por_atendente).toEqual([]);
    expect(parseFunil({ available: false }).available).toBe(false);
  });

  it("rastreio nulo, completo e atribuição inválida", () => {
    expect(parseRastreio({ rastreio: null })).toBeNull();
    expect(parseRastreio({})).toBeNull();
    const r = parseRastreio({ rastreio: { campanha: "Setembro", clicou_em: "2026-10-01T10:00:00Z", fechou_em: null, atribuicao: "humano", atendente_nome: "Ana", valor_em_aberto: 10.5 } });
    expect(r).toMatchObject({ campanha: "Setembro", atribuicao: "humano", atendente_nome: "Ana", valor_em_aberto: 10.5, fechou_em: null });
    expect(parseRastreio({ rastreio: { campanha: "x", atribuicao: "robo" } })?.atribuicao).toBeNull();
  });
});

describe("UTMpay · etapa e formatação", () => {
  it("usa a etapa mais avançada", () => {
    expect(etapaDoRastreio({ clicou_em: null, fechou_em: null, pagou_em: null })).toBe("enviado");
    expect(etapaDoRastreio({ clicou_em: "a", fechou_em: null, pagou_em: null })).toBe("clicou");
    expect(etapaDoRastreio({ clicou_em: "a", fechou_em: "b", pagou_em: null })).toBe("fechou");
    expect(etapaDoRastreio({ clicou_em: null, fechou_em: null, pagou_em: "c" })).toBe("pagou");
  });
  it("percentual e dinheiro em pt-BR", () => {
    expect(fmtPercent(null)).toBe("—");
    expect(fmtPercent(0.085)).toBe("8,5%");
    expect(fmtMoney(null)).toBeNull();
    expect(fmtMoney(1234.5)).toMatch(/1\.234,50/);
  });
});

describe("UTMpay · chamadas", () => {
  it("funil e selo usam as rotas do contrato", async () => {
    apiFetch.mockResolvedValue(json(200, { tracking: true }));
    await fetchFunil("c 1");
    expect(apiFetch.mock.calls[0][0]).toBe("/api/disparador/campaigns/c%201/funil");
    apiFetch.mockResolvedValue(json(200, { rastreio: null }));
    expect(await fetchContactRastreio("k1")).toBeNull();
    expect(apiFetch.mock.calls[1][0]).toBe("/api/contacts/k1/utmpay");
  });

  it("erro HTTP vira UtmpayApiError com o status (mensagem do servidor ou padrão)", async () => {
    apiFetch.mockResolvedValue(json(403, { error: "Sem permissão" }));
    await expect(fetchFunil("c1")).rejects.toMatchObject({ status: 403, message: "Sem permissão" });
    apiFetch.mockResolvedValue(new Response("erro", { status: 500 }));
    const err = await fetchFunil("c1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UtmpayApiError);
    expect(err).toMatchObject({ status: 500 });
  });

  it("config: GET mascara segredos e PUT manda só o que o chamador pôs", async () => {
    apiFetch.mockResolvedValue(json(200, { available: true, configured: true, enabled: true, base_url: "https://u.example", has_api_key: true, has_webhook_secret: false, janela_dias: 7, send_without_tracking: false, events_url: "https://crm/api/integrations/utmpay/events" }));
    const c = await fetchConfig();
    expect(c).toMatchObject({ has_api_key: true, has_webhook_secret: false, janela_dias: 7 });
    expect(JSON.stringify(c)).not.toMatch(/api_key"?:\s*"/);
    await saveConfig({ enabled: false, janela_dias: 10 });
    expect(JSON.parse(apiFetch.mock.calls[1][1].body)).toEqual({ enabled: false, janela_dias: 10 });
    apiFetch.mockResolvedValue(json(200, { ok: false, message: "UTMpay não respondeu" }));
    expect(await testConfig()).toEqual({ ok: false, message: "UTMpay não respondeu" });
  });
});
