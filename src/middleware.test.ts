import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

let mockClaims: { sub: string } | null = null;
let mockClaimsError: { message: string; name?: string; status?: number } | null = null;
let mockRole: string | null = "owner";
let mockRoleError: { message: string } | null = null;
let refreshedCookies: Array<{
  name: string;
  value: string;
  options: Record<string, unknown>;
}> = [];
let queriedUserId: string | null = null;

vi.mock("@supabase/ssr", () => ({
  createServerClient: (
    _url: string,
    _key: string,
    opts: {
      cookies: { setAll: (c: typeof refreshedCookies) => void };
    },
  ) => ({
    auth: {
      getClaims: async () => {
        if (refreshedCookies.length) opts.cookies.setAll(refreshedCookies);
        return {
          data: { claims: mockClaims },
          error: mockClaimsError,
        };
      },
    },
    from: (table: string) => {
      expect(table).toBe("profiles");
      return {
        select: (columns: string) => {
          expect(columns).toBe("account_role");
          return {
            eq: (column: string, value: string) => {
              expect(column).toBe("user_id");
              queriedUserId = value;
              return {
                maybeSingle: async () => ({
                  data: mockRole ? { account_role: mockRole } : null,
                  error: mockRoleError,
                }),
              };
            },
          };
        },
      };
    },
  }),
}));

const { middleware } = await import("./middleware");

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  mockClaims = null;
  mockClaimsError = null;
  mockRole = "owner";
  mockRoleError = null;
  refreshedCookies = [];
  queriedUserId = null;
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
  it("uses claims.sub as the authenticated user id for RBAC", async () => {
    mockClaims = { sub: "user-1" };
    mockRole = "owner";

    const res = await middleware(new NextRequest("https://app.test/dashboard"));

    expect(res.headers.get("location")).toBeNull();
    expect(queriedUserId).toBe("user-1");
  });

  it("redirects protected routes to login when claims are missing", async () => {
    mockClaims = null;
    mockClaimsError = authMissing;

    const res = await middleware(new NextRequest("https://app.test/dashboard"));

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
    expect(res.headers.get("location")).toContain("auth_failed=true");
    expect(res.headers.get("location")).toContain("auth_err=Auth+session+missing%21");
    expect(res.headers.get("cache-control")).toBe(
      "private, no-store, no-cache, max-age=0, must-revalidate",
    );
    expect(queriedUserId).toBeNull();
  });

  it("keeps refreshed cookies on auth redirects", async () => {
    mockClaims = null;
    mockClaimsError = authMissing;
    refreshedCookies = [ROTATED];

    const res = await middleware(new NextRequest("https://app.test/dashboard"));

    expect(res.headers.get("location")).toContain("/login");
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it("redirects an authenticated user away from /login with no-store", async () => {
    mockClaims = { sub: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await middleware(new NextRequest("https://app.test/login"));

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/dashboard");
    expect(res.headers.get("cache-control")).toBe(
      "private, no-store, no-cache, max-age=0, must-revalidate",
    );
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
    expect(queriedUserId).toBeNull();
  });

  it("redirects RBAC-denied users with no-store", async () => {
    mockClaims = { sub: "user-1" };
    mockRole = "viewer";

    const res = await middleware(new NextRequest("https://app.test/flows"));

    expect(queriedUserId).toBe("user-1");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/dashboard");
    expect(res.headers.get("cache-control")).toBe(
      "private, no-store, no-cache, max-age=0, must-revalidate",
    );
  });

  it("returns the normal response for an authenticated and authorized route", async () => {
    mockClaims = { sub: "user-1" };
    mockRole = "owner";
    refreshedCookies = [ROTATED];

    const res = await middleware(new NextRequest("https://app.test/flows"));

    expect(queriedUserId).toBe("user-1");
    expect(res.headers.get("location")).toBeNull();
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });
});
