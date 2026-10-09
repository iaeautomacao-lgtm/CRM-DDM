// Migration 278 (PRD 17, PR 17.3): parada automática da régua por evento do CRM. PGlite com as migrations REAIS 270–275 + 278.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const FILES = ["270_billing_rulers.sql", "271_billing_debts.sql", "272_billing_enrollments.sql", "273_billing_step_sends.sql", "274_billing_functions.sql", "275_billing_sync_state.sql", "278_billing_event_stops.sql"];
const migration = (file: string) => readFileSync(resolve(process.cwd(), "supabase/migrations", file), "utf8").replace(/NOTIFY pgrst[^;]*;/g, "");

const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";

const BOOTSTRAP = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA wacrm; GRANT USAGE ON SCHEMA wacrm TO anon, authenticated, service_role;
  CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
  CREATE TABLE wacrm.whatsapp_config (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid REFERENCES wacrm.accounts(id));
  CREATE TABLE wacrm.contacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid REFERENCES wacrm.accounts(id), phone text, cpf text);
  CREATE TABLE wacrm.tags (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid, name text, codigo_tabulacao integer);
  CREATE TABLE wacrm.conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid REFERENCES wacrm.accounts(id), contact_id uuid REFERENCES wacrm.contacts(id), outcome_tag_id uuid REFERENCES wacrm.tags(id));
  CREATE TABLE wacrm.blacklist (id bigserial PRIMARY KEY, account_id uuid, telefone text NOT NULL, motivo text);
  CREATE FUNCTION wacrm.phone_key(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT right(regexp_replace(coalesce(p, ''), '\\D', '', 'g'), 8) $$;
  CREATE FUNCTION wacrm.blacklisted_phone_keys(p_keys text[]) RETURNS TABLE(key text) LANGUAGE sql STABLE AS
    $$ SELECT DISTINCT wacrm.phone_key(b.telefone) FROM wacrm.blacklist b WHERE wacrm.phone_key(b.telefone) = ANY (p_keys) $$;
  CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
  INSERT INTO wacrm.accounts (id, name) VALUES ('${A}', 'A'), ('${B}', 'B');
`;

describe("migration 278 — paradas por evento", { timeout: 120_000 }, () => {
  let db: PGlite;
  let n = 0;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(BOOTSTRAP);
    for (const f of FILES) await db.exec(migration(f));
  }, 60_000);
  afterAll(async () => {
    await db.close();
  }, 60_000);
  beforeEach(async () => {
    await db.exec(`DELETE FROM wacrm.billing_step_sends; DELETE FROM wacrm.billing_enrollments; DELETE FROM wacrm.billing_debts; DELETE FROM wacrm.billing_ruler_steps;
      DELETE FROM wacrm.billing_rulers; DELETE FROM wacrm.conversations; DELETE FROM wacrm.tags; DELETE FROM wacrm.blacklist; DELETE FROM wacrm.contacts;`);
  });

  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
  const contact = async (phone: string, account = A) => (await one<{ id: string }>(`INSERT INTO wacrm.contacts (account_id, phone) VALUES ($1, $2) RETURNING id`, [account, phone])).id;
  const ruler = async (account = A) => (await one<{ id: string }>(`INSERT INTO wacrm.billing_rulers (account_id, name, active, dry_run) VALUES ($1, $2, true, false) RETURNING id`, [account, `R${++n}`])).id;
  const enrolled = async (contactId: string, rulerId: string, nextStepAt: string, account = A) => {
    const debt = (await one<{ id: string }>(`INSERT INTO wacrm.billing_debts (account_id, contact_id, external_ref, due_date) VALUES ($1, $2, $3, '2026-10-22') RETURNING id`, [account, contactId, `ref-${++n}`])).id;
    const e = (await one<{ id: string }>(`INSERT INTO wacrm.billing_enrollments (account_id, ruler_id, debt_id, next_step_at) VALUES ($1, $2, $3, $4) RETURNING id`, [account, rulerId, debt, nextStepAt])).id;
    return { debt, e };
  };
  const state = async (id: string) => one<{ status: string; stop_reason: string | null }>(`SELECT status, stop_reason FROM wacrm.billing_enrollments WHERE id = $1`, [id]);

  describe("acordo fechado no CRM (tabulação 142)", () => {
    const tag = async (code: number) => (await one<{ id: string }>(`INSERT INTO wacrm.tags (account_id, name, codigo_tabulacao) VALUES ($1, $2, $3) RETURNING id`, [A, `T${code}`, code])).id;
    const conversation = async (contactId: string) => (await one<{ id: string }>(`INSERT INTO wacrm.conversations (account_id, contact_id) VALUES ($1, $2) RETURNING id`, [A, contactId])).id;

    it("tabulação 142 para TODAS as inscrições do contato (motivo agreement), cancela envio reservado e marca a dívida", async () => {
      const c = await contact("5521999990001");
      const r = await ruler();
      const x = await enrolled(c, r, "2026-10-22T11:00:00Z");
      const y = await enrolled(c, r, "2026-11-22T11:00:00Z");
      const other = await enrolled(await contact("5521999990002"), r, "2026-10-22T11:00:00Z");
      const step = (await one<{ id: string }>(`INSERT INTO wacrm.billing_ruler_steps (account_id, ruler_id, position, kind, offset_days) VALUES ($1, $2, 0, 'offset', 0) RETURNING id`, [A, r])).id;
      await db.query(`INSERT INTO wacrm.billing_step_sends (account_id, enrollment_id, contact_id, step_id, due_at, send_key) VALUES ($1, $2, $3, $4, now(), 'k1')`, [A, x.e, c, step]);
      const conv = await conversation(c);
      await db.query(`UPDATE wacrm.conversations SET outcome_tag_id = $1 WHERE id = $2`, [await tag(142), conv]);
      expect(await state(x.e)).toEqual({ status: "stopped", stop_reason: "agreement" });
      expect(await state(y.e)).toEqual({ status: "stopped", stop_reason: "agreement" });
      expect(await state(other.e)).toEqual({ status: "active", stop_reason: null });
      expect(await one(`SELECT status, error_code FROM wacrm.billing_step_sends WHERE send_key = 'k1'`)).toEqual({ status: "cancelled", error_code: "agreement" });
    });

    it("outras tabulações não param nada; contato sem inscrição não faz nada", async () => {
      const c = await contact("5521999990003");
      const e = await enrolled(c, await ruler(), "2026-10-22T11:00:00Z");
      const conv = await conversation(c);
      await db.query(`UPDATE wacrm.conversations SET outcome_tag_id = $1 WHERE id = $2`, [await tag(7), conv]);
      expect(await state(e.e)).toEqual({ status: "active", stop_reason: null });
      const lonely = await conversation(await contact("5521999990004"));
      await db.query(`UPDATE wacrm.conversations SET outcome_tag_id = $1 WHERE id = $2`, [await tag(142), lonely]);
    });

    it("à prova de falha: se a parada quebrar, a tabulação da conversa continua gravada", async () => {
      const c = await contact("5521999990005");
      await enrolled(c, await ruler(), "2026-10-22T11:00:00Z");
      const conv = await conversation(c);
      await db.exec(`ALTER TABLE wacrm.billing_enrollments ADD CONSTRAINT boom CHECK (status <> 'stopped') NOT VALID`);
      try {
        const t = await tag(142);
        await db.query(`UPDATE wacrm.conversations SET outcome_tag_id = $1 WHERE id = $2`, [t, conv]);
        expect((await one<{ outcome_tag_id: string }>(`SELECT outcome_tag_id FROM wacrm.conversations WHERE id = $1`, [conv])).outcome_tag_id).toBe(t);
      } finally {
        await db.exec(`ALTER TABLE wacrm.billing_enrollments DROP CONSTRAINT boom`);
      }
    });
  });

  describe("billing_stop_blacklisted (opt-out / blacklist em lote)", () => {
    const run = (account = A, within = "24 hours", limit = 5000) => one<{ n: number }>(`SELECT wacrm.billing_stop_blacklisted($1, $2::interval, $3) AS n`, [account, within, limit]).then((r) => r.n);

    it("para só as inscrições cujo número está na blacklist (mesma equivalência de número da 167), com etapa devida na janela", async () => {
      const r = await ruler();
      const soon = new Date(Date.now() + 3_600_000).toISOString();
      const far = new Date(Date.now() + 10 * 86_400_000).toISOString();
      const blocked = await enrolled(await contact("+55 (21) 99999-0010"), r, soon);
      const farAway = await enrolled(await contact("5521999990011"), r, far);
      const clean = await enrolled(await contact("5521999990012"), r, soon);
      await db.query(`INSERT INTO wacrm.blacklist (account_id, telefone, motivo) VALUES ($1, '5521999990010', 'opt_out'), ($1, '5521999990011', 'manual')`, [A]);
      expect(await run()).toBe(1);
      expect(await state(blocked.e)).toEqual({ status: "stopped", stop_reason: "blacklist" });
      expect(await state(farAway.e)).toEqual({ status: "active", stop_reason: null }); // fora da janela: o guard de envio cobre
      expect(await state(clean.e)).toEqual({ status: "active", stop_reason: null });
      expect(await run(A, "30 days")).toBe(1); // alarga a janela: pega a distante
      expect(await state(farAway.e)).toEqual({ status: "stopped", stop_reason: "blacklist" });
      expect(await run(A, "30 days")).toBe(0); // idempotente
    });

    it("cancela o envio reservado da inscrição parada e isola por conta", async () => {
      const r = await ruler();
      const rb = await ruler(B);
      const c = await contact("5521999990020");
      const soon = new Date(Date.now() + 3_600_000).toISOString();
      const mine = await enrolled(c, r, soon);
      const theirs = await enrolled(await contact("5521999990020", B), rb, soon, B);
      const step = (await one<{ id: string }>(`INSERT INTO wacrm.billing_ruler_steps (account_id, ruler_id, position, kind, offset_days) VALUES ($1, $2, 0, 'offset', 0) RETURNING id`, [A, r])).id;
      await db.query(`INSERT INTO wacrm.billing_step_sends (account_id, enrollment_id, contact_id, step_id, due_at, send_key) VALUES ($1, $2, $3, $4, now(), 'kb')`, [A, mine.e, c, step]);
      await db.query(`INSERT INTO wacrm.blacklist (account_id, telefone, motivo) VALUES (NULL, '5521999990020', 'opt_out')`); // bloqueio global
      expect(await run(A)).toBe(1);
      expect(await state(theirs.e)).toEqual({ status: "active", stop_reason: null }); // outra conta: o tick dela é quem para
      expect(await run(B)).toBe(1);
      expect(await one(`SELECT status, error_code FROM wacrm.billing_step_sends WHERE send_key = 'kb'`)).toEqual({ status: "cancelled", error_code: "blacklist" });
    });

    it("sem blacklist ou sem inscrição devida: 0 e nada muda; respeita o limite", async () => {
      expect(await run()).toBe(0);
      const r = await ruler();
      const soon = new Date(Date.now() + 3_600_000).toISOString();
      for (let i = 0; i < 3; i++) {
        await enrolled(await contact(`552199999003${i}`), r, soon);
        await db.query(`INSERT INTO wacrm.blacklist (account_id, telefone, motivo) VALUES ($1, $2, 'opt_out')`, [A, `552199999003${i}`]);
      }
      expect(await run(A, "24 hours", 2)).toBe(2);
      expect(await run(A, "24 hours", 2)).toBe(1);
    });

    it("fechada para anon/authenticated; registro e idempotência da migration", async () => {
      for (const role of ["anon", "authenticated"]) {
        await db.exec(`SET ROLE ${role}`);
        try {
          await expect(db.query(`SELECT wacrm.billing_stop_blacklisted('${A}')`)).rejects.toThrow(/permission denied/i);
        } finally {
          await db.exec(`RESET ROLE`);
        }
      }
      expect((await db.query(`SELECT 1 FROM wacrm.schema_migrations WHERE version = '278_billing_event_stops'`)).rows).toHaveLength(1);
      await db.exec(migration("278_billing_event_stops.sql"));
      expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM wacrm.schema_migrations WHERE version = '278_billing_event_stops'`)).n).toBe(1);
    });
  });
});
