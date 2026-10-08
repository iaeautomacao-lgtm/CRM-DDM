import { afterEach, describe, expect, it, vi } from "vitest";

// getCurrentAccount resolves the caller's account context. The
// regression this file guards (issue #294): account loading must NOT
// depend on a PostgREST embedded FK join (`accounts!inner`), because a
// stale schema cache makes that embed fail hard and blanks the whole
// context. It must instead read the profile and then the account with
// two plain point queries.

// ------------------------------------------------------------
// Chainable Supabase query-builder mock. Each `.from(table)` hands back
// a thenable builder pre-loaded with the result queued for that table,
// so we can assert which tables were queried and with what filters.
// ------------------------------------------------------------
interface BuilderCall {
  table: string;
  columns?: string;
  eqArgs: [string, unknown][];
}

function makeClient(opts: {
  user: { id: string } | null;
  userErr?: unknown;
  byTable: Record<string, { data: unknown; error: unknown }>;
}) {
  const calls: BuilderCall[] = [];

  const from = (table: string) => {
    const call: BuilderCall = { table, eqArgs: [] };
    calls.push(call);
    const builder = {
      select(columns: string) {
        call.columns = columns;
        return builder;
      },
      eq(col: string, val: unknown) {
        call.eqArgs.push([col, val]);
        return builder;
      },
      maybeSingle() {
        return Promise.resolve(
          opts.byTable[table] ?? { data: null, error: null },
        );
      },
    };
    return builder;
  };

  return {
    calls,
    client: {
      auth: {
        getUser: () =>
          Promise.resolve({
            data: { user: opts.user },
            error: opts.userErr ?? null,
          }),
      },
      from,
    },
  };
}

const createClient = vi.fn();
const recordAccessDenied = vi.fn();
vi.mock("@/lib/audit/access-denied", () => ({ recordAccessDenied: (...a: unknown[]) => recordAccessDenied(...a) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => createClient(),
}));

const { getCurrentAccount, UnauthorizedError, ForbiddenError } = await import(
  "./account"
);
const { ACCOUNT_ROLES } = await import("./roles");
const { PERMISSIONS, SYSTEM_ROLE_PERMISSIONS, can } = await import("./permissions");

afterEach(() => {
  vi.clearAllMocks();
});

describe("getCurrentAccount", () => {
  it("resolves context via a plain accounts lookup, not an embedded join", async () => {
    const { client, calls } = makeClient({
      user: { id: "user-1" },
      byTable: {
        profiles: {
          data: { account_id: "acct-1", account_role: "owner" },
          error: null,
        },
        accounts: { data: { id: "acct-1", name: "Acme" }, error: null },
      },
    });
    createClient.mockReturnValue(client);

    const ctx = await getCurrentAccount();

    expect(ctx).toMatchObject({
      userId: "user-1",
      accountId: "acct-1",
      role: "owner",
      account: { id: "acct-1", name: "Acme" },
    });

    // Two queries: profiles by user_id, then accounts by id. Neither
    // selects an embedded relationship — the regression guard.
    expect(calls.map((c) => c.table)).toEqual(["profiles", "accounts"]);
    expect(calls[0].columns).not.toMatch(/accounts!/);
    expect(calls[0].eqArgs).toEqual([["user_id", "user-1"]]);
    expect(calls[1].columns).not.toMatch(/accounts!/);
    expect(calls[1].eqArgs).toEqual([["id", "acct-1"]]);
  });

  // PRD 20, 20.2: o contexto carrega as permissões (compat: derivadas do papel de sistema).
  it.each(ACCOUNT_ROLES)("carrega as permissões do papel de sistema %s (compat)", async (role) => {
    const { client } = makeClient({
      user: { id: "user-1" },
      byTable: {
        profiles: { data: { account_id: "acct-1", account_role: role }, error: null },
        accounts: { data: { id: "acct-1", name: "Acme" }, error: null },
      },
    });
    createClient.mockReturnValue(client);

    const ctx = await getCurrentAccount();

    expect([...ctx.permissions].sort()).toEqual([...SYSTEM_ROLE_PERMISSIONS[role]].sort());
    for (const permission of PERMISSIONS) {
      expect(can(ctx, permission), `${role} ${permission}`).toBe(can({ role }, permission));
    }
  });

  it("throws UnauthorizedError when there is no session", async () => {
    const { client } = makeClient({ user: null, byTable: {} });
    createClient.mockReturnValue(client);
    await expect(getCurrentAccount()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("maps a profiles query error to 'Could not load account context'", async () => {
    const { client } = makeClient({
      user: { id: "user-1" },
      byTable: {
        profiles: { data: null, error: { code: "PGRST200" } },
      },
    });
    createClient.mockReturnValue(client);
    await expect(getCurrentAccount()).rejects.toThrow(
      "Could not load account context",
    );
  });

  it("maps an accounts query error to 'Could not load account context'", async () => {
    // The exact #294 shape if the embed were still in play, but now on
    // the decoupled accounts lookup: profile resolves, account read errors.
    const { client } = makeClient({
      user: { id: "user-1" },
      byTable: {
        profiles: {
          data: { account_id: "acct-1", account_role: "admin" },
          error: null,
        },
        accounts: { data: null, error: { code: "PGRST200" } },
      },
    });
    createClient.mockReturnValue(client);
    const err = await getCurrentAccount().catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.message).toBe("Could not load account context");
  });

  it("rejects a profile not linked to an account", async () => {
    const { client } = makeClient({
      user: { id: "user-1" },
      byTable: {
        profiles: { data: { account_id: null, account_role: null }, error: null },
      },
    });
    createClient.mockReturnValue(client);
    await expect(getCurrentAccount()).rejects.toThrow(
      "Profile is not linked to an account",
    );
  });

  it("rejects an account_id that resolves to no readable account", async () => {
    const { client } = makeClient({
      user: { id: "user-1" },
      byTable: {
        profiles: {
          data: { account_id: "acct-1", account_role: "viewer" },
          error: null,
        },
        accounts: { data: null, error: null },
      },
    });
    createClient.mockReturnValue(client);
    await expect(getCurrentAccount()).rejects.toThrow(
      "Profile is not linked to an account",
    );
  });
});

// PRD 20, 20.3: requirePermission substitui requireRole com o MESMO resultado para os 5 papéis de sistema.
describe("requirePermission", () => {
  const clientFor = (role: string) =>
    makeClient({
      user: { id: "user-1" },
      byTable: {
        profiles: { data: { account_id: "acct-1", account_role: role }, error: null },
        accounts: { data: { id: "acct-1", name: "Acme" }, error: null },
      },
    }).client;

  const CASES = [
    ["settings.account", "admin"],
    ["members.invite", "admin"],
    ["members.manage", "admin"],
    ["audit.view", "admin"],
    ["members.reset_password", "owner"],
    ["ownership.transfer", "owner"],
    ["members.view", "viewer"],
  ] as const;

  it.each(CASES)("%s == requireRole('%s') para os 5 papéis", async (permission, min) => {
    const { requirePermission, requireRole } = await import("./account");
    for (const role of ACCOUNT_ROLES) {
      createClient.mockReturnValue(clientFor(role));
      const byPermission = await requirePermission(permission).then(() => true, () => false);
      createClient.mockReturnValue(clientFor(role));
      const byRole = await requireRole(min).then(() => true, () => false);
      expect(byPermission, `${role} ${permission}`).toBe(byRole);
    }
  });

  it("403 carrega a permissão que faltou (corpo aditivo: error continua string)", async () => {
    const { requirePermission, toErrorResponse } = await import("./account");
    createClient.mockReturnValue(clientFor("agent"));
    const err = await requirePermission("members.manage").catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.permission).toBe("members.manage");
    const res = toErrorResponse(err);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "This action requires the 'members.manage' permission",
      code: "forbidden",
      permission: "members.manage",
    });
  });

  it("PRD 20.8: o 403 grava access.denied (uma vez, com a permissão); o sucesso não grava; a resposta não muda", async () => {
    const { requirePermission, toErrorResponse } = await import("./account");
    createClient.mockReturnValue(clientFor("agent"));
    const err = await requirePermission("members.manage").catch((e) => e);
    expect(recordAccessDenied).toHaveBeenCalledTimes(1);
    expect(recordAccessDenied).toHaveBeenCalledWith(expect.objectContaining({ accountId: "acct-1", userId: "user-1", role: "agent" }), "members.manage");
    expect(toErrorResponse(err).status).toBe(403);

    recordAccessDenied.mockClear();
    createClient.mockReturnValue(clientFor("admin"));
    await expect(requirePermission("members.manage")).resolves.toBeTruthy();
    expect(recordAccessDenied).not.toHaveBeenCalled();
  });

  it("papel de sistema sem a permissão não passa; chave fora do catálogo nega (fail-closed)", async () => {
    const { requirePermission } = await import("./account");
    createClient.mockReturnValue(clientFor("owner"));
    await expect(requirePermission("nao.existe" as never)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("sem sessão: 401", async () => {
    const { requirePermission } = await import("./account");
    createClient.mockReturnValue(makeClient({ user: null, byTable: {} }).client);
    await expect(requirePermission("members.view")).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
