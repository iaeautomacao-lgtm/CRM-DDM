import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { ACCOUNT_ROLES, canEditSettings, canManageMembers, canSendMessages, canSuperviseTeams, canDeleteAccount, canTransferOwnership, canViewConversationFlows, canViewOnly, hasMinRole, type AccountRole } from "./roles";
import { ROUTE_ALLOWLIST } from "../role-utils";
import { canManageCampaigns } from "../disparador/route-auth";
import { can, permissionsForRole, type Permission } from "./permissions";
import { PAGE_MATRIX, ROUTE_MATRIX, type RouteEntry } from "./permissions-matrix";

// Matriz dourada (PRD 20, 20.1): o catálogo reproduz o comportamento ATUAL. Nenhuma rota
// usa can() ainda — estes testes provam que usar can() no lugar do guard antigo não
// mudaria o resultado para nenhum dos 5 papéis de sistema.

const API_ROOT = resolve(process.cwd(), "src/app/api");
const routeFile = (route: string) => join(API_ROOT, ...route.split("/"), "route.ts");
const read = (route: string) => readFileSync(routeFile(route), "utf8");

describe("matriz de rotas: can(papel, permissão) == hasMinRole(papel, mínimo atual)", () => {
  const checked = ROUTE_MATRIX.filter((e) => e.guard !== "session" && e.min);

  it.each(checked.map((e) => [`${e.method} /api/${e.route} → ${e.permission} (mín. ${e.min})`, e] as const))(
    "%s",
    (_name, e) => {
      for (const role of ACCOUNT_ROLES) {
        expect(can({ role }, e.permission), `${role}`).toBe(hasMinRole(role, e.min as AccountRole));
      }
    },
  );

  it("as entradas só-sessão (qualquer membro) apontam para permissões liberadas a todos os papéis ou documentadas", () => {
    const sessions = ROUTE_MATRIX.filter((e) => e.guard === "session");
    expect(sessions.length).toBeGreaterThan(0);
    // /api/lines e /api/whatsapp/config GET etc. aceitam qualquer papel; a permissão correspondente
    // (channels.view, members.view…) é de TODOS os papéis de sistema.
    for (const e of sessions) {
      for (const role of ACCOUNT_ROLES) expect(can({ role }, e.permission), `${e.route} ${role}`).toBe(true);
    }
  });
});

describe("guard declarado ainda existe no código-fonte da rota (anti-drift)", () => {
  const ROLE_RE = (min: string) =>
    new RegExp(`(?:guardRole|requireRole|agentRoute)\\(\\s*['"]${min}['"]|hasMinRole\\([^)]*['"]${min}['"]`);

  it.each(ROUTE_MATRIX.filter((e) => e.guard !== "session").map((e) => [`${e.method} ${e.route}`, e] as const))(
    "%s",
    (_name, e: RouteEntry) => {
      const file = routeFile(e.route);
      expect(existsSync(file), `arquivo ${e.route}`).toBe(true);
      if (e.pending) return; // lacuna G1–G3 corrigida em outro PR: o guard ainda não está nesta base
      const src = read(e.route);
      switch (e.guard) {
        case "role":
          expect(src, `${e.route} deveria ter guard de papel ${e.min}`).toMatch(ROLE_RE(e.min as string));
          break;
        case "permission": {
          // Rota migrada (20.3): o código pede a PERMISSÃO declarada (requirePermission/guardPermission/can)
          // e não usa mais guard de papel.
          const perm = e.permission.replace(/\./g, "\\.");
          const asksPermission = new RegExp(`(?:requirePermission|guardPermission|agentRoute)\\(\\s*['"]${perm}['"]|can\\([^)]*['"]${perm}['"]`);
          expect(src, `${e.route} deveria pedir a permissão ${e.permission}`).toMatch(asksPermission);
          expect(src, `${e.route} não deveria mais usar guard de papel`).not.toMatch(/(?:guardRole|requireRole)\(/);
          break;
        }
        case "disparador":
          expect(src).toMatch(/requireDisparadorAccess|canManageCampaigns/);
          // 20.3c: limites por segundo pedem campaigns.rate_limit explicitamente (mesmo conjunto: owner/admin)
          if (e.permission === "campaigns.rate_limit") expect(src).toMatch(/requireDisparadorAccess\(\s*["']campaigns\.rate_limit["']/);
          break;
        case "flow":
          expect(src).toMatch(/guardFlow(Access)?\b/);
          // 20.3d: execuções de fluxo pedem flows.view_runs explicitamente (mesmo conjunto: owner/admin)
          if (e.permission === "flows.view_runs") expect(src).toMatch(/guardFlow(Access)?\([^)]*['"]flows\.view_runs['"]/);
          break;
        case "viewer":
          expect(src).toMatch(/viewer/);
          break;
        case "scope":
          expect(src).toMatch(/IntelligenceScope/);
          break;
      }
    },
  );

  it("TODA rota com guard de papel no código está na matriz (rota nova sem permissão falha aqui)", () => {
    const inMatrix = new Set(ROUTE_MATRIX.map((e) => e.route));
    const missing: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (name === "route.ts") {
          const src = readFileSync(p, "utf8");
          if (/(?:guardRole|requireRole|agentRoute)\(\s*['"](?:owner|admin|supervisor|agent)['"]|requirePermission\(|guardPermission\(|agentRoute\(\s*['"]ai\.|requireDisparadorAccess|guardFlow(Access)?\b|resolveIntelligenceScope/.test(src)) {
            const route = relative(API_ROOT, join(p, "..")).split("\\").join("/");
            if (!inMatrix.has(route)) missing.push(route);
          }
        }
      }
    };
    walk(API_ROOT);
    expect(missing, `rotas com guard de papel fora da matriz: ${missing.join(", ")}`).toEqual([]);
  });
});

describe("páginas (ROUTE_ALLOWLIST)", () => {
  it("o instantâneo da matriz = o ROUTE_ALLOWLIST atual (mudou? atualize a matriz de propósito)", () => {
    expect(Object.fromEntries(PAGE_MATRIX.map((p) => [p.prefix, [...p.roles]]))).toEqual(
      Object.fromEntries(Object.entries(ROUTE_ALLOWLIST).map(([k, v]) => [k, [...v]])),
    );
  });

  it.each(PAGE_MATRIX.filter((p) => p.aligned && p.permission).map((p) => [p.prefix, p] as const))(
    "%s: página e permissão alinhadas",
    (_prefix, p) => {
      for (const role of ACCOUNT_ROLES) {
        expect(can({ role }, p.permission as Permission), role).toBe(p.roles.includes(role));
      }
    },
  );

  it("as divergências conhecidas (G5–G8) são exatamente estas — qualquer outra é regressão", () => {
    const divergent = PAGE_MATRIX.filter((p) => !p.aligned).map((p) => p.prefix);
    expect(divergent).toEqual(["/canais", "/contacts", "/pipelines", "/ajuda", "/perfil", "/seguranca"]);
    for (const p of PAGE_MATRIX.filter((x) => !x.aligned)) expect(p.note, p.prefix).toBeTruthy();
  });
});

describe("predicados de roles.ts e helpers legados == permissões", () => {
  const cases: Array<[string, (r: AccountRole) => boolean, Permission]> = [
    ["canManageMembers", canManageMembers, "members.manage"],
    ["canEditSettings", canEditSettings, "settings.account"],
    ["canSendMessages", canSendMessages, "inbox.reply"],
    ["canViewConversationFlows", canViewConversationFlows, "flows.view_runs"],
    ["canDeleteAccount", canDeleteAccount, "account.delete"],
    ["canTransferOwnership", canTransferOwnership, "ownership.transfer"],
    ["canSuperviseTeams", canSuperviseTeams, "monitoring.view_team"],
    ["canManageCampaigns (disparador)", (r) => canManageCampaigns(r), "campaigns.manage"],
  ];
  it.each(cases)("%s", (_n, predicate, permission) => {
    for (const role of ACCOUNT_ROLES) expect(can({ role }, permission), role).toBe(predicate(role));
  });

  it("canViewOnly (viewer) == não pode responder", () => {
    for (const role of ACCOUNT_ROLES) expect(canViewOnly(role)).toBe(!can({ role }, "inbox.reply"));
  });

  it("Intelligence: resolveIntelligenceScope aceita owner/admin/supervisor; owner/admin = conta toda", () => {
    for (const role of ACCOUNT_ROLES) {
      expect(can({ role }, "intelligence.use"), role).toBe(["owner", "admin", "supervisor"].includes(role));
      expect(can({ role }, "intelligence.scope_account"), role).toBe(["owner", "admin"].includes(role));
    }
  });
});

describe("papéis de sistema: conjuntos finais", () => {
  it("owner tem tudo; viewer só leitura (dashboard, contatos, canais, templates, equipes, membros, conta, chaves)", () => {
    const viewer = [...permissionsForRole("viewer")].sort();
    expect(viewer).toEqual(
      [
        "account.view", "api_keys.view", "channels.view", "contacts.view", "conversations.scope_all", "conversations.scope_team",
        "dashboard.view", "members.view", "teams.view", "templates.view",
      ].sort(),
    );
  });

  it("o operador (agent) é o único com inbox.receive_assignments (o handoff de hoje só atribui a 'agent')", () => {
    for (const role of ACCOUNT_ROLES) expect(can({ role }, "inbox.receive_assignments"), role).toBe(role === "agent");
  });

  it("visibilidade de conversas = policy conversations_select (140): owner/admin/viewer tudo; supervisor equipes; agent próprias+fila", () => {
    expect(can({ role: "owner" }, "conversations.scope_all")).toBe(true);
    expect(can({ role: "admin" }, "conversations.scope_all")).toBe(true);
    expect(can({ role: "viewer" }, "conversations.scope_all")).toBe(true); // P-06 do PRD 20: preservado de propósito
    expect(can({ role: "supervisor" }, "conversations.scope_all")).toBe(false);
    expect(can({ role: "supervisor" }, "conversations.scope_team")).toBe(true);
    expect(can({ role: "agent" }, "conversations.scope_team")).toBe(false);
    expect(can({ role: "agent" }, "conversations.scope_all")).toBe(false);
  });
});

describe("execuções de fluxo: ver é leitura, apagar é escrita", () => {
  const src = read("flows/[id]/runs");
  const deleteBody = src.slice(src.indexOf("export async function DELETE"));
  const getBody = src.slice(src.indexOf("export async function GET"), src.indexOf("export async function DELETE"));

  it("a matriz pede flows.view_runs no GET e flows.edit no DELETE", () => {
    const entries = ROUTE_MATRIX.filter((e) => e.route === "flows/[id]/runs");
    expect(entries.find((e) => e.method === "GET")?.permission).toBe("flows.view_runs");
    expect(entries.find((e) => e.method === "DELETE")?.permission).toBe("flows.edit");
  });

  it("o código da rota pede a mesma chave em cada método", () => {
    expect(getBody).toMatch(/guardFlow\([^)]*['"]flows\.view_runs['"]/);
    expect(deleteBody).toMatch(/guardFlow\([^)]*['"]flows\.edit['"]/);
    expect(deleteBody).not.toMatch(/flows\.view_runs/);
  });
});
