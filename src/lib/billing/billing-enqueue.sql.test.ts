// Migration 279 (PRD 17, PR 17.4): origem, variable_map, teto diário contando a campanha MANUAL e reconciliação da fila.
// PGlite com as migrations REAIS 270–275 + 278 + 279 sobre um disp_message_queue/campaigns mínimos.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const FILES = ["270_billing_rulers.sql", "271_billing_debts.sql", "272_billing_enrollments.sql", "273_billing_step_sends.sql", "274_billing_functions.sql", "275_billing_sync_state.sql", "279_billing_enqueue.sql"];
const migration = (file: string) => readFileSync(resolve(process.cwd(), "supabase/migrations", file), "utf8").replace(/NOTIFY pgrst[^;]*;/g, "");
const A = "00000000-0000-0000-0000-00000000000a";

const BOOTSTRAP = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA wacrm; GRANT USAGE ON SCHEMA wacrm TO anon, authenticated, service_role;
  CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
  CREATE TABLE wacrm.whatsapp_config (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid REFERENCES wacrm.accounts(id));
  CREATE TABLE wacrm.contacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid REFERENCES wacrm.accounts(id), phone text);
  CREATE TABLE wacrm.campaigns (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid, nome text);
  CREATE TABLE wacrm.disp_message_queue (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid, campaign_id uuid, contact_id uuid,
    status text NOT NULL DEFAULT 'agendado', sent_at timestamptz, erro text, erro_codigo integer, erro_permanente boolean NOT NULL DEFAULT false
  );
  CREATE INDEX idx_dmq_contact_sent ON wacrm.disp_message_queue (contact_id, sent_at DESC) WHERE sent_at IS NOT NULL;
  CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
  INSERT INTO wacrm.accounts (id, name) VALUES ('${A}', 'A');
  -- linhas que JÁ existiam antes da migration (valem como 'manual')
  INSERT INTO wacrm.campaigns (id, account_id, nome) VALUES ('00000000-0000-0000-0000-0000000000c0', '${A}', 'antiga');
`;

describe("migration 279 — régua: entrega ao disparador", { timeout: 120_000 }, () => {
  let db: PGlite;
  let n = 0;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(BOOTSTRAP);
    await db.exec(`INSERT INTO wacrm.disp_message_queue (account_id, status) VALUES ('${A}', 'agendado')`); // fila existente antes da 279
    for (const f of FILES) await db.exec(migration(f));
  }, 60_000);
  afterAll(async () => {
    await db.close();
  }, 60_000);
  beforeEach(async () => {
    await db.exec(`DELETE FROM wacrm.billing_step_sends; DELETE FROM wacrm.billing_enrollments; DELETE FROM wacrm.billing_debts; DELETE FROM wacrm.billing_ruler_steps;
      DELETE FROM wacrm.billing_rulers; DELETE FROM wacrm.disp_message_queue WHERE account_id IS NOT NULL AND contact_id IS NOT NULL; DELETE FROM wacrm.contacts;`);
  });

  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];

  describe("colunas", () => {
    it("origem 'manual' por padrão em campanhas e fila (as linhas antigas viram 'manual'); só manual|regua nas novas", async () => {
      expect(await one(`SELECT origem FROM wacrm.campaigns WHERE nome = 'antiga'`)).toEqual({ origem: "manual" });
      expect((await db.query<{ origem: string }>(`SELECT DISTINCT origem FROM wacrm.disp_message_queue`)).rows).toEqual([{ origem: "manual" }]);
      await db.exec(`INSERT INTO wacrm.campaigns (account_id, nome, origem) VALUES ('${A}', 'régua', 'regua')`);
      await expect(db.exec(`INSERT INTO wacrm.campaigns (account_id, nome, origem) VALUES ('${A}', 'x', 'outra')`)).rejects.toThrow(/check/i);
      await expect(db.exec(`INSERT INTO wacrm.disp_message_queue (account_id, origem) VALUES ('${A}', 'outra')`)).rejects.toThrow(/check/i);
      await db.exec(`DELETE FROM wacrm.campaigns WHERE nome = 'régua'`);
    });

    it("o CHECK entra NOT VALID (não varre a fila existente) e pode ser validado depois", async () => {
      const rows = (await db.query<{ conname: string; convalidated: boolean }>(`SELECT conname, convalidated FROM pg_constraint WHERE conname IN ('campaigns_origem_check', 'disp_message_queue_origem_check') ORDER BY 1`)).rows;
      expect(rows).toEqual([{ conname: "campaigns_origem_check", convalidated: false }, { conname: "disp_message_queue_origem_check", convalidated: false }]);
      await db.exec(`ALTER TABLE wacrm.disp_message_queue VALIDATE CONSTRAINT disp_message_queue_origem_check`);
    });

    it("variable_map da etapa: array de até 10 itens", async () => {
      const r = (await one<{ id: string }>(`INSERT INTO wacrm.billing_rulers (account_id, name) VALUES ('${A}', 'R${++n}') RETURNING id`)).id;
      const insert = (map: string, pos: number) => db.query(`INSERT INTO wacrm.billing_ruler_steps (account_id, ruler_id, position, kind, offset_days, variable_map) VALUES ($1, $2, $3, 'offset', $3, $4::jsonb)`, [A, r, pos, map]);
      await insert('[{"type":"static","value":"x"}]', 0);
      await expect(insert('{"a":1}', 1)).rejects.toThrow(/check/i);
      await expect(insert(JSON.stringify(Array.from({ length: 11 }, () => ({ type: "static", value: "x" }))), 2)).rejects.toThrow(/check/i);
      expect((await one(`SELECT variable_map FROM wacrm.billing_ruler_steps WHERE position = 0`))).toEqual({ variable_map: [{ type: "static", value: "x" }] });
    });
  });

  describe("teto diário: a campanha MANUAL conta junto", () => {
    const contact = async () => (await one<{ id: string }>(`INSERT INTO wacrm.contacts (account_id, phone) VALUES ('${A}', '5521${String(++n).padStart(8, "0")}') RETURNING id`)).id;
    async function scenario(cap: number) {
      const r = (await one<{ id: string }>(`INSERT INTO wacrm.billing_rulers (account_id, name, active, dry_run, tolerance_days, daily_cap_per_debtor) VALUES ('${A}', 'R${++n}', true, false, 2, $1) RETURNING id`, [cap])).id;
      await db.query(`INSERT INTO wacrm.billing_ruler_steps (account_id, ruler_id, position, kind, offset_days) VALUES ($1, $2, 0, 'offset', 0)`, [A, r]);
      const c = await contact();
      const d = (await one<{ id: string }>(`INSERT INTO wacrm.billing_debts (account_id, contact_id, external_ref, due_date) VALUES ($1, $2, $3, '2026-10-19') RETURNING id`, [A, c, `ref-${++n}`])).id;
      await db.query(`INSERT INTO wacrm.billing_enrollments (account_id, ruler_id, debt_id, created_at, next_step_at) VALUES ($1, $2, $3, '2026-10-10T00:00:00Z', '2026-10-19T11:00:00Z')`, [A, r, d]);
      return { r, c, d };
    }
    const claim = async () => (await db.query<{ send_id: string }>(`SELECT * FROM wacrm.billing_claim_due_steps('${A}', 200, '2026-10-19T12:00:00Z')`)).rows;

    it("envio MANUAL já saído hoje ao mesmo contato consome o teto (cap 1): a etapa fica para amanhã", async () => {
      const { c } = await scenario(1);
      await db.query(`INSERT INTO wacrm.disp_message_queue (account_id, contact_id, status, sent_at, origem) VALUES ($1, $2, 'entregue', '2026-10-19T10:00:00Z', 'manual')`, [A, c]);
      expect(await claim()).toEqual([]);
      expect((await one<{ next_step_at: Date }>(`SELECT next_step_at FROM wacrm.billing_enrollments`)).next_step_at.toISOString()).toBe("2026-10-20T11:00:00.000Z");
    });

    it("com cap 2, um manual + uma da régua cabem; o manual de OUTRO dia ou de OUTRO contato não conta; item de origem 'regua' não é contado em dobro", async () => {
      const { c } = await scenario(2);
      const other = await contact();
      await db.query(`INSERT INTO wacrm.disp_message_queue (account_id, contact_id, status, sent_at, origem) VALUES
        ($1, $2, 'entregue', '2026-10-18T14:00:00Z', 'manual'), ($1, $3, 'entregue', '2026-10-19T10:00:00Z', 'manual'), ($1, $2, 'entregue', '2026-10-19T10:30:00Z', 'regua')`, [A, c, other]);
      expect(await claim()).toHaveLength(1);
    });

    it("sem origem na fila (279 ainda não aplicada em outro banco) a função segue e só conta a régua", async () => {
      const { c } = await scenario(1);
      await db.query(`INSERT INTO wacrm.disp_message_queue (account_id, contact_id, status, sent_at, origem) VALUES ($1, $2, 'entregue', '2026-10-19T10:00:00Z', 'manual')`, [A, c]);
      expect(await claim()).toEqual([]); // com manual: bloqueia
      await db.exec(`UPDATE wacrm.billing_enrollments SET next_step_at = '2026-10-19T11:00:00Z'`);
      await db.exec(`DELETE FROM wacrm.disp_message_queue WHERE contact_id IS NOT NULL`);
      expect(await claim()).toHaveLength(1); // sem o manual: libera
    });
  });

  describe("billing_reconcile_sends", () => {
    async function send(queueStatus: string, over: { permanente?: boolean; codigo?: number | null } = {}) {
      const r = (await one<{ id: string }>(`INSERT INTO wacrm.billing_rulers (account_id, name) VALUES ('${A}', 'R${++n}') RETURNING id`)).id;
      const st = (await one<{ id: string }>(`INSERT INTO wacrm.billing_ruler_steps (account_id, ruler_id, position, kind, offset_days) VALUES ($1, $2, 0, 'offset', 0) RETURNING id`, [A, r])).id;
      const c = (await one<{ id: string }>(`INSERT INTO wacrm.contacts (account_id, phone) VALUES ('${A}', '5521${String(++n).padStart(8, "0")}') RETURNING id`)).id;
      const d = (await one<{ id: string }>(`INSERT INTO wacrm.billing_debts (account_id, contact_id, external_ref, due_date) VALUES ($1, $2, $3, '2026-10-19') RETURNING id`, [A, c, `ref-${++n}`])).id;
      const e = (await one<{ id: string }>(`INSERT INTO wacrm.billing_enrollments (account_id, ruler_id, debt_id, next_step_at) VALUES ($1, $2, $3, now()) RETURNING id`, [A, r, d])).id;
      const q = (await one<{ id: string }>(`INSERT INTO wacrm.disp_message_queue (account_id, contact_id, status, erro_permanente, erro_codigo, origem) VALUES ($1, $2, $3, $4, $5, 'regua') RETURNING id`, [A, c, queueStatus, over.permanente ?? false, over.codigo ?? null])).id;
      const s = (await one<{ id: string }>(`INSERT INTO wacrm.billing_step_sends (account_id, enrollment_id, contact_id, step_id, status, due_at, send_key, queue_item_id) VALUES ($1, $2, $3, $4, 'enqueued', now(), $5, $6) RETURNING id`, [A, e, c, st, `k-${++n}`, q])).id;
      return s;
    }
    const status = async (id: string) => one<{ status: string; error_code: string | null }>(`SELECT status, error_code FROM wacrm.billing_step_sends WHERE id = $1`, [id]);
    const reconcile = async (limit = 2000) => (await one<{ n: number }>(`SELECT wacrm.billing_reconcile_sends('${A}', $1) AS n`, [limit])).n;

    it("entregue→sent; cancelado→cancelled; erro PERMANENTE→error com o código; o que ainda está na fila não muda", async () => {
      const sent = await send("entregue");
      const cancelled = await send("cancelado");
      const failed = await send("erro", { permanente: true, codigo: 131026 });
      const retrying = await send("erro", { permanente: false, codigo: 131000 }); // a fila ainda vai tentar de novo
      const waiting = await send("agendado");
      const sending = await send("enviando");
      expect(await reconcile()).toBe(3);
      expect(await status(sent)).toEqual({ status: "sent", error_code: null });
      expect(await status(cancelled)).toEqual({ status: "cancelled", error_code: "queue_cancelled" });
      expect(await status(failed)).toEqual({ status: "error", error_code: "131026" });
      for (const id of [retrying, waiting, sending]) expect((await status(id)).status).toBe("enqueued");
      expect(await reconcile()).toBe(0); // idempotente
    });

    it("respeita o limite por chamada e a conta; só envios 'enqueued'", async () => {
      for (let i = 0; i < 3; i++) await send("entregue");
      expect(await reconcile(2)).toBe(2);
      expect(await reconcile(2)).toBe(1);
      const other = (await one<{ n: number }>(`SELECT wacrm.billing_reconcile_sends('00000000-0000-0000-0000-0000000000ff', 10) AS n`)).n;
      expect(other).toBe(0);
    });
  });

  it("fechadas para anon/authenticated; registrada; idempotente", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`SET ROLE ${role}`);
      try {
        await expect(db.query(`SELECT wacrm.billing_reconcile_sends('${A}')`)).rejects.toThrow(/permission denied/i);
        await expect(db.query(`SELECT * FROM wacrm.billing_claim_due_steps('${A}')`)).rejects.toThrow(/permission denied/i);
      } finally {
        await db.exec(`RESET ROLE`);
      }
    }
    expect((await db.query(`SELECT 1 FROM wacrm.schema_migrations WHERE version = '279_billing_enqueue'`)).rows).toHaveLength(1);
    await db.exec(migration("279_billing_enqueue.sql"));
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM wacrm.schema_migrations WHERE version = '279_billing_enqueue'`)).n).toBe(1);
  });
});
