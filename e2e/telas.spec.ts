// Teste das telas por papel — SOMENTE LEITURA. Para cada papel abre cada tela e falha se:
//   - o papel não devia ver e não caiu em /unauthorized, ou devia ver e foi barrado;
//   - a tela quebra: erro de JS (console.error / pageerror), error boundary, 404/500, página em branco;
//   - o menu lateral mostra link que o papel não pode abrir ou omite um que deveria mostrar;
//   - /api/me/permissions (campo pages) diverge de ROUTE_ALLOWLIST.
// Nada de clicar em botões que gravam: toda requisição não-GET ao app é BLOQUEADA e registrada (rede de segurança).
import { expect, test, type Page } from "@playwright/test";

import { IGNORED_CONSOLE } from "./ignore";
import { authFile, selectedRoles } from "./roles";
import { ROUTES, expectedAccess, navExpectations } from "./routes";
import { ROUTE_ALLOWLIST, getDefaultRoute } from "@/lib/role-utils";

const BROKEN_TEXT = [
  /Algo deu errado/i,
  /Página não encontrada/i,
  /Application error/i,
  /Internal Server Error/i,
  /This page could not be found/i,
  /Unhandled Runtime Error/i,
];

interface Watch {
  consoleErrors: string[];
  pageErrors: string[];
  serverErrors: string[];
  blocked: string[];
}

/** Liga a escuta de erros e o bloqueio de escrita na página. */
async function guard(page: Page): Promise<Watch> {
  const w: Watch = { consoleErrors: [], pageErrors: [], serverErrors: [], blocked: [] };
  const origin = new URL(process.env.E2E_BASE_URL ?? "http://localhost").origin;

  await page.route(`${origin}/**`, (route) => {
    const m = route.request().method();
    if (m === "GET" || m === "HEAD" || m === "OPTIONS") return route.continue();
    w.blocked.push(`${m} ${new URL(route.request().url()).pathname}`);
    return route.abort("blockedbyclient");
  });
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (IGNORED_CONSOLE.some((re) => re.test(text))) return;
    w.consoleErrors.push(text.slice(0, 300));
  });
  page.on("pageerror", (err) => w.pageErrors.push(String(err.message).slice(0, 300)));
  page.on("response", (res) => {
    if (res.status() >= 500 && res.url().startsWith(origin)) {
      w.serverErrors.push(`${res.status()} ${new URL(res.url()).pathname}`);
    }
  });
  return w;
}

async function settle(page: Page) {
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  // O redirecionamento para /unauthorized é feito no cliente, depois de carregar as permissões.
  await page.waitForTimeout(800);
}

for (const r of selectedRoles()) {
  test.describe(`${r.label}`, () => {
    test.use({ storageState: authFile(r) });

    for (const path of ROUTES) {
      const allowed = expectedAccess(r.role, path);

      test(`${allowed ? "abre" : "é barrado em"} ${path}`, async ({ page }) => {
        const w = await guard(page);
        const res = await page.goto(path, { waitUntil: "domcontentloaded" });

        if (!allowed) {
          await expect
            .poll(() => new URL(page.url()).pathname, { timeout: 20_000, message: `${r.label} devia cair em /unauthorized ao abrir ${path}` })
            .toBe("/unauthorized");
          return;
        }

        await settle(page);
        const finalPath = new URL(page.url()).pathname;
        expect(finalPath, `${r.label} devia ver ${path}, mas foi para ${finalPath}`).not.toBe("/unauthorized");
        expect(finalPath, `sessão perdida ao abrir ${path}`).not.toMatch(/^\/login/);
        expect(res?.status() ?? 200, `status HTTP de ${path}`).toBeLessThan(400);

        const text = (await page.locator("body").innerText()).trim();
        expect(text.length, `página em branco em ${path}`).toBeGreaterThan(20);
        for (const re of BROKEN_TEXT) expect(text, `tela de erro/404 em ${path} (${re})`).not.toMatch(re);

        expect(w.pageErrors, `erro de JS em ${path}`).toEqual([]);
        expect(w.consoleErrors, `console.error em ${path}`).toEqual([]);
        expect(w.serverErrors, `resposta 5xx em ${path}`).toEqual([]);
        if (w.blocked.length) test.info().annotations.push({ type: "escrita bloqueada", description: w.blocked.join(", ") });
      });
    }

    test("menu lateral mostra só o que o papel pode abrir", async ({ page }) => {
      await guard(page);
      await page.goto(getDefaultRoute(r.role), { waitUntil: "domcontentloaded" });
      await settle(page);
      const hrefs = await page.locator("nav a[href^='/']").evaluateAll((as) =>
        as.map((a) => (a.getAttribute("href") ?? "").split("?")[0]),
      );
      const { hidden, visible } = navExpectations(r.role);
      expect(hrefs.filter((h) => hidden.includes(h)), `${r.label} vê no menu o que não devia`).toEqual([]);
      expect(visible.filter((v) => !hrefs.includes(v)), `${r.label} não vê no menu o que devia`).toEqual([]);
    });

    test("/api/me/permissions (pages) bate com ROUTE_ALLOWLIST", async ({ page }) => {
      const res = await page.request.get("/api/me/permissions");
      expect(res.status(), "GET /api/me/permissions").toBe(200);
      const { pages } = (await res.json()) as { pages: string[] };
      const wrong = Object.entries(ROUTE_ALLOWLIST)
        .filter(([prefix, roles]) => (r.role === "owner" || roles.includes(r.role)) !== pages.includes(prefix))
        .map(([prefix]) => prefix);
      expect(wrong, `prefixos em que o servidor e o front discordam para ${r.label}`).toEqual([]);
    });
  });
}
