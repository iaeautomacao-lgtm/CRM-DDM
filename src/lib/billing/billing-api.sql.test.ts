// Migrations 276 e 277 (PRD 17, PR 17.5): permissões billing.* e as funções da API (troca atômica de etapas, métricas).
// PGlite com as migrations REAIS 270–275 + 279 + 277; a 276 num catálogo mínimo (a prova completa catálogo×código está em roles-foundation.sql.test.ts).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const FILES = ["270_billing_rulers.sql", "271_billing_debts.sql", "272_billing_enrollments.sql", "273_billing_step_sends.sql", "274_billing_functions.sql", "275_billing_sync_state.sql", "279_billing_enqueue.sql", "277_billing_api_functions.sql"];
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
  CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
  INSERT INTO wacrm.accounts (id, name) VALUES ('${A}', 'A'), ('${B}', 'B');
`;

describe("migration 277 — troca atômica de etapas e métricas da régua", { timeout: 120_000 }, () => {
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
    await db.exec(`DELETE FROM wacrm.billing_step_sends; DELETE FROM wacrm.billing_enrollments; DELETE FROM wacrm.billing_debts; DELETE FROM wacrm.billing_ruler_steps; DELETE FROM wacrm.billing_rulers; DELETE FROM wacrm.contacts;`);
  });

  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
  const mkRuler = async (account = A) => (await one<{ id: string }>(`INSERT INTO wacrm.billing_rulers (account_id, name) VALUES ($1, $2) RETURNING id`, [account, `R${++n}`])).id;
  const replace = (account: string, ruler: string, steps: unknown[]) => db.query<{ n: number }>(`SELECT wacrm.billing_replace_steps($1, $2, $3::jsonb) AS n`, [account, ruler, JSON.stringify(steps)]);
  const steps = async (ruler: string) => (await db.query<{ id: string; position: number; offset_days: number; message_text: string | null; active: boolean }>(`SELECT id, position, offset_days, message_text, active FROM wacrm.billing_ruler_steps WHERE ruler_id = $1 ORDER BY position`, [ruler])).rows;
  const off = (offset_days: number, over: Record<string, unknown> = {}) => ({ kind: "offset", offset_days, message_text: `D${offset_days} {{1}}`, variable_map: [{ type: "contact_field", field: "name" }], active: true, ...over });

  it("cria na ordem da lista (posição 0..n-1) e devolve a quantidade", async () => {
    const r = await mkRuler();
    expect((await replace(A, r, [off(-3), off(0), off(2)])).rows[0].n).toBe(3);
    expect((await steps(r)).map((s) => [s.position, s.offset_days])).toEqual([[0, -3], [1, 0], [2, 2]]);
  });

  it("com id ATUALIZA a etapa (mesmo id, mesma linha) e reordena; sem id cria", async () => {
    const r = await mkRuler();
    await replace(A, r, [off(-3), off(0)]);
    const [s0, s1] = await steps(r);
    await replace(A, r, [off(0, { id: s1.id, message_text: "novo" }), off(-3, { id: s0.id }), off(5)]);
    const after = await steps(r);
    expect(after.map((s) => s.offset_days)).toEqual([0, -3, 5]);
    expect(after[0]).toMatchObject({ id: s1.id, message_text: "novo", position: 0 });
    expect(after[1].id).toBe(s0.id);
  });

  it("etapa que sai da lista é apagada SE nunca teve envio; com envio no histórico a troca inteira é recusada (nada muda)", async () => {
    const r = await mkRuler();
    await replace(A, r, [off(-3), off(0)]);
    const [s0, s1] = await steps(r);
    await replace(A, r, [off(-3, { id: s0.id })]);
    expect((await steps(r)).map((s) => s.id)).toEqual([s0.id]);

    // dá histórico à s0 e tenta remover
    const c = (await one<{ id: string }>(`INSERT INTO wacrm.contacts (account_id, phone) VALUES ($1, '5521999990001') RETURNING id`, [A])).id;
    const d = (await one<{ id: string }>(`INSERT INTO wacrm.billing_debts (account_id, contact_id, external_ref, due_date) VALUES ($1, $2, 'ref', '2026-10-22') RETURNING id`, [A, c])).id;
    const e = (await one<{ id: string }>(`INSERT INTO wacrm.billing_enrollments (account_id, ruler_id, debt_id) VALUES ($1, $2, $3) RETURNING id`, [A, r, d])).id;
    await db.query(`INSERT INTO wacrm.billing_step_sends (account_id, enrollment_id, contact_id, step_id, due_at, send_key, status) VALUES ($1, $2, $3, $4, now(), 'k', 'sent')`, [A, e, c, s0.id]);
    await expect(replace(A, r, [off(9)])).rejects.toThrow(/step_has_history/);
    expect((await steps(r)).map((s) => s.id)).toEqual([s0.id]); // transação revertida: nada mudou
    // manter a etapa (desativada) é o caminho
    await replace(A, r, [off(-3, { id: s0.id, active: false })]);
    expect((await steps(r))[0]).toMatchObject({ id: s0.id, active: false });
    expect(s1.id).not.toBe(s0.id);
  });

  it("régua de outra conta/inexistente e id de etapa alheia são recusados", async () => {
    const r = await mkRuler(A);
    const rb = await mkRuler(B);
    await replace(B, rb, [off(1)]);
    const alheia = (await steps(rb))[0].id;
    await expect(replace(B, r, [off(1)])).rejects.toThrow(/ruler_not_found/);
    await expect(replace(A, "00000000-0000-0000-0000-0000000000ff", [])).rejects.toThrow(/ruler_not_found/);
    await expect(replace(A, r, [off(1, { id: alheia })])).rejects.toThrow(/step_not_found/);
    await expect(db.query(`SELECT wacrm.billing_replace_steps($1, $2, '{}'::jsonb)`, [A, r])).rejects.toThrow(/array/);
  });

  it("os CHECKs do banco valem mesmo se a rota deixar passar (offset duplicado, kind×campos)", async () => {
    const r = await mkRuler();
    await expect(replace(A, r, [off(1), off(1)])).rejects.toThrow(/duplicate|unique/i);
    await expect(replace(A, r, [{ kind: "offset", status_trigger: "x" }])).rejects.toThrow(/check/i);
    expect(await steps(r)).toEqual([]);
  });

  it("lista vazia remove as etapas sem histórico (régua fica sem etapa)", async () => {
    const r = await mkRuler();
    await replace(A, r, [off(1)]);
    await replace(A, r, []);
    expect(await steps(r)).toEqual([]);
  });

  it("métricas: envios por etapa×status e inscrições por status×motivo, só da conta/régua pedida", async () => {
    const r = await mkRuler();
    await replace(A, r, [off(-3)]);
    const s = (await steps(r))[0].id;
    const c = (await one<{ id: string }>(`INSERT INTO wacrm.contacts (account_id, phone) VALUES ($1, '5521999990001') RETURNING id`, [A])).id;
    for (const [i, st] of ["sent", "sent", "delivered", "error"].entries()) {
      const d = (await one<{ id: string }>(`INSERT INTO wacrm.billing_debts (account_id, contact_id, external_ref, due_date) VALUES ($1, $2, $3, '2026-10-22') RETURNING id`, [A, c, `ref${i}`])).id;
      const e = (await one<{ id: string }>(`INSERT INTO wacrm.billing_enrollments (account_id, ruler_id, debt_id, status, stop_reason, stopped_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [A, r, d, i === 3 ? "stopped" : "active", i === 3 ? "paid" : null, i === 3 ? new Date() : null])).id;
      await db.query(`INSERT INTO wacrm.billing_step_sends (account_id, enrollment_id, contact_id, step_id, due_at, send_key, status) VALUES ($1, $2, $3, $4, now(), $5, $6)`, [A, e, c, s, `k${i}`, st]);
    }
    const m = (await one<{ m: { steps: Array<{ step_id: string; status: string; total: number }>; enrollments: Array<{ status: string; stop_reason: string | null; total: number }> } }>(`SELECT wacrm.billing_ruler_metrics($1, $2) AS m`, [A, r])).m;
    expect(m.steps.map((x) => `${x.status}:${x.total}`).sort()).toEqual(["delivered:1", "error:1", "sent:2"]);
    expect(m.enrollments.map((x) => `${x.status}/${x.stop_reason}:${x.total}`).sort()).toEqual(["active/null:3", "stopped/paid:1"]);
    const other = (await one<{ m: { steps: unknown[]; enrollments: unknown[] } }>(`SELECT wacrm.billing_ruler_metrics($1, $2) AS m`, [B, r])).m;
    expect(other).toEqual({ steps: [], enrollments: [] });
  });

  it("só o service_role executa; é idempotente (rodar de novo não falha) e registra a versão", async () => {
    await db.exec(migration("277_billing_api_functions.sql"));
    expect(await one(`SELECT has_function_privilege('authenticated', 'wacrm.billing_replace_steps(uuid,uuid,jsonb)', 'EXECUTE') AS a, has_function_privilege('service_role', 'wacrm.billing_replace_steps(uuid,uuid,jsonb)', 'EXECUTE') AS s`)).toEqual({ a: false, s: true });
    expect(await one(`SELECT version FROM wacrm.schema_migrations WHERE version = '277_billing_api_functions'`)).toEqual({ version: "277_billing_api_functions" });
  });
});

describe("migration 276 — permissões billing.* (catálogo mínimo)", { timeout: 60_000 }, () => {
  it("insere as duas no catálogo e nos papéis de sistema (owner/admin: ambas; supervisor: view); idempotente", async () => {
    const db = new PGlite();
    await db.exec(`
      CREATE SCHEMA wacrm;
      CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
      CREATE TABLE wacrm.permission_catalog (key text PRIMARY KEY, label text NOT NULL, description text NOT NULL, group_name text NOT NULL, scope text NOT NULL, owner_only boolean NOT NULL DEFAULT false, grantable boolean NOT NULL DEFAULT true, depends_on text[] NOT NULL DEFAULT '{}', sort integer NOT NULL);
      CREATE TABLE wacrm.account_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid, key text NOT NULL);
      CREATE TABLE wacrm.role_permissions (role_id uuid NOT NULL REFERENCES wacrm.account_roles(id), permission text NOT NULL REFERENCES wacrm.permission_catalog(key), PRIMARY KEY (role_id, permission));
      INSERT INTO wacrm.account_roles (account_id, key) VALUES (NULL, 'owner'), (NULL, 'admin'), (NULL, 'supervisor'), (NULL, 'agent'), (NULL, 'viewer'), ('${A}', 'admin');
    `);
    await db.exec(migration("276_billing_permissions.sql"));
    await db.exec(migration("276_billing_permissions.sql"));
    const cat = (await db.query<{ key: string; depends_on: string[]; sort: number; owner_only: boolean }>(`SELECT key, depends_on, sort, owner_only FROM wacrm.permission_catalog ORDER BY sort`)).rows;
    expect(cat).toEqual([{ key: "billing.view", depends_on: [], sort: 640, owner_only: false }, { key: "billing.manage", depends_on: ["billing.view"], sort: 650, owner_only: false }]);
    const grants = (await db.query<{ k: string; p: string }>(`SELECT r.key AS k, rp.permission AS p FROM wacrm.role_permissions rp JOIN wacrm.account_roles r ON r.id = rp.role_id ORDER BY 1, 2`)).rows.map((x) => `${x.k}:${x.p}`);
    expect(grants).toEqual(["admin:billing.manage", "admin:billing.view", "owner:billing.manage", "owner:billing.view", "supervisor:billing.view"]); // papel personalizado da conta A e agent/viewer: nada
    await db.close();
  });
});
