import { beforeEach, describe, expect, it, vi } from "vitest";

// "Conectar com um clique": POST .../connect, GET .../status e o PUT (que conecta ao salvar e ao trocar o segredo). O UTMpay é simulado por um
// fetcher que registra as chamadas; os segredos guardados são cifrados de verdade (encrypt) e só voltam em texto dentro do servidor.
const SECRET = "uma-frase-longa-e-dificil-de-adivinhar";
const KEY = "chave-de-acesso-123";
const EVENTS = "https://crm.exemplo.com/api/integrations/utmpay/events";

const state = vi.hoisted(() => ({
  perm: true,
  rate: true,
  stored: null as Record<string, unknown> | null,
  upserted: null as Record<string, unknown> | null,
  calls: [] as Array<{ url: string; method: string; headers: Record<string, string>; body?: string }>,
  reply: { status: 200, body: { status: "ok", url: "https://crm.exemplo.com/api/integrations/utmpay/events", tem_segredo: true, atualizado_em: "2026-10-15T10:00:00Z" } as unknown } as { status: number; body: unknown } | "network",
  audits: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/auth/route-guard", () => ({
  guardPermission: async () => (state.perm ? { ok: true, ctx: { accountId: "acc-1", userId: "u1", supabase: {} } } : { ok: false, response: new Response("{}", { status: 403 }) }),
}));
vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({
    from: () => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.maybeSingle = async () => ({ data: state.stored, error: null });
      chain.upsert = async (row: Record<string, unknown>) => ((state.upserted = row), (state.stored = row), { error: null });
      return chain;
    },
  }),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ success: state.rate }),
  rateLimitResponse: () => new Response(null, { status: 429 }),
  RATE_LIMITS: { utmpayTest: { limit: 1, windowMs: 1 } },
}));
vi.mock("@/lib/audit/log-event", () => ({ logAuditEvent: vi.fn(async (e: Record<string, unknown>) => void state.audits.push(e)) }));
vi.mock("@/lib/utmpay/config", () => ({ resetUtmpayConfigCache: vi.fn(), loadUtmpayConfig: vi.fn() }));
vi.mock("@/lib/security/ssrf-guard", () => ({
  safeFetch: async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    state.calls.push({ url, ...init });
    if (state.reply === "network") throw new Error("rede");
    return new Response(JSON.stringify(state.reply.body), { status: state.reply.status });
  },
}));

import { encrypt } from "@/lib/whatsapp/encryption";
import { GET as configGet, PUT as configPut } from "./route";
import { POST as connectPost } from "./connect/route";
import { GET as statusGet } from "./status/route";

const OLD_ENV = process.env.NEXT_PUBLIC_APP_URL;
const stored = () => ({ enabled: true, base_url: "https://utmpay.exemplo.com", api_key_enc: encrypt(KEY), webhook_secret_enc: encrypt(SECRET), janela_dias: 7, send_without_tracking: false, updated_at: "2026-10-15T13:00:00Z" });
const put = (body: unknown) => new Request("https://crm.test/x", { method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const noSecrets = (value: unknown) => {
  const text = JSON.stringify(value);
  for (const s of [SECRET, KEY, "CIFRADO"]) expect(text).not.toContain(s);
  expect(text).not.toMatch(/[0-9a-f]{8,}:[0-9a-f]{8,}:[0-9a-f]{8,}/); // formato iv:cifrado:tag
};

beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = "https://crm.exemplo.com";
  Object.assign(state, {
    perm: true,
    rate: true,
    stored: stored(),
    upserted: null,
    calls: [],
    reply: { status: 200, body: { status: "ok", url: EVENTS, tem_segredo: true, atualizado_em: "2026-10-15T10:00:00Z" } },
    audits: [],
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  return () => {
    process.env.NEXT_PUBLIC_APP_URL = OLD_ENV;
  };
});

describe("POST /api/account/utmpay-config/connect (botão Conectar)", () => {
  it("lê a configuração GRAVADA, decifra no servidor e manda { url, segredo } com a chave de acesso", async () => {
    const res = await connectPost();
    expect(res.status).toBe(200);
    const call = state.calls[0];
    expect(call).toMatchObject({ url: "https://utmpay.exemplo.com/api/integracoes/crm", method: "POST", headers: { "X-API-Key": KEY } });
    expect(JSON.parse(call.body!)).toEqual({ url: EVENTS, segredo: SECRET });
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, connected_at: "2026-10-15T10:00:00Z", conexao: { ok: true } });
    expect(body.message).toMatch(/Conectado agora há pouco/);
    expect(body.checklist.itens[3]).toMatchObject({ id: "avisos", estado: "ok" });
    noSecrets(body);
    expect(state.audits[0]).toMatchObject({ action: "utmpay.connected" });
    expect(JSON.stringify(state.audits)).not.toContain(SECRET);
  });

  it("chave errada: diz o que fazer e o checklist mostra o item 4 em vermelho com a ação Conectar", async () => {
    state.reply = { status: 401, body: { status: "erro", mensagem: "x" } };
    const body = await (await connectPost()).json();
    expect(body).toMatchObject({ ok: false, connected_at: null });
    expect(body.message).toMatch(/a chave de acesso está errada.*Copie a chave de novo no UTMpay/);
    expect(body.checklist.itens[3]).toMatchObject({ estado: "erro", acao_id: "conectar" });
    expect(state.audits[0]).toMatchObject({ action: "utmpay.connect_failed" });
    noSecrets(body);
  });

  it("segredo curto ou configuração incompleta: não chama o UTMpay e diz o que falta", async () => {
    state.stored = { ...stored(), webhook_secret_enc: encrypt("curto") };
    const short = await (await connectPost()).json();
    expect(short).toMatchObject({ ok: false });
    expect(short.message).toMatch(/pelo menos 16 caracteres/);
    state.stored = null;
    expect((await (await connectPost()).json()).message).toMatch(/Informe o endereço do UTMpay/);
    expect(state.calls).toHaveLength(0);
  });

  it("exige settings.account e respeita o limite de uso", async () => {
    state.perm = false;
    expect((await connectPost()).status).toBe(403);
    state.perm = true;
    state.rate = false;
    expect((await connectPost()).status).toBe(429);
    expect(state.calls).toHaveLength(0);
  });
});

describe("GET /api/account/utmpay-config/status", () => {
  it("conectado: campos do checklist (base_url_ok, api_key_ok, utmpay_alcancavel, utmpay_recebe_avisos, conectado_em) e checklist pronto", async () => {
    const body = await (await statusGet()).json();
    expect(state.calls[0]).toMatchObject({ url: "https://utmpay.exemplo.com/api/integracoes/crm", method: "GET", headers: { "X-API-Key": KEY } });
    expect(body).toMatchObject({ base_url_ok: true, api_key_ok: true, utmpay_alcancavel: true, utmpay_recebe_avisos: true, conectado_em: "2026-10-15T10:00:00Z", conexao: { estado: "conectado" } });
    expect(body.checklist.itens.map((i: { estado: string }) => i.estado)).toEqual(["ok", "ok", "ok", "ok", "ok"]);
    noSecrets(body);
  });
  it("UTMpay fora do ar: inalcançável e o checklist manda conferir o endereço", async () => {
    state.reply = "network";
    const body = await (await statusGet()).json();
    expect(body).toMatchObject({ utmpay_alcancavel: false, utmpay_recebe_avisos: false, conectado_em: null });
    expect(body.checklist.itens[3]).toMatchObject({ estado: "erro", acao_id: "conectar" });
  });
  it("o UTMpay manda os avisos para outro endereço: divergente (amarelo)", async () => {
    state.reply = { status: 200, body: { url: "https://antigo.com/x", tem_segredo: true, atualizado_em: null } };
    const body = await (await statusGet()).json();
    expect(body.conexao.estado).toBe("divergente");
    expect(body.checklist.itens[3].estado).toBe("atencao");
  });
  it("sem configuração: não chama a rede e o checklist vira passo a passo", async () => {
    state.stored = null;
    const body = await (await statusGet()).json();
    expect(state.calls).toHaveLength(0);
    expect(body).toMatchObject({ base_url_ok: false, api_key_ok: false, utmpay_alcancavel: false });
    expect(body.checklist).toMatchObject({ primeira_vez: true, proximo_passo: "endereco" });
  });
});

describe("PUT /api/account/utmpay-config conecta ao salvar", () => {
  it("1ª configuração com segredo novo: cifra, salva e entrega o segredo ao UTMpay na hora (resposta traz o resultado e o checklist)", async () => {
    state.stored = null;
    const res = await configPut(put({ base_url: "https://utmpay.exemplo.com", api_key: KEY, webhook_secret: SECRET, enabled: true }));
    expect(res.status).toBe(200);
    expect(state.upserted).toMatchObject({ account_id: "acc-1", base_url: "https://utmpay.exemplo.com" });
    expect(JSON.parse(state.calls[0].body!)).toEqual({ url: EVENTS, segredo: SECRET });
    const body = await res.json();
    expect(body.conexao).toMatchObject({ tentou: true, ok: true });
    expect(body.checklist.itens.map((i: { estado: string }) => i.estado)).toEqual(["ok", "ok", "ok", "ok", "ok"]);
    noSecrets(body);
  });

  it("TROCAR o segredo reenvia automaticamente o novo (e a chave guardada é usada no cabeçalho)", async () => {
    const NEW = "outro-segredo-bem-longo-123456";
    const body = await (await configPut(put({ webhook_secret: NEW }))).json();
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0].headers["X-API-Key"]).toBe(KEY);
    expect(JSON.parse(state.calls[0].body!).segredo).toBe(NEW);
    expect(body.conexao.ok).toBe(true);
    expect(JSON.stringify(body)).not.toContain(NEW);
  });

  it("salvar sem trocar o segredo reenvia o guardado (decifrado só no servidor)", async () => {
    await configPut(put({ janela_dias: 10 }));
    expect(JSON.parse(state.calls[0].body!).segredo).toBe(SECRET);
  });

  it("se a conexão falhar a configuração FICA salva e a resposta diz o que fazer (nunca erro 5xx por isso)", async () => {
    state.reply = { status: 401, body: {} };
    const res = await configPut(put({ janela_dias: 9 }));
    expect(res.status).toBe(200);
    expect(state.upserted).toMatchObject({ janela_dias: 9 });
    const body = await res.json();
    expect(body.conexao).toMatchObject({ tentou: true, ok: false, reason: "unauthorized" });
    expect(body.conexao.mensagem).toMatch(/chave de acesso está errada/);
    expect(body.checklist.itens[3].estado).toBe("erro");
  });

  it("sem endereço dos avisos do CRM (NEXT_PUBLIC_APP_URL): salva, não conecta e explica", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    const body = await (await configPut(put({ janela_dias: 8 }))).json();
    expect(state.calls).toHaveLength(0);
    expect(body.conexao).toMatchObject({ tentou: false, ok: false, reason: "no_events_url" });
  });

  it("GET devolve a visão + checklist (sem consultar o UTMpay) e nunca segredo", async () => {
    const body = await (await configGet()).json();
    expect(state.calls).toHaveLength(0);
    expect(body).toMatchObject({ configured: true, has_api_key: true, has_webhook_secret: true, atualizado_em: "2026-10-15T13:00:00Z" });
    expect(body.checklist.itens[3]).toMatchObject({ estado: "pendente", acao_id: "conectar" });
    noSecrets(body);
  });
});
