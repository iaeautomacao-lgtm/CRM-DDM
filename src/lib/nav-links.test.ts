// Valida os links de navegação do app contra as rotas e as abas que EXISTEM:
//  - todo href de nav.ts (menu, relatórios, rodapé) e de command-palette.ts (Ctrl+K) aponta para uma página real;
//  - todo `?tab=` de /settings é uma aba que existe em SETTINGS_SECTIONS (e o item da paleta com settingsSection casa com a aba);
//  - todo prefixo de ROUTE_ALLOWLIST e todo título de nav.ts corresponde a pelo menos uma página (sem regra ou título órfão);
//  - o menu está contido na paleta (cada tela do menu pode ser achada pelo Ctrl+K).
// As rotas vêm do sistema de arquivos (src/app/**/page.tsx), então o teste acompanha o app sozinho.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { PALETTE_ITEMS } from "./command-palette";
import { bottomNavItems, getBreadcrumbs, navItems, reportNavItems } from "./nav";
import { ROUTE_ALLOWLIST } from "./role-utils";
import { SETTINGS_SECTIONS } from "@/components/settings/settings-sections";

const APP_DIR = path.join(process.cwd(), "src", "app");

function collectPages(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectPages(full, out);
    else if (entry.name === "page.tsx") out.push(full);
  }
  return out;
}

/** "/flows/[id]/runs" etc., sem os grupos de rota "(dashboard)". */
const ROUTES: string[] = collectPages(APP_DIR).map((file) => {
  const rel = path.relative(APP_DIR, path.dirname(file)).split(path.sep).filter((s) => !(s.startsWith("(") && s.endsWith(")")));
  return "/" + rel.join("/");
});

function toRegex(pattern: string): RegExp {
  const body = pattern
    .split("/")
    .map((seg) => (seg.startsWith("[") ? "[^/]+" : seg.replace(/[.*+?^${}()|\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${body}$`);
}
const ROUTE_RES = ROUTES.map(toRegex);
const pathOf = (href: string) => href.split("?")[0];
const routeExists = (p: string) => ROUTE_RES.some((re) => re.test(p));
const tabOf = (href: string) => new URLSearchParams(href.split("?")[1] ?? "").get("tab");

const NAV = [...navItems, ...reportNavItems, ...bottomNavItems].map((i) => ({ origem: `menu "${i.label}"`, href: i.href }));
const PALETTE = PALETTE_ITEMS.map((i) => ({ origem: `Ctrl+K "${i.label}"`, href: i.href }));

describe("links de navegação existem", () => {
  it("encontra as páginas do app", () => {
    expect(ROUTES.length).toBeGreaterThan(30);
    expect(ROUTES).toContain("/flows/[id]/runs");
  });

  it.each([...NAV, ...PALETTE])("$origem → $href leva a uma página real", ({ href }) => {
    expect(routeExists(pathOf(href))).toBe(true);
  });

  it("toda aba ?tab= de /settings existe", () => {
    for (const { origem, href } of [...NAV, ...PALETTE]) {
      const tab = tabOf(href);
      if (tab === null) continue;
      expect(pathOf(href), `${origem}: ?tab= só vale em /settings`).toBe("/settings");
      expect(SETTINGS_SECTIONS as readonly string[], `${origem}: aba "${tab}" não existe em SETTINGS_SECTIONS`).toContain(tab);
    }
  });

  it("o item da paleta que declara settingsSection aponta para a própria aba", () => {
    for (const item of PALETTE_ITEMS) {
      if (!item.settingsSection) continue;
      const tab = tabOf(item.href);
      expect(tab ?? "overview", `"${item.label}"`).toBe(item.settingsSection);
    }
  });
});

describe("sem regras ou títulos órfãos", () => {
  it("todo prefixo de ROUTE_ALLOWLIST tem pelo menos uma página", () => {
    for (const prefix of Object.keys(ROUTE_ALLOWLIST)) {
      expect(
        ROUTES.some((r) => r === prefix || r.startsWith(`${prefix}/`)),
        `ROUTE_ALLOWLIST: "${prefix}" não corresponde a nenhuma página`,
      ).toBe(true);
    }
  });

  it("a trilha de cada rota com mais de um nível só tem links para páginas reais", () => {
    const samples = ["/flows/abc", "/flows/abc/runs", "/automations/new", "/automations/x1/edit", "/automations/x1/logs", "/equipes/t1", "/contacts/c1", "/disparador/campanhas/k1", "/inteligencia/chaves"];
    for (const s of samples) {
      for (const c of getBreadcrumbs(s)) if (c.href) expect(routeExists(pathOf(c.href)), `${s}: ${c.href}`).toBe(true);
    }
  });
});

describe("menu e paleta", () => {
  it("toda tela do menu pode ser achada pelo Ctrl+K", () => {
    const paletteTargets = PALETTE_ITEMS.map((i) => pathOf(i.href));
    for (const { origem, href } of NAV) {
      const p = pathOf(href);
      expect(
        paletteTargets.some((t) => t === p || t.startsWith(`${p}/`)),
        `${origem} (${href}) não aparece na paleta`,
      ).toBe(true);
    }
  });

  it("a paleta não repete rótulo", () => {
    const labels = PALETTE_ITEMS.map((i) => i.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
