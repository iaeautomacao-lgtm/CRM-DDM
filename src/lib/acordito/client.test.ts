import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("@/lib/api-fetch", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import {
  ACORDITO_MESSAGES,
  AcorditoError,
  errorCodeOf,
  fetchCopilotConfig,
  fetchSuggestions,
  parseSuggestions,
  saveCopilotConfig,
  sendFeedback,
} from "./client";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => apiFetch.mockReset());

describe("Acordito · sugestões", () => {
  it("manda conversationId e só inclui force quando pedido", async () => {
    apiFetch.mockResolvedValue(json(200, { suggestions: [{ id: "s1", text: "Oi!" }], basedOnMessageId: "m1", cached: true }));
    const res = await fetchSuggestions("c1");
    expect(JSON.parse(apiFetch.mock.calls[0][1].body)).toEqual({ conversationId: "c1" });
    expect(res).toEqual({ suggestions: [{ id: "s1", text: "Oi!" }], basedOnMessageId: "m1", cached: true });
    apiFetch.mockResolvedValue(json(200, { suggestions: [], basedOnMessageId: null, cached: false }));
    await fetchSuggestions("c1", { force: true });
    expect(JSON.parse(apiFetch.mock.calls[1][1].body)).toEqual({ conversationId: "c1", force: true });
  });

  it("filtra sugestões inválidas e limita a 3", () => {
    const r = parseSuggestions({
      suggestions: [{ id: "1", text: "a" }, { id: 2, text: "x" }, { id: "3", text: "  " }, { id: "4", text: "d" }, { id: "5", text: "e" }, { id: "6", text: "f" }],
    });
    expect(r.suggestions.map((s) => s.id)).toEqual(["1", "4", "5"]);
    expect(parseSuggestions(null).suggestions).toEqual([]);
  });

  it.each(["ai_not_configured", "copilot_disabled", "quota_exceeded", "forbidden"] as const)("mapeia o erro %s", async (code) => {
    apiFetch.mockResolvedValue(json(code === "forbidden" ? 403 : 409, { code }));
    await expect(fetchSuggestions("c1")).rejects.toMatchObject({ code, message: ACORDITO_MESSAGES[code] });
  });

  it("código desconhecido ou rede caída vira unknown; 403 sem código vira forbidden", async () => {
    apiFetch.mockResolvedValue(json(500, { code: "xyz" }));
    await expect(fetchSuggestions("c1")).rejects.toMatchObject({ code: "unknown" });
    apiFetch.mockImplementation(() => Promise.reject(new Error("rede")));
    await expect(fetchSuggestions("c1")).rejects.toBeInstanceOf(AcorditoError);
    apiFetch.mockResolvedValue(json(403, {}));
    await expect(fetchSuggestions("c1")).rejects.toMatchObject({ code: "forbidden" });
    expect(errorCodeOf(undefined)).toBe("unknown");
  });
});

describe("Acordito · feedback e configuração", () => {
  it("feedback é fire-and-forget e não propaga falha", async () => {
    const attached = vi.fn();
    apiFetch.mockReturnValue({ catch: attached });
    expect(() => sendFeedback("s1", "used")).not.toThrow();
    // Há um .catch engolindo a falha: a métrica nunca derruba o atendimento.
    expect(attached).toHaveBeenCalledTimes(1);
    expect(apiFetch.mock.calls[0][0]).toBe("/api/ai/copilot/feedback");
    expect(JSON.parse(apiFetch.mock.calls[0][1].body)).toEqual({ suggestionId: "s1", action: "used" });
  });

  it("lê e grava a configuração", async () => {
    apiFetch.mockResolvedValue(json(200, { enabled: true, guidance: "Seja breve." }));
    expect(await fetchCopilotConfig()).toEqual({ enabled: true, guidance: "Seja breve." });
    apiFetch.mockResolvedValue(json(200, { enabled: false, guidance: "" }));
    expect(await saveCopilotConfig({ enabled: false, guidance: "" })).toEqual({ enabled: false, guidance: "" });
    expect(apiFetch.mock.calls[1][1].method).toBe("PUT");
  });

  it("gravar sem permissão devolve mensagem clara", async () => {
    apiFetch.mockResolvedValue(json(403, { code: "forbidden" }));
    await expect(saveCopilotConfig({ enabled: true, guidance: "x" })).rejects.toThrow(/configura a IA/);
  });
});
