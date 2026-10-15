// TESTE DE INTEGRAÇÃO LOCAL, de ponta a ponta: UTMpay (Flask, modo arquivo) ↔ CRM (código REAL) sobre PGlite. Roda com UM comando:
//     npm run test:utmpay-local
// NÃO entra no CI dos PRs (arquivo .e2e.ts fora do include do vitest padrão; config própria). Pré-requisitos: Python portátil e o repositório do
// UTMpay (UTMPAY_PYTHON e UTMPAY_DIR; padrões em utmpay-process.ts). Sem MySQL, sem Supabase remoto, sem rede externa.
//
// O que é real: o UTMpay (processo Python), client.ts + links.ts + dispatch.ts (geração do link em lote), a rota POST /api/integrations/utmpay/events
// (assinatura, relógio, idempotência), ingest.ts (eventos, atribuição, confirmação), stats.ts e a migration 356 (PGlite).
// O que é simulado: o Supabase (adaptador sobre PGlite), a API DDM (situação do acordo) e o `after()` do Next (as tarefas pós-resposta são
// executadas pelo servidor HTTP do teste logo depois de responder).
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { encrypt } from "@/lib/whatsapp/encryption";
import { supabaseOverPglite } from "./pglite-supabase";
import { freePort, localSetup, startUtmpay, type RunningUtmpay } from "./utmpay-process";

// ---------- Simulações (hoisted) ----------
const holder = vi.hoisted(() => ({
  db: null as unknown,
  afterFns: [] as Array<() => Promise<void>>,
  settled: new Map<string, boolean>(),
  // Resposta de localiza_dev por CPF (quando o cenário a define); senão vale `settled`.
  ddmBody: new Map<string, unknown[]>(),
}));

vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: () => holder.db }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ success: true }),
  rateLimitResponse: () => new Response(null, { status: 429 }),
  RATE_LIMITS: { utmpayEvents: { limit: 1_000_000, windowMs: 60_000 } },
}));
vi.mock("next/server", async (orig) => {
  const real = await orig<typeof import("next/server")>();
  return { ...real, after: (fn: () => Promise<void>) => void holder.afterFns.push(fn) };
});
vi.mock("@/lib/billing/ddm-source", async (orig) => {
  const real = await orig<typeof import("@/lib/billing/ddm-source")>();
  return {
    ...real,
    ddmAllowance: () => async () => true,
    // API DDM simulada: a resposta de `localiza_dev` do CPF muda conforme o teste decide; o texto passa pelo interpretador e pelo mapeamento REAIS.
    fetchDdmSituation: async (cpf: string) => {
      const body = holder.ddmBody.get(String(cpf));
      if (body) return real.interpretSituation(body);
      const settled = holder.settled.get(String(cpf)) === true;
      return real.interpretSituation([{ situacao_acordo: settled ? "Quitado" : "Acordo na DDM", valor_em_aberto: settled ? "0,00" : "500,00", instituicao: "Instituição Teste" }]);
    },
  };
});

import { POST as eventsRoute } from "@/app/api/integrations/utmpay/events/route";
import { POST as recheckRoute } from "@/app/api/integrations/utmpay/recheck/route";
import { resetUtmpayConfigCache } from "@/lib/utmpay/config";
import { trackDispatchText } from "@/lib/utmpay/dispatch";
import { detectFromDdm, recheckPendingPayments } from "@/lib/utmpay/ingest";
import { resetLinkQueues } from "@/lib/utmpay/links";
import { signUtmpayBody } from "@/lib/utmpay/signature";
import { loadCampaignFunnel } from "@/lib/utmpay/stats";
import { fetchDdmSituation } from "@/lib/billing/ddm-source";

// ---------- Dados do cenário ----------
const API_KEY = "chave-de-teste-utmpay";
const WEBHOOK_SECRET = "segredo-de-teste-webhook";
const ACC = "00000000-0000-0000-0000-0000000000a1";
const CAMP = "00000000-0000-0000-0000-0000000000d1";
const ATT1 = "00000000-0000-0000-0000-0000000000e1"; // atendente que responde o C3
const ATT2 = "00000000-0000-0000-0000-0000000000e2"; // atendente que respondeu ANTES do envio (não conta)
const CONTACTS = {
  direto: { id: "00000000-0000-0000-0000-0000000000f1", cpf: "12345678909", conv: "00000000-0000-0000-0000-000000000c01", item: "10000000-0000-4000-8000-000000000001" },
  ia: { id: "00000000-0000-0000-0000-0000000000f2", cpf: "11144477735", conv: "00000000-0000-0000-0000-000000000c02", item: "10000000-0000-4000-8000-000000000002" },
  humano: { id: "00000000-0000-0000-0000-0000000000f3", cpf: "52998224725", conv: "00000000-0000-0000-0000-000000000c03", item: "10000000-0000-4000-8000-000000000003" },
} as const;
type Who = keyof typeof CONTACTS;
// Contatos dos cenários de DETECÇÃO por consulta à DDM (o DDMPay hoje só manda `click`): nenhum aviso de funil chega, só o clique.
const EXTRA = {
  detecta: { id: "00000000-0000-0000-0000-0000000000f4", cpf: "86288366757", conv: "00000000-0000-0000-0000-000000000c04", item: "10000000-0000-4000-8000-000000000004" },
  desconhecido: { id: "00000000-0000-0000-0000-0000000000f5", cpf: "05172486305", conv: "00000000-0000-0000-0000-000000000c05", item: "10000000-0000-4000-8000-000000000005" },
  cron: { id: "00000000-0000-0000-0000-0000000000f6", cpf: "16899535009", conv: "00000000-0000-0000-0000-000000000c06", item: "10000000-0000-4000-8000-000000000006" },
} as const;
const DESTINO = "https://ddmacordos.com/acordo/negociar?ref=teste";
const MOBILE_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
const WHATSAPP_UA = "WhatsApp/2.24.10.80 A";

const M356 = readFileSync(resolve("supabase/migrations/356_utmpay_integracao.sql"), "utf8");

interface Delivery {
  eventId: string;
  tid: string;
  etapa: string;
  status: number;
  injected: boolean;
  body: string;
  headers: Record<string, string>;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await wait(100);
  }
  throw new Error(`tempo esgotado esperando: ${what}`);
}

const setup = localSetup();

describe("UTMpay ↔ CRM, ponta a ponta (local)", () => {
  if (setup.missing.length > 0) {
    it("pré-requisitos do teste local", () => {
      throw new Error(`Faltam: ${setup.missing.join("; ")}. Defina UTMPAY_PYTHON e UTMPAY_DIR (veja docs/utmpay.md, "Teste local").`);
    });
    return;
  }

  let pg: PGlite;
  let utm: RunningUtmpay;
  let crm: Server;
  let crmUrl = "";
  const deliveries: Delivery[] = [];
  const failOnce = new Set<string>(); // "tid:etapa" que o CRM processa e responde 500 uma vez (o UTMpay repete com o MESMO event_id)
  const pending = new Set<Promise<void>>();
  const links = new Map<Who, { tid: string; linkCurto: string; text: string }>();
  let loteCalls = 0;

  const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => (await pg.query<T>(sql, params)).rows;
  const linkRow = async (who: Who) => (await q<Record<string, unknown>>(`SELECT * FROM wacrm.utmpay_links WHERE tid = $1`, [CONTACTS[who].item]))[0];
  const eventCount = async (etapa?: string, tid?: string) =>
    (await q<{ n: number }>(`SELECT count(*)::int AS n FROM wacrm.utmpay_events WHERE ($1::text IS NULL OR etapa = $1) AND ($2::text IS NULL OR tid = $2)`, [etapa ?? null, tid ?? null]))[0].n;
  const settleCrm = async () => {
    while (pending.size > 0) await Promise.all([...pending]);
  };
  const delivered = (tid: string, etapa: string) => deliveries.some((d) => d.tid === tid && d.etapa === etapa && d.status === 200);

  async function funil(who: Who, etapa: string) {
    const res = await fetch(`${utm.baseUrl}/api/funil-evento`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tid: CONTACTS[who].item, etapa, url: "https://ddmpay.ddmacordos.com/acesso/" }),
    });
    expect(res.status, `funil-evento ${etapa}`).toBe(200);
    await waitFor(() => delivered(CONTACTS[who].item, etapa), `aviso ${etapa} de ${who} entregue ao CRM`);
  }

  beforeAll(async () => {
    // --- Banco: o mesmo setup do teste da 356 + tabelas do CRM que as libs leem, e a migration REAL ---
    pg = new PGlite();
    await pg.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA wacrm; CREATE SCHEMA auth;
      GRANT USAGE ON SCHEMA wacrm, auth TO authenticated, service_role;
      CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY);
      CREATE TABLE wacrm.campaigns (id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES wacrm.accounts(id), nome text);
      CREATE TABLE wacrm.contacts (id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES wacrm.accounts(id), name text, cpf text);
      CREATE TABLE wacrm.conversations (id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES wacrm.accounts(id), contact_id uuid REFERENCES wacrm.contacts(id));
      CREATE TABLE wacrm.messages (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid NOT NULL REFERENCES wacrm.conversations(id),
        sender_type text, origin text, sender_id uuid, content_text text, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE wacrm.profiles (user_id uuid PRIMARY KEY, full_name text);
      CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
      CREATE FUNCTION wacrm.is_account_member(p_account uuid) RETURNS boolean LANGUAGE sql STABLE AS $f$ SELECT true $f$;
      CREATE FUNCTION wacrm.has_perm(p text) RETURNS boolean LANGUAGE sql STABLE AS $f$ SELECT true $f$;
    `);
    await pg.exec(M356);
    // O CHECK de base_url exige https (produção); o UTMpay local fala http em 127.0.0.1. Só nesta cópia de teste:
    await pg.exec(`ALTER TABLE wacrm.utmpay_config DROP CONSTRAINT utmpay_config_base_url_check`);
    holder.db = supabaseOverPglite(pg);

    await pg.exec(`
      INSERT INTO wacrm.accounts VALUES ('${ACC}');
      INSERT INTO wacrm.campaigns VALUES ('${CAMP}', '${ACC}', 'Cobrança Teste');
      INSERT INTO wacrm.profiles VALUES ('${ATT1}', 'Ana Atendente');
    `);
    for (const [who, c] of Object.entries(CONTACTS)) {
      await pg.exec(`
        INSERT INTO wacrm.contacts VALUES ('${c.id}', '${ACC}', 'Contato ${who}', '${c.cpf}');
        INSERT INTO wacrm.conversations VALUES ('${c.conv}', '${ACC}', '${c.id}');
      `);
    }
    for (const [who, c] of Object.entries(EXTRA)) {
      await pg.exec(`
        INSERT INTO wacrm.contacts VALUES ('${c.id}', '${ACC}', 'Contato ${who}', '${c.cpf}');
        INSERT INTO wacrm.conversations VALUES ('${c.conv}', '${ACC}', '${c.id}');
      `);
    }

    // --- CRM de mentirinha: servidor HTTP que repassa cada aviso ao handler REAL da rota ---
    const crmPort = await freePort();
    crmUrl = `http://127.0.0.1:${crmPort}/api/integrations/utmpay/events`;
    crm = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", async () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
        const response = await eventsRoute(new Request(crmUrl, { method: "POST", headers, body }));
        let parsed: { event_id?: string; tid?: string; etapa?: string } = {};
        try {
          parsed = JSON.parse(body);
        } catch {
          // corpo inválido: o handler já respondeu
        }
        const key = `${parsed.tid}:${parsed.etapa}`;
        const inject = response.status === 200 && failOnce.has(key);
        if (inject) failOnce.delete(key);
        const status = inject ? 500 : response.status;
        const text = await response.text();
        deliveries.push({ eventId: parsed.event_id ?? "", tid: parsed.tid ?? "", etapa: parsed.etapa ?? "", status, injected: inject, body, headers: Object.fromEntries(headers.entries()) });
        res.writeHead(status, { "Content-Type": "application/json" }).end(inject ? '{"error":"falha injetada"}' : text);
        // `after()` do Next: o trabalho pós-resposta roda depois de responder.
        const tasks = holder.afterFns.splice(0);
        const done = Promise.all(tasks.map((t) => t())).then(() => undefined);
        pending.add(done);
        void done.finally(() => pending.delete(done));
      });
    });
    await new Promise<void>((r) => crm.listen(crmPort, "127.0.0.1", r));

    // --- UTMpay real (Python), modo arquivo ---
    utm = await startUtmpay({ python: setup.python, dir: setup.dir, port: await freePort(), apiKey: API_KEY, crmEventsUrl: crmUrl, crmEventsSecret: WEBHOOK_SECRET });

    // --- Configuração do UTMpay da conta (segredos cifrados como na produção) ---
    await pg.query(`INSERT INTO wacrm.utmpay_config (account_id, enabled, base_url, api_key_enc, webhook_secret_enc, janela_dias) VALUES ($1, true, $2, $3, $4, 7)`, [
      ACC,
      utm.baseUrl,
      encrypt(API_KEY),
      encrypt(WEBHOOK_SECRET),
    ]);
    resetUtmpayConfigCache();
    resetLinkQueues();
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((r) => (crm ? crm.close(() => r()) : r()));
    await utm?.stop(); // 6) derruba o UTMpay (e apaga o diretório temporário)
    await pg?.close();
  }, 60_000);

  // ---------------------------------------------------------------------------------------------------------------------
  it("1. gera os links em LOTE pelo client real: 1 chamada ao UTMpay, 1 link por envio (tid = id do item), destino informado preservado", async () => {
    const fetcher = async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
      loteCalls++;
      return fetch(url, init);
    };
    const results = await Promise.all(
      (Object.keys(CONTACTS) as Who[]).map(async (who) => {
        const c = CONTACTS[who];
        const text = `Olá! Negocie sua dívida em ${DESTINO} hoje.`;
        const r = await trackDispatchText(holder.db as never, ACC, { id: c.item, campaign_id: CAMP, contact_id: c.id }, text, { fetcher, windowMs: 100 });
        return { who, text, r };
      }),
    );
    expect(loteCalls).toBe(1);
    for (const { who, text, r } of results) {
      expect(r.kind, who).toBe("tracked");
      if (r.kind !== "tracked") continue;
      const short = r.text.match(/http:\/\/127\.0\.0\.1:\d+\/s\/\w+/)?.[0];
      expect(short, `${who}: link curto no texto`).toBeTruthy();
      expect(r.text).toBe(text.replace(DESTINO, short!)); // só a URL mudou; o resto do texto é idêntico
      links.set(who, { tid: CONTACTS[who].item, linkCurto: short!, text: r.text });
    }
    const rows = await q<{ tid: string; destino: string; link_curto: string; campaign_id: string }>(`SELECT tid, destino, link_curto, campaign_id FROM wacrm.utmpay_links ORDER BY tid`);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.destino).toBe(DESTINO);
      expect(row.campaign_id).toBe(CAMP);
    }
  });

  it("2. destino fora da lista permitida do UTMpay: o link NÃO é gerado e o link cru NÃO sai (failed)", async () => {
    const r = await trackDispatchText(
      holder.db as never,
      ACC,
      { id: "10000000-0000-4000-8000-0000000000ff", campaign_id: CAMP, contact_id: CONTACTS.direto.id },
      "Veja https://golpeddmacordos.com/pague",
      { fetcher: (url, init) => fetch(url, init), windowMs: 10 },
    );
    expect(r).toEqual({ kind: "failed" });
    expect(await q(`SELECT 1 FROM wacrm.utmpay_links WHERE tid = '10000000-0000-4000-8000-0000000000ff'`)).toHaveLength(0);
  });

  it("3. prévia do WhatsApp e HEAD NÃO contam; o clique de celular conta UMA vez (C1)", async () => {
    const { linkCurto } = links.get("direto")!;
    const tid = CONTACTS.direto.item;

    const preview = await fetch(linkCurto, { redirect: "manual", headers: { "User-Agent": WHATSAPP_UA } });
    expect(preview.status).toBe(302);
    expect(preview.headers.get("location")).toContain("ddmacordos.com/acordo/negociar");
    const head = await fetch(linkCurto, { method: "HEAD", redirect: "manual", headers: { "User-Agent": MOBILE_UA } });
    expect(head.status).toBe(302);
    await wait(1500); // dá tempo de um aviso indevido chegar ao CRM
    await settleCrm();
    expect(await eventCount("click", tid), "prévia/HEAD não geram clique").toBe(0);
    expect((await linkRow("direto")).clicou_em).toBeNull();

    const click = await fetch(linkCurto, { redirect: "manual", headers: { "User-Agent": MOBILE_UA } });
    expect(click.status).toBe(302);
    const location = click.headers.get("location") ?? "";
    expect(location).toContain("ddmacordos.com/acordo/negociar"); // vai ao destino informado, não a um checkout fixo
    expect(location).toContain(`tid=${tid}`);
    await waitFor(() => delivered(tid, "click"), "aviso click entregue ao CRM");
    await settleCrm();
    expect(await eventCount("click", tid)).toBe(1);
    expect((await linkRow("direto")).clicou_em).not.toBeNull();
  });

  it("4. os avisos chegam ASSINADOS (HMAC) e sem CPF", async () => {
    expect(deliveries.length).toBeGreaterThan(0);
    for (const d of deliveries) {
      const expected = signUtmpayBody(WEBHOOK_SECRET, d.headers["x-utmpay-timestamp"], d.body);
      expect(d.headers["x-utmpay-signature"], `${d.etapa} assinado`).toBe(expected);
      for (const c of Object.values(CONTACTS)) expect(d.body, "sem CPF no corpo").not.toContain(c.cpf);
      expect(Object.keys(JSON.parse(d.body)).sort()).toEqual(["campanha", "canal", "codigo", "etapa", "event_id", "occurred_at", "tid"]);
    }
  });

  it("5. clique dos outros dois contatos (C2 e C3)", async () => {
    for (const who of ["ia", "humano"] as const) {
      const res = await fetch(links.get(who)!.linkCurto, { redirect: "manual", headers: { "User-Agent": MOBILE_UA } });
      expect(res.status).toBe(302);
      await waitFor(() => delivered(CONTACTS[who].item, "click"), `click de ${who}`);
    }
    await settleCrm();
    expect(await eventCount("click")).toBe(3);
    for (const who of ["direto", "ia", "humano"] as const) expect((await linkRow(who)).clicou_em, who).not.toBeNull();
  });

  it("6. UTMpay recusa evento de funil com tid inexistente (404) e etapa inválida (400)", async () => {
    const post = (body: object) => fetch(`${utm.baseUrl}/api/funil-evento`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect((await post({ tid: "nao-existe", etapa: "paid" })).status).toBe(404);
    expect((await post({ tid: CONTACTS.direto.item, etapa: "comprou" })).status).toBe(400);
  });

  it("7. conversas: monta as mensagens entre o envio e o evento (3 cenários de atribuição)", async () => {
    const link = (await linkRow("ia")).created_at as Date | string;
    // C2: um atendente respondeu ANTES do envio (1 h antes do link): não pode contar.
    await pg.query(`INSERT INTO wacrm.messages (conversation_id, sender_type, origin, sender_id, content_text, created_at) VALUES ($1, 'agent', 'operator', $2, 'conversa antiga', $3::timestamptz - interval '1 hour')`, [CONTACTS.ia.conv, ATT2, link]);
    const msg = (conv: string, type: string, origin: string, sender: string | null, text: string) =>
      pg.query(`INSERT INTO wacrm.messages (conversation_id, sender_type, origin, sender_id, content_text) VALUES ($1, $2, $3, $4, $5)`, [conv, type, origin, sender, text]);
    // C1 (direto): só a própria mensagem do disparo; o contato nunca escreveu.
    await msg(CONTACTS.direto.conv, "agent", "campaign", null, "mensagem do disparo");
    // C2 (ia): o contato escreveu e só a IA respondeu.
    await msg(CONTACTS.ia.conv, "agent", "campaign", null, "mensagem do disparo");
    await msg(CONTACTS.ia.conv, "customer", "customer", null, "quero negociar");
    await msg(CONTACTS.ia.conv, "agent", "ai", null, "claro, vou ajudar");
    // C3 (humano): o contato escreveu, a IA respondeu e depois um atendente humano assumiu.
    await msg(CONTACTS.humano.conv, "agent", "campaign", null, "mensagem do disparo");
    await msg(CONTACTS.humano.conv, "customer", "customer", null, "preciso de um desconto");
    await msg(CONTACTS.humano.conv, "agent", "ai", null, "vou chamar um atendente");
    await msg(CONTACTS.humano.conv, "agent", "operator", ATT1, "oi, aqui é a Ana");
    await wait(1300); // o UTMpay carimba o evento em segundos inteiros: garante que ele vem DEPOIS das mensagens
    expect((await q(`SELECT 1 FROM wacrm.messages`)).length).toBeGreaterThanOrEqual(8);
  });

  it("8. C1 (direto): payment_start e paid confirmado na DDM ⇒ fechou_em, pagou_em, atribuição direto", async () => {
    holder.settled.set(CONTACTS.direto.cpf, true);
    await funil("direto", "cpf_view");
    await funil("direto", "payment_start");
    await funil("direto", "paid");
    await settleCrm();
    await waitFor(async () => (await linkRow("direto")).pagou_em !== null, "pagou_em do C1");
    const row = await linkRow("direto");
    expect(row).toMatchObject({ atribuicao: "direto", atendente_id: null, situacao_acordo: "Quitado", instituicao: "Instituição Teste" });
    expect(row.fechou_em).not.toBeNull();
    expect(Number(row.valor_em_aberto)).toBe(0);
    expect(row.verificado_em).not.toBeNull();
  });

  it("9. C2 (ia): só a IA respondeu ⇒ atribuição ia; a conversa de ANTES do envio é ignorada; reenvio do UTMpay (mesmo event_id) não duplica", async () => {
    holder.settled.set(CONTACTS.ia.cpf, true);
    const tid = CONTACTS.ia.item;
    failOnce.add(`${tid}:payment_start`); // o CRM processa e responde 500 uma vez ⇒ o UTMpay repete com o MESMO event_id
    await funil("ia", "payment_start"); // espera chegar um 200 (a repetição)
    const starts = deliveries.filter((d) => d.tid === tid && d.etapa === "payment_start");
    expect(starts.length, "o UTMpay repetiu a entrega").toBeGreaterThanOrEqual(2);
    expect(starts.some((d) => d.injected)).toBe(true);
    expect(new Set(starts.map((d) => d.eventId)).size, "mesmo event_id nas repetições").toBe(1);
    await settleCrm();
    expect(await eventCount("payment_start", tid), "gravou UMA vez").toBe(1);
    await funil("ia", "paid");
    await settleCrm();
    await waitFor(async () => (await linkRow("ia")).pagou_em !== null, "pagou_em do C2");
    expect(await linkRow("ia")).toMatchObject({ atribuicao: "ia", atendente_id: null });
    expect((await linkRow("ia")).fechou_em).not.toBeNull();
  });

  it("10. C3 (humano): atendente respondeu ⇒ humano com atendente_id; paid NÃO confiado sozinho: só vira pagou_em quando a DDM confirma", async () => {
    holder.settled.set(CONTACTS.humano.cpf, false);
    await funil("humano", "payment_start");
    await funil("humano", "paid");
    await settleCrm();
    await waitFor(async () => (await linkRow("humano")).verificado_em !== null, "verificação do C3 na DDM");
    const before = await linkRow("humano");
    expect(before).toMatchObject({ atribuicao: "humano", atendente_id: ATT1, situacao_acordo: "Acordo na DDM" });
    expect(before.fechou_em).not.toBeNull();
    expect(before.pagou_evento_em, "o evento paid foi recebido").not.toBeNull();
    expect(before.pagou_em, "mas a DDM ainda não confirmou").toBeNull();

    holder.settled.set(CONTACTS.humano.cpf, true); // a DDM passa a confirmar; o cron de conferência confirma
    const result = await recheckPendingPayments(holder.db as never, { situation: (cpf) => fetchDdmSituation(cpf) });
    expect(result).toEqual({ checked: 1, confirmed: 1 });
    const after = await linkRow("humano");
    expect(after.pagou_em).not.toBeNull();
    expect(after.situacao_acordo).toBe("Quitado");
  });

  it("11. idempotência e segurança no CRM: o mesmo aviso reenviado = duplicate (sem duplicar); assinatura errada e relógio velho = 401", async () => {
    const original = deliveries.find((d) => d.tid === CONTACTS.direto.item && d.etapa === "payment_start" && d.status === 200)!;
    const before = await eventCount();
    const send = (body: string, headers: Record<string, string>) => fetch(crmUrl, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });

    const dup = await send(original.body, { "x-utmpay-timestamp": String(Math.floor(Date.now() / 1000)), "x-utmpay-signature": signUtmpayBody(WEBHOOK_SECRET, String(Math.floor(Date.now() / 1000)), original.body) });
    expect(dup.status).toBe(200);
    expect(await dup.json()).toEqual({ status: "duplicate" });
    expect(await eventCount(), "não duplicou").toBe(before);

    const now = String(Math.floor(Date.now() / 1000));
    expect((await send(original.body, { "x-utmpay-timestamp": now, "x-utmpay-signature": signUtmpayBody("segredo-errado", now, original.body) })).status).toBe(401);
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    expect((await send(original.body, { "x-utmpay-timestamp": old, "x-utmpay-signature": signUtmpayBody(WEBHOOK_SECRET, old, original.body) })).status).toBe(401);
    expect((await send(original.body, {})).status).toBe(401);
    expect(await eventCount()).toBe(before);
  });

  it("12. funil da campanha: utmpay_funnel e a lib de estatísticas dão os números certos", async () => {
    const [{ r }] = await q<{ r: Record<string, unknown> }>(`SELECT wacrm.utmpay_funnel($1, $2, NULL) AS r`, [ACC, CAMP]);
    expect(r).toMatchObject({ links: 3, clicou: 3, fechou: 3, pagou: 3 });
    expect(r.por_atribuicao).toEqual({ fechou: { direto: 1, ia: 1, humano: 1 }, pagou: { direto: 1, ia: 1, humano: 1 } });
    expect(r.por_atendente).toEqual([{ atendente_id: ATT1, fechou: 1, pagou: 1 }]);

    const view = await loadCampaignFunnel(holder.db as never, ACC, CAMP, 3); // 3 entregues
    expect(view).toMatchObject({ available: true, tracking: true, entregues: 3, links: 3, clicou: 3, fechou: 3, pagou: 3 });
    expect(view.taxas).toEqual({ clicou: 1, fechou: 1, pagou: 1 });
    expect(view.por_atendente).toEqual([{ atendente_id: ATT1, atendente_nome: "Ana Atendente", fechou: 1, pagou: 1 }]);
  });

  it("13. contagem final de eventos: nenhum evento perdido nem duplicado", async () => {
    // click x3, cpf_view x1, payment_start x3, paid x3 = 10 (a repetição do C2 não conta duas vezes)
    expect(await eventCount()).toBe(10);
    expect(await eventCount("click")).toBe(3);
    expect(await eventCount("payment_start")).toBe(3);
    expect(await eventCount("paid")).toBe(3);
    expect(await eventCount("cpf_view")).toBe(1);
  });

  // ---------------------------------------------------------------------------------------------------------------------
  // DETECÇÃO POR CONSULTA À DDM: o DDMPay (hoje) só manda `click`; fechou/pagou saem do cron de reconferência.
  type Extra = (typeof EXTRA)[keyof typeof EXTRA];
  const rowOf = async (item: string) => (await q<Record<string, unknown>>(`SELECT * FROM wacrm.utmpay_links WHERE tid = $1`, [item]))[0];
  const ddmResponse = (situacao: string, valor = "800,00") => [{ situacao_acordo: situacao, valor_em_aberto: valor, instituicao: "Instituição Teste" }];
  const detect = (opts: { recheckMinutes?: number } = {}) =>
    detectFromDdm(holder.db as never, { situation: (cpf) => fetchDdmSituation(cpf), windowDays: async () => 7 }, opts);

  /** Gera o link rastreado de um contato extra e faz o clique de celular (a ÚNICA coisa que o DDMPay avisa). */
  async function linkAndClick(c: Extra) {
    const r = await trackDispatchText(holder.db as never, ACC, { id: c.item, campaign_id: CAMP, contact_id: c.id }, `Veja ${DESTINO}`, { fetcher: (url, init) => fetch(url, init), windowMs: 10 });
    expect(r.kind).toBe("tracked");
    if (r.kind !== "tracked") return;
    const short = r.text.match(/http:\/\/127\.0\.0\.1:\d+\/s\/\w+/)![0];
    const res = await fetch(short, { redirect: "manual", headers: { "User-Agent": MOBILE_UA } });
    expect(res.status).toBe(302);
    await waitFor(() => delivered(c.item, "click"), `click de ${c.item}`);
    await settleCrm();
  }

  it("14. só chega o CLICK (o DDMPay não manda o funil): o fechou vem pela consulta à DDM, com a atribuição pela conversa", async () => {
    const c = EXTRA.detecta;
    await linkAndClick(c);
    await pg.query(`INSERT INTO wacrm.messages (conversation_id, sender_type, origin, sender_id, content_text) VALUES ($1, 'customer', 'customer', NULL, 'quero fechar'), ($1, 'agent', 'operator', $2, 'vamos fechar')`, [c.conv, ATT1]);
    await wait(1300);
    holder.ddmBody.set(c.cpf, ddmResponse("Acordo na DDM"));

    const result = await detect();
    expect(result).toMatchObject({ checked: 1, fechou: 1, pagou: 0, unknown: 0 });
    const row = await rowOf(c.item);
    expect(row.clicou_em).not.toBeNull();
    expect(row.fechou_em).not.toBeNull();
    expect(row.pagou_em).toBeNull();
    expect(row).toMatchObject({ atribuicao: "humano", atendente_id: ATT1, situacao_acordo: "Acordo na DDM", instituicao: "Instituição Teste" });
    expect(Number(row.valor_em_aberto)).toBe(800);
    // Nenhum aviso de funil chegou: só o click está nos eventos; o resultado veio da DDM.
    expect(await eventCount("click", c.item)).toBe(1);
    expect(await eventCount("payment_start", c.item)).toBe(0);
    expect(await eventCount("paid", c.item)).toBe(0);
  });

  it("15. depois a DDM passa a indicar QUITADO ⇒ pagou_em (o fechou_em que já existia não é sobrescrito)", async () => {
    const c = EXTRA.detecta;
    const before = await rowOf(c.item);
    holder.ddmBody.set(c.cpf, ddmResponse("Quitado", "0,00"));
    const result = await detect({ recheckMinutes: 0 }); // ignora o intervalo mínimo entre consultas do mesmo link
    expect(result).toMatchObject({ checked: 1, fechou: 0, pagou: 1 });
    const after = await rowOf(c.item);
    expect(after.pagou_em).not.toBeNull();
    expect((after.fechou_em as Date).getTime()).toBe((before.fechou_em as Date).getTime());
    expect(after).toMatchObject({ situacao_acordo: "Quitado" });
    expect(Number(after.valor_em_aberto)).toBe(0);
    // pagou ⇒ sai da fila de detecção: uma nova rodada não consulta de novo
    expect(await detect({ recheckMinutes: 0 })).toMatchObject({ checked: 0 });
  });

  it("16. situação DESCONHECIDA: não marca nada e loga uma vez", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = EXTRA.desconhecido;
    await linkAndClick(c);
    holder.ddmBody.set(c.cpf, ddmResponse("status-novo-xyz"));
    expect(await detect()).toMatchObject({ checked: 1, fechou: 0, pagou: 0, unknown: 1 });
    expect(await detect({ recheckMinutes: 0 })).toMatchObject({ checked: 1, unknown: 1 }); // segunda rodada
    const row = await rowOf(c.item);
    expect(row.fechou_em).toBeNull();
    expect(row.pagou_em).toBeNull();
    expect(warn.mock.calls.filter((call) => String(call[0]).includes("situacao_acordo desconhecida"))).toHaveLength(1);
    warn.mockRestore();
  });

  it("17. o cron real (/api/integrations/utmpay/recheck) faz o passo de detecção e exige o segredo", async () => {
    const c = EXTRA.cron;
    await linkAndClick(c);
    holder.ddmBody.set(c.cpf, ddmResponse("Aguardando Pgto"));
    process.env.AUTOMATION_CRON_SECRET = "segredo-do-cron-de-teste";
    const call = (headers: Record<string, string>) => recheckRoute(new Request("http://127.0.0.1/api/integrations/utmpay/recheck", { method: "POST", headers }));

    expect((await call({})).status).toBe(401);
    expect((await call({ "x-cron-secret": "errado" })).status).toBe(401);
    const res = await call({ "x-cron-secret": "segredo-do-cron-de-teste" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { detection: { checked: number; fechou: number; pagou: number } };
    expect(body.detection).toMatchObject({ fechou: 1, pagou: 0 });
    expect((await rowOf(c.item)).fechou_em).not.toBeNull();
    delete process.env.AUTOMATION_CRON_SECRET;
  });
});
