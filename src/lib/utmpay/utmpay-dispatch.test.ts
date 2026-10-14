import { beforeEach, describe, expect, it, vi } from "vitest";

const cfg = vi.hoisted(() => ({
  value: null as null | { enabled: boolean; baseUrl: string; apiKey: string | null; webhookSecret: string | null; janelaDias: number; sendWithoutTracking: boolean },
}));
vi.mock("@/lib/utmpay/config", () => ({
  loadUtmpayConfig: vi.fn(async () => cfg.value),
  resetUtmpayConfigCache: vi.fn(),
}));

import { generateTrackedLinks, UtmpayError, UTMPAY_BATCH_MAX, type UtmpayFetch } from "./client";
import { resetCampaignNameCache, trackDispatchText, trackDispatchVariables, UTMPAY_UNAVAILABLE_ERROR } from "./dispatch";
import { resetLinkQueues } from "./links";

interface Call {
  table: string;
  op: string;
  filters: Record<string, unknown>;
  payload?: unknown;
}

/** Banco falso: registra as chamadas; responde por tabela. */
function fakeDb(handlers: Record<string, (c: Call) => { data?: unknown; error?: { code?: string } | null }>) {
  const calls: Call[] = [];
  const db = {
    from(table: string) {
      const call: Call = { table, op: "select", filters: {} };
      const chain: Record<string, unknown> = {};
      const run = () => {
        calls.push(call);
        const out = (handlers[table] ?? (() => ({ data: null })))(call);
        return { data: out.data ?? null, error: out.error ?? null };
      };
      for (const m of ["select", "order", "limit"]) chain[m] = () => chain;
      chain.eq = (k: string, v: unknown) => ((call.filters[k] = v), chain);
      chain.in = (k: string, v: unknown) => ((call.filters[k] = v), chain);
      chain.upsert = (p: unknown) => ((call.op = "upsert"), (call.payload = p), chain);
      chain.maybeSingle = async () => {
        const r = run();
        return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error };
      };
      chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej);
      return chain;
    },
  };
  return { db: db as never, calls };
}

const ACC = "acc-1";
const item = (id: string, contact = "c-" + id) => ({ id, campaign_id: "camp-1", contact_id: contact });
const config = (over: Partial<NonNullable<typeof cfg.value>> = {}) => ({ enabled: true, baseUrl: "https://utm.exemplo.com", apiKey: "k-123", webhookSecret: "s", janelaDias: 7, sendWithoutTracking: false, ...over });

/** UTMpay falso: devolve um link por aluno. */
function utmpayFetcher(opts: { fail?: number; omit?: string[] } = {}) {
  const requests: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const fetcher: UtmpayFetch = async (url, init) => {
    const body = JSON.parse(init.body) as { alunos: { tid: string }[] };
    requests.push({ url, headers: init.headers, body });
    if (opts.fail) return new Response("erro", { status: opts.fail });
    return new Response(JSON.stringify({ status: "ok", links: body.alunos.filter((a) => !opts.omit?.includes(a.tid)).map((a) => ({ tid: a.tid, codigo: "cd-" + a.tid, link_curto: `https://utm.exemplo.com/s/${a.tid}` })) }), { status: 200 });
  };
  return { fetcher, requests };
}

const stdDb = (over: Record<string, (c: Call) => { data?: unknown; error?: { code?: string } | null }> = {}) =>
  fakeDb({
    utmpay_links: (c) => (c.op === "upsert" ? { error: null } : { data: null }),
    contacts: (c) => ({ data: ((c.filters.id as string[]) ?? []).map((id) => ({ id, cpf: id === "c-cpf" ? "123.456.789-09" : null })) }),
    campaigns: () => ({ data: { nome: "Cobrança Setembro" } }),
    ...over,
  });

beforeEach(() => {
  vi.clearAllMocks();
  resetLinkQueues();
  resetCampaignNameCache();
  cfg.value = config();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("cliente do UTMpay (lote)", () => {
  it("manda X-API-Key, canal, campanha e aluno_id/tid/url_destino por item; devolve por tid", async () => {
    const u = utmpayFetcher();
    const out = await generateTrackedLinks({ baseUrl: "https://utm.exemplo.com", apiKey: "k-123" }, { campanha: "C1", items: [{ tid: "t1", alunoId: "12345678909", destino: "https://ddmacordos.com/p" }] }, u.fetcher);
    expect(u.requests[0].url).toBe("https://utm.exemplo.com/api/gerar-links-lote");
    expect(u.requests[0].headers["X-API-Key"]).toBe("k-123");
    expect(u.requests[0].body).toEqual({ canal: "whatsapp", campanha: "C1", alunos: [{ aluno_id: "12345678909", tid: "t1", url_destino: "https://ddmacordos.com/p" }] });
    expect(out.get("t1")?.linkCurto).toBe("https://utm.exemplo.com/s/t1");
  });
  it("divide lotes acima de 1000 e aproveita resposta parcial (207)", async () => {
    const u = utmpayFetcher();
    const items = Array.from({ length: UTMPAY_BATCH_MAX + 5 }, (_, i) => ({ tid: `t${i}`, alunoId: "x" }));
    const out = await generateTrackedLinks({ baseUrl: "https://u.com", apiKey: "k" }, { campanha: "C", items }, u.fetcher);
    expect(u.requests).toHaveLength(2);
    expect(out.size).toBe(UTMPAY_BATCH_MAX + 5);
  });
  it("sem chave, HTTP de erro e rede viram UtmpayError (5xx/429 retentáveis, 4xx não)", async () => {
    await expect(generateTrackedLinks({ baseUrl: "https://u.com", apiKey: null }, { campanha: "C", items: [{ tid: "t", alunoId: "x" }] })).rejects.toMatchObject({ retryable: false });
    await expect(generateTrackedLinks({ baseUrl: "https://u.com", apiKey: "k" }, { campanha: "C", items: [{ tid: "t", alunoId: "x" }] }, utmpayFetcher({ fail: 503 }).fetcher)).rejects.toMatchObject({ retryable: true });
    await expect(generateTrackedLinks({ baseUrl: "https://u.com", apiKey: "k" }, { campanha: "C", items: [{ tid: "t", alunoId: "x" }] }, utmpayFetcher({ fail: 401 }).fetcher)).rejects.toMatchObject({ retryable: false });
    await expect(generateTrackedLinks({ baseUrl: "https://u.com", apiKey: "k" }, { campanha: "C", items: [{ tid: "t", alunoId: "x" }] }, (async () => { throw new Error("rede"); }) as UtmpayFetch)).rejects.toBeInstanceOf(UtmpayError);
  });
});

describe("WAHA / texto livre: a URL informada vira o DESTINO do link rastreado", () => {
  it("troca a primeira URL; tid = id do item; aluno = CPF do contato; destino = a URL da operação; grava o link", async () => {
    const t = stdDb();
    const u = utmpayFetcher();
    const r = await trackDispatchText(t.db, ACC, item("it-1", "c-cpf"), "Olá! Negocie em https://ddmacordos.com/p?x=1. Obrigado.", { fetcher: u.fetcher, windowMs: 1 });
    expect(r).toEqual({ kind: "tracked", text: "Olá! Negocie em https://utm.exemplo.com/s/it-1. Obrigado." });
    expect(u.requests[0].body).toMatchObject({ campanha: "Cobrança Setembro", canal: "whatsapp", alunos: [{ aluno_id: "12345678909", tid: "it-1", url_destino: "https://ddmacordos.com/p?x=1" }] });
    const saved = t.calls.find((c) => c.table === "utmpay_links" && c.op === "upsert")!.payload as Record<string, unknown>[];
    expect(saved[0]).toMatchObject({ tid: "it-1", account_id: ACC, campaign_id: "camp-1", contact_id: "c-cpf", destino: "https://ddmacordos.com/p?x=1", link_curto: "https://utm.exemplo.com/s/it-1" });
  });
  it("contato sem CPF usa uma chave do contato (nunca telefone)", async () => {
    const u = utmpayFetcher();
    await trackDispatchText(stdDb().db, ACC, item("it-2", "c-sem"), "Veja https://ddmacordos.com/p", { fetcher: u.fetcher, windowMs: 1 });
    expect((u.requests[0].body.alunos as { aluno_id: string }[])[0].aluno_id).toBe("crm-c-sem");
  });
  it("sem URL na mensagem: nada a rastrear; sem config ou desligado: segue como sempre", async () => {
    const u = utmpayFetcher();
    expect(await trackDispatchText(stdDb().db, ACC, item("a"), "Sem link nenhum", { fetcher: u.fetcher })).toEqual({ kind: "unchanged" });
    cfg.value = null;
    expect(await trackDispatchText(stdDb().db, ACC, item("a"), "Veja https://x.com/p", { fetcher: u.fetcher })).toEqual({ kind: "unchanged" });
    cfg.value = config({ enabled: false });
    expect(await trackDispatchText(stdDb().db, ACC, item("a"), "Veja https://x.com/p", { fetcher: u.fetcher })).toEqual({ kind: "unchanged" });
    cfg.value = config({ apiKey: null });
    expect(await trackDispatchText(stdDb().db, ACC, item("a"), "Veja https://x.com/p", { fetcher: u.fetcher })).toEqual({ kind: "unchanged" });
    expect(u.requests).toHaveLength(0);
  });
  it("retry do MESMO envio reaproveita o link gravado (não chama o UTMpay de novo)", async () => {
    const u = utmpayFetcher();
    const t = stdDb({ utmpay_links: () => ({ data: { link_curto: "https://utm.exemplo.com/s/ja-existe" } }) });
    const r = await trackDispatchText(t.db, ACC, item("it-1"), "Veja https://x.com/p", { fetcher: u.fetcher, windowMs: 1 });
    expect(r).toEqual({ kind: "tracked", text: "Veja https://utm.exemplo.com/s/ja-existe" });
    expect(u.requests).toHaveLength(0);
  });
  it("UTMpay fora do ar: o link cru NÃO sai (failed)", async () => {
    const r = await trackDispatchText(stdDb().db, ACC, item("it-1"), "Veja https://x.com/p", { fetcher: utmpayFetcher({ fail: 503 }).fetcher, windowMs: 1 });
    expect(r).toEqual({ kind: "failed" });
    expect(UTMPAY_UNAVAILABLE_ERROR).toMatch(/nada foi enviado ao cliente/);
  });
  it("UTMpay não devolveu o link do item, ou o registro do link falhou: failed", async () => {
    expect(await trackDispatchText(stdDb().db, ACC, item("it-1"), "Veja https://x.com/p", { fetcher: utmpayFetcher({ omit: ["it-1"] }).fetcher, windowMs: 1 })).toEqual({ kind: "failed" });
    const bad = stdDb({ utmpay_links: (c) => (c.op === "upsert" ? { error: { code: "X" } } : { data: null }) });
    expect(await trackDispatchText(bad.db, ACC, item("it-2"), "Veja https://x.com/p", { fetcher: utmpayFetcher().fetcher, windowMs: 1 })).toEqual({ kind: "failed" });
  });
  it("conta que marcou 'enviar sem rastreio se o UTMpay cair': segue com o original", async () => {
    cfg.value = config({ sendWithoutTracking: true });
    const r = await trackDispatchText(stdDb().db, ACC, item("it-1"), "Veja https://x.com/p", { fetcher: utmpayFetcher({ fail: 500 }).fetcher, windowMs: 1 });
    expect(r).toEqual({ kind: "unchanged" });
  });
});

describe("Meta/template: troca só a variável do corpo", () => {
  it("troca a primeira variável com URL (markdown preservado) e não mexe nas demais", async () => {
    const u = utmpayFetcher();
    const r = await trackDispatchVariables(stdDb().db, ACC, item("it-9"), ["Maria", "[Pague aqui](https://ddmacordos.com/p)", "https://outra.com"], { fetcher: u.fetcher, windowMs: 1 });
    expect(r).toEqual({ kind: "tracked", variables: ["Maria", "[Pague aqui](https://utm.exemplo.com/s/it-9)", "https://outra.com"] });
    expect((u.requests[0].body.alunos as { url_destino: string }[])[0].url_destino).toBe("https://ddmacordos.com/p");
  });
  it("sem URL nas variáveis: inalterado; falha do UTMpay: failed", async () => {
    expect(await trackDispatchVariables(stdDb().db, ACC, item("a"), ["Maria", "123"], { fetcher: utmpayFetcher().fetcher })).toEqual({ kind: "unchanged" });
    expect(await trackDispatchVariables(stdDb().db, ACC, item("b"), ["https://x.com/p"], { fetcher: utmpayFetcher({ fail: 502 }).fetcher, windowMs: 1 })).toEqual({ kind: "failed" });
  });
});

describe("agrupamento: os envios simultâneos da campanha viram UMA chamada ao UTMpay", () => {
  it("10 itens ao mesmo tempo ⇒ 1 lote com 10 alunos, cada um com o seu tid e link", async () => {
    const u = utmpayFetcher();
    const t = stdDb();
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => trackDispatchText(t.db, ACC, item(`it-${i}`), `Veja https://x.com/p${i}`, { fetcher: u.fetcher, windowMs: 20 })));
    expect(u.requests).toHaveLength(1);
    expect((u.requests[0].body.alunos as unknown[]).length).toBe(10);
    results.forEach((r, i) => expect(r).toEqual({ kind: "tracked", text: `Veja https://utm.exemplo.com/s/it-${i}` }));
  });
});
