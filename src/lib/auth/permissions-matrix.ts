// ============================================================
// "Matriz dourada" das rotas (PRD 20, fase 20.1) — DADOS PUROS.
//
// Cada entrada declara qual papel mínimo a rota exige HOJE e qual permissão do
// catálogo passa a representá-la. O teste (permissions-matrix.test.ts) prova,
// para os 5 papéis de sistema, que `hasMinRole(papel, mínimo)` == `can(papel,
// permissão)` e confere no código-fonte da rota que o guard declarado ainda
// existe (se alguém mudar o papel de uma rota, o teste acusa a divergência).
// Nas fases 20.3+ cada rota troca o guard antigo por `requirePermission(perm)`.
//
// guard:
//   role        guardRole/requireRole/hasMinRole/agentRoute com `min`
//   disparador  requireDisparadorAccess / canManageCampaigns (owner/admin)
//   flow        guardFlow / guardFlowAccess (admin)
//   viewer      bloqueio explícito do viewer
//   scope       escopo de Intelligence (owner/admin conta; supervisor equipes)
//   session     só sessão (qualquer papel) — informativo, fora da equivalência
// pending: lacuna do PRD 20 corrigida em outro PR (G1/G2/G3); a rota ainda não
//   tem o guard nesta base, então o teste de código-fonte não a exige.
// ============================================================

import type { AccountRole } from "./roles";
import type { Permission } from "./permissions";

export interface RouteEntry {
  /** Caminho em src/app/api (sem /route.ts). */
  route: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "*";
  guard: "role" | "permission" | "disparador" | "flow" | "viewer" | "scope" | "session";
  /** Papel mínimo que o guard ANTIGO exigia (guard = role | permission | viewer(agent) | disparador/flow(admin)); a equivalência prova can(papel, permission) == hasMinRole(papel, min). */
  min?: AccountRole;
  permission: Permission;
  pending?: "G1" | "G2" | "G3";
}

const r = (route: string, method: RouteEntry["method"], min: AccountRole, permission: Permission, pending?: RouteEntry["pending"]): RouteEntry => ({
  route, method, guard: "role", min, permission, ...(pending ? { pending } : {}),
});
// Rota já migrada para requirePermission/guardPermission (PRD 20, 20.3): `min` guarda o que o guard antigo exigia.
const pg = (route: string, method: RouteEntry["method"], min: AccountRole, permission: Permission): RouteEntry => ({
  route, method, guard: "permission", min, permission,
});
const disp = (route: string, method: RouteEntry["method"], permission: Permission = "campaigns.manage", pending?: RouteEntry["pending"]): RouteEntry => ({
  route, method, guard: "disparador", min: "admin", permission, ...(pending ? { pending } : {}),
});
const flow = (route: string, method: RouteEntry["method"], permission: Permission = "flows.edit"): RouteEntry => ({
  route, method, guard: "flow", min: "admin", permission,
});
const session = (route: string, method: RouteEntry["method"], permission: Permission): RouteEntry => ({
  route, method, guard: "session", permission,
});

export const ROUTE_MATRIX: readonly RouteEntry[] = [
  // ── Conta, membros, convites, chaves ────────────────────
  pg("account", "GET", "viewer", "account.view"),
  pg("account", "PATCH", "admin", "settings.account"),
  pg("settings/account-config", "GET", "viewer", "account.view"), // PRD 24, item 6
  pg("settings/account-config/[key]", "PUT", "admin", "settings.account"),
  pg("settings/account-config/[key]", "DELETE", "admin", "settings.account"),
  pg("account/ai-config", "GET", "admin", "ai.config"),
  pg("account/ai-config", "POST", "admin", "ai.config"),
  pg("account/api-keys", "GET", "viewer", "api_keys.view"),
  pg("account/api-keys", "POST", "admin", "api_keys.manage"),
  pg("account/api-keys/[id]", "DELETE", "admin", "api_keys.manage"),
  pg("account/invitations", "GET", "admin", "members.invite"),
  pg("account/invitations", "POST", "admin", "members.invite"),
  pg("account/invitations/[id]", "DELETE", "admin", "members.invite"),
  pg("account/members", "GET", "viewer", "members.view"),
  // PRD 20, 20.10: contrato de permissões para o front (derivado do que o servidor já decide)
  session("me/permissions", "GET", "account.view"),
  session("account/permission-catalog", "GET", "members.view"),
  pg("account/members/[userId]", "PATCH", "admin", "members.manage"),
  pg("account/members/[userId]", "DELETE", "admin", "members.manage"),
  pg("account/members/[userId]/reset-password", "POST", "owner", "members.reset_password"),
  pg("account/members/bulk-invite", "POST", "owner", "members.bulk_invite"),
  pg("account/transfer-ownership", "POST", "owner", "ownership.transfer"),
  pg("account/teams/[teamId]/members", "GET", "viewer", "teams.view"),
  pg("account/teams/[teamId]/members", "POST", "admin", "teams.manage"),
  pg("account/teams/[teamId]/members", "DELETE", "admin", "teams.manage"),
  pg("ai/prompt-versions", "GET", "admin", "ai.config"),
  pg("audit-logs", "GET", "admin", "audit.view"),
  pg("ddm-logs", "GET", "admin", "audit.view"),
  pg("ops/status", "GET", "admin", "audit.view"), // PRD 24, item 5: saúde do sistema

  // ── Canais, WhatsApp, templates, webchat ─────────────────
  pg("channels", "GET", "viewer", "channels.view"),
  pg("channels/[type]", "PATCH", "admin", "channels.manage"),
  pg("channels/[type]", "DELETE", "admin", "channels.manage"),
  pg("channels/[type]/connect", "GET", "admin", "channels.manage"),
  pg("channels/[type]/callback", "GET", "admin", "channels.manage"),
  session("lines", "GET", "channels.view"),
  session("whatsapp/config", "GET", "channels.view"),
  pg("whatsapp/config", "POST", "admin", "channels.manage"),
  pg("whatsapp/config", "DELETE", "admin", "channels.manage"),
  pg("whatsapp/config", "PATCH", "admin", "channels.manage"),
  pg("whatsapp/channel-test", "POST", "admin", "channels.manage"),
  pg("whatsapp/channel-test/templates", "GET", "admin", "channels.manage"),
  pg("whatsapp/contacts/sync-avatars", "POST", "admin", "channels.manage"),
  pg("whatsapp/waha/start", "POST", "admin", "channels.manage"),
  pg("whatsapp/waha/stop", "POST", "admin", "channels.manage"),
  pg("whatsapp/waha/qr", "GET", "admin", "channels.manage"),
  pg("whatsapp/waha/pairing-code", "POST", "admin", "channels.manage"),
  pg("webchat/settings", "GET", "admin", "channels.manage"),
  pg("webchat/settings", "PUT", "admin", "channels.manage"),
  pg("whatsapp/templates/submit", "POST", "admin", "templates.manage"),
  pg("whatsapp/templates/sync", "POST", "admin", "templates.manage"),
  pg("whatsapp/templates/reorder", "POST", "admin", "templates.manage"),
  pg("whatsapp/templates/[id]", "PATCH", "admin", "templates.manage"),
  pg("whatsapp/templates/[id]", "DELETE", "admin", "templates.manage"),
  pg("whatsapp/templates/folders", "POST", "admin", "templates.manage"),
  pg("whatsapp/templates/folders/[id]", "PATCH", "admin", "templates.manage"),
  pg("whatsapp/templates/folders/[id]", "DELETE", "admin", "templates.manage"),

  // ── Inbox e conversas ───────────────────────────────────
  pg("whatsapp/send", "POST", "agent", "inbox.reply"),
  pg("whatsapp/react", "POST", "agent", "inbox.reply"),
  pg("conversations/[id]/transfer", "POST", "agent", "inbox.transfer"),
  pg("conversations/[id]/close", "POST", "agent", "inbox.close"),
  pg("conversations/[id]/sentiment", "POST", "agent", "inbox.ai_assist"),
  pg("conversations/[id]/suggest-tag", "GET", "agent", "inbox.ai_assist"),
  pg("conversations/[id]/flow-runs", "GET", "admin", "flows.view_runs"),
  pg("contacts/[id]/link", "POST", "agent", "contacts.edit"),
  pg("contacts", "POST", "agent", "contacts.edit"),
  pg("contacts/[id]", "PATCH", "agent", "contacts.edit"),
  pg("contacts/[id]/tags", "GET", "viewer", "contacts.view"),
  pg("contacts/[id]/tags", "POST", "agent", "contacts.edit"),
  pg("contacts/[id]/tags/[tagId]", "DELETE", "agent", "contacts.edit"),
  pg("contacts/[id]/phones/invalid", "POST", "agent", "contacts.edit"),
  pg("calls/[...path]", "*", "agent", "calls.use"),
  pg("flows/end-run", "POST", "agent", "inbox.reply"),

  // ── Disparador (owner/admin) ────────────────────────────
  disp("disparador/audience/blacklist", "POST"),
  disp("disparador/audience/preview", "POST"),
  disp("disparador/campaigns", "POST"),
  disp("disparador/campaigns/[id]", "PATCH"),
  disp("disparador/campaigns/[id]", "DELETE"),
  disp("disparador/campaigns/[id]/start", "POST"),
  disp("disparador/campaigns/[id]/stop", "POST"),
  disp("disparador/campaigns/[id]/timing", "GET"),
  disp("disparador/campaigns/[id]/unschedule", "POST"),
  disp("disparador/campaigns/[id]/queue-details", "GET"),
  disp("disparador/campaigns/[id]/info", "GET", "campaigns.manage"),
  disp("disparador/campaigns/[id]/audience", "GET", "campaigns.manage"),
  disp("disparador/campaigns/planned-metrics", "POST"),
  r("disparador/campaigns/recalculate-metrics", "GET", "admin", "campaigns.manage"),
  disp("disparador/contacts/import", "POST"),
  disp("disparador/imports", "POST"),
  disp("disparador/imports", "GET"),
  disp("disparador/imports/[id]", "GET"),
  disp("disparador/imports/[id]/blocks/[n]", "PUT"),
  disp("disparador/imports/[id]/start", "POST"),
  disp("disparador/desempenho", "GET"),
  disp("disparador/desempenho/live", "GET"),
  disp("disparador/desempenho/custo", "GET"),
  disp("disparador/erros", "GET"),
  disp("disparador/erros/[id]", "GET"),
  disp("disparador/exports", "POST"),
  disp("disparador/exports", "GET"),
  disp("disparador/exports/[id]", "GET"),
  disp("disparador/health/refresh", "POST"),
  disp("disparador/monitor/snapshot", "GET"),
  disp("disparador/ritmo", "GET"),
  disp("disparador/utm", "POST"),
  disp("disparador/utm/metricas", "GET"),
  disp("disparador/limits", "GET", "campaigns.rate_limit"),
  disp("disparador/limits", "PUT", "campaigns.rate_limit"),
  disp("disparador/rate-limits", "GET", "campaigns.rate_limit"),
  disp("disparador/rate-limits", "PUT", "campaigns.rate_limit"),
  disp("disparador/rate-limits/acknowledge", "POST", "campaigns.rate_limit"),
  disp("disparador/rate-limits/[session]/revert-auto", "POST", "campaigns.rate_limit"),

  // ── Fluxos, automações, IA, segredos ────────────────────
  flow("flows", "GET"),
  flow("flows", "POST"),
  flow("flows/templates", "GET"),
  flow("flows/import", "POST"),
  flow("flows/[id]", "GET"),
  flow("flows/[id]", "PUT"),
  flow("flows/[id]", "DELETE"),
  flow("flows/[id]/activate", "POST"),
  flow("flows/[id]/export", "GET"),
  flow("flows/[id]/runs", "GET", "flows.view_runs"),
  flow("flows/[id]/runs", "DELETE", "flows.view_runs"),
  pg("flows/[id]/simulate", "POST", "supervisor", "flows.simulate"),
  pg("automations", "GET", "agent", "automations.view"),
  pg("automations", "POST", "admin", "automations.edit"),
  pg("automations/[id]", "GET", "agent", "automations.view"),
  pg("automations/[id]", "PATCH", "admin", "automations.edit"),
  pg("automations/[id]", "DELETE", "admin", "automations.edit"),
  pg("automations/[id]/duplicate", "POST", "admin", "automations.edit"),
  pg("automations/engine", "POST", "admin", "automations.edit"),
  pg("settings/agents", "GET", "supervisor", "ai.agents.view"),
  pg("settings/agents", "POST", "admin", "ai.agents.edit"),
  pg("settings/agents/preview", "POST", "supervisor", "ai.agents.view"),
  pg("settings/agents/[id]", "GET", "supervisor", "ai.agents.view"),
  pg("settings/agents/[id]", "PATCH", "admin", "ai.agents.edit"),
  pg("settings/agents/[id]", "DELETE", "admin", "ai.agents.edit"),
  pg("settings/agents/[id]/versions", "POST", "admin", "ai.agents.edit"),
  pg("settings/agents/[id]/rollback", "POST", "admin", "ai.agents.edit"),
  pg("settings/tools", "GET", "supervisor", "ai.tools.view"),
  pg("settings/tools", "POST", "admin", "ai.tools.edit"),
  pg("settings/tools/[id]", "PATCH", "admin", "ai.tools.edit"),
  pg("settings/tools/[id]", "DELETE", "admin", "ai.tools.edit"),
  pg("settings/tools/[id]/test", "POST", "admin", "ai.tools.edit"),
  pg("settings/secrets", "GET", "supervisor", "secrets.view_meta"),
  pg("settings/secrets", "POST", "admin", "secrets.write"),
  pg("settings/secrets/[id]", "PATCH", "admin", "secrets.write"),
  pg("settings/secrets/[id]", "DELETE", "admin", "secrets.write"),

  // ── Monitoramento, relatórios, Intelligence ─────────────
  pg("monitoramento/dia", "GET", "supervisor", "monitoring.view_team"),
  pg("monitoramento/conversations", "GET", "supervisor", "monitoring.view_team"),
  pg("monitoramento/sla", "GET", "supervisor", "monitoring.view_team"),
  pg("relatorios/exports", "POST", "supervisor", "reports.export"),
  pg("relatorios/exports", "DELETE", "admin", "exports.manage"),
  { route: "intelligence/chat", method: "POST", guard: "scope", min: "supervisor", permission: "intelligence.use" },
  { route: "intelligence/chats", method: "GET", guard: "scope", min: "supervisor", permission: "intelligence.use" },
  { route: "intelligence/chats/[id]", method: "GET", guard: "scope", min: "supervisor", permission: "intelligence.use" },
  { route: "intelligence/tools", method: "GET", guard: "scope", min: "supervisor", permission: "intelligence.use" },
  { route: "intelligence/tools/[name]", method: "POST", guard: "scope", min: "supervisor", permission: "intelligence.use" },
];

// ── Páginas (ROUTE_ALLOWLIST) ────────────────────────────────────────────
/**
 * Para cada prefixo de página: os papéis que o ROUTE_ALLOWLIST libera HOJE
 * (instantâneo — se o allowlist mudar, o teste acusa), a permissão do catálogo
 * que a representa e se página e permissão estão ALINHADAS. Divergências
 * conhecidas (G5–G8 do PRD 20): a tela é mais restrita que a API.
 */
export interface PageEntry {
  prefix: string;
  roles: readonly AccountRole[];
  permission: Permission | null;
  aligned: boolean;
  note?: string;
}

export const PAGE_MATRIX: readonly PageEntry[] = [
  { prefix: "/dashboard", roles: ["owner", "admin", "supervisor", "viewer"], permission: "dashboard.view", aligned: true },
  { prefix: "/monitoramento", roles: ["owner", "admin", "supervisor"], permission: "monitoring.view_team", aligned: true },
  { prefix: "/inteligencia", roles: ["owner", "admin", "supervisor"], permission: "intelligence.use", aligned: true },
  { prefix: "/inbox", roles: ["owner", "admin", "supervisor", "agent"], permission: "inbox.view", aligned: true },
  { prefix: "/relatorios/atendimentos", roles: ["owner", "admin", "supervisor"], permission: "reports.view_team", aligned: true },
  { prefix: "/relatorios/conversas", roles: ["owner", "admin", "supervisor"], permission: "reports.view_team", aligned: true },
  { prefix: "/relatorios/tabulacoes", roles: ["owner", "admin", "supervisor"], permission: "reports.view_team", aligned: true },
  { prefix: "/relatorios/agentes", roles: ["owner", "admin", "supervisor"], permission: "reports.view_team", aligned: true },
  { prefix: "/relatorios", roles: ["owner", "admin"], permission: "reports.view_all", aligned: true },
  { prefix: "/canais", roles: ["owner"], permission: "channels.manage", aligned: false, note: "página só owner; a API aceita admin (G7)" },
  { prefix: "/contacts", roles: ["owner"], permission: "contacts.view", aligned: false, note: "página só owner; contatos são lidos por todos (G7)" },
  { prefix: "/pipelines", roles: ["owner"], permission: "pipelines.manage", aligned: false, note: "página só owner; RLS admin (G7)" },
  { prefix: "/flows", roles: ["owner", "admin"], permission: "flows.edit", aligned: true },
  { prefix: "/disparador", roles: ["owner", "admin"], permission: "campaigns.manage", aligned: true },
  { prefix: "/ajuda", roles: ["owner"], permission: null, aligned: false, note: "sem capacidade correspondente" },
  { prefix: "/settings", roles: ["owner", "admin"], permission: "settings.account", aligned: true },
  { prefix: "/equipes", roles: ["owner", "admin"], permission: "teams.manage", aligned: true, note: "a tela é só leitura para admin; a API deixa gerir (G6)" },
  { prefix: "/perfil", roles: ["owner", "admin"], permission: null, aligned: false, note: "comentário diz 'todos'; allowlist é owner/admin" },
  { prefix: "/seguranca", roles: ["owner", "admin", "supervisor", "agent", "viewer"], permission: null, aligned: false, note: "todos os papéis" },
  { prefix: "/templates", roles: ["owner", "admin"], permission: "templates.manage", aligned: true },
  { prefix: "/tabulacoes", roles: ["owner", "admin"], permission: "tags.manage", aligned: true },
  { prefix: "/respostas-rapidas", roles: ["owner", "admin"], permission: "inbox.quick_replies.manage", aligned: true },
  { prefix: "/usuarios", roles: ["owner", "admin"], permission: "members.manage", aligned: true },
  { prefix: "/membros", roles: ["owner", "admin"], permission: "members.manage", aligned: true },
];
