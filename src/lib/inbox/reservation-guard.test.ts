import { describe, expect, it, vi } from "vitest";

import { handOffToTeamQueue } from "@/lib/ai/team-handoff";
import { isMissingReservationColumn, lostToReservation, runUnlessReserved } from "./reservation-guard";

vi.mock("@/lib/flows/engine", () => ({
  selectAgentForTeam: async () => "u1",
  selectAnyAgentForAccount: async () => "u1",
}));

describe("runUnlessReserved", () => {
  it("roda com o guarda; se a coluna não existe (42703 / PGRST204) roda de novo sem ele", async () => {
    const seen: boolean[] = [];
    const out = await runUnlessReserved<unknown[]>(async (guard) => {
      seen.push(guard);
      return guard ? { data: null, error: { code: "42703" } } : { data: [{ id: "c1" }], error: null };
    });
    expect(seen).toEqual([true, false]);
    expect(out.data).toEqual([{ id: "c1" }]);
    seen.length = 0;
    await runUnlessReserved<unknown[]>(async (guard) => (seen.push(guard), guard ? { data: null, error: { code: "PGRST204" } } : { data: [], error: null }));
    expect(seen).toEqual([true, false]);
  });

  it("outro erro NÃO refaz sem o guarda (nunca ignora a reserva por engano)", async () => {
    const seen: boolean[] = [];
    const out = await runUnlessReserved<unknown[]>(async (guard) => (seen.push(guard), { data: null, error: { code: "57014", message: "timeout" } }));
    expect(seen).toEqual([true]);
    expect(out.error?.code).toBe("57014");
  });

  it("isMissingReservationColumn e lostToReservation", () => {
    expect(isMissingReservationColumn({ code: "42703" })).toBe(true);
    expect(isMissingReservationColumn({ code: "PGRST204" })).toBe(true);
    expect(isMissingReservationColumn({ code: "23505" })).toBe(false);
    expect(isMissingReservationColumn(null)).toBe(false);
    expect(lostToReservation({ data: [], error: null })).toBe(true);
    expect(lostToReservation({ data: null, error: null })).toBe(true);
    expect(lostToReservation({ data: [{ id: "c1" }], error: null })).toBe(false);
    expect(lostToReservation({ data: null, error: { code: "57014" } })).toBe(false);
  });
});

/** Banco falso para handOffToTeamQueue: leituras de team/reserva e o UPDATE guardado com resultados configuráveis. */
function fakeDb(opts: { reservedRead: boolean; updates: Array<{ data: unknown[] | null; error: { code?: string; message?: string } | null }> }) {
  const guards: boolean[] = [];
  const db = {
    from: () => {
      let isUpdate = false;
      let guard = false;
      const b: Record<string, unknown> = {};
      b.select = (cols: string) => {
        if (cols === "requested_agent_id") b.__reservation = true;
        return b;
      };
      b.update = () => ((isUpdate = true), b);
      b.eq = () => b;
      b.is = (col: string) => (col === "requested_agent_id" && (guard = true), b);
      b.limit = () => b;
      b.then = (ok: (v: unknown) => unknown) => {
        if (isUpdate) {
          guards.push(guard);
          return Promise.resolve(opts.updates.shift() ?? { data: [{ id: "c1" }], error: null }).then(ok);
        }
        if (b.__reservation) return Promise.resolve({ data: [{ requested_agent_id: opts.reservedRead ? "u-res" : null }], error: null }).then(ok);
        return Promise.resolve({ data: [{ team_id: "t1", contact_id: "ct1" }], error: null }).then(ok);
      };
      return b;
    },
  };
  return { db: db as never, guards };
}

describe("handOffToTeamQueue (travas da IA) × reserva do @operador", () => {
  it("reserva já visível na leitura: não escolhe agente nem grava", async () => {
    const { db, guards } = fakeDb({ reservedRead: true, updates: [] });
    expect(await handOffToTeamQueue(db, "acc", "c1", "[t]")).toEqual({ ok: true, teamId: "t1", assignedTo: null });
    expect(guards).toEqual([]);
  });

  it("a reserva chega depois da leitura: o UPDATE guardado não atualiza nada e o resultado é 'sem atendente' (reserva preservada)", async () => {
    const { db, guards } = fakeDb({ reservedRead: false, updates: [{ data: [], error: null }] });
    expect(await handOffToTeamQueue(db, "acc", "c1", "[t]")).toEqual({ ok: true, teamId: "t1", assignedTo: null });
    expect(guards).toEqual([true]);
  });

  it("sem reserva: atribui e grava com o guarda", async () => {
    const { db, guards } = fakeDb({ reservedRead: false, updates: [{ data: [{ id: "c1" }], error: null }] });
    expect(await handOffToTeamQueue(db, "acc", "c1", "[t]")).toEqual({ ok: true, teamId: "t1", assignedTo: "u1" });
    expect(guards).toEqual([true]);
  });

  it("sem a migration 376 (coluna ausente no UPDATE): refaz sem o guarda e atribui", async () => {
    const { db, guards } = fakeDb({ reservedRead: false, updates: [{ data: null, error: { code: "42703" } }, { data: [{ id: "c1" }], error: null }] });
    expect(await handOffToTeamQueue(db, "acc", "c1", "[t]")).toEqual({ ok: true, teamId: "t1", assignedTo: "u1" });
    expect(guards).toEqual([true, false]);
  });

  it("erro real do banco no UPDATE: ok:false com a mensagem", async () => {
    const { db } = fakeDb({ reservedRead: false, updates: [{ data: null, error: { code: "57014", message: "timeout" } }] });
    expect(await handOffToTeamQueue(db, "acc", "c1", "[t]")).toEqual({ ok: false, error: "timeout" });
  });
});
