import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  changedAiNodePrompts,
  collectAiNodePrompts,
  hashPromptContent,
  isMissingTableError,
  listPromptVersions,
  promptVersionOf,
  recordFlowNodePromptVersions,
  recordPromptVersion,
  shortPromptVersion,
} from "./prompt-versions";

describe("hashPromptContent / promptVersionOf", () => {
  it("sha256 hex igual ao encode(sha256(convert_to(...,'UTF8')),'hex') do Postgres", () => {
    // sha256("abc") — vetor de teste conhecido.
    expect(hashPromptContent("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(hashPromptContent("Olá, ção")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("versão curta = 12 primeiros caracteres; texto vazio não tem versão", () => {
    expect(shortPromptVersion(hashPromptContent("abc"))).toBe("ba7816bf8f01");
    expect(promptVersionOf("abc")).toBe("ba7816bf8f01");
    expect(promptVersionOf("   ")).toBeNull();
    expect(promptVersionOf(null)).toBeNull();
  });

  it("qualquer diferença (inclusive espaço) muda a versão", () => {
    expect(promptVersionOf("abc")).not.toBe(promptVersionOf("abc "));
  });
});

const aiNode = (node_key: string, prompt?: string) => ({
  node_key,
  node_type: "ai_agent",
  config: prompt === undefined ? {} : { system_prompt_override: prompt },
});

describe("collectAiNodePrompts / changedAiNodePrompts", () => {
  it("só nós ai_agent com instruções preenchidas", () => {
    const map = collectAiNodePrompts([
      aiNode("a", "Prompt A"),
      aiNode("b", "   "),
      aiNode("c"),
      { node_key: "d", node_type: "send_text", config: { system_prompt_override: "x" } },
    ]);
    expect([...map]).toEqual([["a", "Prompt A"]]);
  });

  it("aponta só o que mudou, inclusive nó novo", () => {
    const prev = [aiNode("a", "v1"), aiNode("b", "igual")];
    const next = [aiNode("a", "v2"), aiNode("b", "igual"), aiNode("c", "novo")];
    expect(changedAiNodePrompts(prev, next)).toEqual([
      { nodeKey: "a", content: "v2" },
      { nodeKey: "c", content: "novo" },
    ]);
  });

  it("nó que ficou vazio não gera versão", () => {
    expect(changedAiNodePrompts([aiNode("a", "v1")], [aiNode("a", "")])).toEqual([]);
  });
});

describe("isMissingTableError", () => {
  it("reconhece tabela ausente (148 não aplicada)", () => {
    expect(isMissingTableError({ code: "42P01" })).toBe(true);
    expect(isMissingTableError({ code: "PGRST205" })).toBe(true);
    expect(
      isMissingTableError({ message: "Could not find the table 'wacrm.ai_prompt_versions' in the schema cache" }),
    ).toBe(true);
    expect(isMissingTableError({ code: "23505" })).toBe(false);
    expect(isMissingTableError(null)).toBe(false);
  });
});

// Supabase fake: grava as chamadas e devolve o resultado configurado.
function fakeDb(results: { insert?: unknown; update?: unknown; select?: unknown }) {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const builder = (op: string, result: unknown) => {
    const chain: Record<string, unknown> = {};
    for (const m of ["eq", "is", "order", "range", "select"]) {
      chain[m] = (...args: unknown[]) => {
        calls.push({ op: `${op}.${m}`, args });
        return chain;
      };
    }
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
    return chain;
  };
  const db = {
    from: vi.fn(() => ({
      insert: (row: unknown) => {
        calls.push({ op: "insert", args: [row] });
        return Promise.resolve(results.insert ?? { error: null });
      },
      update: (patch: unknown) => {
        calls.push({ op: "update", args: [patch] });
        return builder("update", results.update ?? { error: null });
      },
      select: (cols: unknown) => {
        calls.push({ op: "select", args: [cols] });
        return builder("select", results.select ?? { data: [], error: null });
      },
    })),
  };
  return { db: db as unknown as SupabaseClient, calls };
}

describe("recordPromptVersion", () => {
  it("texto vazio: não grava", async () => {
    const { db, calls } = fakeDb({});
    expect(await recordPromptVersion(db, { accountId: "acc", target: { scope: "account" }, content: "  " })).toBe(
      "skipped",
    );
    expect(calls).toEqual([]);
  });

  it("texto novo: insere com hash e autor", async () => {
    const { db, calls } = fakeDb({});
    const out = await recordPromptVersion(db, {
      accountId: "acc",
      target: { scope: "flow_node", flowId: "f1", nodeKey: "agente_ddm" },
      content: "abc",
      userId: "u1",
    });
    expect(out).toBe("created");
    expect(calls[0].op).toBe("insert");
    expect(calls[0].args[0]).toMatchObject({
      account_id: "acc",
      scope: "flow_node",
      flow_id: "f1",
      node_key: "agente_ddm",
      content: "abc",
      content_hash: hashPromptContent("abc"),
      source: "ui",
      created_by: "u1",
    });
  });

  it("texto já existente (23505): só re-salva last_saved_at", async () => {
    const { db, calls } = fakeDb({ insert: { error: { code: "23505", message: "dup" } } });
    const out = await recordPromptVersion(db, {
      accountId: "acc",
      target: { scope: "account" },
      content: "abc",
      userId: "u1",
    });
    expect(out).toBe("existing");
    expect(calls.map((c) => c.op)).toContain("update");
    expect(calls).toContainEqual({ op: "update.is", args: ["flow_id", null] });
    expect(calls).toContainEqual({ op: "update.is", args: ["node_key", null] });
  });

  it("erro (ex.: tabela ausente) não lança", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = fakeDb({ insert: { error: { code: "42P01", message: "relation does not exist" } } });
    await expect(
      recordPromptVersion(db, { accountId: "acc", target: { scope: "account" }, content: "abc" }),
    ).resolves.toBe("failed");
    const throwing = { from: () => { throw new Error("boom"); } } as unknown as SupabaseClient;
    await expect(
      recordPromptVersion(throwing, { accountId: "acc", target: { scope: "account" }, content: "abc" }),
    ).resolves.toBe("failed");
    spy.mockRestore();
  });
});

describe("recordFlowNodePromptVersions", () => {
  it("com versão anterior grava só os nós alterados", async () => {
    const { db, calls } = fakeDb({});
    await recordFlowNodePromptVersions(db, {
      accountId: "acc",
      flowId: "f1",
      nodes: [aiNode("a", "v2"), aiNode("b", "igual")],
      onlyChangedFrom: [aiNode("a", "v1"), aiNode("b", "igual")],
    });
    const inserts = calls.filter((c) => c.op === "insert");
    expect(inserts).toHaveLength(1);
    expect(inserts[0].args[0]).toMatchObject({ node_key: "a", content: "v2" });
  });

  it("sem versão anterior (ativação) grava todos", async () => {
    const { db, calls } = fakeDb({});
    await recordFlowNodePromptVersions(db, {
      accountId: "acc",
      flowId: "f1",
      nodes: [aiNode("a", "v2"), aiNode("b", "igual")],
    });
    expect(calls.filter((c) => c.op === "insert")).toHaveLength(2);
  });
});

describe("listPromptVersions", () => {
  it("tabela ausente → lista vazia, sem erro", async () => {
    const { db } = fakeDb({ select: { data: null, error: { code: "PGRST205", message: "schema cache" } } });
    expect(await listPromptVersions(db, "acc", { scope: "account" })).toEqual({ rows: [], error: null });
  });

  it("filtra pelo nó do fluxo", async () => {
    const row = { id: "1", content: "abc" };
    const { db, calls } = fakeDb({ select: { data: [row], error: null } });
    const out = await listPromptVersions(db, "acc", { scope: "flow_node", flowId: "f1", nodeKey: "n1" });
    expect(out.rows).toEqual([row]);
    expect(calls).toContainEqual({ op: "select.eq", args: ["flow_id", "f1"] });
    expect(calls).toContainEqual({ op: "select.eq", args: ["node_key", "n1"] });
  });
});
