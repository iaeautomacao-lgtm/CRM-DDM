// Nó handoff_team × reserva do @operador (migration 376; revisão de segurança 16/10, M6): o fluxo não redistribui conversa reservada, nem quando
// a reserva chega ENTRE a leitura e a gravação (o UPDATE leva o guarda requested_agent_id IS NULL). Motor real sobre o banco em memória.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: () => ({}) }));
vi.mock("@/lib/logger", () => ({ writeLog: async () => undefined, maskPhone: (p: string) => p }));

import { createMemoryDb, type SimTables } from "@/lib/flows/simulator/memory-db";
import { executeHandoffTeam } from "@/lib/flows/engine";

const ACC = "acc-1";
const fresh = () => new Date(Date.now() - 5_000).toISOString();

function tables(requested: string | null | undefined): SimTables {
  return {
    teams: [{ id: "t1", account_id: ACC, overflow_team_id: null }],
    team_members: [{ team_id: "t1", user_id: "u1", created_at: "2026-01-01T00:00:00Z" }],
    profiles: [{ user_id: "u1", account_id: ACC, account_role: "agent", full_name: "U1", max_simultaneous_chats: null, created_at: "2026-01-01T00:00:00Z" }],
    member_presence: [{ user_id: "u1", status: "online", last_seen_at: fresh() }],
    agent_pauses: [],
    conversations: [
      {
        id: "c1", account_id: ACC, team_id: null, assigned_agent_id: null, status: "open",
        ...(requested === undefined ? {} : { requested_agent_id: requested }),
      },
    ],
    flow_runs: [{ id: "r1", account_id: ACC, flow_id: "f1", conversation_id: "c1", contact_id: "ct1", status: "active", vars: {} }],
  };
}

const run = { id: "r1", account_id: ACC, flow_id: "f1", conversation_id: "c1", contact_id: "ct1", vars: {}, current_node_key: "h1" } as never;
const node = { node_key: "h1", node_type: "handoff_team", config: { team_id: "t1", reason_code: "INDEFINIDO" } } as never;
const conv = (t: SimTables) => t.conversations[0] as { assigned_agent_id: string | null; team_id: string | null; status: string; requested_agent_id?: string | null };

describe("handoff_team do fluxo × reserva do @operador", () => {
  it("sem reserva: atribui pelo rodízio (comportamento de sempre)", async () => {
    const t = tables(null);
    await executeHandoffTeam(createMemoryDb({ tables: t, clock: { last: 0 } }) as never, run, node);
    expect(conv(t)).toMatchObject({ assigned_agent_id: "u1", team_id: "t1", status: "pending" });
  });

  it("sem a coluna requested_agent_id (migration 376 ausente): atribui normalmente", async () => {
    const t = tables(undefined);
    await executeHandoffTeam(createMemoryDb({ tables: t, clock: { last: 0 } }) as never, run, node);
    expect(conv(t)).toMatchObject({ assigned_agent_id: "u1", team_id: "t1", status: "pending" });
  });

  it("conversa já reservada: o fluxo não mexe em atendente, equipe, status nem na reserva", async () => {
    const t = tables("u-reservado");
    await executeHandoffTeam(createMemoryDb({ tables: t, clock: { last: 0 } }) as never, run, node);
    expect(conv(t)).toMatchObject({ assigned_agent_id: null, team_id: null, status: "open", requested_agent_id: "u-reservado" });
  });

  it("a reserva chega ENTRE a leitura e a gravação: o UPDATE guardado não pega a conversa e a reserva sobrevive", async () => {
    const t = tables("u-reservado"); // no banco já está reservada...
    const real = createMemoryDb({ tables: t, clock: { last: 0 } }) as unknown as { from: (table: string) => Record<string, unknown> };
    const stale = { eq: () => ({ limit: async () => ({ data: [{ requested_agent_id: null }], error: null }) }) };
    const db = {
      ...real,
      from: (table: string) => {
        const b = real.from(table);
        if (table !== "conversations") return b;
        // ...mas a leitura de hasMentionReservation ainda viu "sem reserva" (a menção chegou logo depois)
        return new Proxy(b, {
          get(target, prop) {
            if (prop === "select") return (cols: string, ...rest: unknown[]) => (cols === "requested_agent_id" ? stale : (target.select as (...a: unknown[]) => unknown)(cols, ...rest));
            const v = target[prop as string];
            return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
          },
        });
      },
    };
    await executeHandoffTeam(db as never, run, node);
    expect(conv(t)).toMatchObject({ assigned_agent_id: null, requested_agent_id: "u-reservado" });
    expect((t.flow_runs[0] as { status: string }).status).toBe("handed_off"); // o fluxo termina normalmente, sem erro
  });
});
