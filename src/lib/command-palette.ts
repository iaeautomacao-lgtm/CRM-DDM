// Paleta de comandos (Ctrl/Cmd+K) — núcleo puro.
//
// Porte do command-palette.js do protótipo DDM, ligado às ROTAS REAIS do
// app (todas existem em src/app) e filtrado pelo que o servidor libera em
// GET /api/me/permissions:
//   - `pages`: prefixos com gate que o papel acessa. O prefixo de cada
//     rota é achado com a MESMA regra do servidor (primeiro prefixo de
//     ROUTE_ALLOWLIST que casa, na mesma ordem). Rota sem gate = livre.
//   - `permissions`: itens que dependem de uma permissão específica.
//   - seções de /settings seguem canSeeSection (a mesma regra do menu).
// O servidor continua bloqueando por conta própria; a paleta só não
// oferece o que vai dar "sem permissão".

import { ROUTE_ALLOWLIST } from "@/lib/role-utils";
import type { MePermissions } from "@/lib/auth/me-permissions";
import type { Permission } from "@/lib/auth/permissions";
import { canSeeSection, type SettingsSection } from "@/components/settings/settings-sections";

export interface PaletteItem {
  label: string;
  /** Grupo exibido à direita (igual aos grupos do menu lateral). */
  group: string;
  href: string;
  /** Termos extras para a busca (sinônimos). */
  keywords?: string;
  /** Exige esta permissão além do gate da rota. */
  permission?: Permission;
  /** Seção de /settings: aplica canSeeSection com o papel do usuário. */
  settingsSection?: SettingsSection;
}

export const PALETTE_ITEMS: readonly PaletteItem[] = [
  { label: "Dashboard", group: "Visão geral", href: "/dashboard", keywords: "inicio painel" },

  { label: "Conversas", group: "Operação", href: "/inbox", keywords: "inbox atendimento mensagens" },
  { label: "Monitoramento", group: "Operação", href: "/monitoramento", keywords: "sla fila" },
  { label: "Histórico", group: "Operação", href: "/historico" },
  { label: "Respostas rápidas", group: "Operação", href: "/respostas-rapidas", keywords: "atalhos" },
  { label: "Tabulações", group: "Operação", href: "/tabulacoes", keywords: "tags desfecho" },

  { label: "Contatos", group: "Relacionamento", href: "/contacts", keywords: "clientes" },
  { label: "Funis", group: "Relacionamento", href: "/pipelines", keywords: "pipelines negocios" },
  { label: "Extrator de leads", group: "Relacionamento", href: "/lead-extractor" },
  { label: "Canais", group: "Relacionamento", href: "/canais", keywords: "whatsapp numeros webchat instagram" },

  { label: "Disparador · Campanhas", group: "Campanhas", href: "/disparador/campanhas", keywords: "envio em massa" },
  { label: "Disparador · Monitor", group: "Campanhas", href: "/disparador/monitor", keywords: "fila" },
  { label: "Disparador · Números", group: "Campanhas", href: "/disparador/numeros", keywords: "qualidade linhas" },
  { label: "Disparador · Controles", group: "Campanhas", href: "/disparador/controles", keywords: "limites ritmo" },
  { label: "Disparador · Desempenho", group: "Campanhas", href: "/disparador/desempenho" },
  { label: "Disparador · Erros", group: "Campanhas", href: "/disparador/erros" },
  { label: "Disparador · Blacklist", group: "Campanhas", href: "/disparador/blacklist", keywords: "bloqueados descadastro" },
  { label: "Contatos do disparador", group: "Campanhas", href: "/disparador/contatos", keywords: "importar lista planilha" },
  { label: "Templates", group: "Campanhas", href: "/templates", keywords: "modelos meta" },
  { label: "Régua de cobrança", group: "Campanhas", href: "/regua", keywords: "cobranca vencimento inscricoes dunning" },

  { label: "Fluxos", group: "Automação", href: "/flows", keywords: "flow builder" },
  { label: "Automações", group: "Automação", href: "/automations", permission: "automations.view" },
  { label: "Agentes de IA", group: "Automação", href: "/settings?tab=agents", settingsSection: "agents" },
  { label: "Agente de IA", group: "Automação", href: "/settings?tab=ai", settingsSection: "ai" },

  { label: "DDM Intelligence", group: "Inteligência", href: "/inteligencia", keywords: "assistente" },
  { label: "Chave pessoal do MCP", group: "Inteligência", href: "/inteligencia/chaves", permission: "intelligence.personal_key" },
  { label: "Relatórios · Atendimentos", group: "Inteligência", href: "/relatorios/atendimentos" },
  { label: "Relatórios · Agentes", group: "Inteligência", href: "/relatorios/agentes" },
  { label: "Relatórios · Conversas", group: "Inteligência", href: "/relatorios/conversas" },
  { label: "Relatórios · Tabulações", group: "Inteligência", href: "/relatorios/tabulacoes" },
  { label: "Relatórios · Envio em lote", group: "Inteligência", href: "/relatorios/envio-em-lote" },
  { label: "Relatórios · Auditoria", group: "Inteligência", href: "/relatorios/auditoria" },
  { label: "Relatórios · Exportações", group: "Inteligência", href: "/relatorios/exportacoes", keywords: "downloads" },

  { label: "Equipes", group: "Administração", href: "/equipes", keywords: "times" },
  { label: "Usuários", group: "Administração", href: "/usuarios", keywords: "membros convites" },
  { label: "Configurações", group: "Administração", href: "/settings", settingsSection: "overview" },
  { label: "Chaves de API", group: "Integrações", href: "/settings?tab=api", settingsSection: "api" },
  { label: "Variáveis e credenciais", group: "Integrações", href: "/settings?tab=secrets", settingsSection: "secrets", keywords: "segredos" },
  { label: "Ferramentas dos agentes", group: "Integrações", href: "/settings?tab=tools", settingsSection: "tools" },
  { label: "Documentação da API", group: "Integrações", href: "/settings?tab=api-docs", settingsSection: "api-docs" },
  { label: "Webhooks de saída", group: "Integrações", href: "/settings?tab=webhooks", settingsSection: "webhooks", keywords: "eventos assinatura" },
  { label: "Logs do sistema", group: "Administração", href: "/ddm-logs", permission: "audit.view" },

  { label: "Meu perfil", group: "Conta", href: "/perfil" },
  { label: "Senha e sessões", group: "Conta", href: "/seguranca", keywords: "seguranca" },
  { label: "Central de ajuda", group: "Ajuda", href: "/ajuda", keywords: "faq duvidas" },
];

/** Prefixo de gate da rota, pela mesma regra do servidor (canAccessRoute). */
export function routeGate(path: string): string | null {
  return Object.keys(ROUTE_ALLOWLIST).find((prefix) => path.startsWith(prefix)) ?? null;
}

type PermissionsView = Pick<MePermissions, "pages" | "permissions"> & { role: Pick<MePermissions["role"], "key"> };

export function isPaletteItemVisible(item: PaletteItem, me: PermissionsView): boolean {
  const path = item.href.split("?")[0];
  const gate = routeGate(path);
  if (gate && !me.pages.includes(gate)) return false;
  if (item.permission && !me.permissions.includes(item.permission)) return false;
  if (item.settingsSection && !canSeeSection(item.settingsSection, me.role.key)) return false;
  return true;
}

/** Minúsculas e sem acento ("Histórico" casa com "historico"). */
export function normalizeSearch(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/**
 * Filtra por todos os termos da busca (rótulo, grupo e sinônimos) e ordena:
 * rótulo que começa com a busca > rótulo que contém > resto. Empate mantém
 * a ordem do catálogo (a do menu).
 */
export function searchPalette(items: readonly PaletteItem[], query: string): PaletteItem[] {
  const q = normalizeSearch(query.trim());
  if (!q) return [...items];
  const terms = q.split(/\s+/);
  const scored: { item: PaletteItem; score: number; index: number }[] = [];
  items.forEach((item, index) => {
    const label = normalizeSearch(item.label);
    const haystack = `${label} ${normalizeSearch(item.group)} ${normalizeSearch(item.keywords ?? "")}`;
    if (!terms.every((t) => haystack.includes(t))) return;
    const score = label.startsWith(q) ? 0 : label.includes(q) ? 1 : 2;
    scored.push({ item, score, index });
  });
  return scored.sort((a, b) => a.score - b.score || a.index - b.index).map((s) => s.item);
}

/** O item é a tela atual? (para o selo "Você está aqui"). */
export function isCurrentPaletteItem(item: PaletteItem, pathname: string, search: string): boolean {
  const [path, query] = item.href.split("?");
  if (path !== pathname) return false;
  const tab = new URLSearchParams(search).get("tab");
  const itemTab = query ? new URLSearchParams(query).get("tab") : null;
  return (tab ?? null) === itemTab || (!itemTab && (tab === null || tab === "overview"));
}
