// ============================================================
// Contrato de permissões para o front (PRD 20, fase 20.10, seção 8).
//
// MÓDULO PURO — monta as respostas de GET /api/me/permissions e
// GET /api/account/permission-catalog a partir do que o servidor já decide
// (getCurrentAccount().permissions e o catálogo). NÃO decide nada novo: o front só consome.
// ============================================================

import { ROUTE_ALLOWLIST, canAccessRoute } from "../role-utils";
import { PAGE_MATRIX } from "./permissions-matrix";
import { PERMISSION_CATALOG, PERMISSIONS, can, isGrantableToCustomRole, type Permission } from "./permissions";
import { ACCOUNT_ROLES, type AccountRole } from "./roles";

export const SYSTEM_ROLE_NAMES: Readonly<Record<AccountRole, string>> = {
  owner: "Proprietário",
  admin: "Administrador",
  supervisor: "Supervisor",
  agent: "Operador",
  viewer: "Visualizador",
};

export type ScopeLevel = "all" | "team" | "own" | "none";

export interface MePermissions {
  organization: { id: string; name: string };
  role: {
    /** Papel personalizado: o id em account_roles; papel de sistema: null. */
    id: string | null;
    /** Papel de sistema (no personalizado, o compat_role — o que o RLS e as páginas usam). */
    key: AccountRole;
    /** Nome exibido (no personalizado, o nome dado pelo proprietário). */
    name: string;
    kind: "system" | "custom";
    /** Sistema: owner 5 … viewer 1 (no personalizado, o do compat_role). */
    rank: number;
    /** Nível para a regra "só abaixo de você" (migration 318): sistema 5..1; personalizado até 3,5. */
    level: number;
    /** Cargo de sistema com permissões ajustadas nesta organização. */
    customized: boolean;
  };
  permissions: Permission[];
  scopes: {
    inbox: ScopeLevel;
    monitoring: ScopeLevel;
    reports: ScopeLevel;
    intelligence: ScopeLevel;
  };
  pages: string[];
  status: "active";
}

export interface MePermissionsInput {
  account: { id: string; name: string };
  role: AccountRole;
  permissions: ReadonlySet<string>;
  customRole?: { id: string; name: string } | null;
  /** Nível do cargo (318); ausente = rank do papel de sistema. */
  roleLevel?: number;
  roleCustomized?: boolean;
  roleKey?: AccountRole | null;
}

/** Escopo de visibilidade por domínio: a variante ampla vence a estreita; sem nenhuma, `fallback`. */
function scopeOf(has: (p: Permission) => boolean, all: Permission, team: Permission, fallback: ScopeLevel): ScopeLevel {
  if (has(all)) return "all";
  if (has(team)) return "team";
  return fallback;
}

export function buildMePermissions(ctx: MePermissionsInput): MePermissions {
  const subject = { role: ctx.role, permissions: ctx.permissions };
  const has = (p: Permission) => can(subject, p);
  return {
    organization: { id: ctx.account.id, name: ctx.account.name },
    role: {
      id: ctx.customRole?.id ?? null,
      key: ctx.role,
      name: ctx.customRole?.name ?? SYSTEM_ROLE_NAMES[ctx.roleKey ?? ctx.role],
      kind: ctx.customRole ? "custom" : "system",
      rank: ACCOUNT_ROLES.indexOf(ctx.role) + 1,
      level: ctx.roleLevel ?? ACCOUNT_ROLES.indexOf(ctx.role) + 1,
      customized: ctx.roleCustomized ?? false,
    },
    permissions: PERMISSIONS.filter(has),
    scopes: {
      // Conversas: sem escopo amplo nem de equipe = só as dele + fila (operador).
      inbox: scopeOf(has, "conversations.scope_all", "conversations.scope_team", "own"),
      monitoring: scopeOf(has, "monitoring.view_all", "monitoring.view_team", "none"),
      reports: scopeOf(has, "reports.view_all", "reports.view_team", "none"),
      intelligence: scopeOf(has, "intelligence.scope_account", "intelligence.use", "none"),
    },
    // Páginas com gate que o usuário abre. Papel de sistema: o ROUTE_ALLOWLIST. Cargo personalizado (ou papel
    // de sistema com permissões ajustadas): a permissão de cada tela (PAGE_MATRIX); tela sem permissão própria
    // (/ajuda, /perfil, /seguranca) segue o papel. /flows também abre para quem só vê execuções
    // (flows.view_runs): o editor abre em modo leitura (decisão do dono 13/10, item 11).
    pages: Object.keys(ROUTE_ALLOWLIST).filter((prefix) => {
      if (prefix === "/flows" && has("flows.view_runs")) return true;
      if (ctx.role === "owner" || !(ctx.customRole || ctx.roleCustomized)) return canAccessRoute(ctx.role, prefix);
      const entry = PAGE_MATRIX.find((p) => p.prefix === prefix);
      if (!entry?.permission) return canAccessRoute(ctx.role, prefix);
      return has(entry.permission) || (entry.anyOf ?? []).some(has);
    }),
    status: "active",
  };
}

export interface CatalogPermissionView {
  key: Permission;
  label: string;
  description: string;
  /** 'n/a' quando a permissão não tem dimensão de escopo (mesmo valor da tabela permission_catalog). */
  scope: "account" | "team" | "own" | "n/a";
  ownerOnly: boolean;
  grantable: boolean;
  dependsOn: string[];
}

export interface CatalogGroupView {
  key: string;
  label: string;
  permissions: CatalogPermissionView[];
}

const slug = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** Catálogo agrupado, na ordem do catálogo (grupos pela 1ª aparição). Somente leitura. */
export function buildPermissionCatalogGroups(): CatalogGroupView[] {
  const groups = new Map<string, CatalogGroupView>();
  for (const key of PERMISSIONS) {
    const def = PERMISSION_CATALOG[key] as {
      label: string;
      description: string;
      group: string;
      scope: "account" | "team" | "own" | "none";
      ownerOnly?: true;
      dependsOn?: readonly string[];
    };
    let group = groups.get(def.group);
    if (!group) {
      group = { key: slug(def.group), label: def.group, permissions: [] };
      groups.set(def.group, group);
    }
    group.permissions.push({
      key,
      label: def.label,
      description: def.description,
      scope: def.scope === "none" ? "n/a" : def.scope,
      ownerOnly: Boolean(def.ownerOnly),
      grantable: isGrantableToCustomRole(key),
      dependsOn: [...(def.dependsOn ?? [])],
    });
  }
  return [...groups.values()];
}
