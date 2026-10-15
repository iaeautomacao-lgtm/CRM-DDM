import { describe, expect, it } from "vitest";

import { buildChecklist } from "./checklist";
import { connectUtmpay, connectionFromResult, MIN_SECRET_CHARS, missingForConnect, readUtmpayConnection, type ConnectFetch } from "./connect";

const SECRET = "uma-frase-longa-e-dificil-de-adivinhar";
const EVENTS = "https://crm.exemplo.com/api/integrations/utmpay/events";
const input = (over: Partial<Parameters<typeof connectUtmpay>[0]> = {}) => ({ baseUrl: "https://utmpay.exemplo.com", apiKey: "chave-123", secret: SECRET, eventsUrl: EVENTS, ...over });

const reply = (status: number, body: unknown = { status: "ok" }) => new Response(JSON.stringify(body), { status });
function fetcher(res: Response | Error) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  const fn: ConnectFetch = async (url, init) => {
    calls.push({ url, ...init });
    if (res instanceof Error) throw res;
    return res.clone();
  };
  return { fn, calls };
}

describe("Conectar ao UTMpay (POST /api/integracoes/crm)", () => {
  it("manda a chave de acesso no cabeçalho e { url, segredo } no corpo; ok devolve o que o UTMpay guardou", async () => {
    const f = fetcher(reply(200, { status: "ok", url: EVENTS, tem_segredo: true, atualizado_em: "2026-10-15T10:00:00Z" }));
    const r = await connectUtmpay(input({ baseUrl: "https://utmpay.exemplo.com/" }), f.fn);
    expect(f.calls[0]).toMatchObject({ url: "https://utmpay.exemplo.com/api/integracoes/crm", method: "POST", headers: { "X-API-Key": "chave-123", "Content-Type": "application/json" } });
    expect(JSON.parse(f.calls[0].body!)).toEqual({ url: EVENTS, segredo: SECRET });
    expect(r).toMatchObject({ tentou: true, ok: true, reason: null, url: EVENTS, atualizado_em: "2026-10-15T10:00:00Z" });
    expect(r.mensagem).toMatch(/Conectado agora há pouco/);
  });

  it.each([
    [401, "unauthorized", /a chave de acesso está errada.*Copie a chave de novo no UTMpay/],
    [403, "unauthorized", /chave de acesso está errada/],
    [400, "rejected", /https.*16 caracteres/],
    [503, "unavailable", /banco de dados/],
    [500, "http", /tente de novo/i],
  ])("HTTP %i ⇒ %s, com a mensagem dizendo o que fazer", async (status, reason, text) => {
    const r = await connectUtmpay(input(), fetcher(reply(status, { status: "erro", mensagem: "detalhe interno" })).fn);
    expect(r).toMatchObject({ tentou: true, ok: false, reason });
    expect(r.mensagem).toMatch(text);
    expect(r.mensagem).not.toContain("detalhe interno"); // não repassa texto cru do UTMpay
  });

  it("rede fora do ar: network; 2xx sem JSON ainda é conectado", async () => {
    expect(await connectUtmpay(input(), fetcher(new Error("ECONNREFUSED")).fn)).toMatchObject({ ok: false, reason: "network" });
    const ok = await connectUtmpay(input(), fetcher(new Response("ok", { status: 200 })).fn);
    expect(ok).toMatchObject({ ok: true, url: EVENTS });
  });

  it("falta algo ⇒ NÃO chama a rede e diz o que falta (inclui segredo curto < 16)", async () => {
    const f = fetcher(reply(200));
    expect(MIN_SECRET_CHARS).toBe(16);
    for (const [over, reason] of [
      [{ baseUrl: "" }, "no_base_url"],
      [{ apiKey: null }, "no_key"],
      [{ secret: null }, "no_secret"],
      [{ secret: "curto" }, "secret_short"],
      [{ eventsUrl: null }, "no_events_url"],
    ] as const) {
      const r = await connectUtmpay(input(over), f.fn);
      expect(r, reason).toMatchObject({ tentou: false, ok: false, reason });
      expect(missingForConnect(input(over))).toBe(reason);
    }
    expect(f.calls).toHaveLength(0);
  });

  it("o segredo e a chave NUNCA aparecem nas mensagens nem no resultado", async () => {
    for (const res of [reply(401), reply(400), reply(503), reply(500), new Error("rede")]) {
      const r = await connectUtmpay(input(), fetcher(res).fn);
      const text = JSON.stringify(r);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("chave-123");
    }
  });
});

describe("Ler a conexão (GET /api/integracoes/crm)", () => {
  const read = (res: Response | Error) => readUtmpayConnection({ baseUrl: "https://utmpay.exemplo.com", apiKey: "k", eventsUrl: EVENTS }, fetcher(res).fn);

  it("conectado: o endereço bate e há segredo; nunca devolve o segredo", async () => {
    const s = await read(reply(200, { url: EVENTS, tem_segredo: true, atualizado_em: "2026-10-15T10:00:00Z" }));
    expect(s).toMatchObject({ estado: "conectado", alcancavel: true, tem_segredo: true, url: EVENTS });
    expect(s.mensagem).toContain(EVENTS);
  });
  it("divergente (outro endereço), sem segredo, ainda não conectado", async () => {
    expect((await read(reply(200, { url: "https://outro.com/x", tem_segredo: true, atualizado_em: null }))).estado).toBe("divergente");
    expect((await read(reply(200, { url: EVENTS, tem_segredo: false, atualizado_em: null }))).estado).toBe("nao_conectado");
    expect((await read(reply(200, { url: null, tem_segredo: false, atualizado_em: null }))).estado).toBe("nao_conectado");
  });
  it("erros: chave errada, UTMpay antigo (404), erro HTTP e fora do ar (alcancavel=false)", async () => {
    expect(await read(reply(401))).toMatchObject({ estado: "erro", alcancavel: true });
    const old = await read(reply(404));
    expect(old).toMatchObject({ estado: "erro", alcancavel: true });
    expect(old.mensagem).toMatch(/Atualize o UTMpay/);
    expect(await read(reply(500))).toMatchObject({ estado: "erro", alcancavel: true });
    expect(await read(new Error("rede"))).toMatchObject({ estado: "erro", alcancavel: false });
  });
  it("sem endereço ou chave: não chama a rede", async () => {
    const f = fetcher(reply(200));
    expect((await readUtmpayConnection({ baseUrl: "", apiKey: "k", eventsUrl: EVENTS }, f.fn)).estado).toBe("nao_configurado");
    expect((await readUtmpayConnection({ baseUrl: "https://x.com", apiKey: null, eventsUrl: EVENTS }, f.fn)).estado).toBe("nao_configurado");
    expect(f.calls).toHaveLength(0);
  });
  it("estado deduzido de um POST: ok = conectado; falha de rede = inalcançável", () => {
    const ok = connectionFromResult({ tentou: true, ok: true, reason: null, mensagem: "m", url: EVENTS, atualizado_em: "x" }, EVENTS);
    expect(ok).toMatchObject({ estado: "conectado", alcancavel: true });
    expect(connectionFromResult({ tentou: true, ok: false, reason: "network", mensagem: "m", url: null, atualizado_em: null }, EVENTS)).toMatchObject({ estado: "erro", alcancavel: false });
    expect(connectionFromResult({ tentou: false, ok: false, reason: "no_key", mensagem: "m", url: null, atualizado_em: null }, EVENTS)).toMatchObject({ estado: "nao_configurado" });
  });
});

describe("Checklist da tela (verde/amarelo/vermelho/cinza + o que fazer)", () => {
  const view = (over: Record<string, unknown> = {}) =>
    ({ configured: true, enabled: false, base_url: "https://utmpay.exemplo.com", has_api_key: true, has_webhook_secret: true, atualizado_em: "2026-10-15T13:00:00Z", ...over }) as Parameters<typeof buildChecklist>[0];
  const state = (estado: string, mensagem = "m") => ({ estado, url: null, tem_segredo: false, atualizado_em: null, esperado: EVENTS, mensagem, alcancavel: true }) as Parameters<typeof buildChecklist>[1];

  it("primeira vez, nada configurado: itens 1 a 3 vermelhos com o que fazer, 4 e 5 em cinza, passo a passo", () => {
    const c = buildChecklist(view({ configured: false, base_url: "", has_api_key: false, has_webhook_secret: false, atualizado_em: null }), null);
    expect(c.primeira_vez).toBe(true);
    expect(c.itens.map((i) => i.estado)).toEqual(["erro", "erro", "erro", "pendente", "pendente"]);
    expect(c.proximo_passo).toBe("endereco");
    expect(c.itens[0].acao).toMatch(/Exemplo: https:\/\//);
    expect(c.itens[0].titulo).toBe("1. Endereço do UTMpay");
    expect(c.prontos).toBe(0);
    expect(c.total).toBe(5);
  });
  it("tudo salvo mas ainda sem conexão: o item 4 pede Conectar; ligado fica em cinza com a ação de ligar", () => {
    const c = buildChecklist(view(), state("nao_conectado", "O UTMpay ainda não manda avisos para o CRM. Clique em Conectar."));
    expect(c.itens.map((i) => i.estado)).toEqual(["ok", "ok", "ok", "erro", "pendente"]);
    expect(c.itens[3]).toMatchObject({ acao_id: "conectar", titulo: "4. UTMpay mandando avisos para o CRM" });
    expect(c.itens[4]).toMatchObject({ acao_id: "ligar" });
    expect(c.proximo_passo).toBe("avisos");
    expect(c.primeira_vez).toBe(false);
  });
  it("conectado e ligado: 5 de 5, sem próximo passo; divergente é amarelo", () => {
    const done = buildChecklist(view({ enabled: true }), state("conectado"));
    expect(done.itens.every((i) => i.estado === "ok")).toBe(true);
    expect(done).toMatchObject({ prontos: 5, proximo_passo: null });
    expect(buildChecklist(view(), state("divergente")).itens[3].estado).toBe("atencao");
  });
  it("segredos: mostra a data em que foram salvos e nunca o valor; sem jargão nos textos", () => {
    const c = buildChecklist(view({ enabled: true }), state("conectado"));
    const text = JSON.stringify(c);
    expect(c.itens[1].detalhe).toMatch(/salva em 15\/10\/2026/);
    expect(c.itens[2].detalhe).toMatch(/salvo em/);
    for (const word of ["X-API-Key", "webhook", "HMAC", "outbox", "tid", "token"]) expect(text, word).not.toContain(word);
  });
  it("conexão ainda não verificada: item 4 em cinza com a ação Conectar", () => {
    expect(buildChecklist(view(), null).itens[3]).toMatchObject({ estado: "pendente", acao_id: "conectar" });
  });
});
