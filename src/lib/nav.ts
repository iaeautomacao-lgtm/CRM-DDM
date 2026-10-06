import {
  Activity,
  Bot,
  Download,
  FileText,
  Headphones,
  HelpCircle,
  LayoutDashboard,
  Megaphone,
  MessageSquare,
  Send,
  Settings,
  Shield,
  ShieldAlert,
  Sparkles,
  Tags,
  UserCheck,
  Users,
  UsersRound,
  Wifi,
  Workflow,
  Zap,
} from "lucide-react";

// ============================================================
// Fonte única dos itens de navegação do dashboard.
//
// A sidebar renderiza estas listas e o header deriva o título da
// página a partir delas (getPageTitle) — assim um item novo no menu
// já ganha título sem precisar lembrar de editar dois arquivos.
// ============================================================

export interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  /**
   * Quando true, a linha do menu mostra um chip "Beta" depois do rótulo.
   * Puramente informativo — não afeta rota nem acesso.
   */
  beta?: boolean;
}

export const navItems: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/monitoramento", label: "Monitoramento", icon: Activity },
  { href: "/inteligencia", label: "DDM Intelligence", icon: Sparkles, beta: true },
  { href: "/canais", label: "Canais", icon: Wifi },
  { href: "/inbox", label: "Conversas", icon: MessageSquare },
  { href: "/contacts", label: "Contatos", icon: Users },
  { href: "/flows", label: "Fluxos", icon: Workflow, beta: true },
  { href: "/disparador", label: "Disparador", icon: Megaphone },
  { href: "/disparador/blacklist", label: "Blacklist", icon: ShieldAlert },
  { href: "/equipes", label: "Equipes", icon: Users },
  { href: "/templates", label: "Templates", icon: FileText },
  { href: "/tabulacoes", label: "Tabulações", icon: Tags },
  { href: "/respostas-rapidas", label: "Respostas rápidas", icon: Zap },
  { href: "/usuarios", label: "Usuários", icon: UsersRound },
  { href: "/settings?tab=ai", label: "Agente de IA", icon: Bot },
];

// Sub-itens do grupo recolhível "Relatórios".
export const reportNavItems: NavItem[] = [
  { href: "/relatorios/auditoria", label: "Auditoria", icon: Shield },
  { href: "/relatorios/atendimentos", label: "Atendimentos", icon: Headphones },
  { href: "/relatorios/agentes", label: "Agentes", icon: UserCheck },
  { href: "/relatorios/conversas", label: "Conversas", icon: MessageSquare },
  { href: "/relatorios/envio-em-lote", label: "Envio em lote", icon: Send },
  { href: "/relatorios/exportacoes", label: "Exportações", icon: Download },
];

export const bottomNavItems: NavItem[] = [
  { href: "/ajuda", label: "Central de Ajuda", icon: HelpCircle },
  { href: "/settings", label: "Configurações", icon: Settings },
];

// Rotas que existem mas não estão no menu (acessadas pelo dropdown do
// usuário, por links internos ou por URL direta) e subpáginas cujo
// título difere do item-pai.
const extraTitles: Record<string, string> = {
  "/relatorios": "Relatórios",
  "/disparador/campanhas": "Disparador · Campanhas",
  "/disparador/contatos": "Disparador · Contatos",
  "/disparador/monitor": "Disparador · Monitor",
  "/perfil": "Meu Perfil",
  "/seguranca": "Senha e sessões",
  "/historico": "Histórico",
  "/pipelines": "Funis",
  "/automations": "Automações",
  "/lead-extractor": "Extrator de leads",
  "/membros": "Usuários",
  "/unauthorized": "Acesso negado",
};

/** Caminho sem query string (ex.: "/settings?tab=ai" → "/settings"). */
export function navPath(href: string): string {
  return href.split("?")[0];
}

/** True se `pathname` é `prefix` ou uma subrota dele (por segmento —
 *  "/flowsx" não casa com "/flows"). */
export function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Entre `hrefs`, o de prefixo mais longo que casa com `pathname`
 * (comparando só o caminho, sem query). Usado para destacar um único
 * item ativo quando há itens aninhados (/disparador vs
 * /disparador/blacklist). Retorna null se nenhum casar.
 */
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

// Mapa caminho → título. Itens com query string (Agente de IA) não
// entram: o título deriva só do pathname, e "/settings" já é
// "Configurações".
const titleMap: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const item of [...navItems, ...reportNavItems, ...bottomNavItems]) {
    if (item.href.includes("?")) continue;
    map[item.href] = item.label;
  }
  // Relatórios: prefixa o grupo para não confundir "Conversas" do
  // relatório com a inbox.
  for (const item of reportNavItems) {
    map[item.href] = `Relatórios · ${item.label}`;
  }
  return { ...map, ...extraTitles };
})();

/** Título da página para o header — prefixo mais longo que casar;
 *  string vazia (neutra) quando a rota não é conhecida. */
export function getPageTitle(pathname: string): string {
  const match = longestMatchingHref(pathname, Object.keys(titleMap));
  return match ? titleMap[match] : "";
}
