// Cron de retry-assignment × expiração da reserva do @operador: a reserva liberada segue a distribuição normal (dono > rodízio) NO MESMO tick.
import { beforeEach, describe, expect, it, vi } from "vitest";

const NOW = Date.parse("2026-10-16T15:00:00.000Z");
const min = (m: number, extraMs = 0) => new Date(NOW - m * 60_000 - extraMs).toISOString();

const state = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  selectorCalls: [] as Array<{ kind: string; ownerCtx: unknown; team?: string }>,
  agent: "agent-novo" as string | null,
}));

vi.mock("@/lib/audit/log-event", () => ({ logAuditEvent: async () => undefined }));
vi.mock("@/lib/flows/engine", () => ({
  selectAgentForTeam: vi.fn(async (_db: unknown, team: string, _acc: string, ownerCtx: unknown) => {
    state.selectorCalls.push({ kind: "team", ownerCtx, team });
    return state.agent;
  }),
  selectAnyAgentForAccount: vi.fn(async (_db: unknown, _acc: string, ownerCtx: unknown) => {
    state.selectorCalls.push({ kind: "any", ownerCtx });
    return state.agent;
  }),
}));
vi.mock("@/lib/flows/admin-client", async () => {
  const { createMemoryDb } = await import("@/lib/flows/simulator/memory-db");
  return {
    supabaseAdmin: () => {
      const real = createMemoryDb({ tables: state.tables, clock: { last: 0 } }) as unknown as { from: (t: string) => Record<string, unknown> };
      // a memória não implementa .or(): na consulta do cron o filtro de adiamento é irrelevante para estes cenários
      const wrap = (target: Record<string, unknown>): Record<string, unknown> => {
        const proxy: Record<string, unknown> = new Proxy(target, {
          get(t, prop) {
            if (prop === "or") return () => proxy;
            const v = t[prop as string];
            if (typeof v !== "function") return v;
            return (...args: unknown[]) => {
              const r = (v as (...a: unknown[]) => unknown).apply(t, args);
              return r === t ? proxy : r; // mantém o encadeamento dentro do proxy
            };
          },
        });
        return proxy;
      };
      return { from: (t: string) => wrap(real.from(t)) };
    },
  };
});

const { POST } = await import("./route");
const call = () => POST(new Request("http://x", { method: "POST", headers: { "x-cron-secret": "s3cr3t" } }));
const conv = (id: string) => state.tables.conversations.find((c) => c.id === id) as { assigned_agent_id: string | null; requested_agent_id: string | null };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("AUTOMATION_CRON_SECRET", "s3cr3t");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  state.selectorCalls = [];
  state.agent = "agent-novo";
  state.tables = {
    conversations: [
      // reservada há 45 min; operador pausado há 40 min; a conversa teve mensagem há 2 min (fora do corte de 5 min do cron)
      { id: "c-exp", account_id: "acc", team_id: "t1", contact_id: "ct-exp", status: "pending", assigned_agent_id: null, requested_agent_id: "op-pausado", requested_at: min(45), updated_at: min(2) },
      // reservada há 45 min; operador online e fora de pausa: mantém
      { id: "c-mantem", account_id: "acc", team_id: "t1", contact_id: "ct-m", status: "pending", assigned_agent_id: null, requested_agent_id: "op-online", requested_at: min(45), updated_at: min(45) },
      // reservada há 10 min com operador pausado há 40: ainda não completou 30 min de reserva
      { id: "c-nova", account_id: "acc", team_id: "t1", contact_id: "ct-n", status: "pending", assigned_agent_id: null, requested_agent_id: "op-pausado", requested_at: min(10), updated_at: min(10) },
    ],
    agent_pauses: [{ id: "p", user_id: "op-pausado", account_id: "acc", reason_name: "Almoço", started_at: min(40), ended_at: null }],
    member_presence: [
      { user_id: "op-pausado", status: "online", last_seen_at: new Date(NOW - 5_000).toISOString() },
      { user_id: "op-online", status: "online", last_seen_at: new Date(NOW - 5_000).toISOString() },
    ],
  };
});

describe("retry-assignment × expiração da reserva", () => {
  it("a reserva expirada volta para a fila e é distribuída NO MESMO tick, com o contato e a conversa para a regra dono > rodízio", async () => {
    const res = await call();
    expect(await res.json()).toEqual({ retried: 1, assigned: 1, reservations_expired: 1 });
    expect(conv("c-exp")).toMatchObject({ assigned_agent_id: "agent-novo", requested_agent_id: null });
    // o seletor recebeu contato e conversa: é lá que o dono do contato passa na frente do rodízio (src/lib/carteira/owner-preference.ts)
    expect(state.selectorCalls).toEqual([{ kind: "team", team: "t1", ownerCtx: { contactId: "ct-exp", conversationId: "c-exp" } }]);
  });

  it("as que não cumprem a regra continuam reservadas e intocadas (operador que voltou a tempo; reserva com menos de 30 min)", async () => {
    await call();
    expect(conv("c-mantem")).toMatchObject({ assigned_agent_id: null, requested_agent_id: "op-online" });
    expect(conv("c-nova")).toMatchObject({ assigned_agent_id: null, requested_agent_id: "op-pausado" });
  });

  it("sem a migration 384 (reservas sem requested_at): nada expira, o cron segue como antes", async () => {
    for (const c of state.tables.conversations) delete c.requested_at;
    const res = await call();
    expect(await res.json()).toEqual({ retried: 0, assigned: 0, reservations_expired: 0 });
    expect(conv("c-exp").requested_agent_id).toBe("op-pausado");
    expect(state.selectorCalls).toEqual([]);
  });

  it("liberada, mas sem agente disponível: fica na fila (pending, sem reserva) com o adiamento padrão, sem erro", async () => {
    state.agent = null;
    const res = await call();
    expect(await res.json()).toMatchObject({ assigned: 0, reservations_expired: 1 });
    expect(conv("c-exp")).toMatchObject({ assigned_agent_id: null, requested_agent_id: null });
  });
});
