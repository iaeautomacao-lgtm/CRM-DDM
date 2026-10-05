import { describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/auth/account";
import { fakeDb } from "./__tests__/fake-db";
import { describeScope, narrowScopeToTeam, resolveIntelligenceScope } from "./scope";

const A = "acc-a";
const B = "acc-b";
const tables = {
  teams: [
    { id: "t1", account_id: A },
    { id: "t2", account_id: A },
    { id: "tb", account_id: B },
  ],
  team_members: [
    { team_id: "t2", user_id: "sup" },
    { team_id: "t1", user_id: "sup" },
    { team_id: "tb", user_id: "sup-foreign" },
  ],
};

describe("resolveIntelligenceScope", () => {
  it("owner e admin veem a conta toda (teamIds null)", async () => {
    const { db } = fakeDb(tables);
    for (const role of ["owner", "admin"]) {
      const s = await resolveIntelligenceScope({ accountId: A, userId: "u", role }, db);
      expect(s).toEqual({ accountId: A, userId: "u", role, teamIds: null });
      expect(describeScope(s)).toEqual({ teams: "conta" });
    }
  });

  it("supervisor recebe as equipes dele, da conta dele", async () => {
    const { db } = fakeDb(tables);
    const s = await resolveIntelligenceScope({ accountId: A, userId: "sup", role: "supervisor" }, db);
    expect(s.teamIds).toEqual(["t1", "t2"]);
    expect(describeScope(s)).toEqual({ teams: 2 });
  });

  it("supervisor sem equipe (ou só com equipe de outra conta) é barrado", async () => {
    const { db } = fakeDb(tables);
    await expect(
      resolveIntelligenceScope({ accountId: A, userId: "ninguem", role: "supervisor" }, db),
    ).rejects.toThrow("Supervisor sem equipe");
    await expect(
      resolveIntelligenceScope({ accountId: A, userId: "sup-foreign", role: "supervisor" }, db),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("agent, viewer e papéis desconhecidos: Forbidden", async () => {
    const { db } = fakeDb(tables);
    for (const role of ["agent", "viewer", "superadmin", ""]) {
      await expect(resolveIntelligenceScope({ accountId: A, userId: "u", role }, db)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    }
  });
});

describe("narrowScopeToTeam", () => {
  const sup = { accountId: A, userId: "sup", role: "supervisor", teamIds: ["t1", "t2"] };
  it("supervisor só pode filtrar equipe dele", () => {
    expect(narrowScopeToTeam(sup, "t1").teamIds).toEqual(["t1"]);
    expect(() => narrowScopeToTeam(sup, "t9")).toThrow(ForbiddenError);
    expect(narrowScopeToTeam(sup, undefined)).toBe(sup);
  });
  it("owner filtra qualquer equipe, mas o account_id continua no escopo", () => {
    const owner = { accountId: A, userId: "o", role: "owner", teamIds: null };
    expect(narrowScopeToTeam(owner, "tb")).toEqual({ ...owner, teamIds: ["tb"] });
  });
});
