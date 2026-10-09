// PRD 24, item 6: migration 231 (PGlite) + rotas /api/settings/account-config.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
const ACTOR = "00000000-0000-0000-0000-0000000000f1";

describe("migration 231 — account_settings", { timeout: 60_000 }, () => {
  let db: PGlite;
  const migration = () => readFileSync(resolve(process.cwd(), "supabase/migrations/231_account_settings.sql"), "utf8").replace(/NOTIFY pgrst[^;]*;/g, "");

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE SCHEMA wacrm; GRANT USAGE ON SCHEMA wacrm TO anon, authenticated, service_role;
      CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY, name text);
      CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
      CREATE TABLE wacrm.audit_logs (seq bigserial, account_id uuid NOT NULL, event_type text, resource_type text, resource_id uuid, resource_label text, action text, summary text, changes jsonb);
      CREATE FUNCTION wacrm.audit_write(p_account uuid, p_event text, p_resource_type text, p_resource_id uuid, p_label text, p_action text, p_summary text, p_changes jsonb DEFAULT NULL, p_metadata jsonb DEFAULT NULL)
        RETURNS void LANGUAGE sql AS $$ INSERT INTO wacrm.audit_logs (account_id, event_type, resource_type, resource_id, resource_label, action, summary, changes) VALUES (p_account, p_event, p_resource_type, p_resource_id, p_label, p_action, p_summary, p_changes) $$;
      INSERT INTO wacrm.accounts VALUES ('${A}', 'A'), ('${B}', 'B');
    `);
    await db.exec(migration());
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.exec(`DELETE FROM wacrm.account_settings; DELETE FROM wacrm.audit_logs`);
  });

  const logs = async () => (await db.query<{ event_type: string; action: string; resource_label: string; summary: string; changes: unknown }>(`SELECT event_type, action, resource_label, summary, changes FROM wacrm.audit_logs ORDER BY seq`)).rows;

  it("chave por conta (PK conta+chave), valor jsonb, limite de tamanho e formato de chave", async () => {
    await db.query(`INSERT INTO wacrm.account_settings (account_id, key, value, updated_by) VALUES ($1, 'timezone', '"UTC"', $2)`, [A, ACTOR]);
    await db.query(`INSERT INTO wacrm.account_settings (account_id, key, value) VALUES ($1, 'timezone', '"UTC"')`, [B]); // outra conta, mesma chave
    await expect(db.query(`INSERT INTO wacrm.account_settings (account_id, key, value) VALUES ($1, 'timezone', '"x"')`, [A])).rejects.toThrow(/duplicate|unique/i);
    await expect(db.query(`INSERT INTO wacrm.account_settings (account_id, key, value) VALUES ($1, 'Chave Ruim', '1')`, [A])).rejects.toThrow(/check/i);
    await expect(db.query(`INSERT INTO wacrm.account_settings (account_id, key, value) VALUES ($1, 'grande', $2::jsonb)`, [A, JSON.stringify({ x: "y".repeat(17_000) })])).rejects.toThrow(/check|size/i);
  });

  it("auditoria: criar, alterar e voltar ao padrão registram antes → depois da chave", async () => {
    await db.query(`INSERT INTO wacrm.account_settings (account_id, key, value) VALUES ($1, 'timezone', '"UTC"')`, [A]);
    await db.query(`UPDATE wacrm.account_settings SET value = '"America/Manaus"' WHERE account_id = $1`, [A]);
    await db.query(`DELETE FROM wacrm.account_settings WHERE account_id = $1`, [A]);
    const l = await logs();
    expect(l.map((x) => [x.event_type, x.action, x.resource_label])).toEqual([
      ["created", "account_setting.changed", "timezone"],
      ["updated", "account_setting.changed", "timezone"],
      ["deleted", "account_setting.reset", "timezone"],
    ]);
    expect(l[1].changes).toEqual({ value: { before: "UTC", after: "America/Manaus" } });
    expect(l[2].summary).toMatch(/voltou ao padrão/);
  });

  it("à prova de falha: se a auditoria quebrar, a configuração é gravada mesmo assim", async () => {
    await db.exec(`ALTER TABLE wacrm.audit_logs ADD CONSTRAINT boom CHECK (false) NOT VALID`);
    try {
      await db.query(`INSERT INTO wacrm.account_settings (account_id, key, value) VALUES ($1, 'timezone', '"UTC"')`, [A]);
      expect((await db.query(`SELECT count(*)::int AS n FROM wacrm.account_settings`)).rows[0]).toEqual({ n: 1 });
    } finally {
      await db.exec(`ALTER TABLE wacrm.audit_logs DROP CONSTRAINT boom`);
    }
  });

  it("fechada para anon/authenticated; apagar a conta apaga as configurações; registrada; idempotente", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`SET ROLE ${role}`);
      try {
        await expect(db.query(`SELECT 1 FROM wacrm.account_settings`)).rejects.toThrow(/permission denied/i);
      } finally {
        await db.exec(`RESET ROLE`);
      }
    }
    await db.query(`INSERT INTO wacrm.account_settings (account_id, key, value) VALUES ($1, 'timezone', '"UTC"')`, [B]);
    await db.exec(`DELETE FROM wacrm.accounts WHERE id = '${B}'`);
    expect((await db.query(`SELECT count(*)::int AS n FROM wacrm.account_settings`)).rows[0]).toEqual({ n: 0 });
    await db.exec(`INSERT INTO wacrm.accounts VALUES ('${B}', 'B')`);
    await db.exec(migration());
    expect((await db.query(`SELECT version FROM wacrm.schema_migrations`)).rows).toEqual([{ version: "231_account_settings" }]);
  });
});

// ---- rotas -----------------------------------------------------------------------------------------------------------------------
const requirePermission = vi.fn();
vi.mock("@/lib/auth/account", () => ({
  requirePermission: (...a: unknown[]) => requirePermission(...a),
  toErrorResponse: (e: unknown) => Response.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 500 }),
}));
vi.mock("@/lib/auth/permissions", () => ({ can: (ctx: { perms?: string[] }, key: string) => (ctx.perms ?? []).includes(key) }));
const registerAuditActor = vi.fn(async () => {});
vi.mock("@/lib/audit/context", () => ({ registerAuditActor: (...a: unknown[]) => (registerAuditActor as unknown as (...x: unknown[]) => unknown)(...a) }));
const checkRateLimit = vi.fn(async () => ({ success: true }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (...a: unknown[]) => (checkRateLimit as unknown as (...x: unknown[]) => unknown)(...a),
  rateLimitResponse: () => Response.json({ error: "rate" }, { status: 429 }),
  RATE_LIMITS: { adminAction: { limit: 30, windowMs: 60_000 } },
}));

type Call = { op: string; payload?: unknown; opts?: unknown; filters: Record<string, unknown> };
let calls: Call[] = [];
let result: { data?: unknown; error?: { code?: string } | null } = { data: [], error: null };
vi.mock("@/lib/account/admin-client", () => ({
  supabaseAdmin: () => ({
    from: () => {
      const call: Call = { op: "select", filters: {} };
      calls.push(call);
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.upsert = (payload: unknown, opts: unknown) => ((call.op = "upsert"), (call.payload = payload), (call.opts = opts), b);
      b.delete = () => ((call.op = "delete"), b);
      b.eq = (c: string, v: unknown) => ((call.filters[c] = v), b);
      b.then = (resolveFn: (v: unknown) => void) => resolveFn({ data: result.data ?? [], error: result.error ?? null });
      return b;
    },
  }),
}));

const list = await import("./route");
const one = await import("./[key]/route");
const ADMIN = { accountId: A, userId: ACTOR, perms: ["settings.account", "account.view"] };
const VIEWER = { accountId: A, userId: ACTOR, perms: ["account.view"] };
const put = (key: string, body: unknown) => one.PUT(new Request("https://x/api", { method: "PUT", body: typeof body === "string" ? body : JSON.stringify(body) }), { params: Promise.resolve({ key }) });

describe("rotas /api/settings/account-config", () => {
  beforeEach(() => {
    calls = [];
    result = { data: [], error: null };
    requirePermission.mockReset();
    registerAuditActor.mockClear();
    checkRateLimit.mockClear();
    checkRateLimit.mockResolvedValue({ success: true });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("GET: lê com account.view, escopa pela conta, mistura padrão × gravado e marca editable por papel", async () => {
    requirePermission.mockResolvedValue(VIEWER);
    result = { data: [{ key: "timezone", value: "America/Manaus" }] };
    const res = await list.GET();
    expect(requirePermission).toHaveBeenCalledWith("account.view");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { settings } = await res.json();
    expect(settings.find((s: { key: string }) => s.key === "timezone")).toMatchObject({ value: "America/Manaus", source: "account", editable: false });
    expect(settings.find((s: { key: string }) => s.key === "business_hours")).toMatchObject({ value: null, source: "default" });
    expect(calls[0].filters).toEqual({ account_id: A });
    requirePermission.mockResolvedValue(ADMIN);
    expect((await (await list.GET()).json()).settings.every((s: { editable: boolean }) => s.editable)).toBe(true);
  });

  it("GET: migration 231 ausente ⇒ devolve os padrões (a tela não quebra)", async () => {
    requirePermission.mockResolvedValue(VIEWER);
    result = { error: { code: "42P01" } };
    const res = await list.GET();
    expect(res.status).toBe(200);
    expect((await res.json()).settings.every((s: { source: string }) => s.source === "default")).toBe(true);
  });

  it("PUT: valida, grava com a conta/usuário da SESSÃO (nunca do corpo) e registra a observação na auditoria", async () => {
    requirePermission.mockResolvedValue(ADMIN);
    const res = await put("timezone", { value: "America/Manaus", reason: "  filial em Manaus  ", account_id: "OUTRA" });
    expect(requirePermission).toHaveBeenCalledWith("settings.account");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ key: "timezone", value: "America/Manaus", source: "account" });
    expect(calls[0].op).toBe("upsert");
    expect(calls[0].payload).toMatchObject({ account_id: A, key: "timezone", value: "America/Manaus", updated_by: ACTOR });
    expect(calls[0].opts).toEqual({ onConflict: "account_id,key" });
    expect(registerAuditActor).toHaveBeenCalledWith({ note: "filial em Manaus" });
  });

  it("PUT: chave desconhecida 404; valor inválido 422 (mensagem pt-BR); corpo ruim 400; grande 413; nada é gravado", async () => {
    requirePermission.mockResolvedValue(ADMIN);
    expect((await put("inventada", { value: 1 })).status).toBe(404);
    const bad = await put("business_hours", { value: { mon: [{ start: "12:00", end: "08:00" }] } });
    expect(bad.status).toBe(422);
    expect((await bad.json()).error).toMatch(/antes do fim/);
    expect((await put("timezone", { value: null })).status).toBe(422);
    expect((await put("timezone", "{nao json")).status).toBe(400);
    expect((await put("timezone", { semvalue: 1 })).status).toBe(400);
    expect((await put("timezone", { value: "UTC", reason: 5 })).status).toBe(400);
    expect((await put("timezone", { value: "UTC", pad: "x".repeat(21_000) })).status).toBe(413);
    expect(calls).toEqual([]);
  });

  it("PUT: horário de atendimento aceita null (sem horário definido)", async () => {
    requirePermission.mockResolvedValue(ADMIN);
    expect((await put("business_hours", { value: null })).status).toBe(200);
    expect(calls[0].payload).toMatchObject({ key: "business_hours", value: null });
  });

  it("PUT/DELETE sem permissão: 403 e nada lido/gravado; limite de requisições respeitado", async () => {
    requirePermission.mockRejectedValue(Object.assign(new Error("forbidden"), { status: 403 }));
    expect((await put("timezone", { value: "UTC" })).status).toBe(403);
    expect((await one.DELETE(new Request("https://x"), { params: Promise.resolve({ key: "timezone" }) })).status).toBe(403);
    expect(calls).toEqual([]);
    requirePermission.mockResolvedValue(ADMIN);
    checkRateLimit.mockResolvedValue({ success: false });
    expect((await put("timezone", { value: "UTC" })).status).toBe(429);
    expect(calls).toEqual([]);
  });

  it("PUT/DELETE: migration ausente ⇒ 503 explicativo; outro erro ⇒ 500 sem vazar detalhe", async () => {
    requirePermission.mockResolvedValue(ADMIN);
    result = { error: { code: "42P01" } };
    const gone = await put("timezone", { value: "UTC" });
    expect(gone.status).toBe(503);
    expect((await gone.json()).error).toMatch(/migration 231/);
    result = { error: { code: "XX000" } };
    const boom = await put("timezone", { value: "UTC" });
    expect(boom.status).toBe(500);
    expect(JSON.stringify(await boom.json())).not.toContain("XX000");
  });

  it("DELETE volta ao padrão: apaga só a linha da conta e devolve o padrão do registro", async () => {
    requirePermission.mockResolvedValue(ADMIN);
    const res = await one.DELETE(new Request("https://x", { method: "DELETE" }), { params: Promise.resolve({ key: "timezone" }) });
    expect(await res.json()).toEqual({ key: "timezone", value: "America/Sao_Paulo", source: "default" });
    expect(calls[0]).toMatchObject({ op: "delete", filters: { account_id: A, key: "timezone" } });
    expect((await one.DELETE(new Request("https://x"), { params: Promise.resolve({ key: "nao_existe" }) })).status).toBe(404);
  });
});
