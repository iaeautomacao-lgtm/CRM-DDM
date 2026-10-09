import { describe, expect, it, vi } from "vitest";
import { chunk, mergeBatches, newlyAssigned, runBatch, type BatchItemResult } from "./batch-client";

const item = (id: string, ok = true, code?: BatchItemResult["code"]): BatchItemResult => ({ conversation_id: id, ok, ...(code ? { code } : {}) });

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe("monitoramento batch-client", () => {
  it("divide em blocos de 50", () => {
    const ids = Array.from({ length: 120 }, (_, i) => String(i));
    expect(chunk(ids).map((b) => b.length)).toEqual([50, 50, 20]);
    expect(chunk([])).toEqual([]);
  });

  it("junta resultados e recalcula o resumo", () => {
    const merged = mergeBatches([
      { summary: { total: 2, ok: 1, failed: 1 }, results: [item("a"), item("b", false, "error")] },
      { summary: { total: 1, ok: 1, failed: 0 }, results: [item("c", true, "already_mine")] },
    ]);
    expect(merged.summary).toEqual({ total: 3, ok: 2, failed: 1 });
  });

  it("só manda a mensagem de assumir para ok que não eram já do usuário", () => {
    expect(newlyAssigned([item("a"), item("b", true, "already_mine"), item("c", false, "error")])).toEqual(["a"]);
  });

  it("para no bloco que falhou e devolve o que ficou pendente", async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `id${i}`);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ summary: { total: 50, ok: 50, failed: 0 }, results: ids.slice(0, 50).map((id) => item(id)) }))
      .mockResolvedValueOnce(jsonResponse({ error: "Sem permissão" }, 403));
    const out = await runBatch({ fetcher }, "finalizar", { outcome_tag_id: "t" }, ids);
    expect(out.done.summary.ok).toBe(50);
    expect(out.pending).toHaveLength(10);
    expect(out.error).toBe("Sem permissão");
    expect(JSON.parse(fetcher.mock.calls[0][1].body as string).conversation_ids).toHaveLength(50);
  });
});
