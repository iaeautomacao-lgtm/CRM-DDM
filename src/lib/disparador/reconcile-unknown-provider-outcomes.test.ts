import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recoverStaleSendingReservations } from "./reconcile-unknown-provider-outcomes";

type Row = {
  id: string;
  campaign_id: string;
  contact_id: string | null;
  session_id: string | null;
  mensagem_final: string | null;
  waha_message_id: string | null;
  tentativas: number | null;
  erro: string | null;
  sent_at: string | null;
  updated_at: string | null;
};

function database(rows: Row[], confirmFails = false) {
  const updates: Record<string, unknown>[] = [];
  const from = vi.fn(() => ({
    select: () => ({
      eq: () => ({
        lt: () => ({
          limit: vi.fn().mockResolvedValue({ data: rows, error: null }),
        }),
      }),
    }),
    update: (values: Record<string, unknown>) => {
      updates.push(values);
      const chain: any = {
        eq: vi.fn(() => chain),
        then: (resolve: (value: unknown) => void) => resolve({ error: null }),
      };
      return chain;
    },
  }));
  const rpc = vi.fn(async (name: string) => {
    if (name === "confirm_dispatch_item_sent")
      return { data: null, error: confirmFails ? { message: "rpc failed" } : null };
    return { data: null, error: null };
  });
  return { db: { from, rpc } as unknown as SupabaseClient, updates, rpc };
}

const base = (overrides: Partial<Row> = {}): Row => ({
  id: "q1",
  campaign_id: "c1",
  contact_id: "ct1",
  session_id: "s1",
  mensagem_final: "oi",
  waha_message_id: null,
  tentativas: 1,
  erro: null,
  sent_at: null,
  updated_at: "2026-10-07T18:00:00.000Z",
  ...overrides,
});

describe("recoverStaleSendingReservations", () => {
  it("não altera nada sem reserva antiga", async () => {
    const { db, updates } = database([]);
    const result = await recoverStaleSendingReservations(
      db,
      new Date("2026-10-07T18:30:00.000Z")
    );
    expect(result).toEqual({
      recoveredAccepted: 0,
      finalizedUnknown: 0,
      failed: 0,
      campaignIds: [],
    });
    expect(updates).toHaveLength(0);
  });

  it("sem message id terminaliza sem reenviar", async () => {
    const { db, updates } = database([base()]);
    const result = await recoverStaleSendingReservations(db);
    expect(updates).toContainEqual(
      expect.objectContaining({ status: "erro", erro_permanente: true })
    );
    expect(result.finalizedUnknown).toBe(1);
  });

  it("com message id recupera pela RPC normal", async () => {
    const { db, updates, rpc } = database([base({ waha_message_id: "wamid.1" })]);
    const result = await recoverStaleSendingReservations(db);
    expect(rpc).toHaveBeenCalledWith(
      "confirm_dispatch_item_sent",
      expect.objectContaining({ p_item_id: "q1", p_waha_message_id: "wamid.1" })
    );
    expect(updates).toHaveLength(0);
    expect(result.recoveredAccepted).toBe(1);
  });

  it("se a RPC falhar, libera a vaga como enviado sem novo POST", async () => {
    const { db, updates } = database([base({ waha_message_id: "wamid.1" })], true);
    const result = await recoverStaleSendingReservations(db);
    expect(updates).toContainEqual(
      expect.objectContaining({ status: "enviado", erro_permanente: false })
    );
    expect(result.recoveredAccepted).toBe(1);
  });
});
