import { describe, expect, it } from "vitest";
import { buildPermissionCatalogGroups } from "@/lib/auth/me-permissions";
import { permissionsForRole } from "@/lib/auth/permissions";
import {
  assignableRoles,
  blockedReason,
  compatRoleOf,
  deselectWithDependents,
  differsFromDefault,
  myLevel,
  readOnlyReason,
  type RoleItem,
  roleErrorMessage,
  selectWithDependencies,
  validateRoleForm,
  type CatalogPermission,
} from "./editor";

const catalog = new Map<string, CatalogPermission>(
  buildPermissionCatalogGroups().flatMap((g) => g.permissions.map((p) => [p.key, p as CatalogPermission] as const)),
);

describe("roles/editor", () => {
  it("marcar uma permissão marca as dependências (em cascata)", () => {
    const withDeps = [...catalog.values()].find((p) => p.grantable && p.dependsOn.length > 0);
    expect(withDeps).toBeTruthy();
    const next = selectWithDependencies(new Set(), withDeps!.key, catalog);
    expect(next.has(withDeps!.key)).toBe(true);
    for (const dep of withDeps!.dependsOn) expect(next.has(dep)).toBe(true);
  });

  it("não marca permissão que o usuário não tem (nem como dependência)", () => {
    const withDeps = [...catalog.values()].find((p) => p.grantable && p.dependsOn.length > 0)!;
    const lacking = withDeps.dependsOn[0];
    const next = selectWithDependencies(new Set(), withDeps.key, catalog, (k) => k !== lacking);
    expect(next.has(lacking)).toBe(false);
    // Sem poder conceder a dependência, a permissão também não é marcada (o servidor recusaria o conjunto).
    expect(next.has(withDeps.key)).toBe(false);
    expect(next.size).toBe(0);
  });

  it("não marca permissão bloqueada (só proprietário / sem uso)", () => {
    const owner = [...catalog.values()].find((p) => p.ownerOnly)!;
    expect(blockedReason(owner)).toBe("Só o proprietário");
    expect(selectWithDependencies(new Set(), owner.key, catalog).size).toBe(0);
    const notGrantable = [...catalog.values()].find((p) => !p.ownerOnly && !p.grantable);
    if (notGrantable) expect(blockedReason(notGrantable)).toBe("Ainda não disponível");
  });

  it("desmarcar uma dependência desmarca quem dependia dela", () => {
    const withDeps = [...catalog.values()].find((p) => p.grantable && p.dependsOn.length > 0)!;
    const all = selectWithDependencies(new Set(), withDeps.key, catalog);
    const next = deselectWithDependents(all, withDeps.dependsOn[0]);
    expect(next.has(withDeps.dependsOn[0])).toBe(false);
    expect(next.has(withDeps.key)).toBe(false);
  });

  it("o conjunto do Visualizador equivale a Visualizador; escrita sobe o papel", () => {
    expect(compatRoleOf(permissionsForRole("viewer"))).toBe("viewer");
    expect(compatRoleOf(permissionsForRole("agent"))).toBe("agent");
    expect(compatRoleOf(permissionsForRole("admin"))).toBe("admin");
  });

  it("valida nome, descrição e ao menos 1 permissão", () => {
    expect(validateRoleForm({ name: " ", description: "", permissions: new Set() })).toEqual({
      name: "Dê um nome ao papel.",
      permissions: "Marque ao menos uma permissão.",
    });
    expect(validateRoleForm({ name: "a".repeat(81), description: "b".repeat(301), permissions: new Set(["inbox.view"]) })).toMatchObject({
      name: expect.stringContaining("80"),
      description: expect.stringContaining("300"),
    });
    expect(validateRoleForm({ name: "Qualidade", description: "", permissions: new Set(["inbox.view"]) })).toEqual({});
  });

  it("traduz os erros das rotas", () => {
    expect(roleErrorMessage({ code: "role_in_use", members: 3 })).toContain("3 membros");
    expect(roleErrorMessage({ code: "role_in_use", members: 1 })).toContain("1 membro.");
    expect(roleErrorMessage({ code: "name_taken" })).toBe("Já existe um cargo com esse nome.");
    expect(roleErrorMessage({ code: "forbidden" })).toBe("Você não tem permissão para fazer isso.");
    expect(roleErrorMessage({ code: "role_level" })).toContain("abaixo do seu");
    expect(roleErrorMessage({ code: "escalation", permissions: ["inbox.reply", "x.y"] }, "", (p) => (p === "x.y" ? "Rótulo Y" : p))).toBe("Você não pode conceder permissões que não tem: inbox.reply, Rótulo Y.");
    expect(roleErrorMessage({ code: "invalid_permissions", errors: [{ code: "missing_dependency", permission: "x.y" }] })).toContain("x.y");
    expect(roleErrorMessage({ error: "texto do servidor" })).toBe("texto do servidor");
    expect(roleErrorMessage(null)).toBe("Não foi possível concluir.");
  });

  const role = (over: Partial<RoleItem>): RoleItem => ({
    id: "r",
    key: "agent",
    name: "Operador",
    description: null,
    kind: "system",
    rank: 2,
    compat_role: "agent",
    permissions: ["a", "b"],
    member_count: 0,
    member_ids: [],
    created_at: null,
    updated_at: null,
    ...over,
  });

  it("nível do usuário: usa level, senão rank", () => {
    expect(myLevel({ role: { rank: 4, level: 4 } })).toBe(4);
    expect(myLevel({ role: { rank: 4 } })).toBe(4);
    expect(myLevel(null)).toBe(0);
  });

  it("cargos atribuíveis: o servidor manda (assignable); sem o campo, só abaixo de mim e nunca o proprietário", () => {
    const roles = [
      role({ id: "o", key: "owner", rank: 5 }),
      role({ id: "a", key: "admin", rank: 4 }),
      role({ id: "s", key: "supervisor", rank: 3 }),
      role({ id: "c", key: "agent", kind: "custom", rank: 2, level: 2.5 }),
      role({ id: "x", key: "viewer", rank: 1, assignable: false }),
    ];
    // Admin (nível 4): supervisor e o personalizado 2,5; o visualizador some porque o servidor disse assignable=false.
    expect(assignableRoles(roles, 4).map((r) => r.id)).toEqual(["s", "c"]);
    // Proprietário (nível 5): admin também entra.
    expect(assignableRoles(roles, 5).map((r) => r.id)).toEqual(["a", "s", "c"]);
  });

  it("leitura: próprio cargo, mesmo nível ou acima e proprietário", () => {
    expect(readOnlyReason(role({ rank: 2 }), 4, false)).toBeNull();
    expect(readOnlyReason(role({ id: "me", key: "admin", rank: 4 }), 4, true)).toBe("own");
    expect(readOnlyReason(role({ key: "admin", rank: 4 }), 4, false)).toBe("level");
    expect(readOnlyReason(role({ key: "owner", rank: 5 }), 5, false)).toBe("owner");
    // O servidor manda: editable=false vence a regra por nível.
    expect(readOnlyReason(role({ rank: 1, editable: false }), 4, false)).toBe("level");
  });

  it("cargo de sistema ajustado: difere do padrão só quando o conjunto muda", () => {
    expect(differsFromDefault({ permissions: ["a", "b"], default_permissions: ["b", "a"] })).toBe(false);
    expect(differsFromDefault({ permissions: ["a"], default_permissions: ["a", "b"] })).toBe(true);
    expect(differsFromDefault({ permissions: ["a"], default_permissions: null })).toBe(false);
  });
});
