import { describe, expect, it } from "vitest";
import type { MonitorConversation } from "./queries";
import { PatchQueue, applyPatches } from "./patch-batch";

const conv = (id: string, extra: Partial<MonitorConversation> = {}): MonitorConversation =>
  ({
    id,
    status: "open",
    assigned_agent_id: null,
    team_id: null,
    updated_at: "2026-10-15T12:00:00.000Z",
    contact_id: "k",
    ...extra,
  }) as unknown as MonitorConversation;

const update = (assigned: string | null, at = "2026-10-15T12:05:00.000Z") => ({
  kind: "update" as const,
  fields: { status: "open" as const, assigned_agent_id: assigned, team_id: null, updated_at: at },
});

describe("PatchQueue", () => {
  it("a última mudança de cada conversa vence", () => {
    const q = new PatchQueue();
    q.push("a", update("u1"));
    q.push("a", update("u2"));
    const drained = q.drain();
    expect(drained.size).toBe(1);
    expect(drained.get("a")).toEqual(update("u2"));
    expect(q.size).toBe(0);
  });
  it("conversa descartada no lote não volta com uma atualização depois", () => {
    const q = new PatchQueue();
    q.push("a", { kind: "drop" });
    q.push("a", update("u1"));
    expect(q.drain().get("a")).toEqual({ kind: "drop" });
  });
});

describe("applyPatches", () => {
  it("aplica atualizações e descartes num Map novo", () => {
    const board = new Map([["a", conv("a")], ["b", conv("b")]]);
    const patches = new Map<string, ReturnType<typeof update> | { kind: "drop" }>([
      ["a", update("u1")],
      ["b", { kind: "drop" }],
    ]);
    const next = applyPatches(board, patches);
    expect(next).not.toBe(board);
    expect(next.get("a")?.assigned_agent_id).toBe("u1");
    expect(next.has("b")).toBe(false);
    expect(board.has("b")).toBe(true); // o original não é alterado
  });
  it("devolve o mesmo Map quando nada se aplica (conversa desconhecida)", () => {
    const board = new Map([["a", conv("a")]]);
    expect(applyPatches(board, new Map([["zzz", update("u1")]]))).toBe(board);
    expect(applyPatches(board, new Map())).toBe(board);
  });
  it("o evento atualiza as datas de espera do cartão (cliente voltou a escrever / atendente respondeu)", () => {
    const board = new Map([["a", conv("a", { last_message_at: "2026-10-15T12:00:00.000Z", last_customer_message_at: "2026-10-15T12:00:00.000Z" })]]);
    const patch = {
      kind: "update" as const,
      fields: {
        ...update("u1").fields,
        last_message_at: "2026-10-15T12:07:00.000Z",
        last_customer_message_at: "2026-10-15T12:00:00.000Z",
      },
    };
    const got = applyPatches(board, new Map([["a", patch]])).get("a");
    expect(got?.last_message_at).toBe("2026-10-15T12:07:00.000Z");
    expect(got?.last_customer_message_at).toBe("2026-10-15T12:00:00.000Z");
  });
  it("mantém os campos que o evento não traz", () => {
    const board = new Map([["a", conv("a", { contact_id: "k9" })]]);
    expect(applyPatches(board, new Map([["a", update("u1")]])).get("a")?.contact_id).toBe("k9");
  });
});
