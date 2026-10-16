import {
  Activity,
  CalendarClock,
  Bot,
  Download,
  Coins,
  FileText,
  Gauge,
  Headphones,
  HelpCircle,
  History,
  Kanban,
  LayoutTemplate,
  LayoutDashboard,
  Megaphone,
  MessageSquare,
  MessageSquareText,
  Network,
  Settings,
  Shield,
  Tags,
  UserCheck,
  Coffee,
  Users,
  UsersRound,
  Wifi,
  Workflow,
} from "lucide-react";

import type { Permission } from "@/lib/auth/permissions";

export type NavGroup =
  | "overview"
  | "attendance"
  | "clients"
  | "campaigns"
  | "automation"
  | "reports"
  | "administration";

export interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  group?: NavGroup;
  /** Exige esta permissão além do gate da rota (mesma regra da paleta Ctrl+K). */
  permission?: Permission;
}

export const NAV_GROUPS: Array<{ id: NavGroup; label: string }> = [
  { id: "overview", label: "Visão geral" },
  { id: "attendance", label: "Atendimento" },
  { id: "clients", label: "Clientes" },
  { id: "campaigns", label: "Campanhas" },
  { id: "automation", label: "Automação e IA" },
  { id: "reports", label: "Relatórios" },
  { id: "administration", label: "Administração" },
];

export const navItems: NavItem[] = [
  { href: "/dashboard", label: "Painel", icon: LayoutDashboard, group: "overview" },

  { href: "/inbox", label: "Conversas", icon: MessageSquare, group: "attendance" },
  { href: "/monitoramento", label: "Monitoramento", icon: Activity, group: "attendance" },
  { href: "/historico", label: "Histórico", icon: History, group: "attendance" },
  { href: "/respostas-rapidas", label: "Respostas rápidas", icon: MessageSquareText, group: "attendance" },
  { href: "/tabulacoes", label: "Tabulações", icon: Tags, group: "attendance" },

  { href: "/contacts", label: "Contatos", icon: Users, group: "clients" },
  { href: "/pipelines", label: "Funis", icon: Kanban, group: "clients" },

  { href: "/disparador", label: "Campanhas", icon: Megaphone, group: "campaigns" },
  { href: "/templates", label: "Templates", icon: LayoutTemplate, group: "campaigns" },
  { href: "/regua", label: "Régua de cobrança", icon: CalendarClock, group: "campaigns" },

  { href: "/flows", label: "Fluxos", icon: Workflow, group: "automation" },
  { href: "/settings?tab=agents", label: "Agentes de IA", icon: Bot, group: "automation" },
  { href: "/inteligencia", label: "Acordito", icon: Gauge, group: "automation" },

  { href: "/relatorios/atendimentos", label: "Relatórios", icon: FileText, group: "reports" },

  { href: "/usuarios", label: "Usuários", icon: UsersRound, group: "administration" },
  { href: "/equipes", label: "Equipes", icon: Network, group: "administration" },
  { href: "/canais", label: "Canais", icon: Wifi, group: "administration" },
  { href: "/relatorios/auditoria", label: "Auditoria", icon: Shield, group: "administration" },
  { href: "/settings", label: "Configurações", icon: Settings, group: "administration" },
];

/** Abas da tela Relatórios. A Auditoria mora em Administração (menu), não aqui. */
export const reportNavItems: NavItem[] = [
  { href: "/relatorios/atendimentos", label: "Desempenho do atendimento", icon: Headphones },
  { href: "/relatorios/agentes", label: "Sessões de atendentes", icon: UserCheck },
  { href: "/relatorios/pausas", label: "Pausas", icon: Coffee },
  { href: "/relatorios/tabulacoes", label: "Tabulações", icon: Tags },
  { href: "/relatorios/envio-em-lote", label: "Campanhas", icon: Megaphone },
  { href: "/relatorios/exportacoes", label: "Exportações", icon: Download },
  { href: "/relatorios/custos-ia", label: "Custos de IA", icon: Coins, permission: "reports.view_all" },
];

export const bottomNavItems: NavItem[] = [
  { href: "/ajuda", label: "Central de ajuda", icon: HelpCircle },
];

// "Logs do sistema" não entra no menu (ferramenta técnica): só pelo Ctrl+K, com audit.view.
const extraTitles: Record<string, string> = {
  "/relatorios": "Relatórios",
  "/disparador/campanhas": "Campanhas",
  "/disparador/contatos": "Contatos · Importações",
  "/disparador/monitor": "Campanhas · Monitor de envios",
  "/disparador/numeros": "Campanhas · Números",
  "/disparador/controles": "Campanhas · Controles",
  "/disparador/desempenho": "Campanhas · Desempenho",
  "/disparador/erros": "Campanhas · Erros",
  "/disparador/blacklist": "Campanhas · Blacklist",
  "/templates": "Templates",
  "/tabulacoes": "Tabulações",
  "/respostas-rapidas": "Respostas rápidas",
  "/perfil": "Meu perfil",
  "/seguranca": "Segurança",
  "/historico": "Histórico",
  "/pipelines": "Funis",
  "/membros": "Usuários",
  "/unauthorized": "Acesso negado",
  "/ddm-logs": "Logs do sistema",
};

export function navPath(href: string): string {
  return href.split("?")[0];
}

export function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function longestMatchingHref(
  pathname: string,
  hrefs: string[],
): string | null {
  let best: string | null = null;
  for (const href of hrefs) {
    const path = navPath(href);
    if (!matchesPrefix(pathname, path)) continue;
    if (!best || path.length > navPath(best).length) best = href;
  }
  return best;
}

const titleMap: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const item of [...navItems, ...reportNavItems, ...bottomNavItems]) {
    if (item.href.includes("?")) continue;
    map[item.href] = item.label;
  }
  for (const item of reportNavItems) {
    map[item.href] = `Relatórios · ${item.label}`;
  }
  return { ...map, ...extraTitles };
})();

function baseTitle(pathname: string): string {
  const match = longestMatchingHref(pathname, Object.keys(titleMap));
  if (match) return titleMap[match];
  // Fallback: nunca devolve vazio (WCAG 2.4.2/2.4.6). Usa o último segmento
  // da rota de forma legível ou o nome do produto.
  const segment = pathname
    .split("?")[0]
    .split("/")
    .filter(Boolean)
    .pop();
  if (!segment) return "OmniDDM";
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // segmento malformado: usa o texto original
  }
  const friendly = decoded.replace(/[-_]+/g, " ").trim();
  if (!friendly) return "OmniDDM";
  return friendly.charAt(0).toUpperCase() + friendly.slice(1);
}

export interface Crumb {
  label: string;
  /** Ausente no último item (a página atual). */
  href?: string;
}

/**
 * Trilha "você está em" por rota. Só as telas de mais de um nível têm trilha própria (editor e execuções de
 * fluxo, automações, detalhe de equipe/contato/campanha, chaves do Intelligence); as demais têm um item só,
 * com o título de sempre. O último item é o título da página (h1 do cabeçalho); os anteriores são links.
 */
export function getBreadcrumbs(pathname: string): Crumb[] {
  const path = pathname.split("?")[0].replace(/\/+$/, "");
  const [root, a, b] = path.split("/").filter(Boolean);

  if (root === "flows" && a) {
    const flows: Crumb = { label: "Fluxos", href: "/flows" };
    if (!b) return [flows, { label: "Editor de fluxo" }];
    if (b === "runs") return [flows, { label: "Fluxo", href: `/flows/${a}` }, { label: "Execuções" }];
  }
  if (root === "equipes" && a && !b) return [{ label: "Equipes", href: "/equipes" }, { label: "Equipe" }];
  if (root === "contacts" && a && !b) return [{ label: "Contatos", href: "/contacts" }, { label: "Contato" }];
  if (root === "disparador" && a === "campanhas" && b) {
    return [{ label: "Campanhas", href: "/disparador/campanhas" }, { label: "Campanha" }];
  }
  if (root === "inteligencia" && a === "chaves") return [{ label: "Acordito", href: "/inteligencia" }, { label: "Chave pessoal do MCP" }];

  return [{ label: baseTitle(path) }];
}

/** Título da página (aba do navegador e anúncio): a trilha junta com " · " quando há mais de um nível. */
export function getPageTitle(pathname: string): string {
  const crumbs = getBreadcrumbs(pathname);
  return crumbs.length > 1 ? crumbs.map((c) => c.label).join(" · ") : crumbs[0].label;
}
