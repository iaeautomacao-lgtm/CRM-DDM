// Migration 320 (PRD 17, PR 17.6): relatório por período ("pago após cobrança", respondidas) e dados de alerta.
// PGlite com as migrations REAIS 270–275 + 279 + 320 sobre conversations/messages/fila mínimos.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const FILES = ["270_billing_rulers.sql", "271_billing_debts.sql", "272_billing_enrollments.sql", "273_billing_step_sends.sql", "274_billing_functions.sql", "275_billing_sync_state.sql", "279_billing_enqueue.sql", "320_billing_reports.sql"];
const migration = (file: string) => readFileSync(resolve(process.cwd(), "supabase/migrations", file), "utf8").replace(/NOTIFY pgrst[^;]*;/g, "");
const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";

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
  CREATE TABLE wacrm.conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid, contact_id uuid);
  CREATE TABLE wacrm.messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid, sender_type text, created_at timestamptz DEFAULT now());
  CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
  INSERT INTO wacrm.accounts (id, name) VALUES ('${A}', 'A'), ('${B}', 'B');
`;

describe("migration 320 — relatório e alertas da régua", { timeout: 120_000 }, () => {
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
    await db.exec(`DELETE FROM wacrm.messages; DELETE FROM wacrm.conversations; DELETE FROM wacrm.disp_message_queue; DELETE FROM wacrm.billing_step_sends; DELETE FROM wacrm.billing_enrollments;
      DELETE FROM wacrm.billing_debts; DELETE FROM wacrm.billing_ruler_steps; DELETE FROM wacrm.billing_rulers; DELETE FROM wacrm.billing_sync_state; DELETE FROM wacrm.contacts;`);
  });

  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];

  // Cenário: régua com etapas D-3 e D0. `at` = instante de envio (fila.sent_at).
  async function setup(account = A) {
    const ruler = (await one<{ id: string }>(`INSERT INTO wacrm.billing_rulers (account_id, name) VALUES ($1, $2) RETURNING id`, [account, `R${++n}`])).id;
    const step = async (pos: number, off: number) =>
      (await one<{ id: string }>(`INSERT INTO wacrm.billing_ruler_steps (account_id, ruler_id, position, kind, offset_days, message_text) VALUES ($1, $2, $3, 'offset', $4, 'x') RETURNING id`, [account, ruler, pos, off])).id;
    const s1 = await step(0, -3);
    const s2 = await step(1, 0);
    let k = 0;
    const debt = async (contact: string) => {
      const d = (await one<{ id: string }>(`INSERT INTO wacrm.billing_debts (account_id, contact_id, external_ref, due_date) VALUES ($1, $2, $3, '2026-10-22') RETURNING id`, [account, contact, `ref${++k}-${n}`])).id;
      return (await one<{ id: string }>(`INSERT INTO wacrm.billing_enrollments (account_id, ruler_id, debt_id) VALUES ($1, $2, $3) RETURNING id`, [account, ruler, d])).id;
    };
    const contact = async () => (await one<{ id: string }>(`INSERT INTO wacrm.contacts (account_id, phone) VALUES ($1, $2) RETURNING id`, [account, `55219999${++k}`])).id;
    const send = async (enr: string, contactId: string, step: string, status: string, at: string) => {
      const q = (await one<{ id: string }>(`INSERT INTO wacrm.disp_message_queue (account_id, contact_id, sent_at) VALUES ($1, $2, $3::timestamptz) RETURNING id`, [account, contactId, at])).id;
      await db.query(`INSERT INTO wacrm.billing_step_sends (account_id, enrollment_id, contact_id, step_id, due_at, send_key, status, queue_item_id) VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8)`, [account, enr, contactId, step, at, `k${++k}`, status, q]);
    };
    const stop = (enr: string, reason: string, at: string) =>
      db.query(`UPDATE wacrm.billing_enrollments SET status = 'stopped', stop_reason = $2, stopped_at = $3::timestamptz WHERE id = $1`, [enr, reason, at]);
    const reply = async (contactId: string, at: string) => {
      const conv = (await one<{ id: string }>(`INSERT INTO wacrm.conversations (account_id, contact_id) VALUES ($1, $2) RETURNING id`, [account, contactId])).id;
      await db.query(`INSERT INTO wacrm.messages (conversation_id, sender_type, created_at) VALUES ($1, 'customer', $2::timestamptz)`, [conv, at]);
    };
    return { ruler, s1, s2, debt, contact, send, stop, reply };
  }

  const report = async (account: string, ruler: string, from = "2026-10-01", to = "2026-10-31") =>
    (await one<{ r: Record<string, any> }>(`SELECT wacrm.billing_ruler_report($1, $2, $3::date, $4::date) AS r`, [account, ruler, from, to])).r;

  it("funil por etapa: enviadas/entregues/lidas/erros e RESPONDIDAS (cliente escreveu em até 3 dias; antes do envio ou depois de 3 dias não vale)", async () => {
    const t = await setup();
    const [c1, c2, c3, c4] = [await t.contact(), await t.contact(), await t.contact(), await t.contact()];
    const [e1, e2, e3, e4] = [await t.debt(c1), await t.debt(c2), await t.debt(c3), await t.debt(c4)];
    await t.send(e1, c1, t.s1, "read", "2026-10-10T13:00:00Z");
    await t.send(e2, c2, t.s1, "delivered", "2026-10-10T13:00:00Z");
    await t.send(e3, c3, t.s1, "sent", "2026-10-10T13:00:00Z");
    await t.send(e4, c4, t.s1, "error", "2026-10-10T13:00:00Z");
    await t.reply(c1, "2026-10-11T10:00:00Z"); // dentro de 3 dias ⇒ respondida
    await t.reply(c2, "2026-10-09T10:00:00Z"); // ANTES do envio ⇒ não conta
    await t.reply(c3, "2026-10-14T10:00:00Z"); // depois de 3 dias ⇒ não conta
    const r = await report(A, t.ruler);
    const s1 = r.steps.find((s: any) => s.step_id === t.s1);
    expect(s1).toMatchObject({ sent: 3, delivered: 2, read: 1, replied: 1, errors: 1, paid_after: 0 });
    expect(r.steps.find((s: any) => s.step_id === t.s2)).toMatchObject({ sent: 0, replied: 0 });
    expect(r.totals).toEqual({ sent: 3, delivered: 2, read: 1, replied: 1, errors: 1 });
  });

  it("PAGA APÓS COBRANÇA: pagamento detectado depois de etapa enviada, atribuído à ÚLTIMA etapa enviada; 'cobranças até o pagamento'", async () => {
    const t = await setup();
    const [c1, c2] = [await t.contact(), await t.contact()];
    const [e1, e2] = [await t.debt(c1), await t.debt(c2)];
    await t.send(e1, c1, t.s1, "delivered", "2026-10-10T13:00:00Z");
    await t.send(e1, c1, t.s2, "read", "2026-10-13T13:00:00Z");
    await t.stop(e1, "paid", "2026-10-14T09:00:00Z"); // 2 cobranças, última = s2
    await t.send(e2, c2, t.s1, "sent", "2026-10-10T13:00:00Z");
    await t.stop(e2, "paid", "2026-10-11T09:00:00Z"); // 1 cobrança, última = s1
    const r = await report(A, t.ruler);
    expect(r.steps.find((s: any) => s.step_id === t.s2).paid_after).toBe(1);
    expect(r.steps.find((s: any) => s.step_id === t.s1).paid_after).toBe(1);
    expect(r.payments).toMatchObject({ paid_after_charge: 2, paid_without_charge: 0, avg_charges_before_payment: 1.5 });
    expect(r.payments.by_charges).toEqual([{ charges: 1, total: 1 }, { charges: 2, total: 1 }]);
  });

  it("pagamento SEM cobrança antes não é 'pago após cobrança'; etapa enviada DEPOIS da parada não conta; outros motivos de parada ficam fora", async () => {
    const t = await setup();
    const [c1, c2, c3] = [await t.contact(), await t.contact(), await t.contact()];
    const [e1, e2, e3] = [await t.debt(c1), await t.debt(c2), await t.debt(c3)];
    await t.stop(e1, "paid", "2026-10-09T09:00:00Z"); // pago antes de qualquer envio
    await t.send(e2, c2, t.s1, "sent", "2026-10-12T13:00:00Z");
    await t.stop(e2, "paid", "2026-10-10T09:00:00Z"); // envio registrado DEPOIS da detecção
    await t.send(e3, c3, t.s1, "sent", "2026-10-10T13:00:00Z");
    await t.stop(e3, "agreement", "2026-10-11T09:00:00Z"); // acordo não é pagamento
    const r = await report(A, t.ruler);
    expect(r.payments).toMatchObject({ paid_after_charge: 0, paid_without_charge: 2, avg_charges_before_payment: null, by_charges: [] });
  });

  it("período em horário de Brasília: envio às 02:00 UTC do dia 11 (23:00 do dia 10 em Brasília) cai no dia 10; fora do período não entra; série diária", async () => {
    const t = await setup();
    const c = await t.contact();
    const e = await t.debt(c);
    await t.send(e, c, t.s1, "sent", "2026-10-11T02:00:00Z"); // 10/10 23:00 BRT
    await t.stop(e, "paid", "2026-10-12T12:00:00Z");
    const c2 = await t.contact();
    await t.send(await t.debt(c2), c2, t.s1, "sent", "2026-09-30T20:00:00Z"); // fora de 01–31/10
    const r = await report(A, t.ruler, "2026-10-10", "2026-10-12");
    expect(r.totals.sent).toBe(1);
    expect(r.daily).toEqual([{ day: "2026-10-10", sent: 1, paid_after: 0 }, { day: "2026-10-12", sent: 0, paid_after: 1 }]);
    expect((await report(A, t.ruler, "2026-10-11", "2026-10-31")).totals.sent).toBe(0); // 02:00 UTC do dia 11 já é dia 10 em Brasília
  });

  it("escopo e validação: régua de outra conta, período invertido e > 93 dias são recusados; sem dados devolve zeros", async () => {
    const t = await setup();
    await expect(report(B, t.ruler)).rejects.toThrow(/ruler_not_found/);
    await expect(report(A, t.ruler, "2026-10-31", "2026-10-01")).rejects.toThrow(/range_invalid/);
    await expect(report(A, t.ruler, "2026-01-01", "2026-12-31")).rejects.toThrow(/range_invalid/);
    const r = await report(A, t.ruler);
    expect(r.totals).toEqual({ sent: 0, delivered: 0, read: 0, replied: 0, errors: 0 });
    expect(r.payments).toMatchObject({ paid_after_charge: 0, paid_without_charge: 0 });
    expect(r.daily).toEqual([]);
  });

  it("alert_stats: reservadas paradas > 15 min, sync por fonte, réguas ligadas fora do dry-run, dívidas abertas — só da conta", async () => {
    const t = await setup();
    const c = await t.contact();
    const e = await t.debt(c);
    await db.query(`INSERT INTO wacrm.billing_step_sends (account_id, enrollment_id, contact_id, step_id, due_at, send_key, status, reserved_at) VALUES ($1, $2, $3, $4, now(), 'k-old', 'reserved', now() - interval '20 minutes')`, [A, e, c, t.s1]);
    await db.query(`INSERT INTO wacrm.billing_sync_state (account_id, source, last_success_at) VALUES ($1, 'ddm', now() - interval '2 hours')`, [A]);
    await db.query(`UPDATE wacrm.billing_rulers SET active = true, dry_run = false WHERE id = $1`, [t.ruler]);
    const s = (await one<{ s: Record<string, any> }>(`SELECT wacrm.billing_alert_stats($1) AS s`, [A])).s;
    expect(s.reserved_stuck).toBe(1);
    expect(s.oldest_reserved_s).toBeGreaterThanOrEqual(1200);
    expect(s.sync).toHaveLength(1);
    expect(s.sync[0]).toMatchObject({ source: "ddm" });
    expect(s.live_rulers).toEqual([{ id: t.ruler, name: expect.any(String), channel_id: null }]);
    expect(s.open_debts).toBe(1);
    const other = (await one<{ s: Record<string, any> }>(`SELECT wacrm.billing_alert_stats($1) AS s`, [B])).s;
    expect(other).toMatchObject({ reserved_stuck: 0, open_debts: 0, sync: [], live_rulers: [] });
  });

  it("só o service_role executa; idempotente e registra a versão", async () => {
    await db.exec(migration("320_billing_reports.sql"));
    expect(await one(`SELECT has_function_privilege('authenticated', 'wacrm.billing_ruler_report(uuid,uuid,date,date)', 'EXECUTE') AS a, has_function_privilege('service_role', 'wacrm.billing_ruler_report(uuid,uuid,date,date)', 'EXECUTE') AS s`)).toEqual({ a: false, s: true });
    expect(await one(`SELECT version FROM wacrm.schema_migrations WHERE version = '320_billing_reports'`)).toEqual({ version: "320_billing_reports" });
  });
});
