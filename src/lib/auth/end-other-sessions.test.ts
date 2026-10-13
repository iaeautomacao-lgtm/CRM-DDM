// Depois da troca de senha pelo próprio usuário: encerra as OUTRAS sessões pela rota de servidor (revisão de segurança 13/10).
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-fetch", () => ({ apiFetch }));

const { endOtherSessions } = await import("./end-other-sessions");

beforeEach(() => apiFetch.mockReset());

describe("endOtherSessions", () => {
  it("chama POST /api/me/sessions/revoke-others e devolve true no 200", async () => {
    apiFetch.mockResolvedValue(new Response(JSON.stringify({ revoked: 2 }), { status: 200 }));
    expect(await endOtherSessions()).toBe(true);
    expect(apiFetch).toHaveBeenCalledWith("/api/me/sessions/revoke-others", { method: "POST" });
  });

  it("falha (409 sem sessão identificada, rede) devolve false sem lançar", async () => {
    apiFetch.mockResolvedValueOnce(new Response("{}", { status: 409 }));
    expect(await endOtherSessions()).toBe(false);
    apiFetch.mockRejectedValueOnce(new Error("rede"));
    expect(await endOtherSessions()).toBe(false);
  });
});
