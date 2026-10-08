import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  error: null as { message: string } | null,
  queries: 0,
  filters: [] as Array<[string, unknown]>,
}));
vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({
    from: () => {
      const b: Record<string, any> = {};
      b.select = () => b;
      b.eq = (c: string, v: unknown) => (state.filters.push([c, v]), b);
      b.in = (c: string, v: unknown) => (state.filters.push([c, v]), b);
      b.then = (resolve: (v: unknown) => unknown) => {
        state.queries++;
        return Promise.resolve({ data: state.error ? null : state.rows, error: state.error }).then(resolve);
      };
      return b;
    },
  }),
}));

import { listAccountTools, mergeTools, resolveEffectiveTools } from "./runtime";
import type { AiAgentTool } from "@/lib/flows/types";

const row = (id: string, name: string, enabled = true) => ({
  id,
  name,
  description: `d-${name}`,
  parameters: { type: "object" as const, properties: {}, required: [] },
  http: { url: `https://api.exemplo.com/${name}`, method: "GET" as const },
  timeout_ms: 8000,
  enabled,
});
const inline = (name: string): AiAgentTool => ({
  name,
  description: "inline",
  parameters: { type: "object", properties: {} },
  http: { url: "https://x.com/i", method: "GET" },
});

describe("mergeTools", () => {
  it("catálogo na ordem dos refs, depois inline", () => {
    const out = mergeTools([row("a", "alfa"), row("b", "beta")], ["b", "a"], [inline("zeta")]);
    expect(out.map((t) => t.name)).toEqual(["beta", "alfa", "zeta"]);
    expect(out[0]).toMatchObject({ description: "d-beta", timeout_ms: 8000 });
  });

  it("ferramenta DESLIGADA some da lista enviada ao modelo", () => {
    const out = mergeTools([row("a", "alfa", false), row("b", "beta")], ["a", "b"], []);
    expect(out.map((t) => t.name)).toEqual(["beta"]);
  });

  it("ref inexistente (apagada ou de outra conta) é ignorada", () => {
    expect(mergeTools([row("a", "alfa")], ["a", "fantasma"], undefined).map((t) => t.name)).toEqual(["alfa"]);
  });

  it("nome duplicado: vale a primeira (catálogo antes do inline) e o resto é reportado", () => {
    const dups: string[] = [];
    const out = mergeTools([row("a", "buscar")], ["a"], [inline("buscar"), inline("outra")], (n) => dups.push(n));
    expect(out.map((t) => t.description)).toEqual(["d-buscar", "inline"]);
    expect(out.map((t) => t.name)).toEqual(["buscar", "outra"]);
    expect(dups).toEqual(["buscar"]);
  });
});

describe("resolveEffectiveTools", () => {
  beforeEach(() => {
    state.rows = [];
    state.error = null;
    state.queries = 0;
    state.filters = [];
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("sem tool_refs: devolve o inline como está, sem consultar o banco (compatibilidade)", async () => {
    const tools = [inline("a")];
    expect(await resolveEffectiveTools("ACC", tools, undefined)).toBe(tools);
    expect(await resolveEffectiveTools("ACC", tools, [])).toBe(tools);
    expect(await resolveEffectiveTools("ACC", undefined, undefined)).toBeUndefined();
    expect(state.queries).toBe(0);
  });

  it("com refs: consulta o catálogo filtrando pela conta e pelos ids", async () => {
    state.rows = [row("a", "alfa")];
    const out = await resolveEffectiveTools("ACC-1", [inline("z")], ["a"]);
    expect(out?.map((t) => t.name)).toEqual(["alfa", "z"]);
    expect(state.filters).toContainEqual(["account_id", "ACC-1"]);
    expect(state.filters).toContainEqual(["id", ["a"]]);
  });

  it("falha ao ler o catálogo: segue só com o inline (o atendimento não cai)", async () => {
    state.error = { message: "timeout" };
    const out = await resolveEffectiveTools("ACC", [inline("z")], ["a"]);
    expect(out?.map((t) => t.name)).toEqual(["z"]);
  });

  it("listAccountTools: falha de leitura = null (o validador não acusa referências à toa)", async () => {
    state.error = { message: "x" };
    expect(await listAccountTools("ACC")).toBeNull();
    state.error = null;
    state.rows = [{ id: "a", name: "alfa", enabled: true }];
    expect(await listAccountTools("ACC")).toEqual([{ id: "a", name: "alfa", enabled: true }]);
  });
});
