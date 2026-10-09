import { beforeEach, describe, expect, it, vi } from "vitest";

const writeLog = vi.fn(async () => {});
vi.mock("@/lib/logger", () => ({ writeLog: (...a: unknown[]) => (writeLog as unknown as (...x: unknown[]) => unknown)(...a) }));
vi.mock("@/lib/whatsapp/encryption", () => ({
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => {
    if (!s.startsWith("enc:")) throw new Error("ilegível");
    return s.slice(4);
  },
}));

const { attemptDelivery, drainWebhookDeliveries } = await import("./deliver");
const { SsrfBlockedError } = await import("@/lib/security/ssrf-guard");
const { verifyWebhookSignature } = await import("./signature");

const row = (over: Record<string, unknown> = {}) => ({
  id: "d1",
  account_id: "A",
  endpoint_id: "E1",
  event: "message.received",
  payload: { id: "ev1", type: "message.received", data: { text: "olá" } },
  attempts: 1,
  url: "https://cliente.example/hook",
  secret_enc: "enc:whsec_x",
  ...over,
});

beforeEach(() => writeLog.mockClear());

describe("attemptDelivery", () => {
  it("POST assinado com os cabeçalhos do contrato; 2xx = entregue", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const out = await attemptDelivery(row() as never, fetcher as never, 1_760_000_000_000);
    expect(out).toEqual({ kind: "delivered", http: 204 });
    const [url, init, options] = fetcher.mock.calls[0] as unknown as [string, { method: string; headers: Record<string, string>; body: string }, Record<string, unknown>];
    expect(url).toBe("https://cliente.example/hook");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "content-type": "application/json; charset=utf-8", "x-crm-event": "message.received", "x-crm-delivery": "d1", "x-crm-attempt": "1" });
    expect(init.body).toBe(JSON.stringify(row().payload));
    // o receptor consegue validar exatamente o que recebeu
    expect(verifyWebhookSignature("whsec_x", init.body, init.headers["x-crm-signature"], 1_760_000_000_000)).toEqual({ ok: true });
    // sem redirect, resposta pequena, timeout curto, guard de rede ligado (safeFetch)
    expect(options).toMatchObject({ maxRedirects: 0, timeoutMs: 10_000, maxBytes: 65_536, failOnCrossOriginRedirect: true });
  });

  it.each([[301], [400], [401], [404], [429], [500], [503]])("HTTP %i = falha com nova tentativa", async (status) => {
    const out = await attemptDelivery(row() as never, (async () => new Response("", { status })) as never);
    expect(out).toEqual({ kind: "retry", http: status, error: `HTTP ${status}` });
  });

  it("falhas do guard de rede que não adianta repetir viram dead; timeout/DNS repetem", async () => {
    for (const reason of ["blocked_ip", "blocked_host", "protocol", "invalid_url", "credentials", "too_many_redirects", "cross_origin_redirect"] as const) {
      const out = await attemptDelivery(row() as never, (async () => { throw new SsrfBlockedError(reason); }) as never);
      expect(out).toMatchObject({ kind: "dead", http: null });
    }
    for (const reason of ["timeout", "dns_failure", "response_too_large"] as const) {
      const out = await attemptDelivery(row() as never, (async () => { throw new SsrfBlockedError(reason); }) as never);
      expect(out).toMatchObject({ kind: "retry", http: null });
    }
  });

  it("erro de rede genérico repete e a mensagem não vaza URL/segredo", async () => {
    const out = await attemptDelivery(row() as never, (async () => { throw Object.assign(new Error("connect ECONNREFUSED 10.0.0.1 https://cliente.example/hook?token=s3"), { name: "FetchError" }); }) as never);
    expect(out).toEqual({ kind: "retry", http: null, error: "Falha de rede (FetchError)" });
  });

  it("segredo ilegível = dead (sem chamar a rede)", async () => {
    const fetcher = vi.fn();
    const out = await attemptDelivery(row({ secret_enc: "lixo" }) as never, fetcher as never);
    expect(out.kind).toBe("dead");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("drainWebhookDeliveries", () => {
  function fakeDb(batches: unknown[][], failState: "pending" | "dead" = "pending") {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    let i = 0;
    const db = {
      rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        if (fn === "claim_webhook_deliveries") return { data: batches[i++] ?? [], error: null };
        if (fn === "fail_webhook_delivery") return { data: failState, error: null };
        return { data: true, error: null };
      }),
    };
    return { db: db as never, calls };
  }

  it("entrega, conclui e reporta; para quando a fila esvazia", async () => {
    const { db, calls } = fakeDb([[row({ id: "a" }), row({ id: "b" })]]);
    const summary = await drainWebhookDeliveries(db, { owner: "o1", batch: 20, fetcher: (async () => new Response("", { status: 200 })) as never });
    expect(summary).toEqual({ claimed: 2, delivered: 2, retried: 0, dead: 0 });
    expect(calls.filter((c) => c.fn === "complete_webhook_delivery").map((c) => c.args)).toEqual([
      { p_id: "a", p_owner: "o1", p_http: 200 },
      { p_id: "b", p_owner: "o1", p_http: 200 },
    ]);
    expect(calls.filter((c) => c.fn === "claim_webhook_deliveries")).toHaveLength(1);
  });

  it("falha repete (pending) e a 12ª vira dead com alerta sem URL/corpo", async () => {
    const retry = fakeDb([[row({ id: "a" })]], "pending");
    expect(await drainWebhookDeliveries(retry.db, { owner: "o", fetcher: (async () => new Response("", { status: 503 })) as never })).toMatchObject({ retried: 1, dead: 0 });
    expect(retry.calls.find((c) => c.fn === "fail_webhook_delivery")?.args).toEqual({ p_id: "a", p_owner: "o", p_http: 503, p_error: "HTTP 503", p_final: false });
    expect(writeLog).not.toHaveBeenCalled();

    const dead = fakeDb([[row({ id: "z", attempts: 12 })]], "dead");
    expect(await drainWebhookDeliveries(dead.db, { owner: "o", fetcher: (async () => new Response("", { status: 500 })) as never })).toMatchObject({ retried: 0, dead: 1 });
    expect(writeLog).toHaveBeenCalledTimes(1);
    const log = writeLog.mock.calls[0] as unknown as [{ account_id: string; event: string; payload: Record<string, unknown> }];
    expect(log[0]).toMatchObject({ account_id: "A", event: "webhook_delivery_dead", payload: { delivery_id: "z", endpoint_id: "E1", attempts: 12, last_status: 500 } });
    expect(JSON.stringify(log[0])).not.toMatch(/cliente\.example|olá|whsec/);
  });

  it("erro final (SSRF) chama fail com p_final=true", async () => {
    const { db, calls } = fakeDb([[row()]], "dead");
    await drainWebhookDeliveries(db, { owner: "o", fetcher: (async () => { throw new SsrfBlockedError("blocked_ip"); }) as never });
    expect(calls.find((c) => c.fn === "fail_webhook_delivery")?.args).toMatchObject({ p_final: true, p_http: null });
  });

  it("continua em lotes enquanto vier lote cheio e respeita o orçamento de tempo", async () => {
    const full = (n: number) => Array.from({ length: 2 }, (_, k) => row({ id: `b${n}-${k}` }));
    const { db, calls } = fakeDb([full(1), full(2), full(3), []]);
    const summary = await drainWebhookDeliveries(db, { owner: "o", batch: 2, fetcher: (async () => new Response("", { status: 200 })) as never });
    expect(summary.claimed).toBe(6);
    expect(calls.filter((c) => c.fn === "claim_webhook_deliveries")).toHaveLength(4);

    const zero = fakeDb([full(1)]);
    expect(await drainWebhookDeliveries(zero.db, { owner: "o", budgetMs: 0 })).toEqual({ claimed: 0, delivered: 0, retried: 0, dead: 0 });
  });

  it("erro do claim (ex.: migration 204 ausente) sobe para o cron responder 503", async () => {
    const db = { rpc: async () => ({ data: null, error: { code: "42883", message: "function does not exist" } }) } as never;
    await expect(drainWebhookDeliveries(db, { owner: "o" })).rejects.toMatchObject({ code: "42883" });
  });
});
