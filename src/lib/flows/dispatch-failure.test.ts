// Decisão do dono (13/10, item 12): fila + motivo quando a entrega ao fluxo falha. O helper nunca lança.
import { describe, expect, it } from "vitest";

import { DISPATCH_FAILURE_REASON, queueAfterDispatchFailure } from "./dispatch-failure";

type Row = Record<string, unknown>;
function fakeDb(opts: { updateRows?: Row[]; updateError?: boolean; insertError?: boolean; throws?: boolean } = {}) {
  const calls: Array<{ table: string; op: string; payload?: unknown; filters: Array<[string, unknown]> }> = [];
  const db = {
    from: (table: string) => {
      if (opts.throws) throw new Error("boom");
      const call: (typeof calls)[number] = { table, op: "select", filters: [] };
      calls.push(call);
      const b: Record<string, unknown> = {};
      b.update = (p: unknown) => ((call.op = "update"), (call.payload = p), b);
      b.insert = (p: unknown) => ((call.op = "insert"), (call.payload = p), b);
      b.select = () => b;
      for (const m of ["eq", "neq"]) b[m] = (c: string, v: unknown) => (call.filters.push([`${m}:${c}`, v]), b);
      b.then = (resolve: (v: unknown) => void) =>
        resolve(call.op === "update" ? { data: opts.updateError ? null : (opts.updateRows ?? [{ id: "cv" }]), error: opts.updateError ? { message: "x" } : null } : { data: null, error: opts.insertError ? { message: "x" } : null });
      return b;
    },
  };
  return { db: db as never, calls };
}
const input = { accountId: "acc", contactId: "ct", conversationId: "cv" };

describe("queueAfterDispatchFailure", () => {
  it("põe a conversa na fila e registra o motivo (com o detalhe curto, sem passar de 200 caracteres)", async () => {
    const { db, calls } = fakeDb();
    expect(await queueAfterDispatchFailure(db, input, "x".repeat(500))).toEqual({ queued: true, recorded: true });
    expect(calls[0]).toMatchObject({ table: "conversations", op: "update", payload: { status: "pending" } });
    expect(calls[0].filters).toEqual([["eq:id", "cv"], ["eq:account_id", "acc"], ["neq:status", "closed"]]);
    const decision = calls[1].payload as Row;
    expect(decision).toMatchObject({ handoff_reason: DISPATCH_FAILURE_REASON, needs_human: true, decision_type: "handoff" });
    expect(String((decision.decision as Row).detail)).toHaveLength(200);
  });

  it("conversa encerrada (0 linhas atualizadas): não conta como na fila, mas o motivo é registrado; sem conversa: só registra", async () => {
    expect(await queueAfterDispatchFailure(fakeDb({ updateRows: [] }).db, input, "e")).toEqual({ queued: false, recorded: true });
    const { db, calls } = fakeDb();
    expect(await queueAfterDispatchFailure(db, { accountId: "acc", contactId: "ct" }, "e")).toEqual({ queued: false, recorded: true });
    expect(calls.map((c) => c.table)).toEqual(["ai_decisions"]);
  });

  it("falha de banco em qualquer passo nunca lança", async () => {
    expect(await queueAfterDispatchFailure(fakeDb({ updateError: true, insertError: true }).db, input, "e")).toEqual({ queued: false, recorded: false });
    expect(await queueAfterDispatchFailure(fakeDb({ throws: true }).db, input, "e")).toEqual({ queued: false, recorded: false });
  });
});
