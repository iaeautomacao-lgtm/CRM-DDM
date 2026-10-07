import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cleanupOrphanReceipts } from "./receipts-cleanup";

describe("limpeza com orçamento e cadência distribuída", () => {
  const database = () => {
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
    return { db: { rpc } as unknown as SupabaseClient, rpc };
  };
  it("pula sem tempo ou com lease perdido", async () => {
    const { db, rpc } = database();
    await cleanupOrphanReceipts(db, 10_000, () => false, () => 0);
    await cleanupOrphanReceipts(db, 30_000, () => true, () => 0);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("limpa até 5000 e usa TTL de 10 min, sem liberar o lease", async () => {
    const { db, rpc } = database();
    await cleanupOrphanReceipts(db, 30_000, () => false, () => 0);
    expect(rpc.mock.calls).toEqual([
      ["try_acquire_cron_lock", { p_name: "dispatch_receipts_cleanup", p_owner_id: expect.any(String), p_ttl_seconds: 600 }],
      ["cleanup_orphan_dispatch_receipts", { p_limit: 5000 }],
    ]);
  });
  it("não limpa novamente enquanto o lease de cadência está ocupado", async () => {
    const { db, rpc } = database();
    rpc.mockResolvedValue({ data: false, error: null });
    await cleanupOrphanReceipts(db, 30_000, () => false, () => 0);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it("reconfere tempo após obter o lease e tolera migration ausente", async () => {
    const { db, rpc } = database();
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValue(25_000);
    await cleanupOrphanReceipts(db, 30_000, () => false, now);
    expect(rpc).toHaveBeenCalledTimes(1);
    rpc.mockRejectedValue(new Error("RPC ausente"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(cleanupOrphanReceipts(db, 30_000, () => false, () => 0)).resolves.toBeUndefined();
    errorLog.mockRestore();
  });
});
