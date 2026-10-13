// Lógica pura do editor de cargos (sistema e personalizados) no navegador. Só importa módulos puros de auth: NÃO importar
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
  // TASK5-CARGOS (campos opcionais: um servidor mais antigo não os envia; o front cai na regra por nível).
  /** Posso ajustar permissões/nome (sistema: só abaixo de mim; nunca o meu; nunca o proprietário). */
  editable?: boolean;
  /** Posso convidar/atribuir este cargo (abaixo de mim e só com permissões que eu tenho). */
  assignable?: boolean;
  /** Personalizado editável. */
  deletable?: boolean;
  /** Cargo de sistema ajustado nesta organização. */
  customized?: boolean;
  /** Sistema: o padrão global (para comparar e restaurar). Personalizado: null. */
  default_permissions?: string[] | null;
  /** Sistema = rank; personalizado = min(rank do compat, 3) + 0,5. Abaixo de mim = nível menor que o meu. */
  level?: number;
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
export function selectWithDependencies(
  selected: ReadonlySet<string>,
  key: string,
  catalog: ReadonlyMap<string, CatalogPermission>,
  /** Quem edita só concede o que tem: permissão fora de `allowed` não é marcada (nem como dependência). */
  allowed: (permission: string) => boolean = () => true,
): Set<string> {
  // Só marca se a permissão E todas as dependências (em cascata) puderem ser concedidas; senão o servidor recusaria o conjunto.
  const toAdd = new Set<string>();
  const collect = (k: string, trail: ReadonlySet<string>): boolean => {
    if (selected.has(k) || toAdd.has(k)) return true;
    if (trail.has(k)) return true; // ciclo: já está sendo tratado acima
    const def = catalog.get(k);
    if (!def || blockedReason(def) || !allowed(k)) return false;
    const nextTrail = new Set(trail).add(k);
    for (const dep of def.dependsOn) if (!collect(dep, nextTrail)) return false;
    toAdd.add(k);
    return true;
  };
  if (!collect(key, new Set())) return new Set(selected);
  return new Set([...selected, ...toAdd]);
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
  name_taken: "Já existe um cargo com esse nome.",
  limit_reached: "A organização já tem o máximo de cargos personalizados.",
  role_in_use: "Este cargo está em uso. Troque o cargo dos membros antes de apagar.",
  forbidden: "Você não tem permissão para fazer isso.",
  role_level: "Você só pode mexer em cargos abaixo do seu (não no seu próprio, nem em cargos do mesmo nível ou acima).",
  not_found: "Cargo ou membro não encontrado.",
  unavailable: "Cargos personalizados ainda não estão disponíveis nesta organização.",
  invalid: "Dados inválidos.",
};

const PERMISSION_ERROR: Record<string, string> = {
  unknown_permission: "permissão desconhecida",
  owner_only: "só o proprietário pode ter",
  not_grantable: "ainda não disponível para papéis personalizados",
  missing_dependency: "falta uma permissão da qual ela depende",
};

/** Mensagem em português para o corpo de erro das rotas de papéis. */
export function roleErrorMessage(
  payload: unknown,
  fallback = "Não foi possível concluir.",
  /** Opcional: traduz a chave de uma permissão para o rótulo do catálogo. */
  labelOf: (permission: string) => string = (p) => p,
): string {
  const p = (payload ?? {}) as { error?: unknown; code?: unknown; members?: unknown; errors?: unknown; permissions?: unknown };
  const code = typeof p.code === "string" ? p.code : "";
  if (code === "role_in_use" && typeof p.members === "number") {
    return `Este cargo está em uso por ${p.members} ${p.members === 1 ? "membro" : "membros"}. Troque o cargo deles antes de apagar.`;
  }
  if (code === "escalation" && Array.isArray(p.permissions) && p.permissions.length > 0) {
    const list = (p.permissions as unknown[]).filter((x): x is string => typeof x === "string").map(labelOf).join(", ");
    return `Você não pode conceder permissões que não tem: ${list}.`;
  }
  if (code === "invalid_permissions" && Array.isArray(p.errors) && p.errors.length > 0) {
    const first = p.errors[0] as { code?: string; permission?: string };
    const why = PERMISSION_ERROR[first.code ?? ""] ?? "inválida";
    return `Permissão ${first.permission ?? ""}: ${why}.`;
  }
  if (CODE_MESSAGE[code]) return CODE_MESSAGE[code];
  return typeof p.error === "string" && p.error ? p.error : fallback;
}

// ── Hierarquia: "só abaixo de você" ─────────────────────────────────────

/** Nível do usuário logado (role.level; sem ele, o rank). */
export function myLevel(me: { role: { rank: number; level?: number } } | null | undefined): number {
  return me ? me.role.level ?? me.role.rank : 0;
}

/** Nível do cargo (level; sem ele, o rank). */
export function levelOf(role: Pick<RoleItem, "rank" | "level">): number {
  return role.level ?? role.rank;
}

/**
 * Cargos que posso convidar/atribuir: o servidor diz (`assignable`); sem o campo, vale a regra por nível
 * (nunca o proprietário, e só nível menor que o meu).
 */
export function assignableRoles(roles: readonly RoleItem[], level: number): RoleItem[] {
  return roles.filter((r) => r.assignable ?? (r.key !== "owner" && levelOf(r) < level));
}

export type ReadOnlyReason = "own" | "level" | "owner" | null;

/** Por que o cargo está só em leitura para mim (null = posso editar). */
export function readOnlyReason(role: RoleItem, level: number, isOwn: boolean): ReadOnlyReason {
  const editable = role.editable ?? (role.key !== "owner" && levelOf(role) < level);
  if (editable) return null;
  if (role.key === "owner" && role.kind === "system") return "owner";
  if (isOwn) return "own";
  return "level";
}

export const READ_ONLY_TEXT: Record<Exclude<ReadOnlyReason, null>, string> = {
  own: "Este é o seu cargo: você não edita o próprio cargo.",
  level: "Este cargo é do seu nível ou acima: você só edita cargos abaixo do seu.",
  owner: "O proprietário tem sempre todas as permissões e não é editável.",
};

/** O cargo de sistema difere do padrão (mesmo conjunto de permissões = sem ajuste)? */
export function differsFromDefault(role: Pick<RoleItem, "permissions" | "default_permissions">): boolean {
  if (!role.default_permissions) return false;
  const a = [...role.permissions].sort().join("|");
  const b = [...role.default_permissions].sort().join("|");
  return a !== b;
}

/** Permissões do catálogo que EU não tenho (não posso conceder): ficam desabilitadas, com explicação. */
export function lacksPermission(key: string, mine: ReadonlySet<string>): boolean {
  return !mine.has(key);
}
