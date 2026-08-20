import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

let mockUser: { id: string } | null = null;
let mockUserError: { message: string; name?: string; status?: number } | null = null;
let refreshedCookies: Array<{
  name: string;
  value: string;
  options: Record<string, unknown>;
}> = [];
const fromSpy = vi.fn();

vi.mock("@supabase/ssr", () => ({
  createServerClient: (
    _url: string,
    _key: string,
    opts: {
      cookies: { setAll: (c: typeof refreshedCookies) => void };
    },
  ) => ({
    auth: {
      getUser: async () => {
        if (refreshedCookies.length) opts.cookies.setAll(refreshedCookies);
        return {
          data: { user: mockUser },
          error: mockUserError,
        };
      },
    },
    from: fromSpy,
  }),
}));

const { middleware } = await import("./middleware");

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  mockUser = null;
  mockUserError = null;
  refreshedCookies = [];
  fromSpy.mockReset();
});

afterEach(() => vi.clearAllMocks());

const ROTATED = {
  name: "sb-test-auth-token",
  value: "rotated-refresh-token",
  options: { path: "/", httpOnly: true },
};

const authMissing = {
  message: "Auth session missing!",
  name: "AuthSessionMissingError",
  status: 400,
};

describe("middleware auth", () => {
  it("allows an authenticated protected page without querying profiles", async () => {
    mockUser = { id: "user-1" };

    const res = await middleware(new NextRequest("https://app.test/dashboard"));

    expect(res.headers.get("location")).toBeNull();
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it("redirects protected routes to login when user is missing", async () => {
    mockUser = null;
    mockUserError = authMissing;

    const res = await middleware(new NextRequest("https://app.test/dashboard"));

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
    expect(res.headers.get("location")).toContain("auth_failed=true");
    expect(res.headers.get("location")).toContain("auth_err=Auth+session+missing%21");
    expect(res.headers.get("cache-control")).toBe(
      "private, no-store, no-cache, max-age=0, must-revalidate",
    );
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it("keeps refreshed cookies on auth redirects", async () => {
    mockUser = null;
    mockUserError = authMissing;
    refreshedCookies = [ROTATED];

    const res = await middleware(new NextRequest("https://app.test/dashboard"));

    expect(res.headers.get("location")).toContain("/login");
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it("redirects an authenticated user away from /login with no-store", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await middleware(new NextRequest("https://app.test/login"));

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/dashboard");
    expect(res.headers.get("cache-control")).toBe(
      "private, no-store, no-cache, max-age=0, must-revalidate",
    );
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it("returns 401 for protected WhatsApp API routes when signed out", async () => {
    mockUser = null;

    const res = await middleware(new NextRequest("https://app.test/api/whatsapp/send"));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it("returns 401 for protected Disparador API routes when signed out", async () => {
    mockUser = null;

    const res = await middleware(new NextRequest("https://app.test/api/disparador/campaigns/1"));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it("allows an authenticated protected route with refreshed cookies and no DB role lookup", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await middleware(new NextRequest("https://app.test/flows"));

    expect(res.headers.get("location")).toBeNull();
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
    expect(fromSpy).not.toHaveBeenCalled();
  });
});
