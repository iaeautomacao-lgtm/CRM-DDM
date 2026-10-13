import "server-only";
// PRD 20 — papel personalizado (migrations 312/313). Servidor, service role, sempre escopado pela organização.
//
// Só o proprietário cria, edita, apaga e atribui (roles.manage na rota; o banco confere de novo). O TS valida antes
// (validateCustomRolePermissions) para devolver 400 com a lista de erros sem ir ao banco; o banco é a fonte de verdade.
// A auditoria vem das triggers da 248 (role.created/updated/deleted, role.permissions_changed, member.role_changed),
// com o ator dos cabeçalhos x-audit-* do cliente admin.

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  MAX_CUSTOM_ROLES,
  SYSTEM_ROLE_PERMISSIONS,
  validateCustomRolePermissions,
  type RolePermissionError,
} from "@/lib/auth/permissions";
import { isAccountRole, type AccountRole } from "@/lib/auth/roles";

type Db = Pick<SupabaseClient, "rpc" | "from">;

export type CustomRoleErrorCode =
  | "forbidden"
  | "not_found"
  | "invalid"
  | "invalid_permissions"
  | "name_taken"
  | "limit_reached"
  | "role_in_use"
  | "unavailable"
  | "internal";

export class CustomRoleError extends Error {
  constructor(
    message: string,
    public status: 400 | 403 | 404 | 409 | 500 | 503,
    public code: CustomRoleErrorCode,
    public extra: { errors?: RolePermissionError[]; members?: number } = {},
  ) {
    super(message);
  }
}

export interface RoleView {
  id: string;
  key: string;
  name: string;
  description: string | null;
  kind: "system" | "custom";
  /** Sistema: owner 5 … viewer 1. Personalizado: o rank do compat_role. */
  rank: number;
  /** Papel de sistema equivalente no acesso direto aos dados (RLS) — o editor mostra o aviso. */
  compat_role: AccountRole;
  permissions: string[];
  member_count: number;
  member_ids: string[];
  created_at: string | null;
  updated_at: string | null;
}

export interface RolesList {
  roles: RoleView[];
  limits: { max_custom_roles: number; custom_roles: number };
}

const MISSING_FN = new Set(["42883", "PGRST202"]);

function mapRpcError(err: { code?: string; message?: string; details?: string | null }): CustomRoleError {
  const message = err.message ?? "";
  switch (err.code) {
    case "42501":
      return new CustomRoleError(message || "Só o proprietário gerencia papéis personalizados.", 403, "forbidden");
    case "P0002":
      return new CustomRoleError(message || "Não encontrado nesta organização.", 404, "not_found");
    case "22023": {
      let errors: RolePermissionError[] | undefined;
      try {
        const parsed: unknown = err.details ? JSON.parse(err.details) : undefined;
        if (Array.isArray(parsed)) errors = parsed as RolePermissionError[];
      } catch {
        errors = undefined;
      }
      return errors
        ? new CustomRoleError(message, 400, "invalid_permissions", { errors })
        : new CustomRoleError(message || "Dados inválidos.", 400, "invalid");
    }
    case "23505":
      return new CustomRoleError(message || "Já existe um papel com esse nome.", 409, "name_taken");
    case "54000":
      return new CustomRoleError(message || `Limite de ${MAX_CUSTOM_ROLES} papéis personalizados atingido.`, 409, "limit_reached");
    case "55006": {
      const members = Number.parseInt(err.details ?? "", 10);
      return new CustomRoleError(message || "O papel está em uso.", 409, "role_in_use", Number.isFinite(members) ? { members } : {});
    }
    default:
      if (err.code && MISSING_FN.has(err.code)) {
        return new CustomRoleError("Papéis personalizados indisponíveis: aplique as migrations 312 e 313.", 503, "unavailable");
      }
      console.error("[custom-roles] erro inesperado do banco:", err);
      return new CustomRoleError("Não foi possível salvar o papel.", 500, "internal");
  }
}

// ── Entrada ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface RoleInput {
  name?: string;
  description?: string;
  permissions?: string[];
}

/** Lê e valida o corpo (POST exige nome e permissões; PATCH aceita qualquer subconjunto, ao menos um campo). */
export function parseRoleInput(body: unknown, mode: "create" | "update"): RoleInput {
  if (!body || typeof body !== "object") throw new CustomRoleError("Corpo inválido.", 400, "invalid");
  const b = body as Record<string, unknown>;
  const out: RoleInput = {};
  if (b.name !== undefined) {
    if (typeof b.name !== "string") throw new CustomRoleError("'name' deve ser texto.", 400, "invalid");
    out.name = b.name;
  }
  if (b.description !== undefined && b.description !== null) {
    if (typeof b.description !== "string") throw new CustomRoleError("'description' deve ser texto.", 400, "invalid");
    out.description = b.description;
  } else if (b.description === null && mode === "update") {
    out.description = ""; // null limpa
  }
  if (b.permissions !== undefined) {
    if (!Array.isArray(b.permissions) || b.permissions.some((p) => typeof p !== "string")) {
      throw new CustomRoleError("'permissions' deve ser uma lista de chaves.", 400, "invalid");
    }
    out.permissions = [...new Set(b.permissions as string[])];
  }
  if (mode === "create") {
    if (!out.name?.trim()) throw new CustomRoleError("Informe o nome do papel.", 400, "invalid");
    if (!out.permissions) throw new CustomRoleError("Informe as permissões do papel.", 400, "invalid");
  } else if (out.name === undefined && out.description === undefined && out.permissions === undefined) {
    throw new CustomRoleError("Nada para alterar: envie name, description e/ou permissions.", 400, "invalid");
  }
  if (out.name !== undefined && (!out.name.trim() || out.name.trim().length > 80)) {
    throw new CustomRoleError("O nome do papel deve ter de 1 a 80 caracteres.", 400, "invalid");
  }
  if (out.description !== undefined && out.description.length > 300) {
    throw new CustomRoleError("A descrição deve ter até 300 caracteres.", 400, "invalid");
  }
  if (out.permissions) {
    if (out.permissions.length === 0) throw new CustomRoleError("Escolha ao menos uma permissão.", 400, "invalid");
    const errors = validateCustomRolePermissions(out.permissions);
    if (errors.length > 0) {
      throw new CustomRoleError("Permissões inválidas para um papel personalizado.", 400, "invalid_permissions", { errors });
    }
  }
  return out;
}

// ── Operações ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export async function createCustomRole(db: Db, input: { accountId: string; actorId: string } & RoleInput) {
  const { data, error } = await db.rpc("create_custom_role", {
    p_account: input.accountId,
    p_actor: input.actorId,
    p_name: input.name ?? "",
    p_description: input.description ?? null,
    p_permissions: input.permissions ?? [],
  });
  if (error) throw mapRpcError(error);
  return data as { id: string; key: string; compat_role: AccountRole };
}

export async function updateCustomRole(db: Db, input: { accountId: string; actorId: string; roleId: string } & RoleInput) {
  const { data, error } = await db.rpc("update_custom_role", {
    p_account: input.accountId,
    p_actor: input.actorId,
    p_role: input.roleId,
    p_name: input.name ?? null,
    p_description: input.description ?? null,
    p_permissions: input.permissions ?? null,
  });
  if (error) throw mapRpcError(error);
  return data as { id: string; compat_role: AccountRole; previous_compat_role: AccountRole; members_updated: number };
}

export async function deleteCustomRole(db: Db, input: { accountId: string; actorId: string; roleId: string }) {
  const { data, error } = await db.rpc("delete_custom_role", {
    p_account: input.accountId,
    p_actor: input.actorId,
    p_role: input.roleId,
  });
  if (error) throw mapRpcError(error);
  return data as { id: string; name: string };
}

export async function assignMemberRole(db: Db, input: { accountId: string; actorId: string; targetId: string; roleId: string }) {
  const { data, error } = await db.rpc("assign_member_role", {
    p_account: input.accountId,
    p_actor: input.actorId,
    p_target: input.targetId,
    p_role: input.roleId,
  });
  if (error) throw mapRpcError(error);
  return data as { previous_role_id: string | null; role_id: string; compat_role: AccountRole };
}

/** O membro tem papel personalizado? (a troca de papel pela rota antiga, de admin, não pode tirá-lo do personalizado). */
export async function memberHasCustomRole(db: Db, accountId: string, userId: string): Promise<boolean> {
  const { data, error } = await db
    .from("profiles")
    .select("role_id")
    .eq("account_id", accountId)
    .eq("user_id", userId)
    .limit(1);
  if (error) throw mapRpcError(error);
  const roleId = (data?.[0] as { role_id?: string | null } | undefined)?.role_id;
  if (!roleId) return false;
  const role = await db.from("account_roles").select("kind").eq("id", roleId).limit(1);
  if (role.error) throw mapRpcError(role.error);
  return (role.data?.[0] as { kind?: string } | undefined)?.kind === "custom";
}

// ── Leitura ───────────────────────────────────────────────────────────────────────────────────────────────────────────

interface RoleRow {
  id: string;
  account_id: string | null;
  key: string;
  name: string;
  description: string | null;
  kind: "system" | "custom";
  rank: number;
  compat_role: string;
  created_at: string | null;
  updated_at: string | null;
}

/** Papéis de sistema + personalizados da organização, com permissões e membros. Sistema primeiro (rank desc), depois por nome. */
export async function listRoles(db: Db, accountId: string): Promise<RolesList> {
  const roles = await db
    .from("account_roles")
    .select("id, account_id, key, name, description, kind, rank, compat_role, created_at, updated_at")
    .or(`account_id.is.null,account_id.eq.${accountId}`);
  if (roles.error) throw mapRpcError(roles.error);
  const rows = (roles.data ?? []) as RoleRow[];
  const customIds = rows.filter((r) => r.kind === "custom").map((r) => r.id);

  const perms = new Map<string, string[]>();
  if (customIds.length > 0) {
    const rp = await db.from("role_permissions").select("role_id, permission").in("role_id", customIds);
    if (rp.error) throw mapRpcError(rp.error);
    for (const row of (rp.data ?? []) as { role_id: string; permission: string }[]) {
      perms.set(row.role_id, [...(perms.get(row.role_id) ?? []), row.permission]);
    }
  }

  const members = new Map<string, string[]>();
  const profiles = await db.from("profiles").select("user_id, role_id").eq("account_id", accountId);
  if (profiles.error) throw mapRpcError(profiles.error);
  for (const p of (profiles.data ?? []) as { user_id: string; role_id: string | null }[]) {
    if (p.role_id) members.set(p.role_id, [...(members.get(p.role_id) ?? []), p.user_id]);
  }

  const views: RoleView[] = rows
    .filter((r) => isAccountRole(r.compat_role) && (r.kind === "custom" || isAccountRole(r.key)))
    .map((r) => ({
      id: r.id,
      key: r.key,
      name: r.name,
      description: r.description,
      kind: r.kind,
      rank: r.rank,
      compat_role: r.compat_role as AccountRole,
      // Sistema: o conjunto que o servidor aplica (permissions.ts); personalizado: o do banco.
      permissions:
        r.kind === "system" ? [...SYSTEM_ROLE_PERMISSIONS[r.key as AccountRole]].sort() : (perms.get(r.id) ?? []).sort(),
      member_count: members.get(r.id)?.length ?? 0,
      member_ids: members.get(r.id) ?? [],
      created_at: r.created_at,
      updated_at: r.updated_at,
    }))
    .sort((a, b) =>
      a.kind !== b.kind ? (a.kind === "system" ? -1 : 1) : a.kind === "system" ? b.rank - a.rank : a.name.localeCompare(b.name, "pt-BR"),
    );

  return { roles: views, limits: { max_custom_roles: MAX_CUSTOM_ROLES, custom_roles: customIds.length } };
}
