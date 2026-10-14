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
  { label: "Painel", group: "Visão geral", href: "/dashboard", keywords: "dashboard inicio" },

  { label: "Conversas", group: "Atendimento", href: "/inbox", keywords: "inbox atendimento mensagens" },
  { label: "Monitoramento", group: "Atendimento", href: "/monitoramento", keywords: "sla fila atendentes" },
  { label: "Histórico", group: "Atendimento", href: "/historico" },
  { label: "Respostas rápidas", group: "Atendimento", href: "/respostas-rapidas", keywords: "atalhos" },
  { label: "Tabulações", group: "Atendimento", href: "/tabulacoes", keywords: "tags desfecho" },

  { label: "Contatos", group: "Clientes", href: "/contacts", keywords: "clientes" },
  { label: "Contatos · Importações", group: "Clientes", href: "/disparador/contatos", keywords: "importar lista planilha contatos do disparador" },
  { label: "Funis", group: "Clientes", href: "/pipelines", keywords: "pipelines negocios" },
  { label: "Extrator de leads", group: "Clientes", href: "/lead-extractor" },

  { label: "Campanhas", group: "Campanhas", href: "/disparador/campanhas", keywords: "disparador envio em lote envio em massa" },
  { label: "Campanhas · Monitor de envios", group: "Campanhas", href: "/disparador/monitor", keywords: "disparador fila monitor" },
  { label: "Campanhas · Números", group: "Campanhas", href: "/disparador/numeros", keywords: "disparador qualidade linhas" },
  { label: "Campanhas · Controles", group: "Campanhas", href: "/disparador/controles", keywords: "disparador limites ritmo" },
  { label: "Campanhas · Desempenho", group: "Campanhas", href: "/disparador/desempenho", keywords: "disparador" },
  { label: "Campanhas · Erros", group: "Campanhas", href: "/disparador/erros", keywords: "disparador" },
  { label: "Campanhas · Blacklist", group: "Campanhas", href: "/disparador/blacklist", keywords: "disparador bloqueados descadastro" },
  { label: "Templates", group: "Campanhas", href: "/templates", keywords: "modelos meta" },
  { label: "Régua de cobrança", group: "Campanhas", href: "/regua", keywords: "cobranca vencimento inscricoes dunning" },

  { label: "Fluxos", group: "Automação e IA", href: "/flows", keywords: "flow builder conversa guiada" },
  { label: "Automações", group: "Automação e IA", href: "/automations", permission: "automations.view", keywords: "regras gatilhos" },
  { label: "Agentes de IA", group: "Automação e IA", href: "/settings?tab=agents", settingsSection: "agents" },
  { label: "Ferramentas dos agentes", group: "Automação e IA", href: "/settings?tab=tools", settingsSection: "tools" },
  { label: "Provedores de IA", group: "Automação e IA", href: "/settings?tab=ai", settingsSection: "ai", keywords: "openai chave modelo" },
  { label: "Acordito", group: "Automação e IA", href: "/inteligencia", keywords: "inteligência ddm intelligence assistente copiloto" },
  { label: "Chave pessoal do MCP", group: "Automação e IA", href: "/inteligencia/chaves", permission: "intelligence.personal_key" },

  { label: "Relatórios · Desempenho do atendimento", group: "Relatórios", href: "/relatorios/atendimentos", keywords: "atendimentos" },
  { label: "Relatórios · Sessões de atendentes", group: "Relatórios", href: "/relatorios/agentes", keywords: "agentes login" },
  { label: "Relatórios · Tabulações", group: "Relatórios", href: "/relatorios/tabulacoes" },
  { label: "Relatórios · Campanhas", group: "Relatórios", href: "/relatorios/envio-em-lote", keywords: "envio em lote disparador" },
  { label: "Relatórios · Exportações", group: "Relatórios", href: "/relatorios/exportacoes", keywords: "downloads" },

  { label: "Usuários", group: "Administração", href: "/usuarios", keywords: "membros convites cargos permissões papeis" },
  { label: "Equipes", group: "Administração", href: "/equipes", keywords: "times" },
  { label: "Canais", group: "Administração", href: "/canais", keywords: "whatsapp numeros webchat instagram" },
  { label: "Auditoria", group: "Administração", href: "/relatorios/auditoria", keywords: "relatorio de auditoria" },
  { label: "Logs do sistema", group: "Administração", href: "/ddm-logs", permission: "audit.view", keywords: "ddm logs" },
  { label: "Configurações", group: "Administração", href: "/settings", settingsSection: "overview" },
  { label: "Chaves de API", group: "Administração", href: "/settings?tab=api", settingsSection: "api" },
  { label: "Variáveis e credenciais", group: "Administração", href: "/settings?tab=secrets", settingsSection: "secrets", keywords: "segredos" },
  { label: "Documentação da API", group: "Administração", href: "/settings?tab=api-docs", settingsSection: "api-docs" },
  { label: "Webhooks de saída", group: "Administração", href: "/settings?tab=webhooks", settingsSection: "webhooks", keywords: "eventos assinatura" },

  { label: "Meu perfil", group: "Conta", href: "/perfil" },
  { label: "Segurança", group: "Conta", href: "/seguranca", keywords: "senha sessoes" },
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
