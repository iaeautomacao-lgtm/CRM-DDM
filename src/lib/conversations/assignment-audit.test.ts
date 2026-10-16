import { describe, expect, it } from "vitest";
import { completeAssignmentAudit } from "./assignment-audit";

type Row = { id: string; conversation_id: string; from_agent_id: string | null; to_agent_id: string | null; from_team_id: string | null; to_team_id: string | null; actor_id: string | null; reason: string | null; created_at: string };

function fakeDb(rows: Row[], opts: { selectError?: boolean; updateError?: boolean } = {}) {
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  return {
    updates,
    db: {
      from: () => {
        let op = "select";
        let payload: Record<string, unknown> = {};
        const filters: Array<(r: Row) => boolean> = [];
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.update = (p: Record<string, unknown>) => ((op = "update"), (payload = p), b);
        b.eq = (c: keyof Row, v: unknown) => (filters.push((r) => r[c] === v), b);
        b.is = (c: keyof Row, v: null) => (filters.push((r) => (r[c] ?? null) === v), b);
        b.order = () => b;
        b.limit = () => b;
        b.then = (ok: (v: unknown) => unknown) => {
          const matched = rows.filter((r) => filters.every((f) => f(r))).sort((a, c) => c.created_at.localeCompare(a.created_at));
          if (op === "update") {
            if (opts.updateError) return Promise.resolve({ data: null, error: { message: "x" } }).then(ok);
            for (const r of matched) {
              updates.push({ id: r.id, patch: payload });
              Object.assign(r, payload);
            }
            return Promise.resolve({ data: matched, error: null }).then(ok);
          }
          return Promise.resolve({ data: opts.selectError ? null : matched.slice(0, 1), error: opts.selectError ? { message: "x" } : null }).then(ok);
        };
        return b;
      },
    } as never,
  };
}
const row = (over: Partial<Row>): Row => ({ id: "a1", conversation_id: "c1", from_agent_id: null, to_agent_id: "u2", from_team_id: null, to_team_id: null, actor_id: null, reason: null, created_at: "2026-10-16T12:00:00.000Z", ...over });
const input = { conversationId: "c1", fromAgent: null, fromTeam: null, toAgent: "u2", toTeam: null, actorId: "u9", reason: "motivo" };

describe("completeAssignmentAudit (B6: a linha é a do próprio UPDATE, não a de um relógio)", () => {
  it("preenche ator e motivo na linha que casa com o de→para, sem depender de horário", async () => {
    // created_at do BANCO bem ANTES do relógio do Node: o filtro antigo (created_at >= startedAt) não acharia nada
    const rows = [row({ created_at: "2020-01-01T00:00:00.000Z" })];
    const { db, updates } = fakeDb(rows);
    expect(await completeAssignmentAudit(db, input)).toBe(true);
    expect(rows[0]).toMatchObject({ actor_id: "u9", reason: "motivo" });
    expect(updates).toHaveLength(1);
  });

  it("não cai na linha de OUTRA atribuição simultânea (motor/IA para outro atendente) nem sobrescreve linha que já tem ator", async () => {
    const rows = [
      row({ id: "ia", to_agent_id: "u7", created_at: "2026-10-16T12:00:01.000Z" }), // a mais recente é de outro destino
      row({ id: "minha", to_agent_id: "u2", created_at: "2026-10-16T12:00:00.000Z" }),
      row({ id: "ja-tem-ator", to_agent_id: "u2", actor_id: "u1", created_at: "2026-10-16T12:00:02.000Z" }),
    ];
    const { db } = fakeDb(rows);
    expect(await completeAssignmentAudit(db, input)).toBe(true);
    expect(rows.find((r) => r.id === "minha")).toMatchObject({ actor_id: "u9" });
    expect(rows.find((r) => r.id === "ia")).toMatchObject({ actor_id: null, reason: null });
    expect(rows.find((r) => r.id === "ja-tem-ator")).toMatchObject({ actor_id: "u1" });
  });

  it("casa também a equipe e o atendente anteriores (null = sem atendente/equipe)", async () => {
    const rows = [row({ id: "t", from_agent_id: "u1", to_agent_id: null, from_team_id: "t1", to_team_id: "t2" })];
    const { db } = fakeDb(rows);
    expect(await completeAssignmentAudit(db, { ...input, fromAgent: "u1", toAgent: null, fromTeam: "t1", toTeam: "t2" })).toBe(true);
    expect(await completeAssignmentAudit(db, { ...input, fromAgent: "u1", toAgent: null, fromTeam: "tX", toTeam: "t2" })).toBe(false);
  });

  it("sem linha, sem ator e sem motivo: devolve false sem erro; erro do banco propaga", async () => {
    expect(await completeAssignmentAudit(fakeDb([]).db, input)).toBe(false);
    const { db, updates } = fakeDb([row({})]);
    expect(await completeAssignmentAudit(db, { ...input, actorId: null, reason: null })).toBe(false);
    expect(updates).toHaveLength(0);
    await expect(completeAssignmentAudit(fakeDb([row({})], { selectError: true }).db, input)).rejects.toBeTruthy();
    await expect(completeAssignmentAudit(fakeDb([row({})], { updateError: true }).db, input)).rejects.toBeTruthy();
  });
});
