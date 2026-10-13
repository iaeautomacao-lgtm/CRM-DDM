// Nomes de navegação coerentes: a mesma tela tem o mesmo nome no menu, no título da página (aba do navegador e h1 do
// cabeçalho), no breadcrumb e na busca Ctrl+K. Só rótulos de navegação; textos de operação não entram aqui.
import { describe, expect, it } from "vitest";

import { PALETTE_ITEMS } from "./command-palette";
import { bottomNavItems, getBreadcrumbs, getPageTitle, navItems, reportNavItems } from "./nav";

const pathOf = (href: string) => href.split("?")[0];

describe("Ctrl+K × título da página", () => {
  // Itens com ?tab= são seções dentro de Configurações (o título da aba é "Configurações"): ficam de fora.
  const items = PALETTE_ITEMS.filter((i) => !i.href.includes("?"));

  it.each(items.map((i) => [i.label, i.href]))('"%s" (%s) tem o nome do título da página ou do último item do breadcrumb', (label, href) => {
    const crumbs = getBreadcrumbs(pathOf(href));
    const last = crumbs[crumbs.length - 1].label;
    expect([getPageTitle(pathOf(href)), last]).toContain(label);
  });
});

describe("menu × título da página", () => {
  it.each([...navItems, ...bottomNavItems, ...reportNavItems].filter((i) => !i.href.includes("?")).map((i) => [i.label, i.href]))(
    '"%s" (%s) é o título da própria página (ou a trilha dele)',
    (label, href) => {
      const title = getPageTitle(pathOf(href));
      expect(title === label || title.endsWith(` · ${label}`) || title.startsWith(`${label} ·`)).toBe(true);
    },
  );
});

describe("vocabulário", () => {
  it("o funil se chama Funis na navegação, não Pipelines", () => {
    const all = [...PALETTE_ITEMS.map((i) => i.label), getPageTitle("/pipelines"), ...navItems.map((i) => i.label)];
    expect(all.some((l) => /pipeline/i.test(l))).toBe(false);
    expect(getPageTitle("/pipelines")).toBe("Funis");
  });

  it("Meu perfil e Segurança têm a mesma grafia no título e na busca", () => {
    expect(getPageTitle("/perfil")).toBe("Meu perfil");
    expect(PALETTE_ITEMS.find((i) => i.href === "/perfil")?.label).toBe("Meu perfil");
    expect(getPageTitle("/seguranca")).toBe("Segurança");
    expect(PALETTE_ITEMS.find((i) => i.href === "/seguranca")?.label).toBe("Segurança");
  });
});
