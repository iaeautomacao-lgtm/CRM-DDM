/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ writeLog: vi.fn().mockResolvedValue(undefined) }));
import { AiHumanTakeoverError, assertAiMayRespond } from "./human-takeover-guard";

type Conversation = { assigned_agent_id: string | null; status: string; contact_id: string | null };
function dbMock(conversation: Conversation | null, paused = false, error = false) {
  const from = vi.fn((table: string) => {
    const q: Record<string, any> = {};
    for (const key of ["select", "eq", "limit"]) q[key] = () => q;
    q.maybeSingle = async () => ({ data: error ? null : conversation, error: error ? { message: "DB unavailable" } : null });
    q.then = (resolve: (x: unknown) => void) => resolve({
      data: table === "flow_runs" && paused ? [{ id: "run-1" }] : [],
      error: null,
    });
    return q;
  });
  return { from } as never;
}
describe("human takeover guard", () => {
  it("permits an unassigned active conversation", async () => {
    await expect(assertAiMayRespond(dbMock({ assigned_agent_id: null, status: "open", contact_id: "contact" }), "account", "conversation")).resolves.toBeUndefined();
  });
  it("blocks an active run when an operator is assigned", async () => {
    await expect(assertAiMayRespond(dbMock({ assigned_agent_id: "ana", status: "open", contact_id: "contact" }), "account", "conversation")).rejects.toMatchObject({ reason: "assigned_to_human" });
  });
  it("blocks a previously paused flow even without current assignment", async () => {
    await expect(assertAiMayRespond(dbMock({ assigned_agent_id: null, status: "open", contact_id: "contact" }, true), "account", "conversation")).rejects.toMatchObject({ reason: "flow_paused_by_human" });
  });
  it("blocks closed or queued conversations", async () => {
    for (const status of ["pending", "closed"]) {
      await expect(assertAiMayRespond(dbMock({ assigned_agent_id: null, status, contact_id: "contact" }), "account", "conversation")).rejects.toBeInstanceOf(AiHumanTakeoverError);
    }
  });
  it("fails closed when the conversation cannot be retrieved", async () => {
    await expect(assertAiMayRespond(dbMock(null, false, true), "account", "conversation")).rejects.toMatchObject({ reason: "conversation_unavailable" });
  });
});
