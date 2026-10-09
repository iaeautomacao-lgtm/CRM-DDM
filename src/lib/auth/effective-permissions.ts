// Permissões efetivas do membro (PRD 20, papel personalizado — migrations 312/313).
//
// Papel de SISTEMA: permissionsForRole(account_role) — nada muda para quem não usa personalizado (e não custa consulta:
// os ids dos papéis de sistema ficam em cache no processo; eles nunca mudam).
// Papel PERSONALIZADO: role_permissions do role_id, só chaves concedíveis (nunca ownerOnly/future, mesmo que o banco
// tenha), expandidas pelas implicações de escopo. Fail-closed: papel que não carrega, de outra organização ou com tipo
// estranho → ForbiddenError (o chamador trata como "sem contexto").
//
// `role` (account_role = compat_role) continua sendo o que o RLS e as páginas usam nesta entrega.

import type { SupabaseClient } from "@supabase/supabase-js";

import { expandPermissions, isGrantableToCustomRole, permissionsForRole, type Permission } from "./permissions";
import type { AccountRole } from "./roles";

export interface CustomRoleInfo {
  id: string;
  key: string;
  name: string;
}

export interface EffectivePermissions {
  permissions: ReadonlySet<Permission>;
  customRole: CustomRoleInfo | null;
}

type Db = Pick<SupabaseClient, "from">;

let systemRoleIds: Promise<ReadonlySet<string>> | null = null;

async function loadSystemRoleIds(db: Db): Promise<ReadonlySet<string>> {
  if (!systemRoleIds) {
    systemRoleIds = (async () => {
      const { data, error } = await db.from("account_roles").select("id").is("account_id", null);
      if (error) throw error;
      return new Set(((data ?? []) as { id: string }[]).map((r) => r.id));
    })();
    // Falha não fica em cache: a próxima requisição tenta de novo.
    systemRoleIds.catch(() => {
      systemRoleIds = null;
    });
  }
  return systemRoleIds;
}

/** Só para testes. */
export function resetSystemRoleIdsCache(): void {
  systemRoleIds = null;
}

export class RoleLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoleLoadError";
  }
}

export async function resolveEffectivePermissions(
  db: Db,
  profile: { account_id: string; account_role: AccountRole; role_id?: string | null },
): Promise<EffectivePermissions> {
  const system: EffectivePermissions = { permissions: permissionsForRole(profile.account_role), customRole: null };
  const roleId = profile.role_id;
  if (!roleId) return system;

  try {
    if ((await loadSystemRoleIds(db)).has(roleId)) return system;
  } catch (err) {
    // Sem a lista (ex.: banco sem a 240): cai na consulta direta abaixo, que decide sozinha.
    console.error("[effective-permissions] falha ao carregar os papéis de sistema:", err);
  }

  const role = await db.from("account_roles").select("id, key, name, kind, account_id").eq("id", roleId).limit(1);
  if (role.error) throw new RoleLoadError(`papel ${roleId}: ${role.error.message}`);
  const row = (role.data?.[0] ?? null) as { id: string; key: string; name: string; kind: string; account_id: string | null } | null;
  if (!row) throw new RoleLoadError(`papel ${roleId} não encontrado`);
  if (row.kind === "system" && row.account_id === null) return system;
  if (row.kind !== "custom" || row.account_id !== profile.account_id) {
    throw new RoleLoadError(`papel ${roleId} não pertence à organização do membro`);
  }

  const rp = await db.from("role_permissions").select("permission").eq("role_id", roleId);
  if (rp.error) throw new RoleLoadError(`permissões do papel ${roleId}: ${rp.error.message}`);
  const granted = ((rp.data ?? []) as { permission: string }[]).map((r) => r.permission).filter(isGrantableToCustomRole);
  return {
    permissions: expandPermissions(granted),
    customRole: { id: row.id, key: row.key, name: row.name },
  };
}
