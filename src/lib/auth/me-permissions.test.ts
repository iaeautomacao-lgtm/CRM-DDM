import { describe, expect, it } from "vitest";

import { buildMePermissions, buildPermissionCatalogGroups, SYSTEM_ROLE_NAMES } from "./me-permissions";
import { PERMISSIONS, SYSTEM_ROLE_PERMISSIONS, permissionDef } from "./permissions";
import { ACCOUNT_ROLES, type AccountRole } from "./roles";
import { canAccessRoute, ROUTE_ALLOWLIST } from "../role-utils";

const ctxFor = (role: AccountRole) => ({
  account: { id: "acc-1", name: "Acme" },
  role,
  permissions: SYSTEM_ROLE_PERMISSIONS[role],
});

describe("buildMePermissions (contrato do front, PRD 20 seção 8)", () => {
  it.each(ACCOUNT_ROLES)("%s: organização, papel de sistema e status", (role) => {
    const me = buildMePermissions(ctxFor(role));
    expect(me.organization).toEqual({ id: "acc-1", name: "Acme" });
    expect(me.role).toEqual({
      id: null,
      key: role,
      name: SYSTEM_ROLE_NAMES[role],
      kind: "system",
      rank: ACCOUNT_ROLES.indexOf(role) + 1,
    });
    expect(me.status).toBe("active");
  });

  it.each(ACCOUNT_ROLES)("%s: permissions == conjunto do papel (ordem do catálogo)", (role) => {
    const me = buildMePermissions(ctxFor(role));
    expect(new Set(me.permissions)).toEqual(new Set(SYSTEM_ROLE_PERMISSIONS[role]));
    expect(me.permissions).toEqual(PERMISSIONS.filter((p) => SYSTEM_ROLE_PERMISSIONS[role].has(p)));
  });

  it.each(ACCOUNT_ROLES)("%s: pages == o que o ROUTE_ALLOWLIST libera hoje", (role) => {
    const me = buildMePermissions(ctxFor(role));
    for (const prefix of Object.keys(ROUTE_ALLOWLIST)) {
      expect(me.pages.includes(prefix), `${role} ${prefix}`).toBe(canAccessRoute(role, prefix));
    }
  });

  it("escopos por papel", () => {
    const scopes = (r: AccountRole) => buildMePermissions(ctxFor(r)).scopes;
    expect(scopes("owner")).toEqual({ inbox: "all", monitoring: "all", reports: "all", intelligence: "all" });
    expect(scopes("admin")).toEqual({ inbox: "all", monitoring: "all", reports: "all", intelligence: "all" });
    expect(scopes("supervisor")).toEqual({ inbox: "team", monitoring: "team", reports: "team", intelligence: "team" });
    expect(scopes("agent")).toEqual({ inbox: "own", monitoring: "none", reports: "none", intelligence: "none" });
    // P-06 do PRD 20: o visualizador vê todas as conversas hoje (preservado)
    expect(scopes("viewer")).toEqual({ inbox: "all", monitoring: "none", reports: "none", intelligence: "none" });
  });

  it("usa a lista efetiva (papel personalizado) quando ela difere do papel de sistema", () => {
    const me = buildMePermissions({ ...ctxFor("agent"), permissions: new Set(["inbox.view", "inbox.reply"]) });
    expect(me.permissions).toEqual(["inbox.view", "inbox.reply"]);
    expect(me.scopes.inbox).toBe("own");
  });
});

describe("buildPermissionCatalogGroups", () => {
  const groups = buildPermissionCatalogGroups();
  const flat = groups.flatMap((g) => g.permissions);

  it("cobre TODAS as permissões, sem repetir, na ordem do catálogo", () => {
    expect(flat.map((p) => p.key)).toEqual([...PERMISSIONS]);
  });

  it("grupos com chave sem acento e rótulo em pt-BR", () => {
    expect(groups.map((g) => g.key)).toEqual(
      expect.arrayContaining(["inbox", "contatos", "acompanhamento", "disparador", "fluxos-e-ia", "canais", "pessoas", "organizacao"]),
    );
    for (const g of groups) expect(g.key).toMatch(/^[a-z0-9-]+$/);
  });

  it("campos do contrato: escopo, ownerOnly/grantable e dependências", () => {
    const byKey = Object.fromEntries(flat.map((p) => [p.key, p]));
    expect(byKey["roles.manage"]).toMatchObject({ ownerOnly: true, grantable: false })
    expect(byKey["inbox.reply"]).toMatchObject({ ownerOnly: false, grantable: true, dependsOn: ["inbox.view"], scope: "n/a" });
    expect(byKey["conversations.scope_all"].scope).toBe("account");
    for (const p of PERMISSIONS) {
      expect(byKey[p].label).toBe(permissionDef(p).label);
      expect(byKey[p].dependsOn).toEqual([...(permissionDef(p).dependsOn ?? [])]);
    }
  });
});
