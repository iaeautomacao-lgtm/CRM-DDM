// loadLiveCountsViaRpc: sem a função (migration 198 ausente) ou com falha devolve null — o endpoint usa as contagens de antes.
import { describe, expect, it } from "vitest";
import { buildLivePerformanceSnapshot, loadLiveCountsViaRpc } from "./live-performance";

describe("loadLiveCountsViaRpc", () => {
  it("função ausente / erro / exceção / cliente sem rpc: null", async () => {
    expect(await loadLiveCountsViaRpc({ rpc: async () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function" } }) }, "a")).toBeNull();
    expect(await loadLiveCountsViaRpc({ rpc: async () => ({ data: null, error: { message: "timeout" } }) }, "a")).toBeNull();
    expect(
      await loadLiveCountsViaRpc(
        {
          rpc: async () => {
            throw new Error("boom");
          },
        },
        "a",
      ),
    ).toBeNull();
    expect(await loadLiveCountsViaRpc({} as never, "a")).toBeNull();
  });

  it("converte o JSON da RPC e só inclui `capped` no snapshot quando algum campo bateu no teto", async () => {
    const data = { active_campaigns: 2, queued: 100000, sending: 3, errors: 1, blocked: 0, sent_last_60s: 120, capped: { queued: true } };
    const fast = await loadLiveCountsViaRpc({ rpc: async () => ({ data, error: null }) }, "a");
    expect(fast!.counts).toEqual({ activeCampaigns: 2, queued: 100000, sending: 3, errors: 1, blocked: 0, sentLast60s: 120 });
    const capped = buildLivePerformanceSnapshot({ sampledAt: "x", ...fast!.counts, capped: fast!.capped });
    expect(capped.capped).toMatchObject({ queued: true, sending: false });
    const exact = buildLivePerformanceSnapshot({ sampledAt: "x", ...fast!.counts, capped: { queued: false } });
    expect(exact).not.toHaveProperty("capped"); // formato de sempre quando tudo é exato
  });
});
