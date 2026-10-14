import { beforeEach, describe, expect, it, vi } from "vitest";

// Webhook de eventos do UTMpay (público, assinado), configuração e teste de conexão. A regra de negócio está em lib/utmpay/*.test.ts.
const state = vi.hoisted(() => ({
  link: { tid: "t1", account_id: "acc-1", campaign_id: "camp", contact_id: "c1", created_at: "2026-10-14T11:00:00.000Z", clicou_em: null, fechou_em: null, pagou_em: null, pagou_evento_em: null } as Record<string, unknown> | null,
  linkError: false,
  config: { enabled: true, baseUrl: "https://utm.exemplo.com", apiKey: "k", webhookSecret: "segredo-do-webhook", janelaDias: 7, sendWithoutTracking: false } as Record<string, unknown> | null,
  record: { duplicate: false, inWindow: true },
  recordThrows: false,
  rate: true,
  perm: true,
  stored: null as Record<string, unknown> | null,
  upserted: null as Record<string, unknown> | null,
  health: "ok" as "ok" | "http" | "net",
  afterFns: [] as Array<() => Promise<void>>,
}));

vi.mock("next/server", async (orig) => {
  const real = await orig<typeof import("next/server")>();
  return { ...real, after: (fn: () => Promise<void>) => state.afterFns.push(fn) };
});
vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({
    from: () => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.maybeSingle = async () => ({ data: state.stored, error: null });
      chain.upsert = async (row: Record<string, unknown>) => ((state.upserted = row), { error: null });
      return chain;
    },
  }),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ success: state.rate }),
  rateLimitResponse: () => new Response(null, { status: 429 }),
  RATE_LIMITS: { utmpayEvents: { limit: 1, windowMs: 1 }, utmpayTest: { limit: 1, windowMs: 1 } },
}));
vi.mock("@/lib/utmpay/config", () => ({ loadUtmpayConfig: async () => state.config, resetUtmpayConfigCache: vi.fn() }));
vi.mock("@/lib/utmpay/ingest", async (orig) => {
  const real = await orig<typeof import("@/lib/utmpay/ingest")>();
  return {
    ...real,
    loadLinkByTid: async () => {
      if (state.linkError) throw new Error("sem tabela");
      return state.link;
    },
    recordUtmpayEvent: vi.fn(async () => {
      if (state.recordThrows) throw new Error("banco");
      return state.record;
    }),
    enrichFromEvent: vi.fn(async () => {}),
  };
});
vi.mock("@/lib/billing/ddm-source", () => ({ fetchDdmSituation: vi.fn(), ddmAllowance: () => async () => true }));
vi.mock("@/lib/auth/route-guard", () => ({
  guardPermission: async () => (state.perm ? { ok: true, ctx: { accountId: "acc-1", userId: "u1", supabase: {} } } : { ok: false, response: new Response("{}", { status: 403 }) }),
}));
vi.mock("@/lib/audit/log-event", () => ({ logAuditEvent: vi.fn(async () => {}) }));
vi.mock("@/lib/whatsapp/secret-write", () => ({
  resolveSecretForWrite: (submitted: unknown, existing: string | null | undefined) => {
    const keep = submitted === undefined || submitted === null || (typeof submitted === "string" && (submitted.trim() === "" || /^[•*]+$/.test(submitted.trim())));
    return { ok: true, value: keep ? (existing ?? null) : `ENC(${String(submitted)})` };
  },
}));
vi.mock("@/lib/security/ssrf-guard", () => ({
  safeFetch: async () => {
    if (state.health === "net") throw new Error("rede");
    return new Response("ok", { status: state.health === "http" ? 503 : 200 });
  },
}));

import { enrichFromEvent, recordUtmpayEvent } from "@/lib/utmpay/ingest";
import { signUtmpayBody } from "@/lib/utmpay/signature";
import { POST as eventsPost } from "./events/route";
import { GET as configGet, PUT as configPut } from "../../account/utmpay-config/route";
import { POST as testPost } from "../../account/utmpay-config/test/route";

const SECRET = "segredo-do-webhook";
const EVENT = { event_id: "123e4567-e89b-42d3-a456-426614174000", tid: "t1", etapa: "payment_start", occurred_at: "2026-10-14T12:00:00Z", codigo: "abc", campanha: "C", canal: "whatsapp" };

function signedRequest(body: unknown, over: { secret?: string; ts?: string; sig?: string } = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const ts = over.ts ?? String(Math.floor(Date.now() / 1000));
  return new Request("https://crm.test/api/integrations/utmpay/events", {
    method: "POST",
    headers: { "content-type": "application/json", "x-utmpay-timestamp": ts, "x-utmpay-signature": over.sig ?? signUtmpayBody(over.secret ?? SECRET, ts, text) },
    body: text,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.link = { tid: "t1", account_id: "acc-1", campaign_id: "camp", contact_id: "c1", created_at: new Date(Date.now() - 3600_000).toISOString(), clicou_em: null, fechou_em: null, pagou_em: null, pagou_evento_em: null };
  state.linkError = false;
  state.config = { enabled: true, baseUrl: "https://utm.exemplo.com", apiKey: "k", webhookSecret: SECRET, janelaDias: 7, sendWithoutTracking: false };
  state.record = { duplicate: false, inWindow: true };
  state.recordThrows = false;
  state.rate = true;
  state.perm = true;
  state.stored = null;
  state.upserted = null;
  state.health = "ok";
  state.afterFns = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/integrations/utmpay/events", () => {
  it("assinatura válida: grava o evento, responde 200 e enriquece DEPOIS da resposta (payment_start/paid)", async () => {
    const res = await eventsPost(signedRequest(EVENT));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(recordUtmpayEvent).toHaveBeenCalledOnce();
    expect(enrichFromEvent).not.toHaveBeenCalled(); // só roda no after()
    await Promise.all(state.afterFns.map((f) => f()));
    expect(enrichFromEvent).toHaveBeenCalledOnce();
  });
  it("etapas que não mudam resultado (click) não agendam enriquecimento", async () => {
    await eventsPost(signedRequest({ ...EVENT, etapa: "click" }));
    expect(state.afterFns).toHaveLength(0);
  });
  it("evento repetido (mesmo event_id) responde 200 duplicate, sem enriquecer de novo", async () => {
    state.record = { duplicate: true, inWindow: true };
    const res = await eventsPost(signedRequest(EVENT));
    expect(await res.json()).toEqual({ status: "duplicate" });
    expect(state.afterFns).toHaveLength(0);
  });
  it.each([
    ["assinatura errada", () => signedRequest(EVENT, { secret: "outro" })],
    ["corpo alterado depois de assinado", () => { const r = signedRequest(EVENT); return new Request(r.url, { method: "POST", headers: r.headers, body: JSON.stringify({ ...EVENT, etapa: "paid" }) }); }],
    ["relógio fora de 5 min", () => signedRequest(EVENT, { ts: String(Math.floor(Date.now() / 1000) - 3600) })],
    ["sem assinatura", () => new Request("https://crm.test/x", { method: "POST", body: JSON.stringify(EVENT) })],
  ])("%s ⇒ 401 igual, sem gravar nada", async (_n, make) => {
    const res = await eventsPost(make());
    expect(res.status).toBe(401);
    expect(recordUtmpayEvent).not.toHaveBeenCalled();
  });
  it("tid desconhecido e conta sem segredo respondem o MESMO 401 (não revela o motivo)", async () => {
    state.link = null;
    expect((await eventsPost(signedRequest(EVENT))).status).toBe(401);
    state.link = { tid: "t1", account_id: "acc-1", created_at: "2026-10-14T11:00:00Z" };
    state.config = { ...state.config!, webhookSecret: null };
    expect((await eventsPost(signedRequest(EVENT))).status).toBe(401);
  });
  it("corpo inválido: 400; tid diferente do assinado não existe como caminho; limite excedido: 429; migration ausente: 503; erro de banco: 500", async () => {
    expect((await eventsPost(signedRequest("lixo"))).status).toBe(400);
    expect((await eventsPost(signedRequest({ ...EVENT, etapa: "comprou" }))).status).toBe(400);
    state.rate = false;
    expect((await eventsPost(signedRequest(EVENT))).status).toBe(429);
    state.rate = true;
    state.linkError = true;
    expect((await eventsPost(signedRequest(EVENT))).status).toBe(503);
    state.linkError = false;
    state.recordThrows = true;
    expect((await eventsPost(signedRequest(EVENT))).status).toBe(500);
  });
  it("corpo gigante é recusado (413) antes de qualquer consulta", async () => {
    const res = await eventsPost(new Request("https://crm.test/x", { method: "POST", headers: { "content-length": "999999" }, body: "{}" }));
    expect(res.status).toBe(413);
  });
});

describe("GET/PUT /api/account/utmpay-config", () => {
  const put = (body: unknown) => new Request("https://crm.test/x", { method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

  it("exige settings.account", async () => {
    state.perm = false;
    expect((await configGet()).status).toBe(403);
    expect((await configPut(put({ base_url: "https://utm.exemplo.com" }))).status).toBe(403);
  });
  it("GET nunca devolve segredo, só has_*", async () => {
    state.stored = { enabled: true, base_url: "https://utm.exemplo.com", api_key_enc: "CIFRADO-1", webhook_secret_enc: "CIFRADO-2", janela_dias: 7, send_without_tracking: false };
    const body = await (await configGet()).json();
    expect(body).toMatchObject({ configured: true, has_api_key: true, has_webhook_secret: true, base_url: "https://utm.exemplo.com" });
    expect(JSON.stringify(body)).not.toContain("CIFRADO");
  });
  it("PUT cifra os segredos novos no servidor (resolveSecretForWrite) e mantém os atuais quando vêm vazios", async () => {
    state.stored = { enabled: true, base_url: "https://utm.exemplo.com", api_key_enc: "KEY-ATUAL", webhook_secret_enc: "WH-ATUAL", janela_dias: 7, send_without_tracking: false };
    const res = await configPut(put({ api_key: "nova-chave", webhook_secret: "", janela_dias: 14 }));
    expect(res.status).toBe(200);
    expect(state.upserted).toMatchObject({ account_id: "acc-1", api_key_enc: "ENC(nova-chave)", webhook_secret_enc: "WH-ATUAL", janela_dias: 14, base_url: "https://utm.exemplo.com", updated_by: "u1" });
    const body = await res.json();
    expect(JSON.stringify(body)).not.toMatch(/nova-chave|ENC\(|WH-ATUAL/);
  });
  it("PUT valida (422) e exige base_url na 1ª gravação", async () => {
    expect((await configPut(put({}))).status).toBe(422);
    expect((await configPut(put({ base_url: "http://inseguro.com" }))).status).toBe(422);
    expect((await configPut(put({ base_url: "https://utm.exemplo.com", janela_dias: 0 }))).status).toBe(422);
  });
});

describe("POST /api/account/utmpay-config/test", () => {
  it("exige settings.account e responde só {ok,message} genérico", async () => {
    state.perm = false;
    expect((await testPost()).status).toBe(403);
    state.perm = true;
    expect(await (await testPost()).json()).toEqual({ ok: true, message: "Conexão com o UTMpay funcionando." });
    state.health = "http";
    const bad = await (await testPost()).json();
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).not.toContain("utm.exemplo.com");
    state.health = "net";
    expect((await (await testPost()).json()).message).toBe("Não foi possível alcançar o UTMpay.");
  });
  it("sem configuração ou sem chave/segredo: avisa o que falta; limite de uso: 429", async () => {
    state.config = null;
    expect((await (await testPost()).json()).message).toMatch(/ainda não configurado/);
    state.config = { enabled: true, baseUrl: "https://utm.exemplo.com", apiKey: null, webhookSecret: null, janelaDias: 7, sendWithoutTracking: false };
    expect((await (await testPost()).json()).message).toMatch(/chave da API e segredo do webhook/);
    state.rate = false;
    expect((await testPost()).status).toBe(429);
  });
});
