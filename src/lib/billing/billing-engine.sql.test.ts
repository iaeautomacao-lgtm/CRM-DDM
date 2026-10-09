// Migrations 270–275 (PRD 17, PR 17.1): régua de cobrança — tabelas e motor em SQL.
// PGlite com as migrations REAIS sobre um bootstrap mínimo (accounts, whatsapp_config, contacts, blacklist e os helpers phone_key /
// blacklisted_phone_keys da 167). Datas de 2026-10 com o fuso de Brasília (UTC-3): 19/10 é segunda, 22/10 quinta, 24/10 sábado.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const FILES = [
  "270_billing_rulers.sql",
  "271_billing_debts.sql",
  "272_billing_enrollments.sql",
  "273_billing_step_sends.sql",
  "274_billing_functions.sql",
  "275_billing_sync_state.sql",
];
const migration = (file: string) =>
  readFileSync(resolve(process.cwd(), "supabase/migrations", file), "utf8").replace(/NOTIFY pgrst[^;]*;/g, "");

const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";

const BOOTSTRAP = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA wacrm; GRANT USAGE ON SCHEMA wacrm TO anon, authenticated, service_role;
  CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
  CREATE TABLE wacrm.whatsapp_config (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid REFERENCES wacrm.accounts(id));
  CREATE TABLE wacrm.contacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid REFERENCES wacrm.accounts(id), phone text, cpf text);
  CREATE TABLE wacrm.blacklist (id bigserial PRIMARY KEY, account_id uuid, telefone text NOT NULL, motivo text);
  CREATE FUNCTION wacrm.phone_key(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT right(regexp_replace(coalesce(p, ''), '\\D', '', 'g'), 8) $$;
  CREATE FUNCTION wacrm.blacklisted_phone_keys(p_keys text[]) RETURNS TABLE(key text) LANGUAGE sql STABLE AS
    $$ SELECT DISTINCT wacrm.phone_key(b.telefone) FROM wacrm.blacklist b WHERE wacrm.phone_key(b.telefone) = ANY (p_keys) $$;
  CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
  INSERT INTO wacrm.accounts (id, name) VALUES ('${A}', 'A'), ('${B}', 'B');
`;

type Claimed = { send_id: string; enrollment_id: string; step_id: string; send_key: string; due_at: Date | string; template_id: string | null; message_text: string | null; contact_id: string; debt_id: string };

describe("migrations 270–275 — régua de cobrança", { timeout: 180_000 }, () => {
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
    await db.exec(`DELETE FROM wacrm.billing_step_sends; DELETE FROM wacrm.billing_enrollments; DELETE FROM wacrm.billing_debts;
      DELETE FROM wacrm.billing_ruler_steps; DELETE FROM wacrm.billing_rulers; DELETE FROM wacrm.billing_sync_state;
      DELETE FROM wacrm.blacklist; DELETE FROM wacrm.contacts;`);
  });

  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
  const contact = async (phone = `5521999${String(++n).padStart(6, "0")}`) =>
    (await one<{ id: string }>(`INSERT INTO wacrm.contacts (account_id, phone, cpf) VALUES ($1, $2, '12345678901') RETURNING id`, [A, phone])).id;
  const ruler = async (over: Record<string, unknown> = {}) => {
    const v = { active: true, dry_run: false, tolerance_days: 1, daily_cap_per_debtor: 1, priority: 100, ...over };
    return (await one<{ id: string }>(
      `INSERT INTO wacrm.billing_rulers (account_id, name, active, dry_run, tolerance_days, daily_cap_per_debtor, priority) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [A, `Régua ${++n}`, v.active, v.dry_run, v.tolerance_days, v.daily_cap_per_debtor, v.priority],
    )).id;
  };
  const step = async (rulerId: string, offset: number, position: number, text: string | null = "olá {{1}}") =>
    (await one<{ id: string }>(
      `INSERT INTO wacrm.billing_ruler_steps (account_id, ruler_id, position, kind, offset_days, message_text) VALUES ($1, $2, $3, 'offset', $4, $5) RETURNING id`,
      [A, rulerId, position, offset, text],
    )).id;
  const debt = async (contactId: string, due: string, status = "open") =>
    (await one<{ id: string }>(
      `INSERT INTO wacrm.billing_debts (account_id, contact_id, external_ref, due_date, amount_cents, status) VALUES ($1, $2, $3, $4, 15000, $5) RETURNING id`,
      [A, contactId, `ref-${++n}`, due, status],
    )).id;
  /** Inscreve com created_at e next_step_at controlados (o "agora" do teste é passado por parâmetro). */
  const enroll = async (rulerId: string, debtId: string, createdAt: string, nextStepAt: string) =>
    (await one<{ id: string }>(
      `INSERT INTO wacrm.billing_enrollments (account_id, ruler_id, debt_id, created_at, next_step_at) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [A, rulerId, debtId, createdAt, nextStepAt],
    )).id;
  const claim = async (now: string, limit = 200) => (await db.query<Claimed>(`SELECT * FROM wacrm.billing_claim_due_steps($1, $2, $3)`, [A, limit, now])).rows;
  const sends = async () => (await db.query<{ status: string; error_code: string | null }>(`SELECT status, error_code FROM wacrm.billing_step_sends ORDER BY due_at, status`)).rows;
  const enrollment = async (id: string) => one<{ status: string; stop_reason: string | null; next_step_at: Date | null }>(`SELECT status, stop_reason, next_step_at FROM wacrm.billing_enrollments WHERE id = $1`, [id]);
  const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

  /** Régua padrão: etapas D-3, D0, D+2 (08:00 de Brasília) e uma dívida que vence quinta 22/10. */
  async function scenario(over: Record<string, unknown> = {}, due = "2026-10-22") {
    const r = await ruler(over);
    const s = [await step(r, -3, 0), await step(r, 0, 1), await step(r, 2, 2)];
    const c = await contact();
    const d = await debt(c, due);
    const e = await enroll(r, d, "2026-10-10T12:00:00Z", "2026-10-19T11:00:00Z");
    return { r, s, c, d, e };
  }

  describe("tabelas", () => {
    it("etapa: offset exige offset_days, status exige status_trigger; offset único por régua; posição única", async () => {
      const r = await ruler();
      await expect(db.query(`INSERT INTO wacrm.billing_ruler_steps (account_id, ruler_id, position, kind) VALUES ($1, $2, 0, 'offset')`, [A, r])).rejects.toThrow(/check/i);
      await expect(db.query(`INSERT INTO wacrm.billing_ruler_steps (account_id, ruler_id, position, kind, offset_days, status_trigger) VALUES ($1, $2, 0, 'offset', 1, 'x')`, [A, r])).rejects.toThrow(/check/i);
      await db.query(`INSERT INTO wacrm.billing_ruler_steps (account_id, ruler_id, position, kind, status_trigger) VALUES ($1, $2, 5, 'status', 'acordo_quebrado')`, [A, r]);
      await step(r, 1, 0);
      await expect(step(r, 1, 1)).rejects.toThrow(/unique|duplicate/i);
      await expect(step(r, 2, 0)).rejects.toThrow(/unique|duplicate/i);
    });

    it("régua nasce DESLIGADA e em dry-run; janela e teto validados; nome único por conta", async () => {
      const row = await one<{ active: boolean; dry_run: boolean; window_start: string; weekdays: number[]; daily_cap_per_debtor: number }>(
        `INSERT INTO wacrm.billing_rulers (account_id, name) VALUES ($1, 'Padrão') RETURNING active, dry_run, window_start, weekdays, daily_cap_per_debtor`, [A]);
      expect(row).toMatchObject({ active: false, dry_run: true, window_start: "08:00:00", weekdays: [1, 2, 3, 4, 5], daily_cap_per_debtor: 1 });
      await expect(db.query(`INSERT INTO wacrm.billing_rulers (account_id, name, window_start, window_end) VALUES ($1, 'x', '20:00', '08:00')`, [A])).rejects.toThrow(/check/i);
      await expect(db.query(`INSERT INTO wacrm.billing_rulers (account_id, name, daily_cap_per_debtor) VALUES ($1, 'y', 0)`, [A])).rejects.toThrow(/check/i);
      await expect(db.query(`INSERT INTO wacrm.billing_rulers (account_id, name, weekdays) VALUES ($1, 'z', '{9}')`, [A])).rejects.toThrow(/check/i);
      await expect(db.query(`INSERT INTO wacrm.billing_rulers (account_id, name) VALUES ($1, '  padrão ')`, [A])).rejects.toThrow(/unique|duplicate/i);
    });

    it("inscrição: parada exige motivo e data; ativa não pode ter motivo; única por (régua, dívida)", async () => {
      const { r, d } = await scenario();
      await expect(db.query(`UPDATE wacrm.billing_enrollments SET status = 'stopped'`)).rejects.toThrow(/check/i);
      await expect(db.query(`UPDATE wacrm.billing_enrollments SET stop_reason = 'paid'`)).rejects.toThrow(/check/i);
      await expect(db.query(`UPDATE wacrm.billing_enrollments SET status = 'stopped', stop_reason = 'inventado', stopped_at = now()`)).rejects.toThrow(/check/i);
      await expect(enroll(r, d, "2026-10-10T00:00:00Z", "2026-10-19T00:00:00Z")).rejects.toThrow(/unique|duplicate/i);
    });

    it("dívida: status válido, única por (conta, fonte, ref); sem coluna de CPF", async () => {
      const c = await contact();
      await expect(debt(c, "2026-10-22", "paga")).rejects.toThrow(/check/i);
      await db.query(`INSERT INTO wacrm.billing_debts (account_id, contact_id, external_ref, due_date) VALUES ($1, $2, 'iddev:1', '2026-10-22')`, [A, c]);
      await expect(db.query(`INSERT INTO wacrm.billing_debts (account_id, contact_id, external_ref, due_date) VALUES ($1, $2, 'iddev:1', '2026-11-22')`, [A, c])).rejects.toThrow(/unique|duplicate/i);
      const cols = (await db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema='wacrm' AND table_name='billing_debts'`)).rows.map((r) => r.column_name);
      expect(cols.some((c2) => /cpf|doc/i.test(c2))).toBe(false);
    });

    it("tabelas fechadas: anon/authenticated sem acesso; funções só service_role; registro das 6 versões; idempotente", async () => {
      for (const role of ["anon", "authenticated"]) {
        await db.exec(`SET ROLE ${role}`);
        try {
          for (const t of ["billing_rulers", "billing_ruler_steps", "billing_debts", "billing_enrollments", "billing_step_sends", "billing_sync_state"]) {
            await expect(db.query(`SELECT 1 FROM wacrm.${t}`)).rejects.toThrow(/permission denied/i);
          }
          await expect(db.query(`SELECT * FROM wacrm.billing_claim_due_steps('${A}')`)).rejects.toThrow(/permission denied/i);
        } finally {
          await db.exec(`RESET ROLE`);
        }
      }
      expect((await db.query(`SELECT version FROM wacrm.schema_migrations ORDER BY 1`)).rows.map((r) => (r as { version: string }).version)).toEqual(FILES.map((f) => f.replace(".sql", "")));
      for (const f of FILES) await db.exec(migration(f));
      expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM wacrm.schema_migrations`)).n).toBe(6);
    });

    it("apagar a conta apaga tudo em cascata (sem órfãos)", async () => {
      await scenario();
      await db.exec(`INSERT INTO wacrm.billing_sync_state (account_id, source) VALUES ('${A}', 'ddm')`);
      await db.exec(`DELETE FROM wacrm.contacts; DELETE FROM wacrm.whatsapp_config; DELETE FROM wacrm.accounts WHERE id = '${A}'`);
      for (const t of ["billing_rulers", "billing_ruler_steps", "billing_debts", "billing_enrollments", "billing_sync_state"]) {
        expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM wacrm.${t}`)).n).toBe(0);
      }
      await db.exec(`INSERT INTO wacrm.accounts (id, name) VALUES ('${A}', 'A')`);
    });
  });

  describe("billing_step_due_at (Brasília)", () => {
    it("(vencimento + offset) às 08:00 de Brasília = 11:00Z; negativo = antes; cruza mês/ano", async () => {
      const at = async (due: string, off: number) => iso((await one<{ t: Date }>(`SELECT wacrm.billing_step_due_at($1::date, $2, '08:00'::time) AS t`, [due, off])).t);
      expect(await at("2026-10-20", -3)).toBe("2026-10-17T11:00:00.000Z");
      expect(await at("2026-10-20", 0)).toBe("2026-10-20T11:00:00.000Z");
      expect(await at("2026-10-30", 5)).toBe("2026-11-04T11:00:00.000Z");
      expect(await at("2026-01-02", -5)).toBe("2025-12-28T11:00:00.000Z");
    });
  });

  describe("billing_enroll_open_debts", () => {
    it("inscreve só dívida ABERTA com etapa ainda no alcance (dentro da tolerância); idempotente; calcula next_step_at", async () => {
      const r = await ruler({ tolerance_days: 1 });
      await step(r, -3, 0);
      await step(r, 0, 1);
      const c = await contact();
      const open = await debt(c, "2026-10-22");
      await debt(c, "2026-10-22", "paid");
      await debt(c, "2026-06-01"); // vencida há meses: nenhuma etapa no alcance
      const run = () => one<{ n: number }>(`SELECT wacrm.billing_enroll_open_debts($1, $2, $3) AS n`, [A, r, "2026-10-12T15:00:00Z"]);
      expect((await run()).n).toBe(1);
      expect((await run()).n).toBe(0);
      const e = await one<{ debt_id: string; status: string; next_step_at: Date }>(`SELECT debt_id, status, next_step_at FROM wacrm.billing_enrollments`);
      expect(e).toMatchObject({ debt_id: open, status: "active" });
      expect(iso(e.next_step_at)).toBe("2026-10-19T11:00:00.000Z"); // D-3 de 22/10
    });

    it("não inscreve em régua de outra conta nem sem etapa", async () => {
      const r = await ruler();
      await debt(await contact(), "2026-10-22");
      expect((await one<{ n: number }>(`SELECT wacrm.billing_enroll_open_debts($1, $2, now()) AS n`, [A, r])).n).toBe(0); // sem etapa
      await step(r, 0, 0);
      expect((await one<{ n: number }>(`SELECT wacrm.billing_enroll_open_debts($1, $2, $3) AS n`, [B, r, "2026-10-12T15:00:00Z"])).n).toBe(0); // conta errada
    });
  });

  describe("billing_claim_due_steps", () => {
    it("reserva a etapa devida dentro da janela, com chave determinística; adianta next_step_at; segunda chamada não repete", async () => {
      const { s, e, c, d } = await scenario();
      expect(await claim("2026-10-19T10:00:00Z")).toEqual([]); // 07:00 BRT: antes da janela (e antes de devida)
      const rows = await claim("2026-10-19T12:00:00Z"); // seg 09:00 BRT
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ enrollment_id: e, step_id: s[0], send_key: `regua:${e}:${s[0]}`, message_text: "olá {{1}}", contact_id: c, debt_id: d });
      expect(iso(rows[0].due_at)).toBe("2026-10-19T11:00:00.000Z");
      expect(iso((await enrollment(e)).next_step_at)).toBe("2026-10-22T11:00:00.000Z");
      expect(await claim("2026-10-19T12:05:00Z")).toEqual([]);
      expect(await sends()).toEqual([{ status: "reserved", error_code: null }]);
    });

    it("idempotência: etapa que já tem envio nunca é reservada de novo (UNIQUE enrollment+step)", async () => {
      const { s, e } = await scenario();
      await db.query(`INSERT INTO wacrm.billing_step_sends (account_id, enrollment_id, contact_id, step_id, status, due_at, send_key) VALUES ($1, $2, (SELECT id FROM wacrm.contacts LIMIT 1), $3, 'sent', '2026-10-19T11:00:00Z', 'regua:x')`, [A, e, s[0]]);
      expect(await claim("2026-10-19T12:00:00Z")).toEqual([]);
      await expect(
        db.query(`INSERT INTO wacrm.billing_step_sends (account_id, enrollment_id, contact_id, step_id, due_at, send_key) VALUES ($1, $2, (SELECT id FROM wacrm.contacts LIMIT 1), $3, now(), 'regua:y')`, [A, e, s[0]]),
      ).rejects.toThrow(/unique|duplicate/i);
    });

    it("fora da janela (depois das 20:00) ou em dia não permitido (sábado/domingo): nada sai e o estado não muda", async () => {
      const { e } = await scenario();
      expect(await claim("2026-10-19T23:30:00Z")).toEqual([]); // seg 20:30 BRT
      expect(await claim("2026-10-24T14:00:00Z")).toEqual([]); // sáb
      expect(await claim("2026-10-25T14:00:00Z")).toEqual([]); // dom
      expect((await enrollment(e)).status).toBe("active");
      expect(await sends()).toEqual([]);
    });

    it("régua inativa ou em dry-run NUNCA reserva", async () => {
      const a = await scenario({ active: false });
      expect(await claim("2026-10-19T12:00:00Z")).toEqual([]);
      await db.exec(`UPDATE wacrm.billing_rulers SET active = true, dry_run = true WHERE id = '${a.r}'`);
      expect(await claim("2026-10-19T12:00:00Z")).toEqual([]);
      await db.exec(`UPDATE wacrm.billing_rulers SET dry_run = false WHERE id = '${a.r}'`);
      expect(await claim("2026-10-19T12:00:00Z")).toHaveLength(1);
    });

    it("dívida que não está aberta não é cobrada", async () => {
      const { d } = await scenario();
      await db.exec(`UPDATE wacrm.billing_debts SET status = 'paid' WHERE id = '${d}'`);
      expect(await claim("2026-10-19T12:00:00Z")).toEqual([]);
    });

    it("percorre as etapas em ordem cronológica e conclui a inscrição na última", async () => {
      const { s, e } = await scenario({ tolerance_days: 2 });
      expect((await claim("2026-10-19T12:00:00Z")).map((x) => x.step_id)).toEqual([s[0]]);
      expect((await claim("2026-10-22T12:00:00Z")).map((x) => x.step_id)).toEqual([s[1]]); // qui, D0
      expect(iso((await enrollment(e)).next_step_at)).toBe("2026-10-24T11:00:00.000Z"); // D+2 = sábado
      expect((await claim("2026-10-26T12:00:00Z")).length).toBe(0); // segunda: a de sábado passou da tolerância de 2 dias? (48 h + 1 h) → expira
      expect(await sends()).toEqual(expect.arrayContaining([{ status: "expired", error_code: null }]));
      expect((await enrollment(e)).status).toBe("completed");
    });

    it("cron parado por dias: as etapas vencidas viram 'expired' (registradas) e NENHUMA sai — nunca rajada", async () => {
      const { e } = await scenario({ tolerance_days: 1 });
      // só roda na quarta 28/10 (6 dias depois): D-3, D0 e D+2 estão todas além da tolerância
      expect(await claim("2026-10-28T12:00:00Z")).toEqual([]);
      expect(await sends()).toEqual([
        { status: "expired", error_code: null },
        { status: "expired", error_code: null },
        { status: "expired", error_code: null },
      ]);
      expect((await enrollment(e)).status).toBe("completed");
    });

    it("etapa devida há pouco mas já passada a tolerância vira expired (registrada) e a seguinte ainda pode sair", async () => {
      const r = await ruler({ tolerance_days: 1 });
      const s1 = await step(r, 0, 0);
      const s2 = await step(r, 1, 1);
      const d = await debt(await contact(), "2026-10-21"); // qua
      const e = await enroll(r, d, "2026-10-20T00:00:00Z", "2026-10-21T11:00:00Z");
      // quinta 22/10 12:00Z: D0 (qua 11:00Z) está 25 h atrasada (> 1 dia) → expira; D+1 (qui 11:00Z) está devida → sai
      const rows = await claim("2026-10-22T12:00:00Z");
      expect(rows.map((x) => x.step_id)).toEqual([s2]);
      expect(await sends()).toEqual([{ status: "expired", error_code: null }, { status: "reserved", error_code: null }]);
      expect((await enrollment(e)).status).toBe("completed");
      void s1;
    });

    it("teto diário por devedor: duas dívidas do mesmo contato no mesmo dia ⇒ só uma sai; a outra espera o dia seguinte", async () => {
      const r = await ruler({ tolerance_days: 3, daily_cap_per_debtor: 1 });
      await step(r, 0, 0);
      const c = await contact();
      const d1 = await debt(c, "2026-10-19");
      const d2 = await debt(c, "2026-10-19");
      const e1 = await enroll(r, d1, "2026-10-10T00:00:00Z", "2026-10-19T11:00:00Z");
      const e2 = await enroll(r, d2, "2026-10-10T00:00:00Z", "2026-10-19T11:00:01Z");
      const first = await claim("2026-10-19T12:00:00Z");
      expect(first.map((x) => x.enrollment_id)).toEqual([e1]);
      expect(iso((await enrollment(e2)).next_step_at)).toBe("2026-10-20T11:00:00.000Z"); // amanhã 08:00 BRT
      expect(await claim("2026-10-19T13:00:00Z")).toEqual([]);
      expect((await claim("2026-10-20T12:00:00Z")).map((x) => x.enrollment_id)).toEqual([e2]);
    });

    it("teto 2: duas etapas no mesmo dia saem ambas; devedores diferentes não disputam o teto", async () => {
      const r = await ruler({ tolerance_days: 3, daily_cap_per_debtor: 2 });
      await step(r, 0, 0);
      const c = await contact();
      const [d1, d2] = [await debt(c, "2026-10-19"), await debt(c, "2026-10-19")];
      await enroll(r, d1, "2026-10-10T00:00:00Z", "2026-10-19T11:00:00Z");
      await enroll(r, d2, "2026-10-10T00:00:00Z", "2026-10-19T11:00:00Z");
      expect(await claim("2026-10-19T12:00:00Z")).toHaveLength(2);
      const other = await debt(await contact(), "2026-10-19");
      await enroll(r, other, "2026-10-10T00:00:00Z", "2026-10-19T11:00:00Z");
      expect(await claim("2026-10-19T12:10:00Z")).toHaveLength(1);
    });

    it("prioridade entre réguas e limite por chamada", async () => {
      const low = await ruler({ priority: 200 });
      const high = await ruler({ priority: 10 });
      await step(low, 0, 0);
      await step(high, 0, 0);
      const [c1, c2] = [await contact(), await contact()];
      const eLow = await enroll(low, await debt(c1, "2026-10-19"), "2026-10-10T00:00:00Z", "2026-10-19T11:00:00Z");
      const eHigh = await enroll(high, await debt(c2, "2026-10-19"), "2026-10-10T00:00:00Z", "2026-10-19T11:30:00Z");
      expect((await claim("2026-10-19T12:00:00Z", 1)).map((x) => x.enrollment_id)).toEqual([eHigh]);
      expect((await claim("2026-10-19T12:00:00Z", 5)).map((x) => x.enrollment_id)).toEqual([eLow]);
    });

    it("inscrição de outra conta nunca é reservada na conta errada", async () => {
      await scenario();
      expect((await db.query(`SELECT * FROM wacrm.billing_claim_due_steps($1, 200, $2)`, [B, "2026-10-19T12:00:00Z"])).rows).toEqual([]);
    });
  });

  describe("billing_stop_enrollments", () => {
    it("pago: para a inscrição, cancela o envio reservado, marca a dívida e nada mais sai", async () => {
      const { d, e } = await scenario();
      const [sent] = await claim("2026-10-19T12:00:00Z");
      expect((await one<{ n: number }>(`SELECT wacrm.billing_stop_enrollments($1, 'paid', $2, NULL) AS n`, [A, d])).n).toBe(1);
      expect(await enrollment(e)).toMatchObject({ status: "stopped", stop_reason: "paid", next_step_at: null });
      expect(await one(`SELECT status FROM wacrm.billing_debts WHERE id = $1`, [d])).toEqual({ status: "paid" });
      expect(await sends()).toEqual([{ status: "cancelled", error_code: "paid" }]);
      expect(await claim("2026-10-22T12:00:00Z")).toEqual([]);
      expect(await one(`SELECT wacrm.billing_should_send($1) AS r`, [sent.send_id])).toEqual({ r: { ok: false, reason: "send_not_pending" } });
      expect((await one<{ n: number }>(`SELECT wacrm.billing_stop_enrollments($1, 'paid', $2, NULL) AS n`, [A, d])).n).toBe(0); // idempotente
    });

    it("opt-out por CONTATO para todas as dívidas dele (e só dele); acordo marca a dívida", async () => {
      const r = await ruler();
      await step(r, 0, 0);
      const [c1, c2] = [await contact(), await contact()];
      const [d1, d2, d3] = [await debt(c1, "2026-10-22"), await debt(c1, "2026-11-22"), await debt(c2, "2026-10-22")];
      for (const d of [d1, d2, d3]) await enroll(r, d, "2026-10-10T00:00:00Z", "2026-10-22T11:00:00Z");
      expect((await one<{ n: number }>(`SELECT wacrm.billing_stop_enrollments($1, 'opt_out', NULL, $2) AS n`, [A, c1])).n).toBe(2);
      const rows = (await db.query<{ debt_id: string; status: string; stop_reason: string | null }>(`SELECT debt_id, status, stop_reason FROM wacrm.billing_enrollments`)).rows;
      expect(rows.find((x) => x.debt_id === d3)).toMatchObject({ status: "active", stop_reason: null });
      expect(rows.filter((x) => x.stop_reason === "opt_out")).toHaveLength(2);
      expect((await one<{ n: number }>(`SELECT wacrm.billing_stop_enrollments($1, 'agreement', $2, NULL) AS n`, [A, d3])).n).toBe(1);
      expect(await one(`SELECT status FROM wacrm.billing_debts WHERE id = $1`, [d3])).toEqual({ status: "agreement" });
    });

    it("motivo fora do enum e chamada sem dívida/contato são recusados; conta errada não para nada", async () => {
      const { d } = await scenario();
      await expect(one(`SELECT wacrm.billing_stop_enrollments($1, 'porque_sim', $2, NULL)`, [A, d])).rejects.toThrow(/motivo inválido/);
      await expect(one(`SELECT wacrm.billing_stop_enrollments($1, 'manual', NULL, NULL)`, [A])).rejects.toThrow(/dívida ou o contato/);
      expect((await one<{ n: number }>(`SELECT wacrm.billing_stop_enrollments($1, 'manual', $2, NULL) AS n`, [B, d])).n).toBe(0);
    });
  });

  describe("billing_should_send (guarda de pré-envio)", () => {
    const should = async (id: string) => (await one<{ r: { ok: boolean; reason: string | null } }>(`SELECT wacrm.billing_should_send($1) AS r`, [id])).r;

    it("ok quando tudo está em ordem; não altera a etapa", async () => {
      await scenario();
      const [sent] = await claim("2026-10-19T12:00:00Z");
      expect(await should(sent.send_id)).toEqual({ ok: true, reason: null });
      expect(await sends()).toEqual([{ status: "reserved", error_code: null }]);
    });

    it("blacklist entre a reserva e o envio: cancela a etapa e PARA a inscrição (blacklist)", async () => {
      const { e } = await scenario();
      const [sent] = await claim("2026-10-19T12:00:00Z");
      const phone = (await one<{ phone: string }>(`SELECT phone FROM wacrm.contacts`)).phone;
      await db.query(`INSERT INTO wacrm.blacklist (account_id, telefone, motivo) VALUES ($1, $2, 'opt_out')`, [A, `+${phone}`]);
      expect(await should(sent.send_id)).toEqual({ ok: false, reason: "blacklisted" });
      expect(await sends()).toEqual([{ status: "cancelled", error_code: "blacklisted" }]);
      expect(await enrollment(e)).toMatchObject({ status: "stopped", stop_reason: "blacklist" });
    });

    it.each([
      ["dívida paga", `UPDATE wacrm.billing_debts SET status = 'paid'`, "debt_paid"],
      ["dívida em acordo", `UPDATE wacrm.billing_debts SET status = 'agreement'`, "debt_agreement"],
      ["régua desligada", `UPDATE wacrm.billing_rulers SET active = false`, "ruler_inactive"],
      ["régua em dry-run", `UPDATE wacrm.billing_rulers SET dry_run = true`, "ruler_inactive"],
      ["inscrição pausada", `UPDATE wacrm.billing_enrollments SET status = 'paused'`, "enrollment_not_active"],
    ])("%s ⇒ cancela e diz o porquê", async (_n, sql, reason) => {
      await scenario();
      const [sent] = await claim("2026-10-19T12:00:00Z");
      await db.exec(sql);
      expect(await should(sent.send_id)).toEqual({ ok: false, reason });
      expect((await sends())[0]).toEqual({ status: "cancelled", error_code: reason });
    });

    it("envio inexistente ou já fora de 'reserved/enqueued' não é enviado", async () => {
      expect(await should("00000000-0000-0000-0000-0000000000ff")).toEqual({ ok: false, reason: "send_not_found" });
      await scenario();
      const [sent] = await claim("2026-10-19T12:00:00Z");
      await db.exec(`UPDATE wacrm.billing_step_sends SET status = 'sent'`);
      expect(await should(sent.send_id)).toEqual({ ok: false, reason: "send_not_pending" });
    });
  });

  describe("billing_dry_run", () => {
    it("conta quantas dívidas teriam a etapa numa data, sem criar nada", async () => {
      const r = await ruler({ active: false, dry_run: true });
      const s1 = await step(r, -3, 0);
      const s2 = await step(r, 0, 1);
      const c = await contact();
      for (const due of ["2026-10-22", "2026-10-22", "2026-10-25"]) await debt(c, due);
      await debt(c, "2026-10-22", "paid");
      const run = async (date: string) => (await db.query<{ step_id: string; offset_days: number; debts: number }>(`SELECT * FROM wacrm.billing_dry_run($1, $2, $3)`, [A, r, date])).rows;
      expect(await run("2026-10-19")).toEqual([{ step_id: s1, offset_days: -3, debts: 2 }, { step_id: s2, offset_days: 0, debts: 0 }]);
      expect(await run("2026-10-22")).toEqual([{ step_id: s1, offset_days: -3, debts: 1 }, { step_id: s2, offset_days: 0, debts: 2 }]);
      expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM wacrm.billing_step_sends`)).n).toBe(0);
      expect((await db.query(`SELECT * FROM wacrm.billing_dry_run($1, $2, '2026-10-22')`, [B, r])).rows).toEqual([]);
    });
  });

  describe("escala", () => {
    it("30 mil inscrições: o tick (limite 1000) reserva rápido e sem duplicar; segunda rodada pega as seguintes", async () => {
      // banco próprio (sem a sujeira dos outros testes) e ANALYZE depois da carga, como o autovacuum faz em produção
      const big = new PGlite();
      try {
        await big.exec(BOOTSTRAP);
        for (const f of FILES) await big.exec(migration(f));
        await big.exec(`
          INSERT INTO wacrm.billing_rulers (id, account_id, name, active, dry_run, tolerance_days) VALUES ('00000000-0000-0000-0000-0000000000a1', '${A}', 'carga', true, false, 2);
          INSERT INTO wacrm.billing_ruler_steps (account_id, ruler_id, position, kind, offset_days) VALUES ('${A}', '00000000-0000-0000-0000-0000000000a1', 0, 'offset', 0);
          INSERT INTO wacrm.contacts (account_id, phone) SELECT '${A}', '5521' || lpad(g::text, 9, '0') FROM generate_series(1, 30000) g;
          INSERT INTO wacrm.billing_debts (account_id, contact_id, external_ref, due_date) SELECT '${A}', c.id, 'ref-' || c.phone, '2026-10-19' FROM wacrm.contacts c;
          INSERT INTO wacrm.billing_enrollments (account_id, ruler_id, debt_id, created_at, next_step_at)
            SELECT '${A}', '00000000-0000-0000-0000-0000000000a1', d.id, '2026-10-10T00:00:00Z', '2026-10-19T11:00:00Z' FROM wacrm.billing_debts d;
          ANALYZE;
        `);
        const run = (limit: number) => big.query<{ send_key: string }>(`SELECT * FROM wacrm.billing_claim_due_steps($1, $2, $3)`, [A, limit, "2026-10-19T12:00:00Z"]);
        const t0 = performance.now();
        const first = (await run(1000)).rows;
        const ms = performance.now() - t0;
        const second = (await run(1000)).rows;
        console.info(`[270-275 carga] 30k inscrições: claim de 1000 em ${ms.toFixed(0)} ms`);
        expect(first).toHaveLength(1000);
        expect(second).toHaveLength(1000);
        expect(new Set([...first, ...second].map((x) => x.send_key)).size).toBe(2000);
        expect(ms).toBeLessThan(15_000);
      } finally {
        await big.close();
      }
    }, 120_000);
  });
});
