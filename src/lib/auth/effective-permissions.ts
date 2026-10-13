// Permissões efetivas do membro (PRD 20 + TASK5 — migrations 312/313/318).
//
// Cargo de SISTEMA: o padrão de permissions.ts, ou o AJUSTE da organização (wacrm.account_role_overrides, 318) se houver.
//   Os ids dos cargos de sistema ficam em cache no processo (nunca mudam); o ajuste é uma consulta por requisição (PK).
// Cargo PERSONALIZADO: role_permissions do role_id, só chaves concedíveis (nunca ownerOnly/future/não concedível, mesmo que
//   o banco tenha), expandidas pelas implicações de escopo.
// Fail-closed: cargo que não carrega, de outra organização ou com tipo estranho → RoleLoadError (o chamador trata como
// "sem contexto"). `role` (account_role = compat) continua sendo o que o RLS legado e as páginas usam.
//
// Nível (regra "só abaixo de você", igual a wacrm.role_level): sistema = rank 5..1; personalizado = min(rank do compat, 3) + 0,5.

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  expandPermissions,
  isGrantableToCustomRole,
  isPermission,
  permissionDef,
  permissionsForRole,
  type Permission,
} from "./permissions";
import { ACCOUNT_ROLES, isAccountRole, type AccountRole } from "./roles";

export interface CustomRoleInfo {
  id: string;
  key: string;
  name: string;
}

export interface EffectivePermissions {
  permissions: ReadonlySet<Permission>;
  customRole: CustomRoleInfo | null;
  /** Cargo (account_roles.id) do membro; null em perfil antigo sem role_id. */
  roleId: string | null;
  /** Nível do cargo (sistema 5..1; personalizado até 3,5). */
  level: number;
  /** Cargo de sistema com ajuste nesta organização (318). */
  customized: boolean;
  /** Chave do cargo de SISTEMA do membro (null no personalizado). Difere de account_role quando o ajuste muda o compat. */
  systemKey: AccountRole | null;
}

type Db = Pick<SupabaseClient, "from">;

/** Rank do cargo de sistema (viewer 1 … owner 5). */
export function systemRank(role: AccountRole): number {
  return ACCOUNT_ROLES.indexOf(role) + 1;
}

/** Nível de um cargo — espelho de wacrm.role_level (318). */
export function roleLevel(kind: "system" | "custom", rank: number): number {
  return kind === "system" ? rank : Math.min(rank, 3) + 0.5;
}

let systemRoles: Promise<ReadonlyMap<string, AccountRole>> | null = null;

async function loadSystemRoles(db: Db): Promise<ReadonlyMap<string, AccountRole>> {
  if (!systemRoles) {
    systemRoles = (async () => {
      const { data, error } = await db.from("account_roles").select("id, key").is("account_id", null);
      if (error) throw error;
      const map = new Map<string, AccountRole>();
      for (const r of (data ?? []) as { id: string; key: string }[]) if (isAccountRole(r.key)) map.set(r.id, r.key);
      return map;
    })();
    // Falha não fica em cache: a próxima requisição tenta de novo.
    systemRoles.catch(() => {
      systemRoles = null;
    });
  }
  return systemRoles;
}

/** Só para testes. */
export function resetSystemRoleIdsCache(): void {
  systemRoles = null;
}

export class RoleLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoleLoadError";
  }
}

/** Banco sem a 318 (tabela ausente): vale o padrão. */
const MISSING_TABLE = new Set(["42P01", "PGRST205"]);

async function systemEffective(
  db: Db,
  accountId: string,
  roleId: string,
  key: AccountRole,
): Promise<EffectivePermissions> {
  const base = { customRole: null, roleId, level: systemRank(key), systemKey: key };
  const { data, error } = await db
    .from("account_role_overrides")
    .select("permissions")
    .eq("account_id", accountId)
    .eq("role_id", roleId)
    .limit(1);
  if (error) {
    if (MISSING_TABLE.has((error as { code?: string }).code ?? "")) {
      return { ...base, permissions: permissionsForRole(key), customized: false };
    }
    throw new RoleLoadError(`ajuste do cargo ${roleId}: ${error.message}`);
  }
  const row = (data?.[0] ?? null) as { permissions: string[] } | null;
  if (!row) return { ...base, permissions: permissionsForRole(key), customized: false };
  // Ajuste de cargo de sistema: só chaves do catálogo e nunca ownerOnly (o banco já garante; defesa em profundidade).
  const granted = row.permissions.filter((p): p is Permission => isPermission(p) && !permissionDef(p).ownerOnly);
  return { ...base, permissions: expandPermissions(granted), customized: true };
}

export async function resolveEffectivePermissions(
  db: Db,
  profile: { account_id: string; account_role: AccountRole; role_id?: string | null },
): Promise<EffectivePermissions> {
  const roleId = profile.role_id ?? null;
  if (!roleId) {
    return {
      permissions: permissionsForRole(profile.account_role),
      customRole: null,
      roleId: null,
      level: systemRank(profile.account_role),
      customized: false,
      systemKey: profile.account_role,
    };
  }

  try {
    const key = (await loadSystemRoles(db)).get(roleId);
    if (key === "owner") {
      return { permissions: permissionsForRole("owner"), customRole: null, roleId, level: 5, customized: false, systemKey: "owner" };
    }
    if (key) return await systemEffective(db, profile.account_id, roleId, key);
  } catch (err) {
    if (err instanceof RoleLoadError) throw err;
    // Sem a lista (ex.: banco sem a 240): cai na consulta direta abaixo, que decide sozinha.
    console.error("[effective-permissions] falha ao carregar os cargos de sistema:", err);
  }

  const role = await db.from("account_roles").select("id, key, name, kind, account_id, rank").eq("id", roleId).limit(1);
  if (role.error) throw new RoleLoadError(`papel ${roleId}: ${role.error.message}`);
  const row = (role.data?.[0] ?? null) as
    | { id: string; key: string; name: string; kind: string; account_id: string | null; rank: number }
    | null;
  if (!row) throw new RoleLoadError(`papel ${roleId} não encontrado`);
  if (row.kind === "system" && row.account_id === null && isAccountRole(row.key)) {
    if (row.key === "owner") {
      return { permissions: permissionsForRole("owner"), customRole: null, roleId, level: 5, customized: false, systemKey: "owner" };
    }
    return systemEffective(db, profile.account_id, roleId, row.key);
  }
  if (row.kind !== "custom" || row.account_id !== profile.account_id) {
    throw new RoleLoadError(`papel ${roleId} não pertence à organização do membro`);
  }

  const rp = await db.from("role_permissions").select("permission").eq("role_id", roleId);
  if (rp.error) throw new RoleLoadError(`permissões do papel ${roleId}: ${rp.error.message}`);
  const granted = ((rp.data ?? []) as { permission: string }[]).map((r) => r.permission).filter(isGrantableToCustomRole);
  return {
    permissions: expandPermissions(granted),
    customRole: { id: row.id, key: row.key, name: row.name },
    roleId,
    level: roleLevel("custom", row.rank ?? 2),
    customized: false,
    systemKey: null,
  };
}
