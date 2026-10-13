import "server-only";
// PRD 20 + TASK5 — cargos (migrations 312/313/318/319). Servidor, service role, sempre escopado pela organização.
//
// Quem tem roles.manage (admin e acima) cria e edita personalizados, ajusta as permissões dos cargos de sistema ABAIXO do
// seu nível por organização (com restaurar padrão) e atribui cargos. Sem escalada (decisão do dono 13/10): o editor só
// adiciona o que tem; as permissões concedíveis que ele não tem ficam TRAVADAS no estado atual do cargo (não adiciona nem
// remove). O banco confere tudo de novo (318). O TS valida antes
// (validateCustomRolePermissions) para devolver 400 com a lista de erros sem ir ao banco; o banco é a fonte de verdade.
// A auditoria vem das triggers da 248 (role.created/updated/deleted, role.permissions_changed, member.role_changed),
// com o ator dos cabeçalhos x-audit-* do cliente admin.

import type { SupabaseClient } from "@supabase/supabase-js";

import { roleLevel } from "@/lib/auth/effective-permissions";
import {
  MAX_CUSTOM_ROLES,
  PERMISSIONS,
  SYSTEM_ROLE_PERMISSIONS,
  can,
  isGrantableToCustomRole,
  validateCustomRolePermissions,
  type RolePermissionError,
} from "@/lib/auth/permissions";
import { ACCOUNT_ROLES, isAccountRole, type AccountRole } from "@/lib/auth/roles";

type Db = Pick<SupabaseClient, "rpc" | "from">;

export type CustomRoleErrorCode =
  | "forbidden"
  | "escalation"
  | "locked"
  | "role_level"
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
    public extra: { errors?: RolePermissionError[]; members?: number; permissions?: string[] } = {},
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
  /** Conjunto EFETIVO na organização (com o ajuste, se houver). */
  permissions: string[];
  /** Sistema: o padrão global (para comparar e restaurar). Personalizado: null. */
  default_permissions: string[] | null;
  /** Cargo de sistema ajustado nesta organização. */
  customized: boolean;
  /** Nível (sistema 5..1; personalizado até 3,5). */
  level: number;
  /** Posso ajustar as permissões (e, no personalizado, nome/descrição). */
  editable: boolean;
  /** Posso convidar/atribuir este cargo (regra de nível). */
  assignable: boolean;
  /** Posso apagar (personalizado editável). */
  deletable: boolean;
  member_count: number;
  member_ids: string[];
  created_at: string | null;
  updated_at: string | null;
}

/** Quem está olhando a lista (de getCurrentAccount). */
export interface RoleActor {
  role: AccountRole;
  permissions: ReadonlySet<string>;
  roleId?: string | null;
  roleLevel?: number;
}

export interface RolesList {
  roles: RoleView[];
  limits: { max_custom_roles: number; custom_roles: number };
  /**
   * Permissões concedíveis que EU não tenho: no editor ficam desabilitadas e marcadas, no estado em que o cargo está
   * (não posso adicionar nem remover). Vazio para o proprietário.
   */
  locked_permissions: string[];
}

const MISSING_FN = new Set(["42883", "PGRST202"]);

function mapRpcError(err: { code?: string; message?: string; details?: string | null }): CustomRoleError {
  const message = err.message ?? "";
  switch (err.code) {
    case "42501": {
      // 318: DETAIL jsonb {"code":"escalation","permissions":[...]} | {"code":"role_level"} | {"code":"forbidden"}
      let detail: { code?: string; permissions?: string[] } = {};
      try {
        detail = err.details ? (JSON.parse(err.details) as typeof detail) : {};
      } catch {
        detail = {};
      }
      if (detail.code === "escalation") {
        return new CustomRoleError(message || "Você não pode conceder permissões que não tem.", 403, "escalation", {
          permissions: detail.permissions ?? [],
        });
      }
      if (detail.code === "locked") {
        return new CustomRoleError(message || "Você não pode remover permissões que não tem.", 403, "locked", {
          permissions: detail.permissions ?? [],
        });
      }
      if (detail.code === "role_level") {
        return new CustomRoleError(message || "Você só gere cargos abaixo do seu.", 403, "role_level");
      }
      return new CustomRoleError(message || "Você não pode gerir cargos.", 403, "forbidden");
    }
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

/** Ajusta as permissões de um cargo de SISTEMA nesta organização (318). */
export async function setSystemRolePermissions(
  db: Db,
  input: { accountId: string; actorId: string; roleId: string; permissions: string[] },
) {
  const { data, error } = await db.rpc("set_system_role_permissions", {
    p_account: input.accountId,
    p_actor: input.actorId,
    p_role: input.roleId,
    p_permissions: input.permissions,
  });
  if (error) throw mapRpcError(error);
  return data as { id: string; compat_role: AccountRole; previous_compat_role: AccountRole; members_updated: number; customized: true };
}

/** Restaura o padrão de um cargo de sistema nesta organização (318). */
export async function resetSystemRolePermissions(db: Db, input: { accountId: string; actorId: string; roleId: string }) {
  const { data, error } = await db.rpc("reset_system_role_permissions", {
    p_account: input.accountId,
    p_actor: input.actorId,
    p_role: input.roleId,
  });
  if (error) throw mapRpcError(error);
  return data as { id: string; compat_role: AccountRole; members_updated: number; customized: false };
}

/** O ator pode convidar/atribuir este cargo? Devolve o compat efetivo do cargo (vai no `role` do convite). */
export async function roleAssignable(db: Db, input: { accountId: string; actorId: string; roleId: string }): Promise<AccountRole> {
  const { data, error } = await db.rpc("role_assignable", {
    p_account: input.accountId,
    p_actor: input.actorId,
    p_role: input.roleId,
  });
  if (error) throw mapRpcError(error);
  if (!isAccountRole(data) || data === "owner") throw new CustomRoleError("Cargo inválido para convite.", 400, "invalid");
  return data;
}

/** Tipo do cargo (sistema ou personalizado da organização); null se não existe para esta organização. */
export async function roleKind(db: Db, accountId: string, roleId: string): Promise<"system" | "custom" | null> {
  const { data, error } = await db.from("account_roles").select("kind, account_id").eq("id", roleId).limit(1);
  if (error) throw mapRpcError(error);
  const row = (data?.[0] ?? null) as { kind: string; account_id: string | null } | null;
  if (!row) return null;
  if (row.kind === "system" && row.account_id === null) return "system";
  if (row.kind === "custom" && row.account_id === accountId) return "custom";
  return null;
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

/** Cargos de sistema + personalizados da organização, com permissões efetivas, membros e o que o ator pode fazer. */
export async function listRoles(db: Db, accountId: string, actor: RoleActor): Promise<RolesList> {
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

  const overrides = new Map<string, string[]>();
  const ov = await db.from("account_role_overrides").select("role_id, permissions").eq("account_id", accountId);
  // Banco sem a 318: sem ajustes.
  if (ov.error && !["42P01", "PGRST205"].includes((ov.error as { code?: string }).code ?? "")) throw mapRpcError(ov.error);
  for (const row of (ov.data ?? []) as { role_id: string; permissions: string[] }[]) overrides.set(row.role_id, row.permissions);

  const actorLevel = actor.roleLevel ?? ACCOUNT_ROLES.indexOf(actor.role) + 1;
  const isOwner = actor.role === "owner";
  const canManage = isOwner || can(actor, "roles.manage");
  const canInvite = isOwner || can(actor, "members.invite") || canManage;

  const members = new Map<string, string[]>();
  const profiles = await db.from("profiles").select("user_id, role_id").eq("account_id", accountId);
  if (profiles.error) throw mapRpcError(profiles.error);
  for (const p of (profiles.data ?? []) as { user_id: string; role_id: string | null }[]) {
    if (p.role_id) members.set(p.role_id, [...(members.get(p.role_id) ?? []), p.user_id]);
  }

  const views: RoleView[] = rows
    .filter((r) => isAccountRole(r.compat_role) && (r.kind === "custom" || isAccountRole(r.key)))
    .map((r) => {
      const isSystem = r.kind === "system";
      const defaults = isSystem ? [...SYSTEM_ROLE_PERMISSIONS[r.key as AccountRole]].sort() : null;
      const override = isSystem ? overrides.get(r.id) : undefined;
      // Sistema: o ajuste da organização ou o padrão (permissions.ts); personalizado: o do banco.
      const effective = (isSystem ? (override ?? defaults ?? []) : (perms.get(r.id) ?? [])).slice().sort();
      const level = roleLevel(r.kind, r.rank);
      const isOwnerRole = isSystem && r.key === "owner";
      const below = level < actorLevel && r.id !== actor.roleId && !isOwnerRole;
      const editable = canManage && below;
      return {
        id: r.id,
        key: r.key,
        name: r.name,
        description: r.description,
        kind: r.kind,
        rank: r.rank,
        compat_role: r.compat_role as AccountRole,
        permissions: effective,
        default_permissions: defaults,
        customized: Boolean(override),
        level,
        editable,
        assignable: canInvite && below,
        deletable: editable && !isSystem,
        member_count: members.get(r.id)?.length ?? 0,
        member_ids: members.get(r.id) ?? [],
        created_at: r.created_at,
        updated_at: r.updated_at,
      };
    })
    .sort((a, b) =>
      a.kind !== b.kind ? (a.kind === "system" ? -1 : 1) : a.kind === "system" ? b.rank - a.rank : a.name.localeCompare(b.name, "pt-BR"),
    );

  const lockedPermissions = isOwner ? [] : PERMISSIONS.filter((k) => isGrantableToCustomRole(k) && !actor.permissions.has(k));
  return {
    roles: views,
    limits: { max_custom_roles: MAX_CUSTOM_ROLES, custom_roles: customIds.length },
    locked_permissions: lockedPermissions,
  };
}
