import { describe, expect, it, vi } from "vitest";

import { createPrefetcher, prefetchPath } from "./prefetch";

describe("pré-carregar telas por intenção", () => {
  it("usa só o caminho (sem ?query nem #âncora)", () => {
    expect(prefetchPath("/settings?tab=agents")).toBe("/settings");
    expect(prefetchPath("/relatorios/atendimentos#topo")).toBe("/relatorios/atendimentos");
  });

  it("pede cada destino uma vez só, mesmo com várias passadas do mouse", () => {
    const fn = vi.fn();
    const go = createPrefetcher(fn);
    expect(go("/flows")).toBe(true);
    expect(go("/flows")).toBe(false);
    expect(go("/settings?tab=ai")).toBe(true);
    expect(go("/settings?tab=agents")).toBe(false); // mesma tela, outra aba
    expect(fn.mock.calls.map((c) => c[0])).toEqual(["/flows", "/settings"]);
  });

  it("ignora endereço externo e tolera falha (o clique segue funcionando; tenta de novo depois)", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("rede")).mockResolvedValue(undefined);
    const go = createPrefetcher(fn);
    expect(go("https://exemplo.com/x")).toBe(false);
    expect(go("/contacts")).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(go("/contacts")).toBe(true); // falhou: pode tentar de novo
    expect(fn).toHaveBeenCalledTimes(2);
    const quebra = createPrefetcher(() => {
      throw new Error("síncrono");
    });
    expect(() => quebra("/a")).not.toThrow();
  });
});
