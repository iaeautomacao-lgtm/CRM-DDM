import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Migration 356 (UTMpay): tabelas, RLS com has_perm, RPC do funil, idempotência, ROLLBACK executável.
const A = "00000000-0000-0000-0000-0000000000a1";
const B = "00000000-0000-0000-0000-0000000000b1";
const U1 = "00000000-0000-0000-0000-0000000000c1";
const CAMP1 = "00000000-0000-0000-0000-0000000000d1";
const CAMP2 = "00000000-0000-0000-0000-0000000000d2";
const CAMP_B = "00000000-0000-0000-0000-0000000000d3";
const ATT1 = "00000000-0000-0000-0000-0000000000e1";
const ATT2 = "00000000-0000-0000-0000-0000000000e2";

const M356 = readFileSync(resolve("supabase/migrations/356_utmpay_integracao.sql"), "utf8");

function rollbackSql(): string {
  const lines = M356.split("\n");
  const start = lines.findIndex((l) => l.startsWith("-- ROLLBACK:"));
  const end = lines.findIndex((l, i) => i > start && l.startsWith("-- ====="));
  return lines
    .slice(start, end)
    .map((l, i) => (i === 0 ? l.replace("-- ROLLBACK:", "") : l.replace(/^--\s?/, "")))
    .join("\n");
}

async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA wacrm; CREATE SCHEMA auth;
    GRANT USAGE ON SCHEMA wacrm, auth TO authenticated, service_role;
    CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY);
    CREATE TABLE wacrm.campaigns (id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES wacrm.accounts(id));
    CREATE TABLE wacrm.contacts (id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES wacrm.accounts(id));
    CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
    INSERT INTO wacrm.accounts VALUES ('${A}'), ('${B}');
    INSERT INTO wacrm.campaigns VALUES ('${CAMP1}', '${A}'), ('${CAMP2}', '${A}'), ('${CAMP_B}', '${B}');
    INSERT INTO wacrm.contacts VALUES ('00000000-0000-0000-0000-0000000000f1', '${A}');
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('app.uid', true), '')::uuid $f$;
    CREATE FUNCTION wacrm.is_account_member(p_account uuid) RETURNS boolean LANGUAGE sql STABLE
      AS $f$ SELECT p_account::text = current_setting('app.acc', true) $f$;
    CREATE FUNCTION wacrm.has_perm(p text) RETURNS boolean LANGUAGE sql STABLE
      AS $f$ SELECT position(',' || p || ',' IN ',' || coalesce(current_setting('app.perms', true), '') || ',') > 0 $f$;
    CREATE TABLE wacrm.mfa_calls (tbl text);
    CREATE FUNCTION wacrm.apply_mfa_policy(t regclass) RETURNS void LANGUAGE sql AS $f$ INSERT INTO wacrm.mfa_calls VALUES (t::text) $f$;
  `);
  return db;
}

const as = async (db: PGlite, acc: string, perms: string) => {
  await db.exec(`RESET ROLE; SELECT set_config('app.uid', '${U1}', false), set_config('app.acc', '${acc}', false), set_config('app.perms', '${perms}', false); SET ROLE authenticated;`);
};

const link = (tid: string, acc: string, camp: string, extra = "") =>
  `INSERT INTO wacrm.utmpay_links (tid, account_id, campaign_id, destino, link_curto${extra ? ", " + extra.split("|")[0] : ""}) VALUES ('${tid}', '${acc}', '${camp}', 'https://ddmacordos.com/p', 'https://utm.exemplo.com/s/${tid}'${extra ? ", " + extra.split("|")[1] : ""})`;

describe("356 — UTMpay", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await freshDb();
    await db.exec(M356);
    await db.exec(M356); // idempotente
  }, 90_000);

  afterAll(async () => {
    await db?.close();
  });

  it("registra a migration e cobre as três tabelas com a política de 2FA (quando existe)", async () => {
    expect((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM wacrm.schema_migrations WHERE version = '356_utmpay_integracao'`)).rows[0].n).toBe(1);
    const m = await db.query<{ tbl: string }>(`SELECT DISTINCT tbl FROM wacrm.mfa_calls ORDER BY tbl`);
    expect(m.rows.map((r) => r.tbl)).toEqual(["wacrm.utmpay_config", "wacrm.utmpay_events", "wacrm.utmpay_links"]);
  });

  it("utmpay_config: só o servidor (authenticated não lê nem escreve); base_url precisa ser https só com a origem; janela 1–90", async () => {
    await db.exec(`INSERT INTO wacrm.utmpay_config (account_id, base_url, api_key_enc) VALUES ('${A}', 'https://utm.exemplo.com', 'iv:cifrado:tag')`);
    await expect(db.exec(`INSERT INTO wacrm.utmpay_config (account_id, base_url) VALUES ('${B}', 'http://inseguro.com')`)).rejects.toThrow();
    await expect(db.exec(`INSERT INTO wacrm.utmpay_config (account_id, base_url) VALUES ('${B}', 'https://x.com/caminho')`)).rejects.toThrow();
    await expect(db.exec(`INSERT INTO wacrm.utmpay_config (account_id, base_url, janela_dias) VALUES ('${B}', 'https://x.com', 0)`)).rejects.toThrow();
    const d = await db.query<{ janela_dias: number; send_without_tracking: boolean; enabled: boolean }>(`SELECT janela_dias, send_without_tracking, enabled FROM wacrm.utmpay_config WHERE account_id = '${A}'`);
    expect(d.rows[0]).toEqual({ janela_dias: 7, send_without_tracking: false, enabled: true });
    await as(db, A, "campaigns.view,settings.account");
    await expect(db.exec(`SELECT * FROM wacrm.utmpay_config`)).rejects.toThrow();
    await db.exec("RESET ROLE; SET ROLE anon");
    await expect(db.exec(`SELECT * FROM wacrm.utmpay_config`)).rejects.toThrow();
    await db.exec("RESET ROLE");
  });

  it("utmpay_links: ler só com campaigns.view e da própria conta; ninguém escreve pelo cliente", async () => {
    await db.exec(link("t-a1", A, CAMP1));
    await db.exec(link("t-b1", B, CAMP_B));
    await as(db, A, "campaigns.view");
    expect((await db.query<{ tid: string }>(`SELECT tid FROM wacrm.utmpay_links`)).rows.map((r) => r.tid)).toEqual(["t-a1"]);
    await expect(db.exec(`UPDATE wacrm.utmpay_links SET clicou_em = now()`)).rejects.toThrow();
    await expect(db.exec(link("t-x", A, CAMP1))).rejects.toThrow();
    await as(db, A, "inbox.view"); // sem campaigns.view
    expect((await db.query(`SELECT * FROM wacrm.utmpay_links`)).rows).toHaveLength(0);
    await db.exec("RESET ROLE");
  });

  it("utmpay_links: link_curto/destino só http(s); atribuição só direto|ia|humano; tid até 40 caracteres", async () => {
    await expect(db.exec(`INSERT INTO wacrm.utmpay_links (tid, account_id, destino, link_curto) VALUES ('t-x', '${A}', 'javascript:alert(1)', 'https://u/s/x')`)).rejects.toThrow();
    await expect(db.exec(`INSERT INTO wacrm.utmpay_links (tid, account_id, destino, link_curto) VALUES ('t-y', '${A}', 'https://ok.com', 'ftp://u/s/x')`)).rejects.toThrow();
    await expect(db.exec(link("t-z", A, CAMP1, "atribuicao|'robo'"))).rejects.toThrow();
    await expect(db.exec(link("x".repeat(41), A, CAMP1))).rejects.toThrow();
    await db.exec(link("x".repeat(40), A, CAMP1)); // 40 cabe (tid = uuid de 36 também)
  });

  it("utmpay_events: tid precisa existir; etapa do contrato; event_id único (idempotência); leitura só com campaigns.view", async () => {
    const ev = (id: string, tid: string, etapa: string) =>
      `INSERT INTO wacrm.utmpay_events (event_id, account_id, tid, etapa, occurred_at) VALUES ('${id}', '${A}', '${tid}', '${etapa}', now())`;
    const E1 = "123e4567-e89b-42d3-a456-426614174001";
    await db.exec(ev(E1, "t-a1", "click"));
    await expect(db.exec(ev(E1, "t-a1", "click"))).rejects.toThrow(/duplicate|unique/i);
    await expect(db.exec(ev("123e4567-e89b-42d3-a456-426614174002", "tid-inexistente", "click"))).rejects.toThrow();
    await expect(db.exec(ev("123e4567-e89b-42d3-a456-426614174003", "t-a1", "comprou"))).rejects.toThrow();
    for (const [i, etapa] of ["cpf_view", "cpf_submit", "payment_view", "payment_start", "paid"].entries()) {
      await db.exec(ev(`123e4567-e89b-42d3-a456-42661417410${i}`, "t-a1", etapa));
    }
    await as(db, A, "campaigns.view");
    expect((await db.query(`SELECT * FROM wacrm.utmpay_events`)).rows).toHaveLength(6);
    await expect(db.exec(ev("123e4567-e89b-42d3-a456-426614174999", "t-a1", "click"))).rejects.toThrow();
    await as(db, B, "campaigns.view");
    expect((await db.query(`SELECT * FROM wacrm.utmpay_events`)).rows).toHaveLength(0);
    await db.exec("RESET ROLE");
  });

  it("utmpay_funnel: conta links, clicou, fechou, pagou, por atribuição e por atendente; filtra campanha e período; fechada para authenticated", async () => {
    await db.exec(`DELETE FROM wacrm.utmpay_links`);
    await db.exec(link("f1", A, CAMP1, `clicou_em, fechou_em, pagou_em, atribuicao, atendente_id|now(), now(), now(), 'humano', '${ATT1}'`));
    await db.exec(link("f2", A, CAMP1, `clicou_em, fechou_em, atribuicao, atendente_id|now(), now(), 'humano', '${ATT2}'`));
    await db.exec(link("f3", A, CAMP1, `clicou_em, fechou_em, pagou_em, atribuicao|now(), now(), now(), 'ia'`));
    await db.exec(link("f4", A, CAMP1, `clicou_em, atribuicao|now(), 'direto'`));
    await db.exec(link("f5", A, CAMP1));
    await db.exec(link("f6", A, CAMP2, `clicou_em, fechou_em, atribuicao|now(), now(), 'direto'`));
    await db.exec(link("f7", A, CAMP1, `created_at, clicou_em|now() - interval '40 days', now() - interval '40 days'`));
    const f = async (camp: string | null, since: string | null) =>
      (await db.query<{ r: Record<string, unknown> }>(`SELECT wacrm.utmpay_funnel('${A}', ${camp ? `'${camp}'` : "NULL"}, ${since ? `now() - interval '${since}'` : "NULL"}) AS r`)).rows[0].r;

    const c1 = await f(CAMP1, null);
    expect(c1).toMatchObject({ links: 6, clicou: 5, fechou: 3, pagou: 2 });
    expect(c1.por_atribuicao).toEqual({ fechou: { humano: 2, ia: 1 }, pagou: { humano: 1, ia: 1 } });
    expect(c1.por_atendente).toEqual([
      { atendente_id: ATT1, fechou: 1, pagou: 1 },
      { atendente_id: ATT2, fechou: 1, pagou: 0 },
    ]); // ordenado: mais pagos primeiro
    expect(await f(CAMP2, null)).toMatchObject({ links: 1, clicou: 1, fechou: 1, pagou: 0 });
    const periodo = await f(null, "30 days"); // a conta toda, sem o envio de 40 dias atrás
    expect(periodo).toMatchObject({ links: 6, clicou: 5, fechou: 4, pagou: 2 });
    expect(await f(CAMP_B, null)).toMatchObject({ links: 0, clicou: 0, fechou: 0, pagou: 0 }); // outra conta: nada

    await as(db, A, "campaigns.view");
    await expect(db.exec(`SELECT wacrm.utmpay_funnel('${A}', NULL, NULL)`)).rejects.toThrow();
    await db.exec("RESET ROLE");
  });

  it("apagar a campanha leva os links e os eventos junto", async () => {
    await db.exec(`INSERT INTO wacrm.utmpay_events (event_id, account_id, tid, etapa, occurred_at) VALUES ('123e4567-e89b-42d3-a456-426614175000', '${A}', 'f6', 'click', now())`);
    await db.exec(`DELETE FROM wacrm.campaigns WHERE id = '${CAMP2}'`);
    expect((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM wacrm.utmpay_links WHERE tid = 'f6'`)).rows[0].n).toBe(0);
    expect((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM wacrm.utmpay_events WHERE tid = 'f6'`)).rows[0].n).toBe(0);
  });
});

describe("356 — ROLLBACK do cabeçalho", () => {
  it("executa, remove tudo e pode ser reaplicado", async () => {
    const db = await freshDb();
    try {
      await db.exec(M356);
      await db.exec(rollbackSql());
      for (const t of ["utmpay_config", "utmpay_links", "utmpay_events"]) {
        expect((await db.query<{ x: string | null }>(`SELECT to_regclass('wacrm.${t}')::text AS x`)).rows[0].x, t).toBeNull();
      }
      expect((await db.query<{ x: string | null }>(`SELECT to_regprocedure('wacrm.utmpay_funnel(uuid,uuid,timestamptz)')::text AS x`)).rows[0].x).toBeNull();
      expect((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM wacrm.schema_migrations WHERE version = '356_utmpay_integracao'`)).rows[0].n).toBe(0);
      await db.exec(M356);
    } finally {
      await db.close();
    }
  }, 90_000);
});
