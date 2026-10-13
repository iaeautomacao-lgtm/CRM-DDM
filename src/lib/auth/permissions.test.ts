import { describe, expect, it } from "vitest";

import { ACCOUNT_ROLES } from "./roles";
import {
  PERMISSION_CATALOG,
  PERMISSIONS,
  SYSTEM_ROLE_PERMISSIONS,
  can,
  canAll,
  canAny,
  compatRoleFor,
  expandPermissions,
  isGrantableToCustomRole,
  isPermission,
  permissionDef,
  validateCustomRolePermissions,
  type Permission,
} from "./permissions";

describe("catálogo", () => {
  it("tem entre 55 e 75 chaves, todas no formato grupo.acao", () => {
    expect(PERMISSIONS.length).toBeGreaterThanOrEqual(55);
    expect(PERMISSIONS.length).toBeLessThanOrEqual(75);
    for (const key of PERMISSIONS) expect(key).toMatch(/^[a-z_]+(\.[a-z_]+)+$/);
  });

  it("toda permissão tem rótulo, descrição, grupo e ao menos um papel de sistema", () => {
    for (const key of PERMISSIONS) {
      const def = permissionDef(key);
      expect(def.label.length, key).toBeGreaterThan(2);
      expect(def.description.length, key).toBeGreaterThan(10);
      expect(def.group.length, key).toBeGreaterThan(2);
      expect(def.roles.length, key).toBeGreaterThan(0);
    }
  });

  it("dependências existem, não se repetem e não formam ciclo", () => {
    for (const key of PERMISSIONS) {
      const deps = permissionDef(key).dependsOn ?? [];
      expect(new Set(deps).size).toBe(deps.length);
      for (const dep of deps) {
        expect(isPermission(dep), `${key} depende de ${dep}`).toBe(true);
        expect(dep).not.toBe(key);
      }
    }
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (key: Permission) => {
      if (done.has(key)) return;
      expect(visiting.has(key), `ciclo em ${key}`).toBe(false);
      visiting.add(key);
      for (const dep of permissionDef(key).dependsOn ?? []) visit(dep as Permission);
      visiting.delete(key);
      done.add(key);
    };
    for (const key of PERMISSIONS) visit(key);
  });

  it("só o proprietário tem as permissões ownerOnly (e são exatamente estas 6)", () => {
    const ownerOnly = PERMISSIONS.filter((p) => permissionDef(p).ownerOnly).sort();
    expect(ownerOnly).toEqual([
      "account.delete",
      "campaigns.red_quality_override",
      "members.bulk_invite",
      "members.reset_password",
      "ownership.transfer",
      "roles.manage",
    ]);
    for (const p of ownerOnly) {
      for (const role of ACCOUNT_ROLES) expect(can({ role }, p), `${role} ${p}`).toBe(role === "owner");
    }
  });
});

describe("papéis de sistema", () => {
  it("cada conjunto satisfaz as próprias dependências", () => {
    for (const role of ACCOUNT_ROLES) {
      const set = SYSTEM_ROLE_PERMISSIONS[role];
      for (const p of set) {
        for (const dep of permissionDef(p).dependsOn ?? []) {
          expect(set.has(dep as Permission), `${role}: ${p} sem ${dep}`).toBe(true);
        }
      }
    }
  });

  it("owner tem TODAS as permissões, exceto receber atribuições (hoje só o papel Operador recebe handoff)", () => {
    const missing = PERMISSIONS.filter((p) => !SYSTEM_ROLE_PERMISSIONS.owner.has(p));
    expect(missing).toEqual(["inbox.receive_assignments"]);
  });

  it("a escada se mantém (owner ⊇ admin ⊇ supervisor ⊇ agent), com as exceções conhecidas", () => {
    const sets = ACCOUNT_ROLES.map((r) => [r, SYSTEM_ROLE_PERMISSIONS[r]] as const);
    const get = (r: string) => SYSTEM_ROLE_PERMISSIONS[r as keyof typeof SYSTEM_ROLE_PERMISSIONS];
    // exceções não monotônicas de hoje (preservadas de propósito):
    const exceptions: Record<string, Permission[]> = {
      // o operador recebe atribuição; supervisor/admin/owner não (engine.ts)
      agent: ["inbox.receive_assignments"],
      // o operador não vê o dashboard nem tem escopo amplo
      supervisor: ["conversations.scope_team"],
    };
    for (const [lower, higher] of [["agent", "supervisor"], ["supervisor", "admin"], ["admin", "owner"]] as const) {
      for (const p of get(lower)) {
        const excused = exceptions[lower]?.includes(p) ?? false;
        if (!excused) expect(get(higher).has(p), `${p} está em ${lower} mas não em ${higher}`).toBe(true);
      }
    }
    expect(sets).toHaveLength(5);
  });

  it("viewer não escreve: sem nenhuma permissão de inbox/edição/gestão", () => {
    for (const p of SYSTEM_ROLE_PERMISSIONS.viewer) {
      expect(p, p).toMatch(/\.(view|scope_all|scope_team)$/);
    }
  });
});

describe("can()", () => {
  it("usa o papel de sistema quando não há lista efetiva", () => {
    expect(can({ role: "admin" }, "campaigns.manage")).toBe(true);
    expect(can({ role: "agent" }, "campaigns.manage")).toBe(false);
  });

  it("a lista efetiva (papel personalizado) VALE sobre o papel de compatibilidade", () => {
    const subject = { role: "agent" as const, permissions: new Set<string>(["inbox.view", "inbox.reply", "automations.view"]) };
    expect(can(subject, "inbox.reply")).toBe(true);
    expect(can(subject, "inbox.close")).toBe(false); // agent teria, o personalizado não
    expect(can(subject, "campaigns.manage")).toBe(false);
  });

  it("chave fora do catálogo nega (fail-closed)", () => {
    expect(can({ role: "owner" }, "nao.existe" as Permission)).toBe(false);
  });

  it("canAny/canAll", () => {
    expect(canAny({ role: "agent" }, ["campaigns.manage", "inbox.reply"])).toBe(true);
    expect(canAll({ role: "agent" }, ["campaigns.manage", "inbox.reply"])).toBe(false);
    expect(canAll({ role: "agent" }, [])).toBe(true);
  });
});

describe("escopos e implicações", () => {
  it("ver tudo implica ver equipe", () => {
    expect([...expandPermissions(["reports.view_all"])].sort()).toEqual(["reports.view_all", "reports.view_team"]);
    expect(expandPermissions(["monitoring.view_all"]).has("monitoring.view_team")).toBe(true);
    expect(expandPermissions(["intelligence.scope_account"]).has("intelligence.use")).toBe(true);
    expect(expandPermissions(["conversations.scope_all"]).has("conversations.scope_team")).toBe(true);
  });

  it("não inventa permissão para quem só tem a estreita", () => {
    expect(expandPermissions(["reports.view_team"]).has("reports.view_all")).toBe(false);
  });
});

describe("papel personalizado: teto, dependências e papel de compatibilidade", () => {
  it("rejeita chave desconhecida e as ownerOnly", () => {
    const errors = validateCustomRolePermissions(["inbox.view", "roles.manage", "ownership.transfer", "nada.disso"]);
    expect(errors).toContainEqual({ code: "owner_only", permission: "roles.manage" });
    expect(errors).toContainEqual({ code: "owner_only", permission: "ownership.transfer" });
    expect(errors).toContainEqual({ code: "unknown_permission", permission: "nada.disso" });
  });

  it("exige as dependências (inbox.reply sem inbox.view)", () => {
    expect(validateCustomRolePermissions(["inbox.reply"])).toEqual([
      { code: "missing_dependency", permission: "inbox.reply", requires: "inbox.view" },
    ]);
    expect(validateCustomRolePermissions(["inbox.view", "inbox.reply"])).toEqual([]);
  });

  it("dependência satisfeita por implicação de escopo (view_all cobre view_team)", () => {
    expect(validateCustomRolePermissions(["reports.view_all", "reports.export"])).toEqual([]);
    expect(validateCustomRolePermissions(["monitoring.view_all", "monitoring.assign"])).toEqual([]);
  });

  it("conjunto vazio é válido (papel sem acesso)", () => {
    expect(validateCustomRolePermissions([])).toEqual([]);
  });

  it("isGrantableToCustomRole", () => {
    expect(isGrantableToCustomRole("inbox.reply")).toBe(true);
    expect(isGrantableToCustomRole("roles.manage")).toBe(false);
    expect(isGrantableToCustomRole("x")).toBe(false);
  });

  it("os conjuntos dos papéis de sistema (exceto owner) são válidos como personalizados — o teto cobre tudo que o admin faz (menos o que é future)", () => {
    for (const role of ["admin", "supervisor", "agent", "viewer"] as const) {
      const set = [...SYSTEM_ROLE_PERMISSIONS[role]];
      expect(validateCustomRolePermissions(set.filter((p) => !permissionDef(p).future)), role).toEqual([]);
      expect(validateCustomRolePermissions(set).every((e) => e.code === "not_grantable"), role).toBe(true);
    }
  });

  it("permissão future (sem checagem no código) não entra: not_grantable", () => {
    expect(validateCustomRolePermissions(["integrations.manage"])).toEqual([{ code: "not_grantable", permission: "integrations.manage" }]);
    expect(isGrantableToCustomRole("integrations.manage")).toBe(false);
  });

  it("compatRoleFor: o menor papel de sistema que contém o conjunto; sem nenhum, admin", () => {
    expect(compatRoleFor([])).toBe("viewer");
    expect(compatRoleFor(["dashboard.view"])).toBe("viewer");
    expect(compatRoleFor(["inbox.view", "inbox.reply"])).toBe("agent");
    expect(compatRoleFor(["monitoring.view_team"])).toBe("supervisor");
    expect(compatRoleFor(["campaigns.manage"])).toBe("admin");
    // receber atribuição (só agent) + editar automações (só admin+): nenhum contém → admin (teto)
    expect(compatRoleFor(["inbox.receive_assignments", "automations.edit"])).toBe("admin");
  });
});
