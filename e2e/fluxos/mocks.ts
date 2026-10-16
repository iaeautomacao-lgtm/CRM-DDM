// Ajudantes dos testes de fluxo (e2e/fluxos.spec.ts). O LOGIN é o mesmo das telas (auth.setup.ts, papel admin); o que a tela lê
// é simulado aqui com page.route: rotas /api/* do app e as tabelas do Supabase que cada tela consulta (PostgREST). Nada é gravado:
// escrita (POST/PUT/PATCH/DELETE) só passa se o teste simulou a rota; qualquer outra é abortada e registrada.
import type { Page, Request, Route } from "@playwright/test";

type Json = unknown;

export const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS",
  "access-control-expose-headers": "content-range",
};

export interface ApiReply {
  status?: number;
  body?: Json;
  /** Atraso antes de responder (prova que a tela já mostrava o dado do cache). */
  delayMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Simula uma rota do app (mesma origem): `pathname` exato; o handler vê o Request (método, query, corpo). */
export async function mockApi(page: Page, pathname: string, handler: (req: Request) => ApiReply | Promise<ApiReply>) {
  await page.route(
    (url) => url.pathname === pathname,
    async (route) => {
      const reply = await handler(route.request());
      if (reply.delayMs) await sleep(reply.delayMs);
      await route.fulfill({
        status: reply.status ?? 200,
        contentType: "application/json",
        body: JSON.stringify(reply.body ?? {}),
      });
    },
  );
}

/**
 * Simula uma tabela do Supabase (PostgREST, GET). Responde lista, ou objeto quando a tela pede um só (`.maybeSingle()`),
 * com Content-Range para `count: 'exact'`, e trata o preflight de CORS. Escrita na tabela é abortada.
 */
export async function mockTable(
  page: Page,
  table: string,
  handler: (req: Request) => { rows: Json[]; delayMs?: number } | Promise<{ rows: Json[]; delayMs?: number }>,
  blockedWrites: string[] = [],
) {
  await page.route(new RegExp(`/rest/v1/${table}(\\?|$)`), async (route: Route) => {
    const req = route.request();
    const method = req.method();
    if (method === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    if (method !== "GET" && method !== "HEAD") {
      blockedWrites.push(`${method} ${table}`);
      return route.abort("blockedbyclient");
    }
    const { rows, delayMs } = await handler(req);
    if (delayMs) await sleep(delayMs);
    const wantsObject = (req.headers()["accept"] ?? "").includes("vnd.pgrst.object");
    const range = rows.length > 0 ? `0-${rows.length - 1}/${rows.length}` : "*/0";
    return route.fulfill({
      status: 200,
      headers: { ...CORS, "content-type": "application/json", "content-range": range },
      body: method === "HEAD" ? "" : JSON.stringify(wantsObject ? (rows[0] ?? null) : rows),
    });
  });
}

/**
 * GET /api/me/permissions de verdade, menos as permissões em `remove` (e, opcionalmente, páginas).
 * Serve para provar que a tela esconde/nega o que o servidor não concede, sem precisar de outro usuário.
 */
export async function mockPermissions(page: Page, opts: { remove: string[] }) {
  await page.route(
    (url) => url.pathname === "/api/me/permissions",
    async (route) => {
      const real = await route.fetch();
      const data = (await real.json()) as { permissions: string[] };
      data.permissions = data.permissions.filter((p) => !opts.remove.includes(p));
      await route.fulfill({ response: real, json: data });
    },
  );
}

/** Aborta (e registra) escrita no app que o teste não simulou: rede de segurança, como no teste de telas. */
export async function blockUnmockedWrites(page: Page, blocked: string[]) {
  const origin = new URL(page.url() === "about:blank" ? (process.env.E2E_BASE_URL ?? "http://localhost") : page.url()).origin;
  await page.route(`${origin}/api/**`, (route) => {
    const m = route.request().method();
    if (m === "GET" || m === "HEAD" || m === "OPTIONS") return route.fallback();
    blocked.push(`${m} ${new URL(route.request().url()).pathname}`);
    return route.abort("blockedbyclient");
  });
}

/** id do usuário logado, lido do cookie de sessão do Supabase (sb-*-auth-token, possivelmente em pedaços). */
export async function currentUserId(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  const parts = cookies
    .filter((c) => /^sb-.+-auth-token(\.\d+)?$/.test(c.name))
    .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
  if (parts.length === 0) throw new Error("Sem cookie de sessão do Supabase: o login (auth.setup) rodou?");
  let raw = decodeURIComponent(parts.map((c) => c.value).join(""));
  if (raw.startsWith("base64-")) raw = Buffer.from(raw.slice(7), "base64url").toString("utf8");
  const session = JSON.parse(raw) as { user?: { id?: string }; access_token?: string };
  const id = session.user?.id ?? (session.access_token ? (JSON.parse(Buffer.from(session.access_token.split(".")[1], "base64url").toString("utf8")) as { sub?: string }).sub : undefined);
  if (!id) throw new Error("Não achei o id do usuário na sessão.");
  return id;
}

/**
 * Navegação PELO MENU (troca de rota no cliente, sem recarregar): é o que preserva o cache em memória do SWR.
 * page.goto() recarrega a página e esvaziaria o cache, então não serve para esse teste.
 */
export async function navTo(page: Page, href: string) {
  const link = page.locator(`nav a[href="${href}"]`).first();
  if (!(await link.isVisible())) {
    const list = page.locator("nav ul", { has: page.locator(`a[href="${href}"]`) }).first();
    const id = await list.getAttribute("id");
    if (id) await page.locator(`button[aria-controls="${id}"]`).click();
  }
  await link.click();
  await page.waitForURL((u) => u.pathname === href || u.pathname.startsWith(`${href}/`));
}
