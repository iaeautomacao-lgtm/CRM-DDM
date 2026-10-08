// ============================================================
// Contrato de permissões para o front (PRD 20, fase 20.10, seção 8).
//
// MÓDULO PURO — monta as respostas de GET /api/me/permissions e
// GET /api/account/permission-catalog a partir do que o servidor já decide
// (getCurrentAccount().permissions e o catálogo). NÃO decide nada novo: o front só consome.
// ============================================================

import { ROUTE_ALLOWLIST, canAccessRoute } from "../role-utils";
import { PERMISSION_CATALOG, PERMISSIONS, can, type Permission } from "./permissions";
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
    /** null enquanto só existem papéis de sistema (a linha em account_roles ainda não é lida aqui). */
    id: string | null;
    key: AccountRole;
    name: string;
    kind: "system" | "custom";
    /** Sistema: owner 5 … viewer 1. */
    rank: number;
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
      id: null,
      key: ctx.role,
      name: SYSTEM_ROLE_NAMES[ctx.role],
      kind: "system",
      rank: ACCOUNT_ROLES.indexOf(ctx.role) + 1,
    },
    permissions: PERMISSIONS.filter(has),
    scopes: {
      // Conversas: sem escopo amplo nem de equipe = só as dele + fila (operador).
      inbox: scopeOf(has, "conversations.scope_all", "conversations.scope_team", "own"),
      monitoring: scopeOf(has, "monitoring.view_all", "monitoring.view_team", "none"),
      reports: scopeOf(has, "reports.view_all", "reports.view_team", "none"),
      intelligence: scopeOf(has, "intelligence.scope_account", "intelligence.use", "none"),
    },
    // Páginas com gate que o papel acessa hoje (ROUTE_ALLOWLIST); o front deixa de duplicar a tabela.
    pages: Object.keys(ROUTE_ALLOWLIST).filter((prefix) => canAccessRoute(ctx.role, prefix)),
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
      grantable: !def.ownerOnly,
      dependsOn: [...(def.dependsOn ?? [])],
    });
  }
  return [...groups.values()];
}
