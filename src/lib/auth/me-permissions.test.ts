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
      level: ACCOUNT_ROLES.indexOf(role) + 1,
      customized: false,
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
    expect(byKey["roles.manage"]).toMatchObject({ ownerOnly: false, grantable: false }) // admin e acima (TASK5), nunca em cargo
    expect(byKey["inbox.reply"]).toMatchObject({ ownerOnly: false, grantable: true, dependsOn: ["inbox.view"], scope: "n/a" });
    expect(byKey["conversations.scope_all"].scope).toBe("account");
    for (const p of PERMISSIONS) {
      expect(byKey[p].label).toBe(permissionDef(p).label);
      expect(byKey[p].dependsOn).toEqual([...(permissionDef(p).dependsOn ?? [])]);
    }
  });
});

describe("buildMePermissions com papel personalizado (migrations 312/313)", () => {
  it("papel = o personalizado (id, nome, kind custom) com key/rank do compat; permissões e escopos do conjunto dele", () => {
    const me = buildMePermissions({
      account: { id: "acc-1", name: "Acme" },
      role: "supervisor",
      permissions: new Set(["inbox.view", "inbox.reply", "reports.view_team"]),
      customRole: { id: "c1", name: "Cobrança" },
    });
    expect(me.role).toEqual({ id: "c1", key: "supervisor", name: "Cobrança", kind: "custom", rank: 3, level: 3, customized: false });
    expect(me.permissions.sort()).toEqual(["inbox.reply", "inbox.view", "reports.view_team"]);
    expect(me.scopes).toEqual({ inbox: "own", monitoring: "none", reports: "team", intelligence: "none" });
    expect(me.pages).not.toContain("/flows");
  });

  it("só flows.view_runs abre /flows (editor em modo leitura, decisão 13/10)", () => {
    const me = buildMePermissions({
      account: { id: "acc-1", name: "Acme" },
      role: "supervisor",
      permissions: new Set(["inbox.view", "flows.view_runs"]),
      customRole: { id: "c2", name: "Auditoria de fluxo" },
    });
    expect(me.pages).toContain("/flows");
    expect(me.pages).not.toContain("/disparador");
  });

  it("catálogo: future não é concedível (integrations.manage)", () => {
    const all = buildPermissionCatalogGroups().flatMap((g) => g.permissions);
    expect(all.find((p) => p.key === "integrations.manage")).toMatchObject({ ownerOnly: false, grantable: false });
  });
});

describe("buildMePermissions com cargo de sistema ajustado (TASK5, migration 318)", () => {
  it("nome e nível vêm do cargo (Supervisor), não do compat (Admin); customized e o conjunto efetivo", () => {
    const me = buildMePermissions({
      account: { id: "acc-1", name: "Acme" },
      role: "admin", // compat recalculado pelo ajuste
      roleKey: "supervisor",
      roleLevel: 3,
      roleCustomized: true,
      permissions: new Set(["inbox.view", "campaigns.view", "campaigns.manage", "channels.view"]),
    });
    expect(me.role).toEqual({ id: null, key: "admin", name: "Supervisor", kind: "system", rank: 4, level: 3, customized: true });
    expect(me.permissions).toContain("campaigns.manage");
  });
});
