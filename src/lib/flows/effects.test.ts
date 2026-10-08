import { describe, expect, it, vi } from "vitest";

const safeFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/security/ssrf-guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/ssrf-guard")>()),
  safeFetch: safeFetchMock,
}));

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

describe("http_fetch × guard anti-SSRF (#98)", () => {
  it("produção: httpFetch passa pelo safeFetch com o timeout do nó", async () => {
    safeFetchMock.mockReset().mockResolvedValue(new Response("{}", { status: 200 }));
    await liveFlowEffects.httpFetch("n1", "https://api.exemplo.com/x", { method: "POST", headers: { a: "b" }, body: "{}" }, { timeoutMs: 7000 });
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    const [url, init, options] = safeFetchMock.mock.calls[0];
    expect(url).toBe("https://api.exemplo.com/x");
    expect(init).toMatchObject({ method: "POST", body: "{}" });
    expect(options).toEqual({ timeoutMs: 7000 });
  });

  it("simulador: httpFetch mockado nunca chama safeFetch nem rede", async () => {
    safeFetchMock.mockReset();
    const sim: FlowEffects = {
      ...liveFlowEffects,
      mode: "simulation",
      httpFetch: async () => new Response("mock", { status: 200 }),
    };
    const res = await runWithFlowEffects(sim, () => flowEffects().httpFetch("n1", "http://169.254.169.254/", { method: "GET" }, { timeoutMs: 1000 }));
    expect(await res.text()).toBe("mock");
    expect(safeFetchMock).not.toHaveBeenCalled();
  });
});
