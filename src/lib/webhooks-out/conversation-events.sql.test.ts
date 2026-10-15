// Migrations 373 e 374 (API pública Onda 2): conversation.opened, conversation.assigned e campaign.reply.
// PGlite com as migrations REAIS (204 + 373 + 374) sobre um bootstrap mínimo das tabelas que os triggers leem; o trigger de histórico de atribuição
// (log_conversation_assignment, 128) é reproduzido para provar que a atribuição de QUALQUER origem vira evento.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const migration = (file: string) => readFileSync(resolve(process.cwd(), "supabase/migrations", file), "utf8").replace(/NOTIFY pgrst[^;]*;/g, "");

const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
const CONTACT = "00000000-0000-0000-0000-0000000000d1";
const CAMP = "00000000-0000-0000-0000-0000000000c1";
const AG1 = "00000000-0000-0000-0000-0000000000a1";
const AG2 = "00000000-0000-0000-0000-0000000000a2";
const T1 = "00000000-0000-0000-0000-0000000000e1";
const ITEM = "00000000-0000-0000-0000-0000000000f1";

const BOOTSTRAP = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA wacrm; GRANT USAGE ON SCHEMA wacrm TO anon, authenticated, service_role;
  CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
  CREATE TABLE wacrm.contacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid REFERENCES wacrm.accounts(id), phone text);
  CREATE TABLE wacrm.tags (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid, name text, codigo_tabulacao integer, kind text DEFAULT 'contact');
  CREATE TABLE wacrm.campaigns (id uuid PRIMARY KEY, account_id uuid, nome text, idempotency_key text);
  CREATE TABLE wacrm.conversations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid REFERENCES wacrm.accounts(id), contact_id uuid REFERENCES wacrm.contacts(id),
    status text NOT NULL DEFAULT 'open', outcome_tag_id uuid REFERENCES wacrm.tags(id), last_message_text text,
    channel_type text NOT NULL DEFAULT 'whatsapp', team_id uuid, assigned_agent_id uuid, config_id uuid, created_at timestamptz DEFAULT now()
  );
  CREATE TABLE wacrm.messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid NOT NULL REFERENCES wacrm.conversations(id) ON DELETE CASCADE,
    sender_type text NOT NULL, content_type text NOT NULL DEFAULT 'text', content_text text, media_url text, message_id text,
    status text NOT NULL DEFAULT 'sent', created_at timestamptz DEFAULT now(),
    campaign_id uuid, queue_item_id uuid, attribution_method text
  );
  CREATE TABLE wacrm.conversation_assignments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, conversation_id uuid NOT NULL REFERENCES wacrm.conversations(id) ON DELETE CASCADE,
    from_agent_id uuid, to_agent_id uuid, from_team_id uuid, to_team_id uuid, actor_id uuid, reason text, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
  );
  -- Histórico de atribuição como na 128 (ator = auth.uid(); nulo sob service role).
  CREATE FUNCTION wacrm.log_conversation_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF NEW.assigned_agent_id IS DISTINCT FROM OLD.assigned_agent_id OR NEW.team_id IS DISTINCT FROM OLD.team_id THEN
      INSERT INTO wacrm.conversation_assignments (account_id, conversation_id, from_agent_id, to_agent_id, from_team_id, to_team_id, actor_id)
      VALUES (NEW.account_id, NEW.id, OLD.assigned_agent_id, NEW.assigned_agent_id, OLD.team_id, NEW.team_id, NULL);
    END IF;
    RETURN NULL;
  END $$;
  CREATE TRIGGER trg_log_conversation_assignment AFTER UPDATE OF assigned_agent_id, team_id ON wacrm.conversations
    FOR EACH ROW EXECUTE FUNCTION wacrm.log_conversation_assignment();
  -- wacrm.audit_actor() (131): quem agiu na requisição; aqui controlado por um setting de teste.
  CREATE FUNCTION wacrm.audit_actor() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.actor', true), '')::jsonb $$;
  CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
  INSERT INTO wacrm.accounts (id, name) VALUES ('${A}', 'A'), ('${B}', 'B');
  INSERT INTO wacrm.contacts (id, account_id, phone) VALUES ('${CONTACT}', '${A}', '+55 (27) 99999-1212');
  INSERT INTO wacrm.campaigns (id, account_id, nome, idempotency_key) VALUES ('${CAMP}', '${A}', 'Cobrança', 'erp-lote-1');
`;

type Delivery = { event: string; endpoint_id: string; payload: Record<string, any> };

describe("migrations 373 e 374 — webhooks de conversa e de resposta de campanha", { timeout: 120_000 }, () => {
  let db: PGlite;
  let epA: string;
  let epB: string;

  const deliveries = async (event?: string) =>
    (await db.query<Delivery>("SELECT event, endpoint_id, payload FROM wacrm.webhook_deliveries WHERE ($1::text IS NULL OR event = $1) ORDER BY created_at, id", [event ?? null])).rows;
  const subscribe = async (events: string[]) => {
    await db.exec("DELETE FROM wacrm.webhook_deliveries; DELETE FROM wacrm.webhook_endpoints;");
    epA = (await db.query<{ id: string }>("INSERT INTO wacrm.webhook_endpoints (account_id, url, events, secret_enc) VALUES ($1, 'https://erp.exemplo.com/a', $2, 'x') RETURNING id", [A, events])).rows[0].id;
    epB = (await db.query<{ id: string }>("INSERT INTO wacrm.webhook_endpoints (account_id, url, events, secret_enc) VALUES ($1, 'https://outro.exemplo.com/b', $2, 'x') RETURNING id", [B, events])).rows[0].id;
  };
  const conversation = async (over = "") =>
    (await db.query<{ id: string }>(`INSERT INTO wacrm.conversations (account_id, contact_id, status ${over ? ", " + over.split("=")[0] : ""}) VALUES ('${A}', '${CONTACT}', 'pending' ${over ? ", " + over.split("=")[1] : ""}) RETURNING id`)).rows[0].id;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(BOOTSTRAP);
    for (const f of ["204_outbound_webhooks.sql", "373_webhook_conversation_events.sql", "374_webhook_campaign_reply.sql"]) await db.exec(migration(f));
    await db.exec(migration("373_webhook_conversation_events.sql")); // idempotentes
    await db.exec(migration("374_webhook_campaign_reply.sql"));
  }, 60_000);
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.exec("SELECT set_config('test.actor', '', false); DELETE FROM wacrm.messages; DELETE FROM wacrm.conversations;");
    await subscribe(["conversation.opened", "conversation.assigned", "campaign.reply"]);
  });

  it("registra as duas migrations e cria os triggers", async () => {
    const versions = (await db.query<{ version: string }>("SELECT version FROM wacrm.schema_migrations WHERE version LIKE '37%' ORDER BY 1")).rows.map((r) => r.version);
    expect(versions).toEqual(["373_webhook_conversation_events", "374_webhook_campaign_reply"]);
    const triggers = (await db.query<{ tgname: string }>("SELECT tgname FROM pg_trigger WHERE tgname LIKE 'trg_webhook_conversation_%' OR tgname LIKE 'trg_webhook_campaign_reply_%' AND NOT tgisinternal ORDER BY 1")).rows;
    expect(triggers.map((t) => t.tgname)).toEqual(["trg_webhook_campaign_reply_ins", "trg_webhook_campaign_reply_upd", "trg_webhook_conversation_assigned", "trg_webhook_conversation_opened"]);
  });

  describe("conversation.opened", () => {
    it("toda conversa nova (qualquer origem) gera UM evento, só para o endpoint da conta; telefone só com dígitos", async () => {
      const id = await conversation(`team_id='${T1}'`);
      const rows = await deliveries("conversation.opened");
      expect(rows).toHaveLength(1);
      expect(rows[0].endpoint_id).toBe(epA);
      expect(rows[0].payload).toMatchObject({ type: "conversation.opened", account_id: A });
      expect(rows[0].payload.data).toMatchObject({ conversation_id: id, contact_id: CONTACT, phone: "5527999991212", channel: "whatsapp", status: "pending", team_id: T1, assignee_id: null });
      expect(rows[0].payload.data.opened_at).toMatch(/Z$/);
    });
    it("com atendente já na criação: assignee_id preenchido", async () => {
      await conversation(`assigned_agent_id='${AG1}'`);
      expect((await deliveries("conversation.opened"))[0].payload.data.assignee_id).toBe(AG1);
    });
    it("sem assinar o tipo, nada é enfileirado e a criação nunca falha", async () => {
      await subscribe(["message.received"]);
      await conversation();
      expect(await deliveries()).toHaveLength(0);
      expect(Number((await db.query<{ n: string }>("SELECT count(*) AS n FROM wacrm.conversations")).rows[0].n)).toBe(1);
    });
    it("falha por dentro (fila indisponível) vira aviso: a conversa é criada do mesmo jeito", async () => {
      await db.exec("ALTER TABLE wacrm.webhook_deliveries RENAME TO webhook_deliveries_x");
      try {
        await conversation();
      } finally {
        await db.exec("ALTER TABLE wacrm.webhook_deliveries_x RENAME TO webhook_deliveries");
      }
      expect(Number((await db.query<{ n: string }>("SELECT count(*) AS n FROM wacrm.conversations")).rows[0].n)).toBe(1);
    });
  });

  describe("conversation.assigned", () => {
    it("mudança de atendente e de equipe (histórico da 128) vira evento com de/para; ator vem de audit_actor quando a linha não tem", async () => {
      const id = await conversation();
      await db.exec(`SELECT set_config('test.actor', '{"actor_type":"api","user_id":null,"source":"api_v1"}', false)`);
      await db.exec(`UPDATE wacrm.conversations SET assigned_agent_id = '${AG1}', team_id = '${T1}' WHERE id = '${id}'`);
      await db.exec(`SELECT set_config('test.actor', '{"actor_type":"user","user_id":"${AG2}","source":"inbox"}', false)`);
      await db.exec(`UPDATE wacrm.conversations SET assigned_agent_id = '${AG2}' WHERE id = '${id}'`);
      const rows = await deliveries("conversation.assigned");
      expect(rows).toHaveLength(2);
      expect(rows[0].payload.data).toMatchObject({ conversation_id: id, contact_id: CONTACT, from_agent_id: null, to_agent_id: AG1, from_team_id: null, to_team_id: T1, actor: { type: "api", source: "api_v1" } });
      expect(rows[1].payload.data).toMatchObject({ from_agent_id: AG1, to_agent_id: AG2, actor: { type: "user", user_id: AG2, source: "inbox" } });
    });
    it("sem contexto de requisição (cron, motor) o ator é `system`; remover o atendente também é evento", async () => {
      const id = await conversation(`assigned_agent_id='${AG1}'`);
      await db.exec(`UPDATE wacrm.conversations SET assigned_agent_id = NULL WHERE id = '${id}'`);
      const [row] = await deliveries("conversation.assigned");
      expect(row.payload.data).toMatchObject({ from_agent_id: AG1, to_agent_id: null, actor: { type: "system" } });
    });
    it("UPDATE que não muda atendente/equipe não gera evento", async () => {
      const id = await conversation();
      await db.exec(`UPDATE wacrm.conversations SET status = 'open' WHERE id = '${id}'`);
      expect(await deliveries("conversation.assigned")).toHaveLength(0);
    });
    it("sem assinatura do tipo: nada", async () => {
      await subscribe(["conversation.opened"]);
      const id = await conversation();
      await db.exec(`UPDATE wacrm.conversations SET assigned_agent_id = '${AG1}' WHERE id = '${id}'`);
      expect(await deliveries("conversation.assigned")).toHaveLength(0);
    });
  });

  describe("campaign.reply", () => {
    const reply = async (conv: string, extra = "") =>
      (await db.query<{ id: string }>(`INSERT INTO wacrm.messages (conversation_id, sender_type, content_text, message_id ${extra ? ", " + extra.split("|")[0] : ""}) VALUES ('${conv}', 'customer', 'Quero negociar', 'wamid.9' ${extra ? ", " + extra.split("|")[1] : ""}) RETURNING id`)).rows[0].id;

    it("a atribuição chega por UPDATE: sai UM evento por resposta, com campanha, external_id, destinatário, telefone e texto", async () => {
      const conv = await conversation();
      const msg = await reply(conv);
      expect(await deliveries("campaign.reply")).toHaveLength(0); // ainda sem campanha
      await db.exec(`UPDATE wacrm.messages SET campaign_id = '${CAMP}', queue_item_id = '${ITEM}', attribution_method = 'context' WHERE id = '${msg}'`);
      await db.exec(`UPDATE wacrm.messages SET attribution_method = 'recent' WHERE id = '${msg}'`); // outro UPDATE: não repete
      const rows = await deliveries("campaign.reply");
      expect(rows).toHaveLength(1);
      expect(rows[0].endpoint_id).toBe(epA);
      expect(rows[0].payload.data).toMatchObject({
        campaign_id: CAMP, external_id: "erp-lote-1", recipient_id: ITEM, contact_id: CONTACT, phone: "5527999991212", conversation_id: conv,
        message_id: msg, provider_message_id: "wamid.9", content_type: "text", text: "Quero negociar", attribution: "context",
      });
    });
    it("mensagem de cliente já inserida com campaign_id também sai (uma vez)", async () => {
      const conv = await conversation();
      await reply(conv, `campaign_id, queue_item_id, attribution_method|'${CAMP}', '${ITEM}', 'recent'`);
      expect((await deliveries("campaign.reply")).map((r) => r.payload.data.attribution)).toEqual(["recent"]);
    });
    it("mensagem que NÃO é do cliente (campanha/bot/atendente) não gera o evento", async () => {
      const conv = await conversation();
      const { rows } = await db.query<{ id: string }>(`INSERT INTO wacrm.messages (conversation_id, sender_type, content_text) VALUES ('${conv}', 'bot', 'Olá') RETURNING id`);
      await db.exec(`UPDATE wacrm.messages SET campaign_id = '${CAMP}' WHERE id = '${rows[0].id}'`);
      await db.exec(`INSERT INTO wacrm.messages (conversation_id, sender_type, content_text, campaign_id) VALUES ('${conv}', 'agent', 'Oi', '${CAMP}')`);
      expect(await deliveries("campaign.reply")).toHaveLength(0);
    });
    it("sem assinar o tipo: nada; o endpoint de outra conta nunca recebe", async () => {
      const conv = await conversation();
      await reply(conv, `campaign_id|'${CAMP}'`);
      expect((await deliveries("campaign.reply")).every((r) => r.endpoint_id === epA)).toBe(true);
      await subscribe(["message.received"]);
      await reply(conv, `campaign_id|'${CAMP}'`);
      expect(await deliveries("campaign.reply")).toHaveLength(0);
    });
  });
});
