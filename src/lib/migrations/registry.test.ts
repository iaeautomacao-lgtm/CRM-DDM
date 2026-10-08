// PRD 15, 15.3 — registro de migrations: lógica pura (scripts/lib/migrations-registry.mjs) e a migration 202 em PGlite
// (tabela fechada, RPC de relatório, BACKFILL POR DETECÇÃO, índice inválido, idempotência) ligada ao schema:check.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as registry from "../../../scripts/lib/migrations-registry.mjs";

const {
  buildRequired,
  compareWithReport,
  concurrentIndexName,
  exitCodeFor,
  findDuplicateNumbers,
  listMigrations,
  renderTable,
  runSchemaCheck,
} = registry as {
  buildRequired: (dir: string) => { minVersion: number; migrations: Array<{ version: string; kind: string; index?: string }> };
  compareWithReport: (required: unknown, report: unknown) => Array<{ version: string; status: string; kind: string; index?: string }>;
  concurrentIndexName: (sql: string) => string | null;
  exitCodeFor: (rows: unknown) => number;
  findDuplicateNumbers: (names: string[]) => Array<{ key: string; files: string[] }>;
  listMigrations: (dir: string) => string[];
  renderTable: (rows: unknown) => string;
  runSchemaCheck: (client: unknown, required: unknown) => Promise<{ code: number; output: string }>;
};

const MIGRATIONS = resolve(process.cwd(), "supabase/migrations");
const sql = (file: string) => readFileSync(resolve(MIGRATIONS, file), "utf8").replace(/NOTIFY pgrst[^;]*;/g, "");

describe("lógica pura do registro", () => {
  it("números repetidos: 187 e 187b não são duplicata; os 4 legados são ignorados; dois 194_ são", () => {
    expect(findDuplicateNumbers(["186_a", "187_b", "187b_c", "188_d"])).toEqual([]);
    expect(findDuplicateNumbers(["113_cron_locks", "113_outra", "143_a", "143_b"])).toEqual([]);
    expect(findDuplicateNumbers(["194_um", "194_dois", "195_x"])).toEqual([{ key: "194", files: ["194_um", "194_dois"] }]);
    expect(findDuplicateNumbers(["241b_a", "241b_b"])).toEqual([{ key: "241b", files: ["241b_a", "241b_b"] }]);
  });

  it("o repositório NÃO tem número repetido (fora os legados)", () => {
    expect(findDuplicateNumbers(listMigrations(MIGRATIONS))).toEqual([]);
  });

  it("concurrentIndexName lê o índice do código e ignora comentários", () => {
    expect(concurrentIndexName("-- usa CREATE INDEX CONCURRENTLY não roda em transação\nCREATE INDEX CONCURRENTLY IF NOT EXISTS idx_x ON wacrm.t (a);")).toBe("idx_x");
    expect(concurrentIndexName('CREATE UNIQUE INDEX CONCURRENTLY wacrm."idx_y" ON wacrm.t (a);')).toBe("idx_y");
    expect(concurrentIndexName("CREATE INDEX idx_z ON t (a);")).toBeNull();
  });

  it("required-migrations.json == o que sai dos arquivos (rode `node scripts/schema-check.mjs --generate`)", () => {
    const onDisk = JSON.parse(readFileSync(resolve(process.cwd(), "scripts/required-migrations.json"), "utf8"));
    expect(onDisk).toEqual(buildRequired(MIGRATIONS));
  });

  it("toda migration CONCURRENTLY é kind=index e as demais (>=183) são registry; a 202 está na lista", () => {
    const required = buildRequired(MIGRATIONS);
    const byVersion = Object.fromEntries(required.migrations.map((m) => [m.version, m]));
    expect(byVersion["202_schema_migrations_registry"].kind).toBe("registry");
    expect(byVersion["241b_profiles_role_id_idx"]).toMatchObject({ kind: "index", index: "idx_profiles_role_id" });
    expect(byVersion["241_roles_functions"].kind).toBe("registry");
    expect(required.migrations.every((m) => Number(m.version.match(/^\d+/)![0]) >= 183)).toBe(true);
  });

  it("toda migration registry >= 200 (com COMMIT) se registra no próprio arquivo", () => {
    for (const m of buildRequired(MIGRATIONS).migrations) {
      if (m.kind !== "registry") continue;
      const n = Number(m.version.match(/^\d+/)![0]);
      if (n < 200 || m.version.startsWith("202_")) continue;
      expect(sql(`${m.version}.sql`), m.version).toContain(`VALUES ('${m.version}') ON CONFLICT DO NOTHING`);
    }
  });

  it("toda migration kind=index tem a linha RODAR SOZINHO na 1ª linha", () => {
    for (const m of buildRequired(MIGRATIONS).migrations) {
      if (m.kind !== "index") continue;
      expect(readFileSync(resolve(MIGRATIONS, `${m.version}.sql`), "utf8").split(/\r?\n/)[0], m.version).toContain("RODAR SOZINHO");
    }
  });

  it("compareWithReport: aplicada / faltando / índice inválido; saída 0 só se tudo aplicado", () => {
    const required = {
      minVersion: 183,
      migrations: [
        { version: "200_a", kind: "registry" },
        { version: "201_b", kind: "registry" },
        { version: "201b_c", kind: "index", index: "idx_c" },
        { version: "202b_d", kind: "index", index: "idx_d" },
        { version: "203b_e", kind: "index", index: "idx_e" },
      ],
    };
    const rows = compareWithReport(required, {
      applied: ["200_a"],
      indexes: [{ name: "idx_c", valid: true }, { name: "idx_d", valid: false }],
    });
    expect(rows.map((r) => r.status)).toEqual(["aplicada", "faltando", "aplicada", "índice inválido", "faltando"]);
    expect(exitCodeFor(rows)).toBe(1);
    const table = renderTable(rows);
    expect(table).toContain("índice inválido");
    expect(table).toContain("aplicadas: 2 · faltando: 2 · índice inválido: 1");
    expect(exitCodeFor(rows.map((r) => ({ ...r, status: "aplicada" })))).toBe(0);
  });

  it("runSchemaCheck: registro ausente (202 não aplicada) => código 2 com instrução", async () => {
    const client = { rpc: async () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function wacrm.schema_check_report" } }) };
    const out = await runSchemaCheck(client, { migrations: [] });
    expect(out.code).toBe(2);
    expect(out.output).toContain("202_schema_migrations_registry.sql");
  });
});

// ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("migration 202 — registro e backfill por detecção (PGlite)", { timeout: 60_000 }, () => {
  let db: PGlite;

  const BOOT = `
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS; -- como no Supabase
    CREATE SCHEMA wacrm;
    GRANT USAGE ON SCHEMA wacrm TO anon, authenticated, service_role;
    CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE TABLE wacrm.profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
    -- 183: tabela + função  → COMPLETA
    CREATE TABLE wacrm.campaign_metric_deltas (id bigint PRIMARY KEY);
    CREATE FUNCTION wacrm.consolidate_campaign_metrics(p_limit integer DEFAULT 5000) RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;
    -- 201: só a tabela → PARCIAL (não deve registrar)
    CREATE TABLE wacrm.webhook_message_inbox (id bigint PRIMARY KEY);
    -- 192: coluna paused
    CREATE TABLE wacrm.dispatch_channel_limits (session_id uuid PRIMARY KEY, max_in_flight integer CHECK (max_in_flight BETWEEN 1 AND 150), paused boolean NOT NULL DEFAULT false);
    -- 187b e 189b: índices (o de 189b será invalidado)
    CREATE TABLE wacrm.disp_message_queue (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), erro_codigo integer, session_id uuid, status text);
    CREATE INDEX idx_dmq_erro_codigo ON wacrm.disp_message_queue (erro_codigo);
    CREATE INDEX idx_dmq_session_agendado ON wacrm.disp_message_queue (session_id);
    -- 200: policy + authenticated SEM select no segredo
    CREATE TABLE wacrm.ai_config (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid, enabled boolean, api_key text);
    ALTER TABLE wacrm.ai_config ENABLE ROW LEVEL SECURITY;
    CREATE POLICY ai_config_select ON wacrm.ai_config FOR SELECT USING (true);
    REVOKE ALL ON wacrm.ai_config FROM anon, authenticated;
    GRANT SELECT (id, account_id, enabled) ON wacrm.ai_config TO authenticated;
    -- 200b: whatsapp_config AINDA aberta (authenticated lê os segredos) → não registra
    CREATE TABLE wacrm.whatsapp_config (id uuid PRIMARY KEY, access_token text, app_secret text, verify_token text, waha_api_key text);
    GRANT SELECT ON wacrm.whatsapp_config TO authenticated;
  `;

  const run202 = () => db.exec(sql("202_schema_migrations_registry.sql"));
  const registered = async () =>
    (await db.query<{ version: string; source: string }>("SELECT version, source FROM wacrm.schema_migrations ORDER BY version")).rows;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(BOOT);
    // índice inválido (CONCURRENTLY interrompido): marca à mão no catálogo
    await db.exec("UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'wacrm.idx_dmq_session_agendado'::regclass");
    await run202();
  }, 60_000);
  afterAll(async () => {
    await db.close();
  }, 60_000);

  it("registra SÓ o que de fato está no banco (completo); parcial/inválido/aberto ficam de fora", async () => {
    const versions = (await registered()).map((r) => r.version);
    expect(versions).toEqual(
      [
        "183_campaign_metric_deltas",
        "186_dispatch_max_in_flight_150",
        "187b_disp_queue_erro_codigo_index",
        "192_dispatch_channel_paused",
        "200_ai_config_secret_columns",
        "202_schema_migrations_registry",
      ].sort(),
    );
    // 201 parcial (só a tabela), 189b com índice inválido, 200b ainda aberta: NÃO registradas
    for (const v of ["201_webhook_message_inbox", "189b_disp_queue_session_agendado_index", "200b_whatsapp_config_select_columns", "240_roles_foundation"]) {
      expect(versions).not.toContain(v);
    }
  });

  it("origem: backfill para o detectado, migration para a própria 202", async () => {
    const rows = await registered();
    expect(rows.find((r) => r.version === "183_campaign_metric_deltas")?.source).toBe("backfill");
    expect(rows.find((r) => r.version === "202_schema_migrations_registry")?.source).toBe("migration");
  });

  it("a tabela é fechada: authenticated/anon não leem nem escrevem", async () => {
    try {
      for (const role of ["authenticated", "anon"]) {
        await db.exec(`SET ROLE ${role}`);
        await expect(db.query("SELECT * FROM wacrm.schema_migrations")).rejects.toThrow();
        await expect(db.query("INSERT INTO wacrm.schema_migrations (version) VALUES ('x')")).rejects.toThrow();
        await expect(db.query("SELECT wacrm.schema_check_report()")).rejects.toThrow();
        await db.exec("RESET ROLE");
      }
      await db.exec("SET ROLE service_role");
      expect((await db.query("SELECT count(*)::int AS c FROM wacrm.schema_migrations")).rows[0]).toEqual({ c: 6 });
    } finally {
      await db.exec("RESET ROLE");
    }
  });

  it("schema_check_report: versões aplicadas + índices com validade", async () => {
    const { rows } = await db.query<{ r: { applied: string[]; indexes: Array<{ name: string; valid: boolean }> } }>("SELECT wacrm.schema_check_report() AS r");
    expect(rows[0].r.applied).toContain("183_campaign_metric_deltas");
    const idx = Object.fromEntries(rows[0].r.indexes.map((i) => [i.name, i.valid]));
    expect(idx["idx_dmq_erro_codigo"]).toBe(true);
    expect(idx["idx_dmq_session_agendado"]).toBe(false);
  });

  it("schema:check de ponta a ponta (adaptador de RPC sobre o PGlite): faltando, índice inválido e saída ≠ 0", async () => {
    const client = {
      rpc: async (fn: string) => {
        try {
          const { rows } = await db.query<{ r: unknown }>(`SELECT wacrm.${fn}() AS r`);
          return { data: rows[0].r, error: null };
        } catch (e) {
          return { data: null, error: { message: (e as Error).message } };
        }
      },
    };
    const required = {
      minVersion: 183,
      migrations: [
        { version: "183_campaign_metric_deltas", kind: "registry" },
        { version: "187b_disp_queue_erro_codigo_index", kind: "index", index: "idx_dmq_erro_codigo" },
        { version: "189b_disp_queue_session_agendado_index", kind: "index", index: "idx_dmq_session_agendado" },
        { version: "201_webhook_message_inbox", kind: "registry" },
      ],
    };
    const out = await runSchemaCheck(client, required);
    expect(out.code).toBe(1);
    expect(out.output).toMatch(/ok\s+183_campaign_metric_deltas\s+aplicada/);
    expect(out.output).toMatch(/!!\s+189b_disp_queue_session_agendado_index\s+índice inválido/);
    expect(out.output).toMatch(/!!\s+201_webhook_message_inbox\s+faltando/);
    expect(out.output).toContain("aplicadas: 2 · faltando: 1 · índice inválido: 1");
  });

  it("idempotente e incremental: objetos novos entram na reexecução; nada some nem duplica", async () => {
    await db.exec(`
      CREATE FUNCTION wacrm.ingest_message_events(p_events jsonb) RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;
      CREATE FUNCTION wacrm.claim_message_inbox(p_owner text) RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;
      REVOKE SELECT ON wacrm.whatsapp_config FROM authenticated;
      GRANT SELECT (id) ON wacrm.whatsapp_config TO authenticated;
    `);
    await run202();
    await run202();
    const versions = (await registered()).map((r) => r.version);
    expect(versions).toContain("201_webhook_message_inbox");
    expect(versions).toContain("200b_whatsapp_config_select_columns");
    expect(new Set(versions).size).toBe(versions.length);
    // 240 só com os papéis de sistema semeados
    expect(versions).not.toContain("240_roles_foundation");
  });

  it("uma migration nova se registra sozinha (240 e 241 reais sobre o schema com registro) e tolera banco sem a 202", async () => {
    // com a 202: 240/241 registram
    const withRegistry = new PGlite();
    await withRegistry.exec(`
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
      CREATE SCHEMA wacrm; CREATE SCHEMA auth;
      GRANT USAGE ON SCHEMA wacrm, auth TO anon, authenticated, service_role;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
      CREATE TYPE wacrm.account_role_enum AS ENUM ('owner','admin','supervisor','agent','viewer');
      CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, owner_user_id uuid);
      CREATE TABLE wacrm.profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL UNIQUE, account_id uuid REFERENCES wacrm.accounts(id), account_role wacrm.account_role_enum NOT NULL, full_name text, avatar_url text);
      CREATE FUNCTION wacrm.current_account_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
    `);
    await withRegistry.exec(sql("202_schema_migrations_registry.sql"));
    await withRegistry.exec(sql("240_roles_foundation.sql"));
    await withRegistry.exec(sql("241_roles_functions.sql"));
    await withRegistry.exec(sql("240_roles_foundation.sql")); // reexecução
    const { rows } = await withRegistry.query<{ version: string; source: string }>(
      "SELECT version, source FROM wacrm.schema_migrations WHERE version IN ('240_roles_foundation','241_roles_functions') ORDER BY version",
    );
    expect(rows).toEqual([
      { version: "240_roles_foundation", source: "migration" },
      { version: "241_roles_functions", source: "migration" },
    ]);
    await withRegistry.close();

    // sem a 202: a 240 aplica normalmente (o IF tolera a ausência do registro)
    const without = new PGlite();
    await without.exec(`
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
      CREATE SCHEMA wacrm;
      CREATE TYPE wacrm.account_role_enum AS ENUM ('owner','admin','supervisor','agent','viewer');
      CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, owner_user_id uuid);
      CREATE TABLE wacrm.profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL UNIQUE, account_id uuid REFERENCES wacrm.accounts(id), account_role wacrm.account_role_enum NOT NULL);
      CREATE FUNCTION wacrm.current_account_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
    `);
    await without.exec(sql("240_roles_foundation.sql"));
    expect((await without.query<{ t: string | null }>("SELECT to_regclass('wacrm.account_roles')::text AS t")).rows[0].t).not.toBeNull();
    await without.close();
  });
});
