import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), resume: vi.fn() }));
vi.mock("@/lib/disparador/admin-client", () => ({ supabaseAdmin: () => ({ from: mocks.from, rpc: mocks.rpc }) }));
vi.mock("@/lib/disparador/queue-reflow", () => ({ resumeBatchedCampaign: mocks.resume }));
vi.mock("@/lib/logger", () => ({ writeLog: vi.fn() }));
import { startCampaign } from "./startCampaign";

afterEach(() => vi.useRealTimers());

it.each([1, 50])("retomada (batch_size=%i) limpa motivo e reinicia a avaliação sem reenfileirar", async (batchSize) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-06T12:00:00Z"));
  const writes: Array<Record<string, unknown>> = [];
  mocks.from.mockImplementation((table) => {
    expect(table).toBe("campaigns"); // nenhuma inserção/limpeza da fila
    const builder: Record<string, unknown> = {};
    for (const method of ["eq", "in", "not", "select"])
      builder[method] = () => builder;
    builder.update = (row: Record<string, unknown>) => { writes.push(row); return builder; };
    builder.single = async () => ({ data: { id: "camp", status: "pausada", batch_size: batchSize }, error: null });
    builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
    return builder;
  });
  mocks.rpc.mockResolvedValue({ data: 7, error: null });
  mocks.resume.mockResolvedValue({ ok: true, resumed: 7 });
  expect(await startCampaign("camp", "acc")).toEqual({ ok: true, enqueued: 7 });
  expect(writes).toContainEqual({ pausa_automatica_motivo: null, auto_pausa_avaliar_desde: "2026-10-06T12:00:00.000Z" });
  if (batchSize === 1)
    expect(mocks.rpc).toHaveBeenCalledWith("resume_dispatch_campaign", { p_campaign_id: "camp", p_account_id: "acc" });
  else expect(mocks.resume).toHaveBeenCalled();
});
