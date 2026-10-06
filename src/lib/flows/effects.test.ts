import { describe, expect, it } from "vitest";
import {
  flowEffects,
  liveFlowEffects,
  runWithFlowEffects,
  viaFlowEffects,
  type FlowEffects,
} from "./effects";

function fakeEffects(tag: string): FlowEffects {
  return {
    ...liveFlowEffects,
    mode: "simulation",
    writeLog: async () => {
      throw new Error(`writeLog:${tag}`);
    },
  };
}

describe("flowEffects", () => {
  it("fora do simulador devolve os efeitos reais", () => {
    expect(flowEffects()).toBe(liveFlowEffects);
    expect(flowEffects().mode).toBe("live");
  });

  it("dentro de runWithFlowEffects troca só para aquela cadeia async", async () => {
    const sim = fakeEffects("a");
    const inside = await runWithFlowEffects(sim, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return flowEffects();
    });
    expect(inside).toBe(sim);
    expect(flowEffects()).toBe(liveFlowEffects);
  });

  it("duas cadeias simultâneas não se misturam (webhook real × simulação)", async () => {
    const sim = fakeEffects("b");
    const [simSeen, liveSeen] = await Promise.all([
      runWithFlowEffects(sim, async () => {
        await new Promise((r) => setTimeout(r, 5));
        return flowEffects().mode;
      }),
      (async () => {
        await new Promise((r) => setTimeout(r, 1));
        return flowEffects().mode;
      })(),
    ]);
    expect(simSeen).toBe("simulation");
    expect(liveSeen).toBe("live");
  });

  it("viaFlowEffects resolve a implementação na hora da chamada", async () => {
    const writeLog = viaFlowEffects("writeLog");
    await expect(
      runWithFlowEffects(fakeEffects("c"), () =>
        writeLog({ level: "info", source: "flows", event: "x", message: "y" }),
      ),
    ).rejects.toThrow("writeLog:c");
  });
});
