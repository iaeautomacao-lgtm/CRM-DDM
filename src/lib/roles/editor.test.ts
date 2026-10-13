import { describe, expect, it } from "vitest";
import { buildPermissionCatalogGroups } from "@/lib/auth/me-permissions";
import { permissionsForRole } from "@/lib/auth/permissions";
import {
  blockedReason,
  compatRoleOf,
  deselectWithDependents,
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
    expect(roleErrorMessage({ code: "name_taken" })).toBe("Já existe um papel com esse nome.");
    expect(roleErrorMessage({ code: "forbidden" })).toBe("Só o proprietário pode fazer isso.");
    expect(roleErrorMessage({ code: "invalid_permissions", errors: [{ code: "missing_dependency", permission: "x.y" }] })).toContain("x.y");
    expect(roleErrorMessage({ error: "texto do servidor" })).toBe("texto do servidor");
    expect(roleErrorMessage(null)).toBe("Não foi possível concluir.");
  });
});
