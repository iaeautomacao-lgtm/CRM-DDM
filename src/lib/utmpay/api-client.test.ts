import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("@/lib/api-fetch", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import {
  UtmpayApiError,
  connectUtmpay,
  fetchStatus,
  parseChecklist,
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

const CHECKLIST = {
  itens: [
    { id: "endereco", titulo: "1. Endereço do UTMpay", estado: "ok", detalhe: "https://u.example.com", acao: null, acao_id: null },
    { id: "chave", titulo: "2. Chave de acesso", estado: "ok", detalhe: "Configurada (salva em 15/10/2026 09:00).", acao: null, acao_id: null },
    { id: "segredo", titulo: "3. Segredo dos avisos", estado: "ok", detalhe: "Configurado.", acao: null, acao_id: null },
    { id: "avisos", titulo: "4. UTMpay mandando avisos para o CRM", estado: "erro", detalhe: "Ainda não.", acao: "Clique em Conectar.", acao_id: "conectar" },
    { id: "ligado", titulo: "5. Rastreamento ligado", estado: "pendente", detalhe: "Desligado.", acao: "Ligue quando quiser.", acao_id: "ligar" },
  ],
  primeira_vez: false,
  proximo_passo: "avisos",
  prontos: 3,
  total: 5,
};

describe("UTMpay · checklist e conexão (contrato seção 7)", () => {
  it("lê o checklist do servidor; descarta itens/estados desconhecidos sem quebrar", () => {
    const c = parseChecklist(CHECKLIST)!;
    expect(c.itens.map((i) => i.id)).toEqual(["endereco", "chave", "segredo", "avisos", "ligado"]);
    expect(c.itens[3]).toMatchObject({ estado: "erro", acao_id: "conectar" });
    expect(c).toMatchObject({ primeira_vez: false, proximo_passo: "avisos", prontos: 3, total: 5 });
    const ruim = parseChecklist({ itens: [{ id: "chave", estado: "azul", acao_id: "voar" }, { id: "outro" }], proximo_passo: "x" })!;
    expect(ruim.itens).toHaveLength(1);
    expect(ruim.itens[0]).toMatchObject({ estado: "pendente", acao_id: null });
    expect(ruim.proximo_passo).toBeNull();
    expect(parseChecklist(null)).toBeNull();
    expect(parseChecklist({ itens: [] })).toBeNull();
  });

  it("GET config traz o checklist e a data de salvamento", async () => {
    apiFetch.mockResolvedValue(json(200, { available: true, configured: true, enabled: false, base_url: "https://u.example.com", has_api_key: true, has_webhook_secret: true, janela_dias: 7, events_url: "https://crm/x", atualizado_em: "2026-10-15T12:00:00Z", checklist: CHECKLIST }));
    const c = await fetchConfig();
    expect(c.atualizado_em).toBe("2026-10-15T12:00:00Z");
    expect(c.checklist?.total).toBe(5);
  });

  it("PUT já conecta: devolve a conexão (falha não desfaz o salvamento) e o checklist novo", async () => {
    apiFetch.mockResolvedValue(json(200, { available: true, configured: true, enabled: false, base_url: "https://u.example.com", has_api_key: true, has_webhook_secret: true, janela_dias: 7, conexao: { tentou: true, ok: false, reason: "unauthorized", mensagem: "Falhou: a chave de acesso está errada. Copie a chave de novo no UTMpay e salve." }, checklist: CHECKLIST }));
    const r = await saveConfig({ webhook_secret: "um-segredo-bem-longo-123" });
    expect(r.base_url).toBe("https://u.example.com");
    expect(r.conexao).toEqual({ tentou: true, ok: false, mensagem: "Falhou: a chave de acesso está errada. Copie a chave de novo no UTMpay e salve." });
    expect(r.checklist?.itens).toHaveLength(5);
  });

  it("Conectar: ok com data e checklist; falha com a mensagem que diz o que fazer", async () => {
    apiFetch.mockResolvedValue(json(200, { ok: true, message: "Conectado.", connected_at: "2026-10-15T12:00:00Z", conexao: { tentou: true, ok: true }, checklist: CHECKLIST }));
    expect(await connectUtmpay()).toMatchObject({ ok: true, connected_at: "2026-10-15T12:00:00Z" });
    expect(apiFetch.mock.calls[0][0]).toBe("/api/account/utmpay-config/connect");
    expect(apiFetch.mock.calls[0][1].method).toBe("POST");
    apiFetch.mockResolvedValue(json(200, { ok: false, message: "Falhou: a chave de acesso está errada. Copie a chave de novo no UTMpay e salve.", connected_at: null, checklist: null }));
    const f = await connectUtmpay();
    expect(f.ok).toBe(false);
    expect(f.message).toMatch(/Copie a chave de novo/);
    apiFetch.mockResolvedValue(json(429, { error: "Muitas tentativas. Aguarde um minuto." }));
    await expect(connectUtmpay()).rejects.toMatchObject({ status: 429, message: "Muitas tentativas. Aguarde um minuto." });
  });

  it("status: estado real da conexão e checklist atualizado", async () => {
    apiFetch.mockResolvedValue(json(200, { base_url_ok: true, api_key_ok: true, utmpay_alcancavel: true, utmpay_recebe_avisos: true, conectado_em: "2026-10-15T12:00:00Z", conexao: { estado: "conectado" }, checklist: CHECKLIST }));
    const s = await fetchStatus();
    expect(s).toMatchObject({ alcancavel: true, recebeAvisos: true, conectadoEm: "2026-10-15T12:00:00Z" });
    expect(s.checklist?.itens).toHaveLength(5);
    expect(apiFetch.mock.calls[0][0]).toBe("/api/account/utmpay-config/status");
  });
});
