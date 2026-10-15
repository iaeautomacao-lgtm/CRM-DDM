// Migrations 360, 361 e 362 (API pública Onda 1, bloco B): limite de entregas por minuto por endpoint, recipient.status e recipient.funnel.
// PGlite com as migrations REAIS (204 + 360 + 361 + 362) sobre um bootstrap mínimo das tabelas que os triggers leem.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const migration = (file: string) =>
  readFileSync(resolve(process.cwd(), "supabase/migrations", file), "utf8").replace(/NOTIFY pgrst[^;]*;/g, "");

const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
const CAMP = "00000000-0000-0000-0000-0000000000c1";
const CONTACT = "00000000-0000-0000-0000-0000000000d1";
const OWNER = "00000000-0000-0000-0000-0000000000f1";
const OWNER2 = "00000000-0000-0000-0000-0000000000f2";

const BOOTSTRAP = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA wacrm; GRANT USAGE ON SCHEMA wacrm TO anon, authenticated, service_role;
  CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
  CREATE TABLE wacrm.contacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid REFERENCES wacrm.accounts(id), phone text);
  CREATE TABLE wacrm.tags (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid, name text, codigo_tabulacao integer, kind text DEFAULT 'contact');
  CREATE TABLE wacrm.conversations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid REFERENCES wacrm.accounts(id), contact_id uuid REFERENCES wacrm.contacts(id),
    status text NOT NULL DEFAULT 'open', outcome_tag_id uuid REFERENCES wacrm.tags(id), last_message_text text
  );
  CREATE TABLE wacrm.messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid NOT NULL REFERENCES wacrm.conversations(id) ON DELETE CASCADE,
    sender_type text NOT NULL, content_type text NOT NULL DEFAULT 'text', content_text text, media_url text, message_id text,
    status text NOT NULL DEFAULT 'sent', created_at timestamptz DEFAULT now()
  );
  CREATE TABLE wacrm.campaigns (id uuid PRIMARY KEY, account_id uuid, nome text, idempotency_key text);
  CREATE TABLE wacrm.disp_message_queue (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid, campaign_id uuid, contact_id uuid, mensagem_final text,
    status text NOT NULL DEFAULT 'agendado', erro text, erro_codigo integer, cancel_reason text, reference text
  );
  CREATE TABLE wacrm.utmpay_links (
    tid text PRIMARY KEY, account_id uuid NOT NULL, campaign_id uuid, contact_id uuid, clicou_em timestamptz, fechou_em timestamptz,
    pagou_em timestamptz, atribuicao text, atendente_id uuid
  );
  CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
  INSERT INTO wacrm.accounts (id, name) VALUES ('${A}', 'A'), ('${B}', 'B');
  INSERT INTO wacrm.campaigns (id, account_id, nome, idempotency_key) VALUES ('${CAMP}', '${A}', 'Cobrança', 'erp-lote-1');
  INSERT INTO wacrm.contacts (id, account_id, phone) VALUES ('${CONTACT}', '${A}', '+55 (27) 99999-1212');
`;

type Delivery = { event: string; state: string; payload: Record<string, any>; endpoint_id: string };

describe("migrations 360–362 — eventos de campanha e de destinatário", { timeout: 120_000 }, () => {
  let db: PGlite;
  let epRecipient: string;
  let epOther: string;

  const deliveries = async (event?: string) =>
    (await db.query<Delivery>("SELECT event, state, payload, endpoint_id FROM wacrm.webhook_deliveries WHERE ($1::text IS NULL OR event = $1) ORDER BY created_at, id", [event ?? null])).rows;
  const item = async (over: { status?: string; contact?: string | null; msg?: string | null; reference?: string | null } = {}) =>
    (
      await db.query<{ id: string }>(
        "INSERT INTO wacrm.disp_message_queue (account_id, campaign_id, contact_id, mensagem_final, status, reference) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
        [A, CAMP, over.contact === undefined ? CONTACT : over.contact, over.msg ?? null, over.status ?? "enviado", over.reference ?? null],
      )
    ).rows[0].id;
  const setStatus = (id: string, status: string, extra = "") => db.exec(`UPDATE wacrm.disp_message_queue SET status = '${status}' ${extra} WHERE id = '${id}'`);

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(BOOTSTRAP);
    for (const f of ["204_outbound_webhooks.sql", "360_webhook_endpoint_rate_limit.sql", "361_webhook_recipient_status.sql", "362_webhook_recipient_funnel.sql"]) await db.exec(migration(f));
  }, 60_000);
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.exec("DELETE FROM wacrm.webhook_deliveries; DELETE FROM wacrm.webhook_endpoints; DELETE FROM wacrm.disp_message_queue; DELETE FROM wacrm.utmpay_links;");
    epRecipient = (await db.query<{ id: string }>(
      "INSERT INTO wacrm.webhook_endpoints (account_id, url, events, secret_enc) VALUES ($1, 'https://erp.exemplo.com/a', ARRAY['recipient.status','recipient.funnel'], 'x') RETURNING id", [A])).rows[0].id;
    epOther = (await db.query<{ id: string }>(
      "INSERT INTO wacrm.webhook_endpoints (account_id, url, events, secret_enc) VALUES ($1, 'https://outro.exemplo.com/b', ARRAY['recipient.status'], 'x') RETURNING id", [B])).rows[0].id;
  });

  it("registra as migrations e cria os triggers", async () => {
    const versions = (await db.query<{ version: string }>("SELECT version FROM wacrm.schema_migrations WHERE version LIKE '36%' ORDER BY 1")).rows.map((r) => r.version);
    expect(versions).toEqual(["360_webhook_endpoint_rate_limit", "361_webhook_recipient_status", "362_webhook_recipient_funnel"]);
    const triggers = (await db.query<{ tgname: string }>("SELECT tgname FROM pg_trigger WHERE tgname IN ('trg_webhook_queue_status','trg_webhook_utmpay_link') AND NOT tgisinternal ORDER BY 1")).rows;
    expect(triggers).toHaveLength(2);
  });

  describe("recipient.status", () => {
    it("só transições finais: entregue e lido saem; enviado e agendado não", async () => {
      const id = await item({ status: "agendado" });
      await setStatus(id, "enviando");
      await setStatus(id, "enviado");
      expect(await deliveries("recipient.status")).toHaveLength(0);
      await setStatus(id, "entregue");
      await setStatus(id, "lido");
      const rows = await deliveries("recipient.status");
      expect(rows.map((r) => r.payload.data.status)).toEqual(["delivered", "read"]);
      expect(rows[0].payload.data).toMatchObject({
        campaign_id: CAMP, external_id: "erp-lote-1", recipient_id: id, phone: "5527999991212", previous_status: "sent", error: null,
      });
      expect(rows[1].payload.data.previous_status).toBe("delivered");
      expect(rows[0].payload).toMatchObject({ type: "recipient.status", account_id: A });
      expect(rows[0].endpoint_id).toBe(epRecipient); // o endpoint da outra conta não recebe
    });

    it("cada status final sai UMA vez por destinatário (reemitir é idempotente)", async () => {
      const id = await item();
      await setStatus(id, "entregue");
      await setStatus(id, "enviado");
      await setStatus(id, "entregue");
      expect(await deliveries("recipient.status")).toHaveLength(1);
    });

    it("erro: código e tipo classificados, texto técnico NUNCA sai", async () => {
      const id = await item();
      await setStatus(id, "erro", ", erro = 'Meta 131047: Re-engagement message token=SEGREDO', erro_codigo = 131047");
      const [row] = await deliveries("recipient.status");
      expect(row.payload.data).toMatchObject({ status: "error", error: { code: 131047, type: "window_24h" } });
      expect(JSON.stringify(row.payload)).not.toContain("SEGREDO");
      const other = await item();
      await setStatus(other, "erro", ", erro = 'Variável {{2}} vazia', erro_codigo = NULL");
      const rows = await deliveries("recipient.status");
      expect(rows[1].payload.data.error).toEqual({ code: null, type: "empty_variable" });
    });

    it("removido (cancel_reason removed_api:) sai como removed; encerramento de campanha (cancelado sem motivo) NÃO sai", async () => {
      const removed = await item({ status: "agendado", reference: "contrato-77" });
      await setStatus(removed, "cancelado", ", cancel_reason = 'removed_api:paid'");
      const stopped = await item({ status: "agendado" });
      await setStatus(stopped, "cancelado");
      const rows = await deliveries("recipient.status");
      expect(rows).toHaveLength(1);
      expect(rows[0].payload.data).toMatchObject({ status: "removed", previous_status: "queued", reference: "contrato-77" });
    });

    it("bloqueado (opt-out/blacklist no envio) sai como blocked", async () => {
      const id = await item({ status: "agendado" });
      await setStatus(id, "bloqueado");
      expect((await deliveries("recipient.status"))[0].payload.data.status).toBe("blocked");
    });

    it("contato externo da campanha da API: o telefone vem de mensagem_final", async () => {
      const id = await item({ contact: null, msg: "+55 11 98888-0000" });
      await setStatus(id, "entregue");
      expect((await deliveries("recipient.status"))[0].payload.data.phone).toBe("5511988880000");
    });

    it("sem endpoint assinando o tipo, nada é enfileirado (custo zero) e o UPDATE nunca falha", async () => {
      await db.exec("UPDATE wacrm.webhook_endpoints SET events = ARRAY['message.received']");
      const id = await item();
      await setStatus(id, "entregue");
      expect(await deliveries()).toHaveLength(0);
      expect((await db.query<{ status: string }>("SELECT status FROM wacrm.disp_message_queue WHERE id = $1", [id])).rows[0].status).toBe("entregue");
    });

    it("endpoint pausado não recebe; a falha do trigger nunca derruba o envio", async () => {
      await db.exec("UPDATE wacrm.webhook_endpoints SET status = 'paused'");
      const id = await item();
      await setStatus(id, "entregue");
      expect(await deliveries()).toHaveLength(0);
      await db.exec("UPDATE wacrm.webhook_endpoints SET status = 'active'");
      await db.exec("ALTER TABLE wacrm.webhook_deliveries RENAME TO webhook_deliveries_x");
      await setStatus(id, "lido"); // o INSERT da fila falha por dentro: vira WARNING, o UPDATE do envio passa
      await db.exec("ALTER TABLE wacrm.webhook_deliveries_x RENAME TO webhook_deliveries");
      expect((await db.query<{ status: string }>("SELECT status FROM wacrm.disp_message_queue WHERE id = $1", [id])).rows[0].status).toBe("lido");
    });

    it("INSERT na fila (ex.: adicionar contatos à campanha) não dispara", async () => {
      await item({ status: "entregue" });
      expect(await deliveries()).toHaveLength(0);
    });
  });

  describe("recipient.funnel", () => {
    it("clicou → clicked; fechou só sai quando a atribuição existe (uma vez); pagou idem", async () => {
      const id = await item();
      await db.query("INSERT INTO wacrm.utmpay_links (tid, account_id, campaign_id, contact_id) VALUES ($1, $2, $3, $4)", [id, A, CAMP, CONTACT]);
      await db.exec(`UPDATE wacrm.utmpay_links SET clicou_em = '2026-10-15T10:00:00Z' WHERE tid = '${id}'`);
      await db.exec(`UPDATE wacrm.utmpay_links SET fechou_em = '2026-10-15T10:05:00Z' WHERE tid = '${id}'`); // sem atribuição ainda
      expect((await deliveries("recipient.funnel")).map((r) => r.payload.data.step)).toEqual(["clicked"]);
      await db.exec(`UPDATE wacrm.utmpay_links SET atribuicao = 'ia', atendente_id = '${OWNER}' WHERE tid = '${id}'`);
      await db.exec(`UPDATE wacrm.utmpay_links SET pagou_em = '2026-10-15T11:00:00Z' WHERE tid = '${id}'`);
      await db.exec(`UPDATE wacrm.utmpay_links SET atribuicao = 'ia' WHERE tid = '${id}'`); // repetido: nada novo
      const rows = await deliveries("recipient.funnel");
      expect(rows.map((r) => r.payload.data.step)).toEqual(["clicked", "closed", "paid"]);
      expect(rows[0].payload.data).toMatchObject({ campaign_id: CAMP, external_id: "erp-lote-1", recipient_id: id, phone: "5527999991212", attribution: null });
      expect(rows[1].payload.data).toMatchObject({ attribution: "ai", attendant_id: OWNER, at: "2026-10-15T10:05:00.000Z" });
      expect(rows[2].payload.data).toMatchObject({ attribution: "ai", at: "2026-10-15T11:00:00.000Z" });
    });

    it("todos os marcos num único UPDATE (detecção pela DDM) saem na mesma hora, com a atribuição; mapa direto/humano", async () => {
      const id = await item();
      await db.query("INSERT INTO wacrm.utmpay_links (tid, account_id, campaign_id, contact_id) VALUES ($1, $2, $3, $4)", [id, A, CAMP, CONTACT]);
      await db.exec(`UPDATE wacrm.utmpay_links SET clicou_em = now(), fechou_em = now(), pagou_em = now(), atribuicao = 'humano' WHERE tid = '${id}'`);
      const rows = await deliveries("recipient.funnel");
      expect(rows.map((r) => r.payload.data.step).sort()).toEqual(["clicked", "closed", "paid"]);
      expect(rows.find((r) => r.payload.data.step === "paid")!.payload.data.attribution).toBe("human");
      const id2 = await item();
      await db.query("INSERT INTO wacrm.utmpay_links (tid, account_id) VALUES ($1, $2)", [id2, A]);
      await db.exec(`UPDATE wacrm.utmpay_links SET fechou_em = now(), atribuicao = 'direto' WHERE tid = '${id2}'`);
      expect((await deliveries("recipient.funnel")).find((r) => r.payload.data.recipient_id === id2)!.payload.data.attribution).toBe("direct");
    });

    it("pagou_evento_em (sem a confirmação da DDM) não gera evento; tid que não é item e conta sem assinatura também não", async () => {
      await db.exec("INSERT INTO wacrm.utmpay_links (tid, account_id) VALUES ('abc123', '" + A + "')");
      await db.exec("UPDATE wacrm.utmpay_links SET clicou_em = now() WHERE tid = 'abc123'");
      expect(await deliveries()).toHaveLength(0);
      await db.exec("UPDATE wacrm.webhook_endpoints SET events = ARRAY['recipient.status'] WHERE id = '" + epRecipient + "'");
      const id = await item();
      await db.query("INSERT INTO wacrm.utmpay_links (tid, account_id) VALUES ($1, $2)", [id, A]);
      await db.exec(`UPDATE wacrm.utmpay_links SET clicou_em = now() WHERE tid = '${id}'`);
      expect(await deliveries("recipient.funnel")).toHaveLength(0);
    });
  });

  describe("limite por endpoint (migration 360)", () => {
    const enqueue = async (endpoint: string, n: number) => {
      for (let i = 0; i < n; i++) {
        await db.query(
          "INSERT INTO wacrm.webhook_deliveries (account_id, endpoint_id, event_id, event, payload) VALUES ((SELECT account_id FROM wacrm.webhook_endpoints WHERE id = $1), $1, gen_random_uuid(), 'recipient.status', '{}'::jsonb)",
          [endpoint],
        );
      }
    };
    const claim = async (limit = 100) =>
      (await db.query<{ endpoint_id: string; attempts: number }>("SELECT endpoint_id, attempts FROM wacrm.claim_webhook_deliveries($1::uuid, $2)", [OWNER2, limit])).rows;

    it("o padrão é 600/min e o CHECK exige 1..6000", async () => {
      expect((await db.query<{ r: number }>("SELECT rate_limit_per_minute AS r FROM wacrm.webhook_endpoints WHERE id = $1", [epRecipient])).rows[0].r).toBe(600);
      await expect(db.exec(`UPDATE wacrm.webhook_endpoints SET rate_limit_per_minute = 0 WHERE id = '${epRecipient}'`)).rejects.toThrow();
      await expect(db.exec(`UPDATE wacrm.webhook_endpoints SET rate_limit_per_minute = 6001 WHERE id = '${epRecipient}'`)).rejects.toThrow();
    });

    it("reserva só até o orçamento do minuto; o resto fica pending (sem gastar tentativa) e sai quando a janela abre", async () => {
      await db.exec(`UPDATE wacrm.webhook_endpoints SET rate_limit_per_minute = 3 WHERE id = '${epRecipient}'`);
      await enqueue(epRecipient, 10);
      const first = await claim();
      expect(first).toHaveLength(3);
      expect(first.every((r) => r.attempts === 1)).toBe(true);
      expect(await claim()).toHaveLength(0); // orçamento do minuto esgotado
      const pending = (await db.query<{ n: string; a: string }>("SELECT count(*) AS n, max(attempts) AS a FROM wacrm.webhook_deliveries WHERE state = 'pending'")).rows[0];
      expect(Number(pending.n)).toBe(7);
      expect(Number(pending.a)).toBe(0); // o que esperou não gastou tentativa
      await db.exec("UPDATE wacrm.webhook_deliveries SET last_claimed_at = now() - interval '2 minutes' WHERE last_claimed_at IS NOT NULL");
      expect(await claim()).toHaveLength(3);
    });

    it("o limite de um endpoint não segura o outro", async () => {
      await db.exec(`UPDATE wacrm.webhook_endpoints SET rate_limit_per_minute = 1 WHERE id = '${epRecipient}'`);
      await enqueue(epRecipient, 5);
      await enqueue(epOther, 5);
      const got = await claim();
      expect(got.filter((r) => r.endpoint_id === epRecipient)).toHaveLength(1);
      expect(got.filter((r) => r.endpoint_id === epOther)).toHaveLength(5);
    });

    it("endpoint pausado não é reservado; p_limit continua valendo no total", async () => {
      await enqueue(epRecipient, 5);
      await enqueue(epOther, 5);
      await db.exec(`UPDATE wacrm.webhook_endpoints SET status = 'paused' WHERE id = '${epOther}'`);
      expect((await claim()).every((r) => r.endpoint_id === epRecipient)).toBe(true);
      await db.exec("UPDATE wacrm.webhook_deliveries SET state = 'pending', attempts = 0, owner_id = NULL, lease_until = NULL, last_claimed_at = NULL");
      await db.exec(`UPDATE wacrm.webhook_endpoints SET status = 'active' WHERE id = '${epOther}'`);
      expect(await claim(4)).toHaveLength(4);
    });
  });
});
