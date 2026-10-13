import "server-only";
// TASK5 (migrations 318/319): cargo de um convite (individual ou em lote). Aceita o cargo escolhido (role_id: sistema ou
// personalizado da organização) ou, no formato antigo, o papel de sistema (`role`). Sempre passa por
// wacrm.role_assignable: só cargos ABAIXO do nível de quem convida e sem escalada (o admin não convida admin).
// Devolve o role_id (gravado no convite e aplicado no aceite) e o compat efetivo (vai na coluna `role`, obrigatória).

import type { SupabaseClient } from "@supabase/supabase-js";

import type { AccountRole } from "@/lib/auth/roles";
import { CustomRoleError, roleAssignable } from "./custom-roles";

type Db = Pick<SupabaseClient, "rpc" | "from">;

export async function resolveInviteRole(
  db: Db,
  input: { accountId: string; actorId: string; roleId: string | null; role: AccountRole | null },
): Promise<{ roleId: string; role: AccountRole }> {
  let roleId = input.roleId;
  if (!roleId) {
    if (!input.role || input.role === "owner") {
      throw new CustomRoleError("Escolha o cargo do convite.", 400, "invalid");
    }
    const { data, error } = await db.from("account_roles").select("id").is("account_id", null).eq("key", input.role).limit(1);
    if (error || !data?.[0]) throw new CustomRoleError("Cargo não encontrado.", 404, "not_found");
    roleId = (data[0] as { id: string }).id;
  }
  const role = await roleAssignable(db, { accountId: input.accountId, actorId: input.actorId, roleId });
  return { roleId, role };
}
