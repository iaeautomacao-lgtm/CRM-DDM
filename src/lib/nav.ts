import {
  Activity,
  CalendarClock,
  Bot,
  Download,
  FileText,
  Gauge,
  Headphones,
  HelpCircle,
  LayoutDashboard,
  Megaphone,
  MessageSquare,
  Network,
  Settings,
  Shield,
  Tags,
  UserCheck,
  Users,
  UsersRound,
  Wifi,
  Workflow,
} from "lucide-react";

export type NavGroup =
  | "overview"
  | "operation"
  | "relationship"
  | "campaigns"
  | "automation"
  | "intelligence"
  | "administration";

export interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  group?: NavGroup;
  beta?: boolean;
}

export const NAV_GROUPS: Array<{ id: NavGroup; label: string }> = [
  { id: "overview", label: "Visão geral" },
  { id: "operation", label: "Operação" },
  { id: "relationship", label: "Relacionamento" },
  { id: "campaigns", label: "Campanhas" },
  { id: "automation", label: "Automação" },
  { id: "intelligence", label: "Inteligência" },
  { id: "administration", label: "Administração" },
];

export const navItems: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, group: "overview" },

  { href: "/inbox", label: "Conversas", icon: MessageSquare, group: "operation" },
  { href: "/monitoramento", label: "Monitoramento", icon: Activity, group: "operation" },

  { href: "/contacts", label: "Contatos", icon: Users, group: "relationship" },
  { href: "/canais", label: "Canais", icon: Wifi, group: "relationship" },

  { href: "/disparador", label: "Disparador", icon: Megaphone, group: "campaigns" },
  { href: "/regua", label: "Régua de cobrança", icon: CalendarClock, group: "campaigns" },

  { href: "/flows", label: "Fluxos", icon: Workflow, group: "automation", beta: true },
  { href: "/settings?tab=ai", label: "Agente de IA", icon: Bot, group: "automation" },

  { href: "/inteligencia", label: "Inteligência", icon: Gauge, group: "intelligence", beta: true },
  { href: "/relatorios/atendimentos", label: "Relatórios", icon: FileText, group: "intelligence" },

  { href: "/equipes", label: "Equipes", icon: Network, group: "administration" },
  { href: "/usuarios", label: "Usuários", icon: UsersRound, group: "administration" },
];

export const reportNavItems: NavItem[] = [
  { href: "/relatorios/auditoria", label: "Auditoria", icon: Shield },
  { href: "/relatorios/atendimentos", label: "Atendimentos", icon: Headphones },
  { href: "/relatorios/agentes", label: "Agentes", icon: UserCheck },
  { href: "/relatorios/conversas", label: "Conversas", icon: MessageSquare },
  { href: "/relatorios/tabulacoes", label: "Tabulações", icon: Tags },
  { href: "/relatorios/envio-em-lote", label: "Envio em lote", icon: Megaphone },
  { href: "/relatorios/exportacoes", label: "Exportações", icon: Download },
];

export const bottomNavItems: NavItem[] = [
  { href: "/ajuda", label: "Central de ajuda", icon: HelpCircle },
  { href: "/settings", label: "Configurações", icon: Settings },
];

const extraTitles: Record<string, string> = {
  "/relatorios": "Relatórios",
  "/disparador/campanhas": "Disparador · Campanhas",
  "/disparador/contatos": "Disparador · Contatos",
  "/disparador/monitor": "Disparador · Monitor",
  "/disparador/numeros": "Disparador · Números",
  "/disparador/controles": "Disparador · Controles",
  "/disparador/desempenho": "Disparador · Desempenho",
  "/disparador/erros": "Disparador · Erros",
  "/disparador/blacklist": "Disparador · Blacklist",
  "/templates": "Templates",
  "/tabulacoes": "Tabulações",
  "/respostas-rapidas": "Respostas rápidas",
  "/perfil": "Meu Perfil",
  "/seguranca": "Senha e sessões",
  "/historico": "Histórico",
  "/pipelines": "Funis",
  "/automations": "Automações",
  "/lead-extractor": "Extrator de leads",
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

export function getPageTitle(pathname: string): string {
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
