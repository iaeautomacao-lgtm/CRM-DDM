// Lógica pura do editor de papel personalizado (navegador). Só importa módulos puros de auth: NÃO importar
// src/lib/roles/custom-roles.ts nem http.ts (são só de servidor — scripts/ci/server-only-modules.json).
import {
  compatRoleFor,
  isGrantableToCustomRole,
  validateCustomRolePermissions,
  type Permission,
} from "@/lib/auth/permissions";
import type { AccountRole } from "@/lib/auth/roles";

export const ROLE_NAME_MAX = 80;
export const ROLE_DESCRIPTION_MAX = 300;

/** Contrato de GET /api/account/roles (RoleView), repetido aqui para o front não importar o módulo de servidor. */
export interface RoleItem {
  id: string;
  key: string;
  name: string;
  description: string | null;
  kind: "system" | "custom";
  rank: number;
  compat_role: AccountRole;
  permissions: string[];
  member_count: number;
  member_ids: string[];
  created_at: string | null;
  updated_at: string | null;
}

export interface CatalogPermission {
  key: string;
  label: string;
  description: string;
  scope: "account" | "team" | "own" | "n/a";
  ownerOnly: boolean;
  grantable: boolean;
  dependsOn: string[];
}

export interface CatalogGroup {
  key: string;
  label: string;
  permissions: CatalogPermission[];
}

/** Por que uma permissão não pode ser marcada (null = pode). */
export function blockedReason(p: CatalogPermission): string | null {
  if (p.ownerOnly) return "Só o proprietário";
  if (!p.grantable) return "Ainda não disponível";
  return null;
}

/**
 * Marca uma permissão e, junto, tudo de que ela depende (o servidor recusa o conjunto sem as dependências e
 * não completa sozinho). A variante ampla cobre a estreita: se `reports.view_all` já está marcada, `reports.view_team` não precisa.
 */
export function selectWithDependencies(selected: ReadonlySet<string>, key: string, catalog: ReadonlyMap<string, CatalogPermission>): Set<string> {
  const next = new Set(selected);
  const visit = (k: string) => {
    if (next.has(k)) return;
    const def = catalog.get(k);
    if (!def || blockedReason(def)) return;
    next.add(k);
    for (const dep of def.dependsOn) visit(dep);
  };
  visit(key);
  return next;
}

/**
 * Desmarca uma permissão e tudo que dependia dela e ficaria sem a dependência (em cascata), usando a mesma
 * regra de validação do servidor (inclui "a ampla cobre a estreita").
 */
export function deselectWithDependents(selected: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(selected);
  next.delete(key);
  for (let guard = 0; guard < 50; guard += 1) {
    const broken = validateCustomRolePermissions([...next]).filter((e) => e.code === "missing_dependency");
    if (broken.length === 0) break;
    for (const e of broken) next.delete(e.permission);
  }
  return next;
}

/** Papel de sistema equivalente no acesso direto aos dados (mesma função do servidor). */
export function compatRoleOf(selected: Iterable<string>): AccountRole {
  return compatRoleFor([...selected].filter((k) => isGrantableToCustomRole(k)) as Permission[]);
}

export interface RoleFormErrors {
  name?: string;
  description?: string;
  permissions?: string;
}

export function validateRoleForm(input: { name: string; description: string; permissions: ReadonlySet<string> }): RoleFormErrors {
  const errors: RoleFormErrors = {};
  const name = input.name.trim();
  if (name.length < 1) errors.name = "Dê um nome ao papel.";
  else if (name.length > ROLE_NAME_MAX) errors.name = `O nome pode ter até ${ROLE_NAME_MAX} caracteres.`;
  if (input.description.trim().length > ROLE_DESCRIPTION_MAX) errors.description = `A descrição pode ter até ${ROLE_DESCRIPTION_MAX} caracteres.`;
  if (input.permissions.size < 1) errors.permissions = "Marque ao menos uma permissão.";
  return errors;
}

const CODE_MESSAGE: Record<string, string> = {
  name_taken: "Já existe um papel com esse nome.",
  limit_reached: "A organização já tem o máximo de papéis personalizados.",
  role_in_use: "Este papel está em uso. Troque o papel dos membros antes de apagar.",
  forbidden: "Só o proprietário pode fazer isso.",
  not_found: "Papel ou membro não encontrado.",
  unavailable: "Papéis personalizados ainda não estão disponíveis nesta organização.",
  invalid: "Dados inválidos.",
};

const PERMISSION_ERROR: Record<string, string> = {
  unknown_permission: "permissão desconhecida",
  owner_only: "só o proprietário pode ter",
  not_grantable: "ainda não disponível para papéis personalizados",
  missing_dependency: "falta uma permissão da qual ela depende",
};

/** Mensagem em português para o corpo de erro das rotas de papéis. */
export function roleErrorMessage(payload: unknown, fallback = "Não foi possível concluir."): string {
  const p = (payload ?? {}) as { error?: unknown; code?: unknown; members?: unknown; errors?: unknown };
  const code = typeof p.code === "string" ? p.code : "";
  if (code === "role_in_use" && typeof p.members === "number") {
    return `Este papel está em uso por ${p.members} ${p.members === 1 ? "membro" : "membros"}. Troque o papel deles antes de apagar.`;
  }
  if (code === "invalid_permissions" && Array.isArray(p.errors) && p.errors.length > 0) {
    const first = p.errors[0] as { code?: string; permission?: string };
    const why = PERMISSION_ERROR[first.code ?? ""] ?? "inválida";
    return `Permissão ${first.permission ?? ""}: ${why}.`;
  }
  if (CODE_MESSAGE[code]) return CODE_MESSAGE[code];
  return typeof p.error === "string" && p.error ? p.error : fallback;
}
