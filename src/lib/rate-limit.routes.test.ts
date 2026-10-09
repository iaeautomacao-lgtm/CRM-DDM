// PRD 14, 14.9 — as rotas listadas (AP-08 telemetria/feedback, AP-19 webchat) usam o limitador compartilhado, e nenhuma rota
// QUENTE (cron, tick, webhook de status, motor do disparador) chama o limitador (1 RPC por chamada limitada).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { __resetRateLimitForTests, __setSharedBackendForTests } from "./rate-limit";

const mocks = vi.hoisted(() => ({
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
}));

vi.mock("@/lib/auth/account", () => ({
  getCurrentAccount: async () => ({ userId: "user-1", accountId: "acc-1", supabase: {} }),
  toErrorResponse: (e: unknown) => new Response(JSON.stringify({ error: String(e) }), { status: 500 }),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        mocks.inserts.push({ table, row });
        const result = { error: null as null, data: { id: "s1" } };
        return { select: () => ({ single: async () => result }), then: (resolveFn: (v: unknown) => void) => resolveFn(result) };
      },
    }),
    rpc: async () => ({ error: null }),
  }),
}));

const feedback = await import("@/app/api/feedback/route");
const telemetry = await import("@/app/api/telemetry/route");
const { webchatRateLimit } = await import("@/lib/webchat/api");

const post = (url: string, body: unknown, ip = "203.0.113.5") =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json", "x-real-ip": ip }, body: JSON.stringify(body) });

beforeEach(() => {
  __resetRateLimitForTests();
  __setSharedBackendForTests(null); // só o Map (a RPC já tem teste próprio)
  mocks.inserts.length = 0;
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://db.local");
});

describe("AP-08: telemetria e feedback", () => {
  it("feedback: 60/min por usuário; a 61ª vira 429 e não grava; mensagem/página/navegador são truncados", async () => {
    const long = "x".repeat(10_000);
    const first = await feedback.POST(post("http://x/api/feedback", { message: long, page: long, user_agent: long }));
    expect(first.status).toBe(200);
    const row = mocks.inserts[0].row as { message: string; page: string; payload: { user_agent: string } };
    expect(row.message).toHaveLength(4_000);
    expect(row.page).toHaveLength(500);
    expect(row.payload.user_agent).toHaveLength(300);
    for (let i = 1; i < 60; i++) expect((await feedback.POST(post("http://x/api/feedback", { message: "oi" }))).status).toBe(200);
    const blocked = await feedback.POST(post("http://x/api/feedback", { message: "oi" }));
    expect(blocked.status).toBe(429);
    expect(mocks.inserts).toHaveLength(60);
  });

  it("telemetria: trunca texto e payload livre e limita a 60/min por usuário", async () => {
    const ok = await telemetry.POST(
      post("http://x/api/telemetry", {
        type: "error",
        error_message: "e".repeat(9_000),
        error_stack: "s".repeat(9_000),
        action: "a".repeat(500),
        path: "p".repeat(2_000),
        payload: { grande: "z".repeat(20_000) },
      }),
    );
    expect(ok.status).toBe(200);
    const row = mocks.inserts.find((i) => i.table === "system_logs")!.row as { message: string; page: string; action: string; payload: Record<string, unknown> };
    expect(row.message).toHaveLength(2_000);
    expect(row.page).toHaveLength(500);
    expect(row.action).toHaveLength(100);
    expect(row.payload).toMatchObject({ truncated: true });
    for (let i = 1; i < 60; i++) await telemetry.POST(post("http://x/api/telemetry", { type: "action", action: "x" }));
    expect((await telemetry.POST(post("http://x/api/telemetry", { type: "action", action: "x" }))).status).toBe(429);
  });
});

describe("AP-19: webchat por IP + token", () => {
  const req = (ip: string) => new Request("http://x/api/webchat/tok", { headers: { "x-real-ip": ip } });

  it("leitura: 120/min por IP+token; a seguinte é 429 com Retry-After e o corpo do webchat; outro IP ou token não é afetado", async () => {
    for (let i = 0; i < 120; i++) expect(await webchatRateLimit(req("198.51.100.1"), "token-A", "read")).toBeNull();
    const blocked = await webchatRateLimit(req("198.51.100.1"), "token-A", "read");
    expect(blocked?.status).toBe(429);
    expect(Number(blocked?.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    expect(await blocked?.json()).toMatchObject({ state: "rate_limited" });
    expect(await webchatRateLimit(req("198.51.100.2"), "token-A", "read")).toBeNull();
    expect(await webchatRateLimit(req("198.51.100.1"), "token-B", "read")).toBeNull();
  });

  it("escrita (abrir/enviar arquivo): 30/min, orçamento separado do de leitura", async () => {
    for (let i = 0; i < 30; i++) expect(await webchatRateLimit(req("198.51.100.9"), "token-C", "write")).toBeNull();
    expect((await webchatRateLimit(req("198.51.100.9"), "token-C", "write"))?.status).toBe(429);
    expect(await webchatRateLimit(req("198.51.100.9"), "token-C", "read")).toBeNull();
  });

  it("todo handler das rotas públicas do webchat chama o limite ANTES da sessão (inclui o POST de mensagens)", () => {
    const dir = resolve("src/app/api/webchat/[token]");
    const files = [join(dir, "route.ts"), ...readdirSync(dir).map((d) => join(dir, d, "route.ts")).filter((f) => { try { return statSync(f).isFile(); } catch { return false; } })];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const handler of src.split(/export async function /).slice(1)) {
        const name = `${relative(dir, file)} ${handler.slice(0, handler.indexOf("("))}`;
        const limit = handler.indexOf("webchatRateLimit(");
        expect(limit, name).toBeGreaterThan(-1);
        const session = handler.indexOf("requireActiveSession(");
        if (session > -1) expect(limit, name).toBeLessThan(session);
      }
    }
  });

  it("as 5 rotas públicas do webchat chamam o limitador ANTES de resolver a sessão", () => {
    const base = resolve(process.cwd(), "src/app/api/webchat/[token]");
    for (const file of ["route.ts", "open/route.ts", "media/route.ts", "messages/route.ts", "upload/route.ts"]) {
      const src = readFileSync(join(base, file), "utf8");
      const limiter = src.indexOf("webchatRateLimit(request, token");
      const session = src.indexOf("requireActiveSession(token)");
      expect(limiter, file).toBeGreaterThan(-1);
      expect(limiter, `${file}: limitador antes da sessão`).toBeLessThan(session);
    }
  });
});

describe("rotas quentes NÃO chamam o limitador (custo: 1 RPC por chamada limitada)", () => {
  const SRC = resolve(process.cwd(), "src");
  const HOT_FILES = [
    "app/api/disparador/cron/route.ts",
    "app/api/disparador/prepare/cron/route.ts",
    "app/api/disparador/health/cron/route.ts",
    "app/api/automations/cron/route.ts",
    "app/api/flows/cron/route.ts",
    "app/api/whatsapp/webhook/waha/route.ts",
    "app/api/meta/webhook/route.ts",
  ];
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
    }
    return out;
  };

  it("cron, tick, webhook de status/WAHA e o motor do disparador não usam checkRateLimit", () => {
    const offenders: string[] = [];
    for (const rel of HOT_FILES) {
      const src = readFileSync(join(SRC, rel), "utf8");
      if (/checkRateLimit\w*\(/.test(src)) offenders.push(rel);
    }
    for (const file of walk(join(SRC, "lib/disparador"))) {
      if (/checkRateLimit\w*\(/.test(readFileSync(file, "utf8"))) offenders.push(relative(SRC, file));
    }
    expect(offenders).toEqual([]);
  });

  it("no webhook da Meta só o GET de verificação (baixo volume) usa o limitador; o POST (mensagens/status) não", () => {
    const src = readFileSync(join(SRC, "app/api/whatsapp/webhook/route.ts"), "utf8");
    expect([...src.matchAll(/checkRateLimit\(/g)]).toHaveLength(1);
    const call = src.indexOf("checkRateLimit(");
    expect(call).toBeGreaterThan(src.indexOf("export async function GET"));
    expect(call).toBeLessThan(src.indexOf("export async function POST"));
  });
});
