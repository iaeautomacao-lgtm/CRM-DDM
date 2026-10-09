// Migration 204 (PRD 15, 15.14): webhooks de saída — endpoints, fila de entregas (outbox), RPCs e triggers.
// PGlite com a migration REAL sobre um bootstrap mínimo das tabelas que os triggers leem.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const migration = (file: string) =>
  readFileSync(resolve(process.cwd(), "supabase/migrations", file), "utf8").replace(/NOTIFY pgrst[^;]*;/g, "");

const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
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
  CREATE TABLE wacrm.blacklist (id bigserial PRIMARY KEY, account_id uuid, telefone text NOT NULL UNIQUE, motivo text, bloqueado_por text);
  CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
  INSERT INTO wacrm.accounts (id, name) VALUES ('${A}', 'A'), ('${B}', 'B');
`;

type Delivery = { event: string; state: string; attempts: number; endpoint_id: string; account_id: string; payload: Record<string, any>; last_error: string | null };

describe("migration 204 — webhooks de saída", { timeout: 120_000 }, () => {
  let db: PGlite;
  let contact: string;
  let conv: string;
  let epAll: string;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(BOOTSTRAP);
    await db.exec(migration("204_outbound_webhooks.sql"));
  }, 60_000);
  afterAll(async () => {
    await db.close();
  }, 60_000);

  const endpoint = async (account: string, events: string[], status = "active", url = "https://cliente.example/hook") =>
    (await db.query<{ id: string }>(
      `INSERT INTO wacrm.webhook_endpoints (account_id, url, events, secret_enc, status) VALUES ($1, $2, $3::text[], 'enc:secret', $4) RETURNING id`,
      [account, url, events, status],
    )).rows[0].id;
  const deliveries = async (where = "true") =>
    (await db.query<Delivery>(`SELECT event, state, attempts, endpoint_id, account_id, payload, last_error FROM wacrm.webhook_deliveries WHERE ${where} ORDER BY created_at, id`)).rows;

  beforeEach(async () => {
    await db.exec(`
      DELETE FROM wacrm.webhook_deliveries; DELETE FROM wacrm.webhook_endpoints; DELETE FROM wacrm.messages; DELETE FROM wacrm.conversations;
      DELETE FROM wacrm.blacklist; DELETE FROM wacrm.tags; DELETE FROM wacrm.contacts;
      ALTER TABLE wacrm.webhook_deliveries DROP CONSTRAINT IF EXISTS boom;
    `);
    contact = (await db.query<{ id: string }>(`INSERT INTO wacrm.contacts (account_id, phone) VALUES ('${A}', '5521999991234') RETURNING id`)).rows[0].id;
    conv = (await db.query<{ id: string }>(`INSERT INTO wacrm.conversations (account_id, contact_id) VALUES ('${A}', '${contact}') RETURNING id`)).rows[0].id;
    epAll = await endpoint(A, ["message.received", "message.status", "conversation.closed", "agreement.created", "contact.opt_out"]);
  });

  describe("fan-out e idempotência", () => {
    it("uma entrega por endpoint ativo que assina o evento; pausado, outro evento e outra conta ficam de fora", async () => {
      await endpoint(A, ["message.received"]);
      await endpoint(A, ["message.received"], "paused");
      await endpoint(A, ["conversation.closed"]);
      await endpoint(B, ["message.received"]);
      const n = (await db.query<{ n: number }>(`SELECT wacrm.enqueue_webhook_event('${A}', 'message.received', gen_random_uuid(), '{"x":1}') AS n`)).rows[0].n;
      expect(n).toBe(2); // epAll + o 1º extra
      const rows = await deliveries();
      expect(rows).toHaveLength(2);
      expect(rows[0].payload).toMatchObject({ type: "message.received", account_id: A, data: { x: 1 } });
      expect(rows[0].payload.created_at).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
    });

    it("o mesmo event_id não duplica (idempotente por endpoint+evento)", async () => {
      const id = "11111111-1111-4111-8111-111111111111";
      await db.exec(`SELECT wacrm.enqueue_webhook_event('${A}', 'message.received', '${id}', '{}')`);
      const again = (await db.query<{ n: number }>(`SELECT wacrm.enqueue_webhook_event('${A}', 'message.received', '${id}', '{}') AS n`)).rows[0].n;
      expect(again).toBe(0);
      expect(await deliveries()).toHaveLength(1);
    });

    it("sem endpoint assinando, nada é gravado", async () => {
      await db.exec(`DELETE FROM wacrm.webhook_endpoints`);
      await db.exec(`INSERT INTO wacrm.messages (conversation_id, sender_type, content_text) VALUES ('${conv}', 'customer', 'oi')`);
      expect(await deliveries()).toEqual([]);
    });
  });

  describe("triggers (outbox transacional)", () => {
    it("message.received: só mensagem de cliente, com telefone e texto", async () => {
      await db.exec(`INSERT INTO wacrm.messages (conversation_id, sender_type, content_text, message_id) VALUES ('${conv}', 'agent', 'resposta', 'wamid.out')`);
      expect(await deliveries()).toEqual([]);
      const id = (await db.query<{ id: string }>(`INSERT INTO wacrm.messages (conversation_id, sender_type, content_text, message_id) VALUES ('${conv}', 'customer', 'quero negociar', 'wamid.in') RETURNING id`)).rows[0].id;
      const [d] = await deliveries();
      expect(d.event).toBe("message.received");
      expect(d.payload.data).toMatchObject({
        message_id: id, provider_message_id: "wamid.in", conversation_id: conv, contact_id: contact,
        phone: "5521999991234", content_type: "text", text: "quero negociar", has_media: false,
      });
    });

    it("message.status: mudança de status da mensagem enviada, com o status anterior; sem mudança não gera", async () => {
      const id = (await db.query<{ id: string }>(`INSERT INTO wacrm.messages (conversation_id, sender_type, content_text, status) VALUES ('${conv}', 'agent', 'oi', 'sent') RETURNING id`)).rows[0].id;
      await db.exec(`UPDATE wacrm.messages SET status = 'sent' WHERE id = '${id}'`);
      expect(await deliveries()).toEqual([]);
      await db.exec(`UPDATE wacrm.messages SET status = 'delivered' WHERE id = '${id}'`);
      await db.exec(`UPDATE wacrm.messages SET status = 'read' WHERE id = '${id}'`);
      const rows = await deliveries();
      expect(rows.map((r) => r.payload.data.status)).toEqual(["delivered", "read"]);
      expect(rows[1].payload.data).toMatchObject({ previous_status: "delivered", message_id: id });
    });

    it("conversation.closed: uma vez, com a tabulação; reabrir e fechar de novo gera outro evento", async () => {
      const tag = (await db.query<{ id: string }>(`INSERT INTO wacrm.tags (account_id, name, codigo_tabulacao, kind) VALUES ('${A}', 'Sem acordo', 7, 'outcome') RETURNING id`)).rows[0].id;
      await db.exec(`UPDATE wacrm.conversations SET status = 'closed', outcome_tag_id = '${tag}' WHERE id = '${conv}'`);
      await db.exec(`UPDATE wacrm.conversations SET last_message_text = 'x' WHERE id = '${conv}'`);
      let rows = await deliveries();
      expect(rows.map((r) => r.event)).toEqual(["conversation.closed"]);
      expect(rows[0].payload.data).toMatchObject({ conversation_id: conv, contact_id: contact, outcome: { tag_id: tag, name: "Sem acordo", code: 7 } });
      await db.exec(`UPDATE wacrm.conversations SET status = 'open' WHERE id = '${conv}'`);
      await db.exec(`UPDATE wacrm.conversations SET status = 'closed' WHERE id = '${conv}'`);
      rows = await deliveries();
      expect(rows.map((r) => r.event)).toEqual(["conversation.closed", "conversation.closed"]);
      expect(rows[1].payload.data.outcome).toMatchObject({ tag_id: tag });
    });

    it("agreement.created: tabulação 142 'Acordo Realizado' (e conversation.closed junto se fechou)", async () => {
      const acordo = (await db.query<{ id: string }>(`INSERT INTO wacrm.tags (account_id, name, codigo_tabulacao, kind) VALUES ('${A}', 'Acordo Realizado', 142, 'outcome') RETURNING id`)).rows[0].id;
      await db.exec(`UPDATE wacrm.conversations SET outcome_tag_id = '${acordo}' WHERE id = '${conv}'`);
      let rows = await deliveries();
      expect(rows.map((r) => r.event)).toEqual(["agreement.created"]);
      expect(rows[0].payload.data).toMatchObject({ conversation_id: conv, contact_id: contact, tabulation_code: 142, tabulation: "Acordo Realizado" });
      await db.exec(`UPDATE wacrm.conversations SET status = 'closed' WHERE id = '${conv}'`);
      rows = await deliveries();
      expect(rows.map((r) => r.event)).toEqual(["agreement.created", "conversation.closed"]);
    });

    it("contact.opt_out: INSERT e UPSERT para opt_out; outro motivo não gera; telefone só dígitos", async () => {
      await db.exec(`INSERT INTO wacrm.blacklist (account_id, telefone, motivo, bloqueado_por) VALUES ('${A}', '+55 (21) 99999-1234', 'manual', 'operador')`);
      expect(await deliveries()).toEqual([]);
      await db.exec(`UPDATE wacrm.blacklist SET motivo = 'opt_out', bloqueado_por = 'ai_priority_guard'`);
      await db.exec(`INSERT INTO wacrm.blacklist (account_id, telefone, motivo, bloqueado_por) VALUES ('${A}', '5511900000000', 'opt_out', 'ai_priority_guard')`);
      await db.exec(`INSERT INTO wacrm.blacklist (account_id, telefone, motivo) VALUES ('${A}', '5511977777777', 'opt_out') ON CONFLICT (telefone) DO UPDATE SET motivo = 'opt_out'`);
      await db.exec(`UPDATE wacrm.blacklist SET bloqueado_por = 'outro' WHERE telefone = '5511900000000'`); // já era opt_out: sem novo evento
      const rows = await deliveries();
      expect(rows.map((r) => r.payload.data)).toEqual([
        { phone: "5521999991234", reason: "opt_out", source: "ai_priority_guard" },
        { phone: "5511900000000", reason: "opt_out", source: "ai_priority_guard" },
        { phone: "5511977777777", reason: "opt_out", source: null },
      ]);
    });

    it("conta sem endpoint para o evento não gera nada (isolamento por conta)", async () => {
      const contactB = (await db.query<{ id: string }>(`INSERT INTO wacrm.contacts (account_id, phone) VALUES ('${B}', '5511911112222') RETURNING id`)).rows[0].id;
      const convB = (await db.query<{ id: string }>(`INSERT INTO wacrm.conversations (account_id, contact_id) VALUES ('${B}', '${contactB}') RETURNING id`)).rows[0].id;
      await db.exec(`INSERT INTO wacrm.messages (conversation_id, sender_type, content_text) VALUES ('${convB}', 'customer', 'oi da B')`);
      expect(await deliveries()).toEqual([]);
    });

    it("falha do outbox NUNCA derruba a escrita original (mensagem, conversa e blacklist entram)", async () => {
      await db.exec(`ALTER TABLE wacrm.webhook_deliveries ADD CONSTRAINT boom CHECK (false) NOT VALID`);
      await db.exec(`INSERT INTO wacrm.messages (conversation_id, sender_type, content_text) VALUES ('${conv}', 'customer', 'oi')`);
      await db.exec(`UPDATE wacrm.conversations SET status = 'closed' WHERE id = '${conv}'`);
      await db.exec(`INSERT INTO wacrm.blacklist (account_id, telefone, motivo) VALUES ('${A}', '5511900000001', 'opt_out')`);
      expect((await db.query(`SELECT count(*)::int AS n FROM wacrm.messages`)).rows[0]).toEqual({ n: 1 });
      expect((await db.query(`SELECT status FROM wacrm.conversations WHERE id = '${conv}'`)).rows[0]).toEqual({ status: "closed" });
      expect((await db.query(`SELECT count(*)::int AS n FROM wacrm.blacklist`)).rows[0]).toEqual({ n: 1 });
      expect(await deliveries()).toEqual([]);
    });
  });

  describe("claim / complete / fail / replay", () => {
    const enqueue = (account = A, event = "message.received") =>
      db.query(`SELECT wacrm.enqueue_webhook_event($1, $2, gen_random_uuid(), '{}')`, [account, event]);
    const claim = async (owner = OWNER, limit = 20) =>
      (await db.query<{ id: string; attempts: number; url: string; secret_enc: string; payload: Record<string, any> }>(`SELECT * FROM wacrm.claim_webhook_deliveries($1, $2)`, [owner, limit])).rows;

    it("reserva só o que está devido; traz url e segredo cifrado; incrementa tentativas; segunda reserva não repete", async () => {
      await enqueue();
      const [c] = await claim();
      expect(c).toMatchObject({ attempts: 1, url: "https://cliente.example/hook", secret_enc: "enc:secret" });
      expect(c.payload.type).toBe("message.received");
      expect(await claim(OWNER2)).toEqual([]);
      expect((await deliveries())[0].state).toBe("sending");
    });

    it("endpoint pausado não é reservado e a entrega fica esperando; ao reativar sai", async () => {
      await enqueue();
      await db.exec(`UPDATE wacrm.webhook_endpoints SET status = 'paused'`);
      expect(await claim()).toEqual([]);
      await db.exec(`UPDATE wacrm.webhook_endpoints SET status = 'active'`);
      expect(await claim()).toHaveLength(1);
    });

    it("respeita o limite e a ordem por next_attempt_at", async () => {
      for (let i = 0; i < 5; i++) await enqueue();
      expect(await claim(OWNER, 3)).toHaveLength(3);
      expect(await claim(OWNER2, 10)).toHaveLength(2);
    });

    it("lease vencido volta à fila; com 12 tentativas já consumidas vira dead", async () => {
      await enqueue();
      await claim();
      await db.exec(`UPDATE wacrm.webhook_deliveries SET lease_until = now() - interval '1 second'`);
      const [again] = await claim(OWNER2);
      expect(again.attempts).toBe(2);
      await db.exec(`UPDATE wacrm.webhook_deliveries SET lease_until = now() - interval '1 second', attempts = 12`);
      expect(await claim(OWNER)).toEqual([]);
      expect((await deliveries())[0]).toMatchObject({ state: "dead" });
    });

    it("complete: só o dono do lease conclui; zera as falhas consecutivas do endpoint", async () => {
      await enqueue();
      const [c] = await claim();
      await db.exec(`UPDATE wacrm.webhook_endpoints SET consecutive_failures = 4`);
      expect((await db.query<{ ok: boolean }>(`SELECT wacrm.complete_webhook_delivery('${c.id}', '${OWNER2}', 200) AS ok`)).rows[0].ok).toBe(false);
      expect((await db.query<{ ok: boolean }>(`SELECT wacrm.complete_webhook_delivery('${c.id}', '${OWNER}', 200) AS ok`)).rows[0].ok).toBe(true);
      expect((await deliveries())[0].state).toBe("delivered");
      expect((await db.query(`SELECT consecutive_failures, last_success_at IS NOT NULL AS ok FROM wacrm.webhook_endpoints`)).rows[0]).toEqual({ consecutive_failures: 0, ok: true });
    });

    it("fail: backoff 30 s · 2^(n-1) com teto de 1 h (±10 %), conta falha do endpoint", async () => {
      await enqueue();
      const expected = [30, 60, 120, 240, 480, 960, 1920, 3600, 3600];
      for (let i = 0; i < expected.length; i++) {
        const [c] = await claim();
        expect(c.attempts).toBe(i + 1);
        const state = (await db.query<{ s: string }>(`SELECT wacrm.fail_webhook_delivery('${c.id}', '${OWNER}', 503, 'HTTP 503') AS s`)).rows[0].s;
        expect(state).toBe("pending");
        const wait = (await db.query<{ w: number }>(`SELECT extract(epoch FROM next_attempt_at - now())::float AS w FROM wacrm.webhook_deliveries`)).rows[0].w;
        expect(wait).toBeGreaterThan(expected[i] * 0.85);
        expect(wait).toBeLessThan(expected[i] * 1.15);
        await db.exec(`UPDATE wacrm.webhook_deliveries SET next_attempt_at = now()`);
      }
      expect((await db.query(`SELECT consecutive_failures FROM wacrm.webhook_endpoints`)).rows[0]).toEqual({ consecutive_failures: 9 });
    });

    it("12ª falha → dead (e fica fora da fila); erro final (SSRF) → dead na hora; lease alheio → NULL", async () => {
      await enqueue();
      await enqueue();
      await db.exec(`UPDATE wacrm.webhook_deliveries SET attempts = 11`);
      const claimed = await claim(OWNER, 1);
      const state = (await db.query<{ s: string }>(`SELECT wacrm.fail_webhook_delivery('${claimed[0].id}', '${OWNER}', 500, 'HTTP 500') AS s`)).rows[0].s;
      expect(state).toBe("dead");
      const [second] = await claim(OWNER);
      expect((await db.query<{ s: string | null }>(`SELECT wacrm.fail_webhook_delivery('${second.id}', '${OWNER2}', NULL, 'x') AS s`)).rows[0].s).toBeNull();
      expect((await db.query<{ s: string }>(`SELECT wacrm.fail_webhook_delivery('${second.id}', '${OWNER}', NULL, 'host bloqueado', true) AS s`)).rows[0].s).toBe("dead");
      const rows = await deliveries();
      expect(rows.map((r) => r.state)).toEqual(["dead", "dead"]);
      expect(rows.map((r) => r.last_error).sort()).toEqual(["HTTP 500", "host bloqueado"]);
      expect(await claim()).toEqual([]);
    });

    it("replay: só dead, da conta e do endpoint certos; zera as tentativas", async () => {
      await enqueue();
      const [c] = await claim();
      await db.exec(`SELECT wacrm.fail_webhook_delivery('${c.id}', '${OWNER}', 500, 'x', true)`);
      const replay = (account: string, ep: string) =>
        db.query<{ ok: boolean }>(`SELECT wacrm.replay_webhook_delivery('${account}', '${ep}', '${c.id}') AS ok`).then((r) => r.rows[0].ok);
      expect(await replay(B, epAll)).toBe(false);
      expect(await replay(A, "00000000-0000-0000-0000-0000000000ee")).toBe(false);
      expect(await replay(A, epAll)).toBe(true);
      expect(await replay(A, epAll)).toBe(false); // já não está dead
      expect((await deliveries())[0]).toMatchObject({ state: "pending", attempts: 0 });
    });
  });

  describe("segurança e registro", () => {
    it("tabelas e RPCs fechados para anon/authenticated", async () => {
      for (const role of ["anon", "authenticated"]) {
        await db.exec(`SET ROLE ${role}`);
        try {
          await expect(db.query(`SELECT 1 FROM wacrm.webhook_endpoints`)).rejects.toThrow(/permission denied/i);
          await expect(db.query(`SELECT 1 FROM wacrm.webhook_deliveries`)).rejects.toThrow(/permission denied/i);
          await expect(db.query(`SELECT wacrm.enqueue_webhook_event('${A}', 'x', gen_random_uuid(), '{}')`)).rejects.toThrow(/permission denied/i);
          await expect(db.query(`SELECT * FROM wacrm.claim_webhook_deliveries('${OWNER}', 1)`)).rejects.toThrow(/permission denied/i);
        } finally {
          await db.exec(`RESET ROLE`);
        }
      }
    });

    it("endpoint exige https, ao menos um evento e status válido", async () => {
      await expect(endpoint(A, ["message.received"], "active", "http://inseguro.example/hook")).rejects.toThrow(/check/i);
      await expect(endpoint(A, [])).rejects.toThrow(/check/i);
      await expect(endpoint(A, ["message.received"], "disabled")).rejects.toThrow(/check/i);
    });

    it("apagar o endpoint apaga as entregas; registra a versão; idempotente", async () => {
      await db.exec(`SELECT wacrm.enqueue_webhook_event('${A}', 'message.received', gen_random_uuid(), '{}')`);
      await db.exec(`DELETE FROM wacrm.webhook_endpoints WHERE id = '${epAll}'`);
      expect(await deliveries()).toEqual([]);
      expect((await db.query(`SELECT version FROM wacrm.schema_migrations`)).rows).toEqual([{ version: "204_outbound_webhooks" }]);
      await db.exec(migration("204_outbound_webhooks.sql"));
      expect((await db.query(`SELECT count(*)::int AS n FROM wacrm.schema_migrations`)).rows[0]).toEqual({ n: 1 });
    });
  });

  describe("custo nos caminhos quentes", () => {
    it("20 mil mensagens de cliente: sem endpoint ≈ endpoint que não assina o evento; com assinatura grava 1 entrega por mensagem", async () => {
      const insert = `INSERT INTO wacrm.messages (conversation_id, sender_type, content_text) SELECT '${conv}', 'customer', 'm' || g FROM generate_series(1, 20000) g`;
      await db.exec(`DELETE FROM wacrm.webhook_endpoints`);
      let t = performance.now();
      await db.exec(insert);
      const none = performance.now() - t;
      await db.exec(`DELETE FROM wacrm.messages`);

      await endpoint(A, ["conversation.closed"]); // endpoint existe, mas não assina message.received
      t = performance.now();
      await db.exec(insert);
      const otherEvent = performance.now() - t;
      await db.exec(`DELETE FROM wacrm.messages`);

      await endpoint(A, ["message.received"]);
      t = performance.now();
      await db.exec(insert);
      const subscribed = performance.now() - t;
      expect((await db.query(`SELECT count(*)::int AS n FROM wacrm.webhook_deliveries`)).rows[0]).toEqual({ n: 20000 });

      console.info(`[204 carga] 20k mensagens: sem endpoint ${none.toFixed(0)} ms · endpoint de outro evento ${otherEvent.toFixed(0)} ms · assinando ${subscribed.toFixed(0)} ms`);
      expect(otherEvent).toBeLessThan(none * 3 + 5000);
    }, 120_000);
  });
});
