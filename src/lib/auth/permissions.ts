// ============================================================
// Catálogo fechado de permissões (PRD 20, fase 20.1).
//
// MÓDULO PURO — sem I/O e sem import de servidor: pode ir ao navegador.
//
// Esta fase NÃO muda comportamento: nenhuma rota, policy ou tela usa `can()`
// ainda. O catálogo e os conjuntos dos 5 papéis de sistema reproduzem
// EXATAMENTE o que as checagens atuais (`hasMinRole`, `ROUTE_ALLOWLIST`,
// predicados de roles.ts) já decidem; os testes de equivalência
// (permissions.test.ts / permissions-matrix.test.ts) provam isso rota a rota.
// Nas fases seguintes cada checagem passa a pedir uma permissão, e o papel
// personalizado (só o proprietário cria) é um conjunto de chaves daqui.
//
// Convenções:
//   - `roles` = quais papéis de SISTEMA têm a permissão hoje. Definido por
//     lista/limiar explícito (não por rank puro) para reproduzir as exceções
//     não monotônicas (ex.: /dashboard exclui o operador; receber atribuição
//     é só do operador).
//   - `ownerOnly` = nunca entra em papel personalizado (teto do modelo).
//   - `scope` = dimensão de visibilidade: account (organização toda), team
//     (equipes do usuário), own (só o que é dele). `X.*_all` implica `X.*_team`.
// ============================================================

import { ACCOUNT_ROLES, hasMinRole, type AccountRole } from "./roles";

export type PermissionScope = "account" | "team" | "own" | "none";

export interface PermissionDef {
  label: string;
  description: string;
  group: string;
  scope: PermissionScope;
  /** Papéis de sistema que têm a permissão (comportamento de hoje). */
  roles: readonly AccountRole[];
  /** Só o proprietário: nunca vai para papel personalizado. */
  ownerOnly?: true;
  /** Chaves que precisam estar no mesmo papel (validado ao salvar um papel personalizado). */
  dependsOn?: readonly string[];
  /** Ainda sem checagem no código atual (previsto em PRD 19/20). */
  future?: true;
}

const atLeast = (min: AccountRole): readonly AccountRole[] => ACCOUNT_ROLES.filter((r) => hasMinRole(r, min));
const ALL: readonly AccountRole[] = ACCOUNT_ROLES;

export const PERMISSION_CATALOG = {
  // ── Inbox ───────────────────────────────────────────────
  "inbox.view": { label: "Ver conversas", description: "Acessar o Inbox (o nível — todas, da equipe ou próprias — vem de conversations.scope_*).", group: "Inbox", scope: "own", roles: atLeast("agent") },
  "inbox.reply": { label: "Responder", description: "Enviar mensagens, reagir e registrar notas.", group: "Inbox", scope: "none", roles: atLeast("agent"), dependsOn: ["inbox.view"] },
  "inbox.transfer": { label: "Transferir conversa", description: "Transferir uma conversa para outra equipe ou atendente.", group: "Inbox", scope: "none", roles: atLeast("agent"), dependsOn: ["inbox.view"] },
  "inbox.close": { label: "Encerrar e tabular", description: "Encerrar a conversa e aplicar tabulação.", group: "Inbox", scope: "none", roles: atLeast("agent"), dependsOn: ["inbox.view"] },
  "inbox.delete_conversation": { label: "Excluir conversa", description: "Excluir definitivamente uma conversa.", group: "Inbox", scope: "none", roles: atLeast("supervisor"), dependsOn: ["inbox.view"] },
  "inbox.ai_assist": { label: "Assistente de IA no atendimento", description: "Análise de sentimento e sugestão de tag.", group: "Inbox", scope: "none", roles: atLeast("agent"), dependsOn: ["inbox.view"] },
  "inbox.receive_assignments": { label: "Receber atribuições", description: "Pode receber conversas por atribuição e por handoff (hoje: só o papel Operador).", group: "Inbox", scope: "none", roles: ["agent"] },
  "inbox.quick_replies.manage": { label: "Gerenciar respostas rápidas", description: "Cadastrar e editar respostas rápidas.", group: "Inbox", scope: "none", roles: atLeast("admin") },
  "calls.use": { label: "Chamadas de voz", description: "Usar o VoIP.", group: "Inbox", scope: "none", roles: atLeast("agent") },
  "conversations.scope_all": { label: "Ver todas as conversas da organização", description: "Visibilidade total de conversas.", group: "Inbox", scope: "account", roles: ["owner", "admin", "viewer"] },
  "conversations.scope_team": { label: "Ver as conversas das equipes dele", description: "Sem escopo amplo, só as dele e a fila da equipe (nível do operador).", group: "Inbox", scope: "team", roles: ["supervisor"] },

  // ── Contatos e CRM ──────────────────────────────────────
  "contacts.view": { label: "Ver contatos", description: "Listar e abrir contatos.", group: "Contatos", scope: "account", roles: ALL },
  "contacts.edit": { label: "Editar contatos", description: "Criar, editar e vincular contatos.", group: "Contatos", scope: "none", roles: atLeast("agent"), dependsOn: ["contacts.view"] },
  "contacts.import": { label: "Importar contatos", description: "Importar contatos (cria tags).", group: "Contatos", scope: "none", roles: atLeast("admin"), dependsOn: ["contacts.edit"] },
  "tags.manage": { label: "Gerenciar tags e tabulações", description: "Tags, tabulações e campos personalizados.", group: "Contatos", scope: "none", roles: atLeast("admin") },
  "pipelines.manage": { label: "Gerenciar funis", description: "Funis, etapas e regras de negócio do CRM.", group: "Contatos", scope: "none", roles: atLeast("admin"), dependsOn: ["pipelines.view"] },

  // ── Acompanhamento ──────────────────────────────────────
  "dashboard.view": { label: "Dashboard", description: "Ver o dashboard.", group: "Acompanhamento", scope: "account", roles: ["owner", "admin", "supervisor", "viewer"] },
  "monitoring.view_team": { label: "Monitoramento (equipes)", description: "Monitorar as equipes dele.", group: "Acompanhamento", scope: "team", roles: atLeast("supervisor") },
  "monitoring.view_all": { label: "Monitoramento (organização)", description: "Monitorar a organização toda.", group: "Acompanhamento", scope: "account", roles: atLeast("admin"), dependsOn: ["monitoring.view_team"] },
  "monitoring.assign": { label: "Reatribuir no monitoramento", description: "Arrastar/reatribuir conversas.", group: "Acompanhamento", scope: "none", roles: atLeast("admin"), dependsOn: ["monitoring.view_all"] },
  "reports.view_team": { label: "Relatórios (equipes)", description: "Atendimentos, conversas, tabulações e agentes das equipes dele.", group: "Acompanhamento", scope: "team", roles: atLeast("supervisor") },
  "reports.view_all": { label: "Relatórios (organização)", description: "Relatórios da organização toda, inclusive envio em lote.", group: "Acompanhamento", scope: "account", roles: atLeast("admin"), dependsOn: ["reports.view_team"] },
  "reports.export": { label: "Gerar exportações", description: "Gerar e registrar exportações.", group: "Acompanhamento", scope: "none", roles: atLeast("supervisor"), dependsOn: ["reports.view_team"] },
  "exports.manage": { label: "Gerenciar exportações", description: "Listar e apagar exportações geradas.", group: "Acompanhamento", scope: "none", roles: atLeast("admin"), dependsOn: ["reports.export"] },
  "audit.view": { label: "Auditoria e logs", description: "Ver a auditoria e os logs.", group: "Acompanhamento", scope: "account", roles: atLeast("admin") },

  // ── Intelligence ────────────────────────────────────────
  "intelligence.use": { label: "DDM Intelligence", description: "Chat, ferramentas e MCP (escopo das equipes dele).", group: "Intelligence", scope: "team", roles: atLeast("supervisor") },
  "intelligence.scope_account": { label: "Intelligence da organização toda", description: "Sem isso, só as equipes dele.", group: "Intelligence", scope: "account", roles: atLeast("admin"), dependsOn: ["intelligence.use"] },
  "intelligence.personal_key": { label: "Chave pessoal do MCP", description: "Criar a própria chave de acesso ao Intelligence.", group: "Intelligence", scope: "own", roles: atLeast("supervisor"), dependsOn: ["intelligence.use"] },

  // ── Disparador ──────────────────────────────────────────
  "campaigns.manage": { label: "Disparador", description: "Criar, editar, iniciar e pausar campanhas; listas, métricas, erros e UTM.", group: "Disparador", scope: "none", roles: atLeast("admin"), dependsOn: ["channels.view", "campaigns.view"] },
  "campaigns.rate_limit": { label: "Limites de envio", description: "Vagas e limite por segundo por número; reconhecer avisos de qualidade.", group: "Disparador", scope: "none", roles: atLeast("admin"), dependsOn: ["campaigns.manage"] },
  "campaigns.red_quality_override": { label: "Número em qualidade vermelha", description: "Iniciar campanha em número vermelho e alterar a política de qualidade.", group: "Disparador", scope: "none", roles: ["owner"], ownerOnly: true, dependsOn: ["campaigns.manage"] },

  // ── Fluxos, automações e IA ─────────────────────────────
  "flows.edit": { label: "Editar fluxos", description: "Criar, editar, ativar e importar fluxos.", group: "Fluxos e IA", scope: "none", roles: atLeast("admin"), dependsOn: ["automations.view"] },
  "flows.view_runs": { label: "Ver execuções de fluxo", description: "Ver o fluxo que rodou numa conversa e o histórico de execuções.", group: "Fluxos e IA", scope: "none", roles: atLeast("admin") },
  "flows.simulate": { label: "Simulador de fluxo", description: "Usar o simulador (leitura real de credencial exige secrets.write).", group: "Fluxos e IA", scope: "none", roles: atLeast("supervisor") },
  "automations.view": { label: "Ver automações", description: "Listar automações.", group: "Fluxos e IA", scope: "none", roles: atLeast("agent") },
  "automations.edit": { label: "Editar automações", description: "Criar, editar e apagar automações.", group: "Fluxos e IA", scope: "none", roles: atLeast("admin"), dependsOn: ["automations.view"] },
  "ai.config": { label: "Configuração da IA", description: "Chave, prompt e liga/desliga da IA da organização.", group: "Fluxos e IA", scope: "none", roles: atLeast("admin") },
  "ai.agents.view": { label: "Ver agentes de IA", description: "Listar e pré-visualizar perfis de agente.", group: "Fluxos e IA", scope: "none", roles: atLeast("supervisor") },
  "ai.agents.edit": { label: "Editar agentes de IA", description: "Criar, editar, publicar e reverter perfis de agente.", group: "Fluxos e IA", scope: "none", roles: atLeast("admin"), dependsOn: ["ai.agents.view"] },
  "ai.tools.view": { label: "Ver ferramentas de IA", description: "Listar ferramentas dos agentes.", group: "Fluxos e IA", scope: "none", roles: atLeast("supervisor") },
  "ai.tools.edit": { label: "Editar ferramentas de IA", description: "Criar, editar, testar e apagar ferramentas.", group: "Fluxos e IA", scope: "none", roles: atLeast("admin"), dependsOn: ["ai.tools.view"] },
  "secrets.view_meta": { label: "Ver variáveis e credenciais", description: "Listar nomes, hosts e últimos 4 dígitos (o valor nunca volta).", group: "Fluxos e IA", scope: "none", roles: atLeast("supervisor") },
  "secrets.write": { label: "Gravar variáveis e credenciais", description: "Criar, trocar e apagar variáveis e credenciais.", group: "Fluxos e IA", scope: "none", roles: atLeast("admin"), dependsOn: ["secrets.view_meta"] },

  // ── Canais ──────────────────────────────────────────────
  "channels.view": { label: "Ver canais", description: "Listar linhas/canais (equipes para operador e supervisor).", group: "Canais", scope: "team", roles: ALL },
  "channels.manage": { label: "Gerenciar canais", description: "Conectar, configurar, WAHA, webchat e tokens.", group: "Canais", scope: "none", roles: atLeast("admin"), dependsOn: ["channels.view"] },
  "templates.view": { label: "Ver templates", description: "Listar templates e pastas.", group: "Canais", scope: "none", roles: ALL },
  "templates.manage": { label: "Gerenciar templates", description: "Criar, editar, sincronizar e apagar templates Meta e pastas.", group: "Canais", scope: "none", roles: atLeast("admin"), dependsOn: ["templates.view"] },

  // ── Pessoas ─────────────────────────────────────────────
  "teams.view": { label: "Ver equipes", description: "Listar equipes e membros.", group: "Pessoas", scope: "none", roles: ALL },
  "teams.manage": { label: "Gerenciar equipes", description: "Criar equipes e gerir membros de equipe.", group: "Pessoas", scope: "none", roles: atLeast("admin"), dependsOn: ["teams.view"] },
  "members.view": { label: "Ver membros", description: "Listar membros (nome, avatar, papel).", group: "Pessoas", scope: "none", roles: ALL },
  "members.view_emails": { label: "Ver e-mails dos membros", description: "Ver o e-mail de cada membro.", group: "Pessoas", scope: "none", roles: atLeast("admin"), dependsOn: ["members.view"] },
  "members.invite": { label: "Convidar membros", description: "Criar e revogar convites.", group: "Pessoas", scope: "none", roles: atLeast("admin"), dependsOn: ["members.view"] },
  "members.manage": { label: "Gerir membros", description: "Mudar papel, equipe e limite de chats; desativar membro.", group: "Pessoas", scope: "none", roles: atLeast("admin"), dependsOn: ["members.view"] },
  "members.reset_password": { label: "Redefinir senha de outro membro", description: "Trocar a senha de um membro.", group: "Pessoas", scope: "none", roles: ["owner"], ownerOnly: true },
  "members.bulk_invite": { label: "Convite em lote", description: "Criar vários membros de uma vez.", group: "Pessoas", scope: "none", roles: ["owner"], ownerOnly: true },
  "ownership.transfer": { label: "Transferir a propriedade", description: "Passar a organização a outro membro.", group: "Pessoas", scope: "none", roles: ["owner"], ownerOnly: true },
  "account.delete": { label: "Excluir a organização", description: "Excluir a organização e seus dados.", group: "Pessoas", scope: "none", roles: ["owner"], ownerOnly: true },
  "roles.manage": { label: "Gerir papéis personalizados", description: "Criar, editar, apagar e atribuir papéis personalizados.", group: "Pessoas", scope: "none", roles: ["owner"], ownerOnly: true },

  // ── Organização ─────────────────────────────────────────
  "account.view": { label: "Ver a organização", description: "Ver nome e dados gerais da organização.", group: "Organização", scope: "none", roles: ALL },
  "settings.account": { label: "Configurações da organização", description: "Nome e configurações gerais.", group: "Organização", scope: "none", roles: atLeast("admin"), dependsOn: ["account.view"] },
  "api_keys.view": { label: "Ver chaves de API", description: "Listar as chaves de API da organização (sem o segredo).", group: "Organização", scope: "none", roles: ALL },
  "api_keys.manage": { label: "Gerenciar chaves de API", description: "Criar e revogar chaves de API.", group: "Organização", scope: "none", roles: atLeast("admin"), dependsOn: ["api_keys.view"] },
  "integrations.manage": { label: "Integrações da organização", description: "Chaves e integrações por organização (PRD 19).", group: "Organização", scope: "none", roles: atLeast("admin"), future: true },

  // ── Cobrança (PRD 17) ───────────────────────────────────
  "billing.view": { label: "Ver a régua de cobrança", description: "Ver réguas, etapas, inscrições e métricas da régua de cobrança.", group: "Cobrança", scope: "account", roles: atLeast("supervisor") },
  "billing.manage": { label: "Gerir a régua de cobrança", description: "Criar e alterar réguas e etapas, simular, pausar e parar inscrições.", group: "Cobrança", scope: "none", roles: atLeast("admin"), dependsOn: ["billing.view"] },

  // ── Chaves de leitura (RLS fase 2, migration 304): todos os papéis; as policies de SELECT de campanhas e funis passam a perguntar o catálogo (305) ──
  "campaigns.view": { label: "Ver campanhas", description: "Ler campanhas, métricas e fila de envio (leitura direta; o Inbox mostra a origem da conversa).", group: "Leitura de campanhas e funis", scope: "account", roles: ALL },
  "pipelines.view": { label: "Ver funis e negócios", description: "Ler funis, etapas e negócios (leitura direta do CRM).", group: "Leitura de campanhas e funis", scope: "account", roles: ALL },
} as const satisfies Record<string, PermissionDef>;

export type Permission = keyof typeof PERMISSION_CATALOG;

export const PERMISSIONS = Object.keys(PERMISSION_CATALOG) as readonly Permission[];

const DEFS = PERMISSION_CATALOG as Record<Permission, PermissionDef>;

export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(PERMISSION_CATALOG, value);
}

export function permissionDef(permission: Permission): PermissionDef {
  return DEFS[permission];
}

// ── Escopos: a variante mais ampla implica a mais estreita ────────────────
const IMPLIES: Readonly<Partial<Record<Permission, readonly Permission[]>>> = {
  "conversations.scope_all": ["conversations.scope_team"],
  "monitoring.view_all": ["monitoring.view_team"],
  "reports.view_all": ["reports.view_team"],
  "intelligence.scope_account": ["intelligence.use"],
};

/** Acrescenta as permissões implicadas (ex.: ver_tudo ⇒ ver_equipe). */
export function expandPermissions(permissions: Iterable<Permission>): Set<Permission> {
  const out = new Set<Permission>();
  const visit = (p: Permission) => {
    if (out.has(p)) return;
    out.add(p);
    for (const implied of IMPLIES[p] ?? []) visit(implied);
  };
  for (const p of permissions) visit(p);
  return out;
}

// ── Papéis de sistema ────────────────────────────────────────────────────
/** Conjunto de permissões de cada papel de SISTEMA — igual ao comportamento atual. */
export const SYSTEM_ROLE_PERMISSIONS: Readonly<Record<AccountRole, ReadonlySet<Permission>>> = Object.freeze(
  Object.fromEntries(
    ACCOUNT_ROLES.map((role) => [
      role,
      expandPermissions(PERMISSIONS.filter((p) => DEFS[p].roles.includes(role))),
    ]),
  ) as unknown as Record<AccountRole, ReadonlySet<Permission>>,
);

export function permissionsForRole(role: AccountRole): ReadonlySet<Permission> {
  return SYSTEM_ROLE_PERMISSIONS[role];
}

// ── Verificação ──────────────────────────────────────────────────────────
/**
 * Contexto mínimo para decidir: o papel de sistema (compatível com o que o
 * servidor já tem hoje) e, quando existir (papel personalizado, fases
 * seguintes), a lista efetiva de permissões — que, se presente, vale.
 */
export interface PermissionSubject {
  role: AccountRole;
  permissions?: ReadonlySet<string>;
}

/** `can(ctx, 'campaigns.manage')`. Chave fora do catálogo = nega (fail-closed). */
export function can(subject: PermissionSubject, permission: Permission): boolean {
  if (!isPermission(permission)) return false;
  if (subject.permissions) return subject.permissions.has(permission);
  return SYSTEM_ROLE_PERMISSIONS[subject.role]?.has(permission) ?? false;
}

export function canAny(subject: PermissionSubject, permissions: readonly Permission[]): boolean {
  return permissions.some((p) => can(subject, p));
}

export function canAll(subject: PermissionSubject, permissions: readonly Permission[]): boolean {
  return permissions.every((p) => can(subject, p));
}

// ── Papel personalizado: teto, dependências e papel de compatibilidade ───
export type RolePermissionError =
  | { code: "unknown_permission"; permission: string }
  | { code: "owner_only"; permission: Permission }
  /** Ainda sem checagem no código (`future`): não entra em papel personalizado até existir. */
  | { code: "not_grantable"; permission: Permission }
  | { code: "missing_dependency"; permission: Permission; requires: Permission };

/** Limite de papéis personalizados por organização (decisão do dono, 09/10; o banco confere — migration 313). */
export const MAX_CUSTOM_ROLES = 20;

/**
 * Pode entrar em papel personalizado? Teto: nada `ownerOnly`, nada `future` (sem checagem no código ainda) e nada
 * fora do catálogo. Mesmo valor de permission_catalog.grantable (migration 312).
 */
export function isGrantableToCustomRole(permission: string): permission is Permission {
  return isPermission(permission) && !DEFS[permission].ownerOnly && !DEFS[permission].future;
}

/**
 * Valida o conjunto de um papel personalizado: chaves do catálogo, nenhuma
 * `ownerOnly` nem `future` e todas as dependências presentes (explicitamente — não
 * acrescenta nada sozinho). Devolve a lista de erros (vazia = válido).
 */
export function validateCustomRolePermissions(permissions: readonly string[]): RolePermissionError[] {
  const errors: RolePermissionError[] = [];
  const present = new Set(permissions);
  for (const key of present) {
    if (!isPermission(key)) {
      errors.push({ code: "unknown_permission", permission: key });
      continue;
    }
    if (DEFS[key].ownerOnly) {
      errors.push({ code: "owner_only", permission: key });
      continue;
    }
    if (DEFS[key].future) {
      errors.push({ code: "not_grantable", permission: key });
      continue;
    }
    for (const dep of DEFS[key].dependsOn ?? []) {
      if (!present.has(dep) && !impliedBy(present, dep as Permission)) {
        errors.push({ code: "missing_dependency", permission: key, requires: dep as Permission });
      }
    }
  }
  return errors;
}

/** `dep` está presente por implicação (ex.: tem view_all ⇒ tem view_team)? */
function impliedBy(present: ReadonlySet<string>, dep: Permission): boolean {
  for (const [wide, narrows] of Object.entries(IMPLIES)) {
    if (present.has(wide) && narrows?.includes(dep)) return true;
  }
  return false;
}

/**
 * Menor papel de SISTEMA cujo conjunto contém todas as permissões (papel de
 * "compatibilidade" para checagens legadas baseadas no enum). Se nenhum
 * contém (ex.: receber atribuição + editar automações), devolve `admin` — o
 * teto de um personalizado.
 */
export function compatRoleFor(permissions: readonly Permission[]): AccountRole {
  const wanted = expandPermissions(permissions);
  for (const role of ACCOUNT_ROLES) {
    if (role === "owner") break;
    const set = SYSTEM_ROLE_PERMISSIONS[role];
    if ([...wanted].every((p) => set.has(p))) return role;
  }
  return "admin";
}
