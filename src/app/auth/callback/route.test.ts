// /auth/callback: troca do code (PKCE, como antes) e, novo, o link de definição de senha gerado pelo servidor (convite em
// lote — revisão de segurança 13/10): token_hash + type=recovery, verificado com verifyOtp. Outro type não vale.
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  exchangeCodeForSession: vi.fn(async () => ({ error: null as unknown })),
  verifyOtp: vi.fn(async () => ({ error: null as unknown })),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: () => undefined }) }));
vi.mock("@supabase/ssr", () => ({ createServerClient: () => ({ auth }) }));

const { GET } = await import("./route");
const call = (qs: string) => GET(new Request(`https://crm.exemplo.com/auth/callback?${qs}`));

beforeEach(() => {
  auth.exchangeCodeForSession.mockClear();
  auth.verifyOtp.mockClear();
});

describe("GET /auth/callback", () => {
  it("code (PKCE): troca e redireciona para o next", async () => {
    const res = await call("code=abc&next=/inbox");
    expect(auth.exchangeCodeForSession).toHaveBeenCalledWith("abc");
    expect(res.headers.get("location")).toBe("https://crm.exemplo.com/inbox");
  });

  it("token_hash + type=recovery: verifyOtp e vai para a definição de senha", async () => {
    const res = await call("token_hash=h1&type=recovery&next=/reset-password");
    expect(auth.verifyOtp).toHaveBeenCalledWith({ type: "recovery", token_hash: "h1" });
    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toBe("https://crm.exemplo.com/reset-password");
  });

  it("outro type (ex.: magiclink) não é aceito; token inválido cai na tela de erro da recuperação", async () => {
    const other = await call("token_hash=h1&type=magiclink&next=/inbox");
    expect(auth.verifyOtp).not.toHaveBeenCalled();
    expect(other.headers.get("location")).toContain("/login?error=auth-callback-failed");
    auth.verifyOtp.mockResolvedValueOnce({ error: { message: "expired" } });
    const expired = await call("token_hash=h1&type=recovery&next=/reset-password");
    expect(expired.headers.get("location")).toContain("/reset-password?error=");
  });
});
