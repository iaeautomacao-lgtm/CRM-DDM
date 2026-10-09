// Migration 222 (auditoria de contatos sem PII em claro; leve em importação em massa).
// PGlite com a migration REAL 222 sobre a auditoria da 131 reduzida a stand-ins com a MESMA assinatura (audit_logs, audit_actor,
// audit_write) e as tabelas contacts/contact_tags/tags/blacklist (blacklist com id bigint, como pode estar no schema vivo).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const migration = (file: string) =>
  readFileSync(resolve(process.cwd(), "supabase/migrations", file), "utf8").replace(/NOTIFY pgrst[^;]*;/g, "");

const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
const ACTOR = "00000000-0000-0000-0000-0000000000f1";

const BOOTSTRAP = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
  CREATE SCHEMA wacrm;
  CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
  CREATE TABLE wacrm.contacts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
    phone text NOT NULL, name text, email text, company text, cpf text,
    last_message_at timestamptz
  );
  CREATE TABLE wacrm.tags (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL);
  CREATE TABLE wacrm.contact_tags (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    contact_id uuid NOT NULL REFERENCES wacrm.contacts(id) ON DELETE CASCADE,
    tag_id uuid NOT NULL REFERENCES wacrm.tags(id) ON DELETE CASCADE,
    UNIQUE (contact_id, tag_id)
  );
  CREATE TABLE wacrm.blacklist (
    id bigserial PRIMARY KEY, account_id uuid, telefone text NOT NULL, motivo text, mensagem_detectada text, bloqueado_por text,
    data_bloqueio timestamptz DEFAULT now()
  );
  CREATE TABLE wacrm.audit_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seq bigserial,
    account_id uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
    event_type text NOT NULL CHECK (event_type IN ('created','updated','deleted','action')),
    resource_type text NOT NULL, resource_id uuid NOT NULL, resource_label text,
    user_id uuid, user_name text, ip_address text, user_agent text, actor_type text, source text,
    action text, summary text, changes jsonb, metadata jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
  );
  CREATE FUNCTION wacrm.audit_actor() RETURNS jsonb LANGUAGE sql STABLE AS
    $$ SELECT jsonb_build_object('user_id', nullif(current_setting('test.actor', true), ''), 'user_name', 'Ator', 'ip', '203.0.113.1', 'user_agent', 'ua', 'actor_type', 'user', 'source', 'web') $$;
  CREATE FUNCTION wacrm.audit_write(p_account uuid, p_event text, p_resource_type text, p_resource_id uuid, p_label text, p_action text,
      p_summary text, p_changes jsonb DEFAULT NULL, p_metadata jsonb DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
    DECLARE v_actor jsonb := wacrm.audit_actor();
    BEGIN
      IF p_account IS NULL OR p_resource_id IS NULL THEN RETURN; END IF;
      INSERT INTO wacrm.audit_logs (account_id, event_type, resource_type, resource_id, resource_label, user_id, user_name, ip_address, user_agent,
          actor_type, source, action, summary, changes, metadata)
        VALUES (p_account, p_event, p_resource_type, p_resource_id, left(p_label, 200), (v_actor ->> 'user_id')::uuid, v_actor ->> 'user_name',
          v_actor ->> 'ip', v_actor ->> 'user_agent', v_actor ->> 'actor_type', v_actor ->> 'source', p_action, left(p_summary, 500),
          CASE WHEN p_changes = '{}'::jsonb THEN NULL ELSE p_changes END, p_metadata);
    END $$;
  -- triggers por linha da 131 (valor em claro) que a 222 substitui
  CREATE FUNCTION wacrm.audit_contacts_changes() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN coalesce(NEW, OLD); END $$;
  CREATE TRIGGER trg_audit_contacts AFTER INSERT OR UPDATE OR DELETE ON wacrm.contacts FOR EACH ROW EXECUTE FUNCTION wacrm.audit_contacts_changes();
  CREATE FUNCTION wacrm.audit_contact_tags_changes() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN coalesce(NEW, OLD); END $$;
  CREATE TRIGGER trg_audit_contact_tags AFTER INSERT OR DELETE ON wacrm.contact_tags FOR EACH ROW EXECUTE FUNCTION wacrm.audit_contact_tags_changes();
  INSERT INTO wacrm.accounts (id, name) VALUES ('${A}', 'Conta A'), ('${B}', 'Conta B');
`;

type Log = {
  action: string;
  event_type: string;
  resource_type: string;
  resource_label: string | null;
  account_id: string;
  summary: string;
  changes: Record<string, { before: unknown; after: unknown }> | null;
  metadata: Record<string, unknown> | null;
  user_id: string | null;
};

describe("migration 222 — auditoria de contatos", { timeout: 120_000 }, () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(BOOTSTRAP);
    await db.exec(migration("222_audit_contacts.sql"));
  }, 60_000);
  afterAll(async () => {
    await db.close();
  }, 60_000);
  beforeEach(async () => {
    await db.exec(`
      SELECT set_config('test.actor', '${ACTOR}', false);
      DELETE FROM wacrm.contact_tags; DELETE FROM wacrm.contacts; DELETE FROM wacrm.tags; DELETE FROM wacrm.blacklist;
      DELETE FROM wacrm.audit_logs;
    `);
  });

  const logs = async (where = "true") =>
    (await db.query<Log>(
      `SELECT action, event_type, resource_type, resource_label, account_id, summary, changes, metadata, user_id FROM wacrm.audit_logs WHERE ${where} ORDER BY seq`,
    )).rows;
  const dump = async () => JSON.stringify(await logs());
  const newContact = async (phone = "5521999991234", name: string | null = "Maria Silva", extra = "") =>
    (await db.query<{ id: string }>(`INSERT INTO wacrm.contacts (account_id, phone, name ${extra ? "," + extra.split("=")[0] : ""}) VALUES ('${A}', $1, $2 ${extra ? "," + extra.split("=")[1] : ""}) RETURNING id`, [phone, name])).rows[0].id;

  describe("máscara: nada de PII em claro", () => {
    it("INSERT: 1 evento por contato, rótulo mascarado, ator/IP preenchidos pela 131", async () => {
      await newContact();
      const [l] = await logs();
      expect(l).toMatchObject({ action: "contact.created", event_type: "created", resource_type: "contact", resource_label: "M*** S***", user_id: ACTOR });
      expect(await dump()).not.toMatch(/Maria|Silva|5521999991234|1234\b.*Maria/);
    });

    it("sem nome, o rótulo é o telefone mascarado", async () => {
      await newContact("5521988887777", null);
      expect((await logs())[0].resource_label).toBe("****7777");
    });

    it("UPDATE: só os NOMES dos campos que mudaram, com valor mascarado antes/depois", async () => {
      const id = await newContact();
      await db.exec(`DELETE FROM wacrm.audit_logs`);
      await db.query(
        `UPDATE wacrm.contacts SET name = 'João Souza', phone = '5511977776666', email = 'joao@empresa.com.br', cpf = '123.456.789-01', company = 'ACME Ltda' WHERE id = $1`,
        [id],
      );
      const [l] = await logs();
      expect(l.action).toBe("contact.updated");
      expect(Object.keys(l.changes!).sort()).toEqual(["company", "cpf", "email", "name", "phone"]);
      expect(l.changes!.name).toEqual({ before: "M*** S***", after: "J*** S***" });
      expect(l.changes!.phone).toEqual({ before: "****1234", after: "****6666" });
      expect(l.changes!.email).toEqual({ before: null, after: "j***@empresa.com.br" });
      expect(l.changes!.cpf).toEqual({ before: null, after: "***.***.***-01" });
      expect(l.changes!.company).toEqual({ before: null, after: "A*** L***" });
      const all = await dump();
      for (const clear of ["João", "Souza", "joao@", "123.456", "5511977776666", "ACME", "5521999991234", "Maria"]) expect(all).not.toContain(clear);
      expect(l.summary).toMatch(/company, cpf, email, name, phone/);
    });

    it("UPDATE que não toca campo auditado (last_message_at) não gera evento", async () => {
      const id = await newContact();
      await db.exec(`DELETE FROM wacrm.audit_logs`);
      await db.query(`UPDATE wacrm.contacts SET last_message_at = now() WHERE id = $1`, [id]);
      expect(await logs()).toEqual([]);
    });

    it("UPDATE sem mudança real (mesmo valor) não gera evento", async () => {
      const id = await newContact();
      await db.exec(`DELETE FROM wacrm.audit_logs`);
      await db.query(`UPDATE wacrm.contacts SET name = name WHERE id = $1`, [id]);
      expect(await logs()).toEqual([]);
    });

    it("DELETE: telefone e e-mail no metadata mascarados", async () => {
      const id = await newContact("5521999991234", "Maria Silva", "email='maria@x.com'");
      await db.exec(`DELETE FROM wacrm.audit_logs`);
      await db.query(`DELETE FROM wacrm.contacts WHERE id = $1`, [id]);
      const [l] = await logs();
      expect(l).toMatchObject({ action: "contact.deleted", event_type: "deleted", metadata: { phone: "****1234", email: "m***@x.com" } });
      expect(await dump()).not.toMatch(/maria@|Maria|5521999991234/);
    });
  });

  describe("etiquetas", () => {
    it("adicionar/remover: 1 evento por linha, rótulo do contato mascarado, nome da etiqueta mantido", async () => {
      const id = await newContact();
      const tag = (await db.query<{ id: string }>(`INSERT INTO wacrm.tags (name) VALUES ('Negociando') RETURNING id`)).rows[0].id;
      await db.exec(`DELETE FROM wacrm.audit_logs`);
      await db.query(`INSERT INTO wacrm.contact_tags (contact_id, tag_id) VALUES ($1, $2)`, [id, tag]);
      await db.query(`DELETE FROM wacrm.contact_tags WHERE contact_id = $1`, [id]);
      const l = await logs();
      expect(l.map((x) => x.action)).toEqual(["contact.tag_added", "contact.tag_removed"]);
      expect(l[0]).toMatchObject({ resource_label: "M*** S***", metadata: { tag: "Negociando" } });
      expect(await dump()).not.toContain("Maria");
    });

    it("contato apagado em cascata não gera evento de etiqueta (o de exclusão basta)", async () => {
      const id = await newContact();
      const tag = (await db.query<{ id: string }>(`INSERT INTO wacrm.tags (name) VALUES ('T') RETURNING id`)).rows[0].id;
      await db.query(`INSERT INTO wacrm.contact_tags (contact_id, tag_id) VALUES ($1, $2)`, [id, tag]);
      await db.exec(`DELETE FROM wacrm.audit_logs`);
      await db.query(`DELETE FROM wacrm.contacts WHERE id = $1`, [id]);
      expect((await logs()).map((x) => x.action)).toEqual(["contact.deleted"]);
    });
  });

  describe("blacklist / opt-out (id bigint no schema vivo)", () => {
    it("INSERT: opt_out vira contact.opted_out; telefone mascarado; mensagem_detectada NUNCA aparece", async () => {
      await db.query(
        `INSERT INTO wacrm.blacklist (account_id, telefone, motivo, mensagem_detectada, bloqueado_por) VALUES ($1, '5521999991234', 'opt_out', 'não me mande mais mensagem, sou João', 'ai_priority_guard')`,
        [A],
      );
      const [l] = await logs();
      expect(l).toMatchObject({
        action: "contact.opted_out", event_type: "created", resource_type: "blacklist", resource_label: "****1234",
        metadata: { motivo: "opt_out", bloqueado_por: "ai_priority_guard" },
      });
      expect(await dump()).not.toMatch(/João|não me mande|5521999991234/);
    });

    it("outro motivo vira blacklist.added; remoção vira blacklist.removed; mudança de motivo é diff mascarado", async () => {
      await db.query(`INSERT INTO wacrm.blacklist (account_id, telefone, motivo) VALUES ($1, '5521999991234', 'reclamacao')`, [A]);
      await db.query(`UPDATE wacrm.blacklist SET motivo = 'opt_out'`);
      await db.query(`DELETE FROM wacrm.blacklist`);
      const l = await logs();
      expect(l.map((x) => x.action)).toEqual(["blacklist.added", "blacklist.updated", "blacklist.removed"]);
      expect(l[1].changes).toEqual({ motivo: { before: "reclamacao", after: "opt_out" } });
    });

    it("upsert que reescreve os mesmos valores não gera evento; bloqueio global (sem conta) é ignorado", async () => {
      await db.query(`INSERT INTO wacrm.blacklist (account_id, telefone, motivo) VALUES ($1, '5521999991234', 'opt_out')`, [A]);
      await db.exec(`DELETE FROM wacrm.audit_logs`);
      await db.query(`UPDATE wacrm.blacklist SET data_bloqueio = now()`);
      await db.query(`INSERT INTO wacrm.blacklist (account_id, telefone, motivo) VALUES (NULL, '5511900000000', 'manual')`);
      expect(await logs()).toEqual([]);
    });
  });

  describe("lotes: um evento agregado por conta, não um por linha", () => {
    it("INSERT de 21+ contatos = 1 evento bulk_created por conta com contagem e amostra", async () => {
      await db.exec(`
        INSERT INTO wacrm.contacts (account_id, phone, name)
          SELECT CASE WHEN g % 3 = 0 THEN '${B}'::uuid ELSE '${A}'::uuid END, '55219' || lpad(g::text, 8, '0'), 'Nome ' || g FROM generate_series(1, 90) g;
      `);
      const l = await logs();
      expect(l.map((x) => x.action).sort()).toEqual(["contact.bulk_created", "contact.bulk_created"]);
      const a = l.find((x) => x.account_id === A)!;
      expect(a.metadata).toMatchObject({ count: 60 });
      expect((a.metadata!.sample_ids as string[]).length).toBe(5);
      expect(l.find((x) => x.account_id === B)!.metadata).toMatchObject({ count: 30 });
      expect(await dump()).not.toMatch(/Nome \d|55219/);
    });

    it("exatamente o limite (20) ainda é 1 evento por contato; 21 vira lote", async () => {
      await db.exec(`INSERT INTO wacrm.contacts (account_id, phone) SELECT '${A}', '5521' || lpad(g::text, 8, '0') FROM generate_series(1, 20) g`);
      expect(await logs()).toHaveLength(20);
      await db.exec(`DELETE FROM wacrm.audit_logs; INSERT INTO wacrm.contacts (account_id, phone) SELECT '${A}', '5522' || lpad(g::text, 8, '0') FROM generate_series(1, 21) g`);
      expect((await logs()).map((x) => x.action)).toEqual(["contact.bulk_created"]);
    });

    it("UPDATE em lote (backfill de nome/cpf) = 1 evento com quantas linhas mudaram cada campo", async () => {
      await db.exec(`INSERT INTO wacrm.contacts (account_id, phone) SELECT '${A}', '5521' || lpad(g::text, 8, '0') FROM generate_series(1, 50) g`);
      await db.exec(`DELETE FROM wacrm.audit_logs`);
      await db.exec(`UPDATE wacrm.contacts SET name = 'X ' || phone, cpf = CASE WHEN phone < '552100000026' THEN '11122233344' END`);
      const l = await logs();
      expect(l).toHaveLength(1);
      expect(l[0]).toMatchObject({ action: "contact.bulk_updated", metadata: { count: 50, fields_changed: { name: 50, cpf: 25 } } });
      expect(await dump()).not.toMatch(/11122233344|X 5521/);
    });

    it("DELETE em lote, etiquetas em lote e blacklist em lote também agregam", async () => {
      await db.exec(`INSERT INTO wacrm.contacts (account_id, phone) SELECT '${A}', '5521' || lpad(g::text, 8, '0') FROM generate_series(1, 30) g`);
      await db.exec(`INSERT INTO wacrm.tags (name) VALUES ('T1')`);
      await db.exec(`DELETE FROM wacrm.audit_logs`);
      await db.exec(`INSERT INTO wacrm.contact_tags (contact_id, tag_id) SELECT c.id, t.id FROM wacrm.contacts c, wacrm.tags t`);
      await db.exec(`INSERT INTO wacrm.blacklist (account_id, telefone, motivo) SELECT '${A}', '5511' || lpad(g::text, 8, '0'), 'opt_out' FROM generate_series(1, 25) g`);
      await db.exec(`DELETE FROM wacrm.contact_tags`);
      await db.exec(`DELETE FROM wacrm.contacts`);
      await db.exec(`DELETE FROM wacrm.blacklist`);
      expect((await logs()).map((x) => x.action)).toEqual([
        "contact.bulk_tag_added", "blacklist.bulk_added", "contact.bulk_tag_removed", "contact.bulk_deleted", "blacklist.bulk_removed",
      ]);
    });
  });

  describe("auditoria nunca derruba a escrita original", () => {
    it("se audit_write falhar, o INSERT/UPDATE/DELETE do contato continua valendo", async () => {
      await db.exec(`ALTER TABLE wacrm.audit_logs ADD CONSTRAINT boom CHECK (false) NOT VALID`);
      const id = await newContact("5521911112222", "Ana Lima");
      await db.query(`UPDATE wacrm.contacts SET name = 'Ana Souza' WHERE id = $1`, [id]);
      expect((await db.query(`SELECT name FROM wacrm.contacts WHERE id = $1`, [id])).rows[0]).toEqual({ name: "Ana Souza" });
      await db.query(`DELETE FROM wacrm.contacts WHERE id = $1`, [id]);
      expect((await db.query(`SELECT count(*)::int AS n FROM wacrm.contacts`)).rows[0]).toEqual({ n: 0 });
      await db.exec(`ALTER TABLE wacrm.audit_logs DROP CONSTRAINT boom`);
    });
  });

  describe("importação de 100 mil linhas (carga)", () => {
    it("o trigger não deixa a importação lenta: 1 evento agregado e custo pequeno frente ao INSERT sem auditoria", async () => {
      const insert = `INSERT INTO wacrm.contacts (account_id, phone, name) SELECT '${A}', '55' || lpad(g::text, 11, '0'), 'Contato ' || g FROM generate_series(1, 100000) g`;
      // linha de base: mesma tabela sem os triggers de auditoria
      await db.exec(`ALTER TABLE wacrm.contacts DISABLE TRIGGER USER`);
      const t0 = performance.now();
      await db.exec(insert);
      const baseline = performance.now() - t0;
      await db.exec(`DELETE FROM wacrm.contacts; DELETE FROM wacrm.audit_logs; ALTER TABLE wacrm.contacts ENABLE TRIGGER USER`);

      const t1 = performance.now();
      await db.exec(insert);
      const audited = performance.now() - t1;

      const l = await logs();
      expect(l).toHaveLength(1);
      expect(l[0]).toMatchObject({ action: "contact.bulk_created", metadata: { count: 100000 } });

      // UPDATE em lote de 100 mil linhas também gera 1 evento
      await db.exec(`DELETE FROM wacrm.audit_logs`);
      const t2 = performance.now();
      await db.exec(`UPDATE wacrm.contacts SET cpf = '11122233344'`);
      const updated = performance.now() - t2;
      expect(await logs()).toHaveLength(1);

      console.info(`[222 carga] 100k INSERT: sem auditoria ${baseline.toFixed(0)} ms · com ${audited.toFixed(0)} ms · UPDATE em lote ${updated.toFixed(0)} ms`);
      // folga larga (CI/WASM variam): o custo da auditoria por statement é uma contagem + 1 INSERT, não 100 mil INSERTs
      expect(audited).toBeLessThan(baseline * 2 + 3000);
    }, 120_000);
  });

  it("idempotente: aplicar a 222 de novo não duplica nem quebra", async () => {
    await db.exec(migration("222_audit_contacts.sql"));
    await newContact();
    expect(await logs()).toHaveLength(1);
  });
});
