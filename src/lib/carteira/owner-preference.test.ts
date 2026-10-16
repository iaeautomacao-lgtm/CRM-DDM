// Carteira fixa, fase 2: o dono do contato só vence o rodízio quando passa em todas as regras; em qualquer dúvida segue o rodízio.
import { describe, expect, it, vi } from "vitest";
import { createMemoryDb, type SimTables } from "@/lib/flows/simulator/memory-db";
import { selectAgentForTeam, selectAnyAgentForAccount } from "@/lib/flows/engine";
import { preferredContactOwner } from "./owner-preference";

const audit = vi.hoisted(() => vi.fn(async (_p: unknown) => undefined));
vi.mock("@/lib/audit/log-event", () => ({ logAuditEvent: audit }));

const ACC = "acc-1";
const fresh = () => new Date(Date.now() - 5_000).toISOString();
const stale = () => new Date(Date.now() - 10 * 60_000).toISOString();

const profile = (u: string, over: Record<string, unknown> = {}) => ({
  user_id: u, account_id: ACC, account_role: "agent", max_simultaneous_chats: null, created_at: "2026-01-01T00:00:00Z", deactivated_at: null, ...over,
});

function tables(over: Partial<SimTables> = {}): SimTables {
  return {
    teams: [{ id: "t1", account_id: ACC, overflow_team_id: null }],
    team_members: [
      { team_id: "t1", user_id: "u1", created_at: "2026-01-01T00:00:00Z" },
      { team_id: "t1", user_id: "u2", created_at: "2026-01-02T00:00:00Z" },
    ],
    // u1 (mais antigo) ganharia o rodízio; o dono é u2 (ou u3, que está fora da equipe)
    profiles: [profile("u1"), profile("u2", { created_at: "2026-01-02T00:00:00Z" }), profile("u3", { created_at: "2026-01-03T00:00:00Z" })],
    member_presence: ["u1", "u2", "u3"].map((u) => ({ user_id: u, status: "online", last_seen_at: fresh() })),
    contacts: [
      { id: "c-owner", account_id: ACC, owner_user_id: "u2" },
      { id: "c-free", account_id: ACC, owner_user_id: null },
      { id: "c-out", account_id: ACC, owner_user_id: "u3" },
      { id: "c-other", account_id: "acc-2", owner_user_id: "u2" },
    ],
    conversations: [],
    agent_pauses: [],
    ...over,
  };
}
const dbOf = (t: SimTables) => createMemoryDb({ tables: t, clock: { last: 0 } }) as never;
const ctx = (contactId: string) => ({ contactId, conversationId: "conv-1" });

/** Banco em que a tabela dada responde sempre com este erro. */
function dbBreaking(table: string, error: { code?: string; message: string }, methods = ["select", "in", "is", "eq", "limit"]) {
  const real = createMemoryDb({ tables: tables(), clock: { last: 0 } }) as unknown as { from: (t: string) => unknown };
  return {
    ...real,
    from: (t: string) => {
      if (t !== table) return real.from(t);
      const b: Record<string, unknown> = {};
      for (const m of methods) b[m] = () => b;
      b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error }).then(ok);
      return b;
    },
  } as never;
}

describe("carteira fase 2 — seletores", () => {
  it("dono elegível vence o rodízio (equipe e conta) e a atribuição é auditada com via 'owner', só com ids", async () => {
    audit.mockClear();
    expect(await selectAgentForTeam(dbOf(tables()), "t1", ACC, ctx("c-owner"))).toBe("u2");
    expect(await selectAnyAgentForAccount(dbOf(tables()), ACC, ctx("c-owner"))).toBe("u2");
    expect(audit).toHaveBeenCalledTimes(2);
    expect(audit.mock.calls[0][0]).toMatchObject({ accountId: ACC, resourceId: "conv-1", metadata: { via: "owner", agent_id: "u2", team_id: "t1" } });
    expect(JSON.stringify(audit.mock.calls)).not.toMatch(/phone|telefone|cpf|full_name/i);
  });

  it("contato sem dono, sem contexto, inexistente ou de outra conta: rodízio de sempre", async () => {
    expect(await selectAgentForTeam(dbOf(tables()), "t1", ACC, ctx("c-free"))).toBe("u1");
    expect(await selectAgentForTeam(dbOf(tables()), "t1", ACC)).toBe("u1");
    expect(await selectAgentForTeam(dbOf(tables()), "t1", ACC, ctx("c-other"))).toBe("u1");
    expect(await selectAnyAgentForAccount(dbOf(tables()), ACC, ctx("inexistente"))).toBe("u1");
  });

  it("dono em pausa: rodízio (e nunca o pausado)", async () => {
    const t = tables({ agent_pauses: [{ id: "p", user_id: "u2", account_id: ACC, ended_at: null }] });
    expect(await selectAgentForTeam(dbOf(t), "t1", ACC, ctx("c-owner"))).toBe("u1");
    expect(await selectAnyAgentForAccount(dbOf(t), ACC, ctx("c-owner"))).toBe("u1");
  });

  it("dono offline, com batimento velho ou só 'away': rodízio", async () => {
    for (const mp of [
      { user_id: "u2", status: "offline", last_seen_at: fresh() },
      { user_id: "u2", status: "online", last_seen_at: stale() },
      { user_id: "u2", status: "away", last_seen_at: fresh() },
    ]) {
      const t = tables({ member_presence: [{ user_id: "u1", status: "online", last_seen_at: fresh() }, mp] });
      expect(await selectAgentForTeam(dbOf(t), "t1", ACC, ctx("c-owner"))).toBe("u1");
    }
  });

  it("dono no limite de conversas: rodízio; abaixo do limite: dono", async () => {
    const open = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `o${i}`, account_id: ACC, assigned_agent_id: "u2", status: i % 2 ? "open" : "pending" }));
    const profiles = (max: number | null) => [profile("u1"), profile("u2", { max_simultaneous_chats: max }), profile("u3")];
    expect(await selectAgentForTeam(dbOf(tables({ profiles: profiles(2), conversations: open(2) })), "t1", ACC, ctx("c-owner"))).toBe("u1");
    expect(await selectAgentForTeam(dbOf(tables({ profiles: profiles(3), conversations: open(2) })), "t1", ACC, ctx("c-owner"))).toBe("u2");
    expect(await selectAnyAgentForAccount(dbOf(tables({ profiles: profiles(2), conversations: open(2) })), ACC, ctx("c-owner"))).toBe("u1");
  });

  it("dono fora da equipe da conversa: rodízio da equipe; sem equipe (conta toda) o dono vale", async () => {
    expect(await selectAgentForTeam(dbOf(tables()), "t1", ACC, ctx("c-out"))).toBe("u1");
    expect(await selectAnyAgentForAccount(dbOf(tables()), ACC, ctx("c-out"))).toBe("u3");
  });

  it("dono desativado ou que não é operador da conta: rodízio", async () => {
    expect(await selectAgentForTeam(dbOf(tables({ profiles: [profile("u1"), profile("u2", { deactivated_at: stale() })] })), "t1", ACC, ctx("c-owner"))).toBe("u1");
    expect(await selectAgentForTeam(dbOf(tables({ profiles: [profile("u1"), profile("u2", { account_role: "admin" })] })), "t1", ACC, ctx("c-owner"))).toBe("u1");
  });

  it("leitura de pausa falhando: fail-closed — o dono não é escolhido e o rodízio também não atribui ninguém", async () => {
    const broken = dbBreaking("agent_pauses", { code: "XX000", message: "boom" });
    expect(await preferredContactOwner(broken, { accountId: ACC, contactId: "c-owner", teamId: "t1" })).toBeNull();
    expect(await selectAgentForTeam(broken, "t1", ACC, ctx("c-owner"))).toBeNull();
  });

  it("sem a migration 372 (coluna inexistente): sem dono, rodízio", async () => {
    const noCol = dbBreaking("contacts", { code: "42703", message: "x" });
    expect(await selectAgentForTeam(noCol, "t1", ACC, ctx("c-owner"))).toBe("u1");
  });

  it("menção explícita (requested_agent_id) vence o dono: conversa com menção segue o rodízio", async () => {
    const withMention = tables({ conversations: [{ id: "conv-1", account_id: ACC, assigned_agent_id: null, status: "pending", requested_agent_id: "u1" }] });
    expect(await selectAgentForTeam(dbOf(withMention), "t1", ACC, ctx("c-owner"))).toBe("u1");
    const noMention = tables({ conversations: [{ id: "conv-1", account_id: ACC, assigned_agent_id: null, status: "pending", requested_agent_id: null }] });
    expect(await selectAgentForTeam(dbOf(noMention), "t1", ACC, ctx("c-owner"))).toBe("u2");
  });

  it("sem a coluna requested_agent_id (376 não aplicada) o dono segue valendo; outro erro de leitura = rodízio", async () => {
    const real = createMemoryDb({ tables: tables(), clock: { last: 0 } }) as unknown as { from: (t: string) => unknown };
    const failing = (code: string) => ({
      ...real,
      from: (t: string) => {
        if (t !== "conversations") return real.from(t);
        const b: Record<string, unknown> = {};
        for (const m of ["select", "eq", "limit", "in"]) b[m] = () => b;
        b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { code, message: "x" } }).then(ok);
        return b;
      },
    }) as never;
    expect(await selectAgentForTeam(failing("42703"), "t1", ACC, ctx("c-owner"))).toBe("u2");
    expect(await selectAgentForTeam(failing("XX000"), "t1", ACC, ctx("c-owner"))).toBe("u1");
  });

  it("não escreve log com dado do contato", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await selectAgentForTeam(dbOf(tables()), "t1", ACC, ctx("c-owner"));
    expect(log).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    log.mockRestore();
    err.mockRestore();
  });
});
