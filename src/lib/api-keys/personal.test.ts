import { describe, expect, it } from "vitest";
import { isPersonalKeyScopes, planKeyCreation } from "./personal";
import { can } from "@/lib/auth/permissions";
import type { AccountRole } from "@/lib/auth/roles";

// planKeyCreation recebe o que o criador PODE (permissões), não o papel; aqui derivamos do papel de sistema
// para provar que o resultado é o mesmo de antes para os 5 papéis.
const caps = (role: AccountRole) => ({
  canManage: can({ role }, "api_keys.manage"),
  canPersonal: can({ role }, "intelligence.personal_key"),
});

describe("planKeyCreation", () => {
  it("owner/admin: chave da conta sem dono, como antes", () => {
    for (const role of ["owner", "admin"] as const) {
      expect(planKeyCreation(caps(role), "u1", ["messages:send"])).toEqual({
        ok: true,
        scopes: ["messages:send"],
        userId: null,
        personal: false,
      });
    }
  });

  it("owner/admin: chave de Inteligência fica ligada ao próprio criador", () => {
    expect(planKeyCreation(caps("admin"), "u1", ["intelligence:read"])).toEqual({
      ok: true,
      scopes: ["intelligence:read"],
      userId: "u1",
      personal: true,
    });
  });

  it("chave de Inteligência não combina com outros escopos", () => {
    const plan = planKeyCreation(caps("owner"), "u1", ["intelligence:read", "messages:send"]);
    expect(plan).toMatchObject({ ok: false, status: 400 });
  });

  it("supervisor cria só a chave pessoal dele", () => {
    expect(planKeyCreation(caps("supervisor"), "sup", ["intelligence:read"])).toMatchObject({
      ok: true,
      userId: "sup",
    });
    expect(planKeyCreation(caps("supervisor"), "sup", ["messages:send"])).toMatchObject({ ok: false, status: 403 });
    expect(planKeyCreation(caps("supervisor"), "sup", [])).toMatchObject({ ok: false, status: 403 });
  });

  it("agent e viewer não criam chave", () => {
    for (const role of ["agent", "viewer"] as const) {
      expect(planKeyCreation(caps(role), "u", ["intelligence:read"])).toMatchObject({ ok: false, status: 403 });
    }
  });

  it("escopo desconhecido → 400", () => {
    expect(planKeyCreation(caps("owner"), "u", ["intelligence:write"])).toMatchObject({ ok: false, status: 400 });
  });

  it("isPersonalKeyScopes", () => {
    expect(isPersonalKeyScopes(["intelligence:read"])).toBe(true);
    expect(isPersonalKeyScopes(["messages:send"])).toBe(false);
  });
});
