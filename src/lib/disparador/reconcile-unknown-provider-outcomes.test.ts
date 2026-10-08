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
  /** Lease do item em voo (migration 194). Ausente/nulo = item sem lease. */
  inflight_until?: string | null;
};

// Avalia o filtro PostgREST do lease ("inflight_until.is.null,inflight_until.lt.<iso>") sobre as linhas em memória.
function matchesLeaseFilter(expr: string, row: Row): boolean {
  return expr.split(",").some((part) => {
    if (part === "inflight_until.is.null") return row.inflight_until == null;
    const lt = part.match(/^inflight_until.lt.(.+)$/);
    return !!lt && row.inflight_until != null && row.inflight_until < lt[1];
  });
}

function database(rows: Row[], confirmFails = false, options: { leaseColumnMissing?: boolean } = {}) {
  const updates: Record<string, unknown>[] = [];
  const queries: string[] = [];
  const from = vi.fn(() => ({
    select: () => ({
      eq: () => ({
        lt: () => {
          let visible = rows;
          let usesLease = false;
          const chain: any = {
            or: (expr: string) => {
              usesLease = true;
              queries.push(expr);
              visible = visible.filter((r) => matchesLeaseFilter(expr, r));
              return chain;
            },
            limit: vi.fn(async () =>
              usesLease && options.leaseColumnMissing
                ? { data: null, error: { code: "42703", message: "column disp_message_queue.inflight_until does not exist" } }
                : { data: visible, error: null },
            ),
          };
          return chain;
        },
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
  return { db: { from, rpc } as unknown as SupabaseClient, updates, rpc, queries };
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

describe("recoverStaleSendingReservations — lease do item em voo (F14, migration 194)", () => {
  const NOW = new Date("2026-10-07T18:30:00.000Z");
  const future = "2026-10-07T18:31:30.000Z"; // lease renovado: vence depois de agora
  const past = "2026-10-07T18:29:00.000Z"; // lease vencido

  it("lease renovado (envio lento mas vivo): NÃO é varrido nem marcado como incerto", async () => {
    const { db, updates } = database([base({ inflight_until: future })]);
    const result = await recoverStaleSendingReservations(db, NOW);
    expect(result).toEqual({ recoveredAccepted: 0, finalizedUnknown: 0, failed: 0, campaignIds: [] });
    expect(updates).toHaveLength(0);
  });

  it("lease vencido: o watchdog age (encerra como incerto, sem reenvio)", async () => {
    const { db, updates } = database([base({ inflight_until: past })]);
    const result = await recoverStaleSendingReservations(db, NOW);
    expect(result.finalizedUnknown).toBe(1);
    expect(updates).toContainEqual(expect.objectContaining({ status: "erro", erro_permanente: true }));
  });

  it("lease nulo (item de antes da migration): comportamento de sempre", async () => {
    const { db } = database([base({ inflight_until: null })]);
    expect((await recoverStaleSendingReservations(db, NOW)).finalizedUnknown).toBe(1);
  });

  it("mistura: só o vencido/nulo é tratado; o vivo segue", async () => {
    const { db } = database([base({ id: "vivo", inflight_until: future }), base({ id: "morto", inflight_until: past }), base({ id: "antigo" })]);
    const result = await recoverStaleSendingReservations(db, NOW);
    expect(result.finalizedUnknown).toBe(2);
  });

  it("item incerto NÃO volta para a fila: nunca vira 'agendado' nem recebe novo POST", async () => {
    const { db, updates } = database([base({ inflight_until: past })]);
    await recoverStaleSendingReservations(db, NOW);
    expect(updates.every((u) => u.status !== "agendado")).toBe(true);
  });

  it("o filtro do lease usa o horário atual do watchdog", async () => {
    const { db, queries } = database([]);
    await recoverStaleSendingReservations(db, NOW);
    expect(queries[0]).toBe(`inflight_until.is.null,inflight_until.lt.${NOW.toISOString()}`);
  });

  it("sem a coluna (migration 194 ausente: 42703): refaz a consulta sem o lease e segue como antes", async () => {
    const { db, updates } = database([base()], false, { leaseColumnMissing: true });
    const result = await recoverStaleSendingReservations(db, NOW);
    expect(result.finalizedUnknown).toBe(1);
    expect(updates).toContainEqual(expect.objectContaining({ status: "erro" }));
  });
});
