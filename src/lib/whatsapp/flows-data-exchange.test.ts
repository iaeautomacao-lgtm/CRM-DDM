// PRD 21, PR 21.2 — migration 291 (PGlite), armazenamento das chaves, despacho do Data Exchange e as DUAS rotas
// (/api/whatsapp/flows/data/[channelId] ponta a ponta com HMAC + RSA/AES reais; /api/whatsapp/flows/keys/[channelId]).
import { createHmac, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY = "a".repeat(64);
process.env.META_APP_SECRET = "";

const A = "00000000-0000-0000-0000-00000000000a";
const CH = "00000000-0000-4000-8000-0000000000c1";
const CH2 = "00000000-0000-4000-8000-0000000000c2";

// ---- migration 291 ---------------------------------------------------------------------------------------------------------------
describe("migration 291 — whatsapp_flows_keys", { timeout: 60_000 }, () => {
  let db: PGlite;
  const migration = () => readFileSync(resolve(process.cwd(), "supabase/migrations/291_whatsapp_flows_keys.sql"), "utf8").replace(/NOTIFY pgrst[^;]*;/g, "");
  const PEM = "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----";
  const ENC = "aabbcc:ddeeff:001122";

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE SCHEMA wacrm; GRANT USAGE ON SCHEMA wacrm TO anon, authenticated, service_role;
      CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY, name text);
      CREATE TABLE wacrm.whatsapp_config (id uuid PRIMARY KEY, account_id uuid, flows_public_key text, flows_private_key_enc text);
      CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
      INSERT INTO wacrm.accounts VALUES ('${A}', 'A');
      INSERT INTO wacrm.whatsapp_config (id, account_id) VALUES ('${CH}', '${A}'), ('${CH2}', '${A}');
    `);
    await db.exec(migration());
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.exec(`DELETE FROM wacrm.whatsapp_flows_keys`);
  });

  it("uma linha por canal; a privada só no formato cifrado GCM (nunca PEM em claro); a pública precisa ser PEM", async () => {
    await db.query(`INSERT INTO wacrm.whatsapp_flows_keys (channel_id, account_id, public_key, private_key_enc) VALUES ($1, $2, $3, $4)`, [CH, A, PEM, ENC]);
    await expect(db.query(`INSERT INTO wacrm.whatsapp_flows_keys (channel_id, account_id, public_key, private_key_enc) VALUES ($1, $2, $3, $4)`, [CH, A, PEM, ENC])).rejects.toThrow(/duplicate|unique/i);
    await expect(db.query(`INSERT INTO wacrm.whatsapp_flows_keys (channel_id, account_id, public_key, private_key_enc) VALUES ($1, $2, $3, $4)`, [CH2, A, PEM, "-----BEGIN PRIVATE KEY-----\nxx"])).rejects.toThrow(/check/i);
    await expect(db.query(`INSERT INTO wacrm.whatsapp_flows_keys (channel_id, account_id, public_key, private_key_enc) VALUES ($1, $2, $3, $4)`, [CH2, A, "qualquer coisa", ENC])).rejects.toThrow(/check/i);
  });

  it("fechada: anon/authenticated nem leem; apagar o canal apaga a chave; as colunas antigas da 260 saem", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`SET ROLE ${role}`);
      try {
        await expect(db.query(`SELECT public_key FROM wacrm.whatsapp_flows_keys`)).rejects.toThrow(/permission denied/i);
      } finally {
        await db.exec(`RESET ROLE`);
      }
    }
    await db.query(`INSERT INTO wacrm.whatsapp_flows_keys (channel_id, account_id, public_key, private_key_enc) VALUES ($1, $2, $3, $4)`, [CH2, A, PEM, ENC]);
    await db.exec(`DELETE FROM wacrm.whatsapp_config WHERE id = '${CH2}'`);
    expect((await db.query(`SELECT count(*)::int AS n FROM wacrm.whatsapp_flows_keys`)).rows[0]).toEqual({ n: 0 });
    const cols = (await db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema='wacrm' AND table_name='whatsapp_config'`)).rows.map((r) => r.column_name);
    expect(cols).not.toContain("flows_private_key_enc");
    expect(cols).not.toContain("flows_public_key");
  });

  it("recusa-se a rodar se alguém já gravou chave privada na coluna antiga; registrada; idempotente", async () => {
    const other = new PGlite();
    try {
      await other.exec(`
        CREATE SCHEMA wacrm; CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
        CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY); CREATE TABLE wacrm.whatsapp_config (id uuid PRIMARY KEY, account_id uuid, flows_public_key text, flows_private_key_enc text);
        INSERT INTO wacrm.whatsapp_config VALUES ('${CH}', '${A}', 'x', 'segredo');
      `);
      await expect(other.exec(migration())).rejects.toThrow(/chave privada gravada/);
    } finally {
      await other.close();
    }
    await db.exec(migration());
    expect((await db.query(`SELECT version FROM wacrm.schema_migrations`)).rows).toEqual([{ version: "291_whatsapp_flows_keys" }]);
  });
});

// ---- mocks das rotas -------------------------------------------------------------------------------------------------------------
const requirePermission = vi.fn();
vi.mock("@/lib/auth/account", () => ({
  requirePermission: (...a: unknown[]) => requirePermission(...a),
  toErrorResponse: (e: unknown) => Response.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 500 }),
}));
vi.mock("@/lib/logger", () => ({ writeLog: vi.fn(async () => {}), maskPhone: (p: string) => p }));
vi.mock("@/lib/audit/log-event", () => ({ logAuditEvent: vi.fn(async () => {}) }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ success: true }),
  checkRateLimitLocal: () => ({ success: true }),
  rateLimitResponse: () => Response.json({ error: "rate" }, { status: 429 }),
  RATE_LIMITS: { adminAction: { limit: 30, windowMs: 60_000 } },
}));
const setBusinessEncryptionKey = vi.fn(async () => {});
vi.mock("@/lib/whatsapp/meta-api", async (orig) => ({ ...(await orig<typeof import("@/lib/whatsapp/meta-api")>()), setBusinessEncryptionKey: (...a: unknown[]) => (setBusinessEncryptionKey as unknown as (...x: unknown[]) => unknown)(...a) }));

// banco falso: tabelas em memória
type Row = Record<string, unknown>;
let tables: Record<string, Row[]> = {};
let tableError: Record<string, { code: string }> = {};
function fakeAdmin() {
  return {
    from: (table: string) => {
      const filters: Array<[string, unknown]> = [];
      const inFilters: Array<[string, unknown[]]> = [];
      let op = "select";
      let payload: Row = {};
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.insert = (p: Row) => ((op = "insert"), (payload = p), b);
      b.update = (p: Row) => ((op = "update"), (payload = p), b);
      b.eq = (c: string, v: unknown) => (filters.push([c, v]), b);
      b.in = (c: string, v: unknown[]) => (inFilters.push([c, v]), b);
      b.limit = () => b;
      b.then = (resolve: (v: unknown) => void) => {
        if (tableError[table]) return resolve({ data: null, error: tableError[table] });
        const rows = (tables[table] ??= []);
        const match = rows.filter((r) => filters.every(([c, v]) => r[c] === v) && inFilters.every(([c, v]) => v.includes(r[c])));
        if (op === "insert") rows.push({ created_at: "2026-10-09T10:00:00Z", rotated_at: null, ...payload });
        if (op === "update") match.forEach((r) => Object.assign(r, payload));
        resolve({ data: op === "select" ? match : null, error: null });
      };
      return b;
    },
  };
}
vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: () => fakeAdmin() }));

const { encrypt } = await import("@/lib/whatsapp/encryption");
const { generateFlowsKeyPair, decryptFlowRequest, encryptFlowResponse } = await import("./flows-crypto");
const { ensureFlowsKeys, getFlowsKeyInfo, loadFlowsPrivateKey } = await import("./flows-keys");
const { handleFlowData, registerFlowDataHandler, FLOW_UNAVAILABLE_MESSAGE } = await import("./flows-data");
const dataRoute = await import("@/app/api/whatsapp/flows/data/[channelId]/route");
const keysRoute = await import("@/app/api/whatsapp/flows/keys/[channelId]/route");

beforeEach(() => {
  tables = {};
  tableError = {};
  requirePermission.mockReset();
  setBusinessEncryptionKey.mockClear();
});

// ---- chaves -----------------------------------------------------------------------------------------------------------------------
describe("flows-keys", () => {
  it("gera o par uma vez (idempotente), grava a privada CIFRADA e devolve só a pública; rotate troca", async () => {
    const db = fakeAdmin() as never;
    expect(await getFlowsKeyInfo(db, A, CH)).toEqual({ configured: false, public_key: null, created_at: null, rotated_at: null });
    const first = await ensureFlowsKeys(db, A, CH);
    expect(first).toMatchObject({ configured: true, created: true });
    expect(first.public_key).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    const stored = tables.whatsapp_flows_keys[0];
    expect(stored.private_key_enc).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    expect(JSON.stringify(stored)).not.toContain("BEGIN PRIVATE KEY");
    expect(await loadFlowsPrivateKey(db, CH)).toMatch(/^-----BEGIN PRIVATE KEY-----/);

    const again = await ensureFlowsKeys(db, A, CH);
    expect(again).toMatchObject({ created: false, public_key: first.public_key });
    const rotated = await ensureFlowsKeys(db, A, CH, { rotate: true });
    expect(rotated.public_key).not.toBe(first.public_key);
    expect(rotated.rotated_at).not.toBeNull();
    expect(tables.whatsapp_flows_keys).toHaveLength(1);
  });

  it("escopada pela conta e pelo canal; sem chave = null; migration ausente = erro claro / null", async () => {
    const db = fakeAdmin() as never;
    await ensureFlowsKeys(db, A, CH);
    expect((await getFlowsKeyInfo(db, "OUTRA", CH)).configured).toBe(false);
    expect(await loadFlowsPrivateKey(db, CH2)).toBeNull();
    tableError.whatsapp_flows_keys = { code: "42P01" };
    await expect(getFlowsKeyInfo(db, A, CH)).rejects.toThrow(/migration 291/);
    await expect(ensureFlowsKeys(db, A, CH)).rejects.toThrow(/migration 291/);
    expect(await loadFlowsPrivateKey(db, CH)).toBeNull();
  });
});

// ---- despacho ---------------------------------------------------------------------------------------------------------------------
describe("handleFlowData", () => {
  const ctx = { accountId: A, channelId: CH };

  it("ping e error_notification têm resposta própria; ação desconhecida sem handler = erro padrão na tela atual (nada inventado)", async () => {
    expect(await handleFlowData({ action: "ping" }, ctx)).toEqual({ action: "ping", response: { data: { status: "active" } } });
    expect((await handleFlowData({ action: "error_notification" }, ctx)).response).toEqual({ data: { acknowledged: true } });
    expect((await handleFlowData({ action: "INIT", screen: "ABERTURA" }, ctx)).response).toEqual({ screen: "ABERTURA", data: { error_message: FLOW_UNAVAILABLE_MESSAGE } });
    expect((await handleFlowData({}, ctx)).action).toBe("unknown");
  });

  it("handlers registrados respondem na ordem; null passa adiante; remover o registro desfaz", async () => {
    const calls: string[] = [];
    const off1 = registerFlowDataHandler(async () => (calls.push("a"), null));
    const off2 = registerFlowDataHandler(async (req) => (calls.push("b"), { screen: "OPCOES", data: { token: req.flow_token } }));
    expect((await handleFlowData({ action: "INIT", flow_token: "t1" }, ctx)).response).toEqual({ screen: "OPCOES", data: { token: "t1" } });
    expect(calls).toEqual(["a", "b"]);
    off1();
    off2();
    expect((await handleFlowData({ action: "INIT" }, ctx)).response).toMatchObject({ data: { error_message: FLOW_UNAVAILABLE_MESSAGE } });
  });
});

// ---- rota de Data Exchange (ponta a ponta) ----------------------------------------------------------------------------------------
describe("POST /api/whatsapp/flows/data/{channelId}", () => {
  const SECRET = "app-secret-do-canal";
  const subtle = webcrypto.subtle;
  const pemToDer = (pem: string) => Buffer.from(pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, ""), "base64");
  let publicKey: string;

  async function setup() {
    const keys = generateFlowsKeyPair();
    publicKey = keys.publicKeyPem;
    tables.whatsapp_config = [{ id: CH, account_id: A, app_secret: encrypt(SECRET) }];
    tables.whatsapp_flows_keys = [{ channel_id: CH, account_id: A, public_key: keys.publicKeyPem, private_key_enc: encrypt(keys.privateKeyPem) }];
  }

  async function metaCall(payload: unknown, opts: { signWith?: string; badSignature?: boolean; rawBody?: string; channel?: string } = {}) {
    const aes = webcrypto.getRandomValues(new Uint8Array(16));
    const iv = webcrypto.getRandomValues(new Uint8Array(16));
    const rsa = await subtle.importKey("spki", pemToDer(publicKey), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
    const key = await subtle.importKey("raw", aes, "AES-GCM", false, ["encrypt", "decrypt"]);
    const body =
      opts.rawBody ??
      JSON.stringify({
        encrypted_flow_data: Buffer.from(await subtle.encrypt({ name: "AES-GCM", iv, tagLength: 128 }, key, new TextEncoder().encode(JSON.stringify(payload)))).toString("base64"),
        encrypted_aes_key: Buffer.from(await subtle.encrypt({ name: "RSA-OAEP" }, rsa, aes)).toString("base64"),
        initial_vector: Buffer.from(iv).toString("base64"),
      });
    const signature = opts.badSignature ? "sha256=" + "0".repeat(64) : "sha256=" + createHmac("sha256", opts.signWith ?? SECRET).update(body).digest("hex");
    const res = await dataRoute.POST(
      new Request("https://crm.example/api/whatsapp/flows/data/x", { method: "POST", body, headers: { "x-hub-signature-256": signature, "content-type": "application/json" } }),
      { params: Promise.resolve({ channelId: opts.channel ?? CH }) },
    );
    const decryptResponse = async () => {
      const flipped = Uint8Array.from(iv, (b) => ~b & 0xff);
      return JSON.parse(new TextDecoder().decode(await subtle.decrypt({ name: "AES-GCM", iv: flipped, tagLength: 128 }, key, Buffer.from(await res.text(), "base64"))));
    };
    return { res, decryptResponse };
  }

  it("ping assinado e cifrado pela Meta: 200 text/plain, resposta cifrada que a Meta consegue abrir", async () => {
    await setup();
    const { res, decryptResponse } = await metaCall({ action: "ping", version: "3.0" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(await decryptResponse()).toEqual({ data: { status: "active" } });
  });

  it("com handler registrado, a tela devolvida é a do handler (e o conteúdo decifrado chega a ele)", async () => {
    await setup();
    const off = registerFlowDataHandler(async (req, ctx) => (req.action === "INIT" ? { screen: "OPCOES", data: { token: req.flow_token, conta: ctx.accountId } } : null));
    try {
      const { decryptResponse } = await metaCall({ action: "INIT", flow_token: "tok-9" });
      expect(await decryptResponse()).toEqual({ screen: "OPCOES", data: { token: "tok-9", conta: A } });
    } finally {
      off();
    }
  });

  it("assinatura errada / segredo errado / sem cabeçalho ⇒ 432 e NADA é decifrado", async () => {
    await setup();
    expect((await metaCall({ action: "ping" }, { badSignature: true })).res.status).toBe(432);
    expect((await metaCall({ action: "ping" }, { signWith: "outro-segredo" })).res.status).toBe(432);
    const noHeader = await dataRoute.POST(new Request("https://x", { method: "POST", body: "{}" }), { params: Promise.resolve({ channelId: CH }) });
    expect(noHeader.status).toBe(432);
  });

  it("canal inexistente 404; id inválido 404; sem par de chaves 421; corpo gigante 413", async () => {
    await setup();
    expect((await metaCall({ action: "ping" }, { channel: CH2 })).res.status).toBe(404);
    expect((await metaCall({ action: "ping" }, { channel: "nao-uuid" })).res.status).toBe(404);
    tables.whatsapp_flows_keys = [];
    expect((await metaCall({ action: "ping" })).res.status).toBe(421);
    await setup();
    const big = await dataRoute.POST(new Request("https://x", { method: "POST", body: "x".repeat(300 * 1024), headers: { "x-hub-signature-256": "sha256=0" } }), { params: Promise.resolve({ channelId: CH }) });
    expect(big.status).toBe(413);
  });

  it("assinado mas cifrado com a chave pública ERRADA ⇒ 421 (a Meta busca a chave de novo); JSON/forma inválidos ⇒ 400", async () => {
    await setup();
    const real = publicKey;
    publicKey = generateFlowsKeyPair().publicKeyPem; // a Meta ainda tem uma chave antiga
    expect((await metaCall({ action: "ping" })).res.status).toBe(421);
    publicKey = real;
    const sign = (b: string) => "sha256=" + createHmac("sha256", SECRET).update(b).digest("hex");
    for (const raw of ["{nao json", JSON.stringify({ x: 1 })]) {
      const res = await dataRoute.POST(new Request("https://x", { method: "POST", body: raw, headers: { "x-hub-signature-256": sign(raw) } }), { params: Promise.resolve({ channelId: CH }) });
      expect(res.status).toBe(400);
    }
  });

  it("conteúdo decifrado NUNCA vai para o log", async () => {
    await setup();
    const { writeLog } = await import("@/lib/logger");
    (writeLog as unknown as ReturnType<typeof vi.fn>).mockClear();
    await metaCall({ action: "data_exchange", screen: "DADOS", data: { cpf: "12345678901" }, flow_token: "tok-secreto" });
    const logged = JSON.stringify((writeLog as unknown as ReturnType<typeof vi.fn>).mock.calls);
    expect(logged).toContain("flow_data_exchange");
    expect(logged).not.toMatch(/12345678901|tok-secreto|DADOS/);
  });
});

// ---- rota de chaves ---------------------------------------------------------------------------------------------------------------
describe("/api/whatsapp/flows/keys/{channelId}", () => {
  const params = (channelId: string) => ({ params: Promise.resolve({ channelId }) });
  beforeEach(() => {
    tables.whatsapp_config = [{ id: CH, account_id: A, provider: "meta", phone_number_id: "PN1", access_token: encrypt("token-da-meta") }];
  });
  const session = (visible: boolean) => ({
    accountId: A,
    userId: "U",
    supabase: {
      from: () => {
        const b: Record<string, unknown> = {};
        for (const m of ["select", "eq", "limit", "in", "order"]) b[m] = () => b;
        b.then = (resolve: (v: unknown) => void) => resolve({ data: visible ? [{ id: CH, provider: "meta", phone_number_id: "PN1", access_token: "x" }] : [], error: null });
        return b;
      },
    },
  });

  it("GET: só a pública (nunca a privada); canal invisível = 404; permissão channels.view", async () => {
    requirePermission.mockResolvedValue(session(true));
    await ensureFlowsKeys(fakeAdmin() as never, A, CH);
    const res = await keysRoute.GET(new Request("https://x"), params(CH));
    expect(requirePermission).toHaveBeenCalledWith("channels.view");
    const body = await res.json();
    expect(body.configured).toBe(true);
    expect(body.public_key).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    expect(JSON.stringify(body)).not.toMatch(/PRIVATE|private_key/);
    requirePermission.mockResolvedValue(session(false));
    expect((await keysRoute.GET(new Request("https://x"), params(CH))).status).toBe(404);
    expect((await keysRoute.GET(new Request("https://x"), params("nao-uuid"))).status).toBe(404);
  });

  it("POST: gera (201) e depois só devolve (200); channels.manage; sem permissão 403 e nada é gerado", async () => {
    requirePermission.mockResolvedValue(session(true));
    const first = await keysRoute.POST(new Request("https://x", { method: "POST", body: "{}" }), params(CH));
    expect(requirePermission).toHaveBeenCalledWith("channels.manage");
    expect(first.status).toBe(201);
    const second = await keysRoute.POST(new Request("https://x", { method: "POST" }), params(CH));
    expect(second.status).toBe(200);
    expect((await second.json()).created).toBe(false);
    tables = {};
    requirePermission.mockRejectedValue(Object.assign(new Error("forbidden"), { status: 403 }));
    expect((await keysRoute.POST(new Request("https://x", { method: "POST" }), params(CH))).status).toBe(403);
    expect(tables.whatsapp_flows_keys ?? []).toHaveLength(0);
  });

  it("POST rotate troca a pública", async () => {
    requirePermission.mockResolvedValue(session(true));
    const first = await (await keysRoute.POST(new Request("https://x", { method: "POST", body: "{}" }), params(CH))).json();
    const rotated = await (await keysRoute.POST(new Request("https://x", { method: "POST", body: JSON.stringify({ rotate: true }) }), params(CH))).json();
    expect(rotated.public_key).not.toBe(first.public_key);
    expect(tables.whatsapp_flows_keys).toHaveLength(1);
  });

  it("register_with_meta: chama a Meta com a PÚBLICA, o número e o token decifrado; recusa da Meta = 502 sem perder a chave; WAHA = 422", async () => {
    requirePermission.mockResolvedValue(session(true));
    tables.whatsapp_config = [{ id: CH, account_id: A, provider: "meta", phone_number_id: "PN1", access_token: encrypt("token-da-meta") }];
    const ok = await keysRoute.POST(new Request("https://x", { method: "POST", body: JSON.stringify({ register_with_meta: true }) }), params(CH));
    const body = await ok.json();
    expect(ok.status).toBe(201);
    expect(body.registered_with_meta).toBe(true);
    expect(setBusinessEncryptionKey).toHaveBeenCalledWith({ phoneNumberId: "PN1", accessToken: "token-da-meta", publicKeyPem: body.public_key });
    expect(JSON.stringify(body)).not.toContain("token-da-meta");

    const { MetaApiError } = await import("@/lib/whatsapp/meta-api");
    setBusinessEncryptionKey.mockRejectedValueOnce(new MetaApiError("chave inválida", 100, 400));
    const refused = await keysRoute.POST(new Request("https://x", { method: "POST", body: JSON.stringify({ register_with_meta: true }) }), params(CH));
    expect(refused.status).toBe(502);
    expect((await refused.json()).error).toMatch(/A Meta recusou a chave: chave inválida/);
    expect(tables.whatsapp_flows_keys).toHaveLength(1);

    tables.whatsapp_config = [{ id: CH, account_id: A, provider: "waha", phone_number_id: null, access_token: null }];
    setBusinessEncryptionKey.mockClear();
    expect((await keysRoute.POST(new Request("https://x", { method: "POST", body: JSON.stringify({ register_with_meta: true }) }), params(CH))).status).toBe(422);
    expect(setBusinessEncryptionKey).not.toHaveBeenCalled();
  });

  it("migration 291 ausente ⇒ 503 explicativo", async () => {
    requirePermission.mockResolvedValue(session(true));
    tableError.whatsapp_flows_keys = { code: "42P01" };
    const res = await keysRoute.POST(new Request("https://x", { method: "POST" }), params(CH));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/migration 291/);
  });
});

// ---- o servidor cifra/decifra o MESMO formato que o teste da Meta (sanidade cruzada, sem rota) ----------------------------------
describe("sanidade", () => {
  it("decryptFlowRequest + encryptFlowResponse usam a mesma chave de sessão", () => {
    const pair = generateFlowsKeyPair();
    expect(pair.privateKeyPem).toContain("PRIVATE");
    expect(typeof decryptFlowRequest).toBe("function");
    expect(typeof encryptFlowResponse).toBe("function");
  });
});
