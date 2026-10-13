// Decisões do dono de 13/10 (itens 9 e 10), travadas por teste:
//   9) o Visualizador NÃO vê /automations;
//  10) o Supervisor NÃO vê as listas importadas (importações do disparador).
// Se alguém mudar a matriz, o ROUTE_ALLOWLIST ou o RLS das tabelas de importação, este teste falha.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { canAccessRoute } from "../role-utils";
import { ROUTE_MATRIX } from "./permissions-matrix";
import { can } from "./permissions";
import { ACCOUNT_ROLES } from "./roles";

describe("decisão 9: o visualizador não vê /automations", () => {
  it("página: só operador e acima", () => {
    for (const role of ACCOUNT_ROLES) {
      expect(canAccessRoute(role, "/automations"), role).toBe(role !== "viewer");
      expect(canAccessRoute(role, "/automations/new"), role).toBe(role !== "viewer");
    }
  });

  it("API: toda rota de automações pede automations.view/edit, que o visualizador não tem", () => {
    const entries = ROUTE_MATRIX.filter((e) => e.route === "automations" || e.route.startsWith("automations/"));
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(["automations.view", "automations.edit"], e.route).toContain(e.permission);
      expect(can({ role: "viewer" }, e.permission), `${e.method} ${e.route}`).toBe(false);
    }
  });
});

describe("decisão 10: o supervisor não vê as listas importadas", () => {
  it("página do disparador (onde ficam as importações): só proprietário e admin", () => {
    expect(canAccessRoute("supervisor", "/disparador")).toBe(false);
    expect(canAccessRoute("supervisor", "/disparador/contatos")).toBe(false);
  });

  it("API: toda rota de importação exige campaigns.manage, que o supervisor não tem", () => {
    const entries = ROUTE_MATRIX.filter((e) => /^disparador\/(imports|contacts\/import)/.test(e.route));
    expect(entries.length).toBeGreaterThanOrEqual(8);
    for (const e of entries) {
      expect(e.permission, e.route).toBe("campaigns.manage");
      expect(can({ role: "supervisor" }, e.permission), `${e.method} ${e.route}`).toBe(false);
    }
  });

  it("banco: as tabelas de importação não têm policy de leitura para o navegador (só service role)", () => {
    const dir = resolve(process.cwd(), "supabase/migrations");
    const sql = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => readFileSync(join(dir, f), "utf8"))
      .join("\n");
    for (const table of ["disp_import_contacts", "dispatch_import_jobs"]) {
      expect(sql, table).toMatch(new RegExp(`ALTER TABLE wacrm\.${table} ENABLE ROW LEVEL SECURITY`));
      expect(sql, `${table} não pode ter policy`).not.toMatch(new RegExp(`CREATE POLICY[^;]*ON wacrm\.${table}\b`));
      expect(sql, `${table} não pode ter GRANT para authenticated`).not.toMatch(new RegExp(`GRANT[^;]*ON (TABLE )?wacrm\.${table}[^;]*authenticated`));
    }
  });
});
