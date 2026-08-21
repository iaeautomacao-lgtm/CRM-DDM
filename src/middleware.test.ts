import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

// SUPABASE_PROJECT_REF is derived from NEXT_PUBLIC_SUPABASE_URL by a
// top-level IIFE in middleware.ts, evaluated once at module load — it
// must be set BEFORE the dynamic import below, not in a beforeEach,
// or the module would already have resolved to the fallback ref.
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";

const { middleware } = await import("./middleware");

const AUTH_COOKIE_NAME = "sb-test-auth-token";

function sessionCookieJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    access_token: "fake-access-token",
    refresh_token: "fake-refresh-token",
    ...overrides,
  });
}

function requestWithCookie(url: string, name: string, value: string): NextRequest {
  const req = new NextRequest(url);
  req.cookies.set(name, value);
  return req;
}

/** A request carrying a valid, unchunked, unencoded session cookie. */
function authedRequest(url: string): NextRequest {
  return requestWithCookie(url, AUTH_COOKIE_NAME, sessionCookieJson());
}

describe("middleware auth", () => {
  it("allows an authenticated protected page", async () => {
    const res = await middleware(authedRequest("https://app.test/dashboard"));

    expect(res.headers.get("location")).toBeNull();
  });

  it("redirects protected routes to login when there's no session cookie", async () => {
    const res = await middleware(new NextRequest("https://app.test/dashboard"));

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
    expect(res.headers.get("location")).toContain("auth_failed=true");
    expect(res.headers.get("location")).toContain("auth_err=no_session_cookie");
    expect(res.headers.get("cache-control")).toBe(
      "private, no-store, no-cache, max-age=0, must-revalidate",
    );
  });

  it("never sets cookies on the response — it only reads, unlike the old SDK-backed middleware", async () => {
    // The previous implementation could rotate/refresh the session via
    // the Supabase SDK and forward the resulting Set-Cookie headers.
    // This one never touches the SDK, so it can never write cookies of
    // its own — true whether the request is authenticated or not.
    const anon = await middleware(new NextRequest("https://app.test/dashboard"));
    const authed = await middleware(authedRequest("https://app.test/dashboard"));

    expect(anon.cookies.getAll()).toHaveLength(0);
    expect(authed.cookies.getAll()).toHaveLength(0);
  });

  it("redirects an authenticated user away from /login with no-store", async () => {
    const res = await middleware(authedRequest("https://app.test/login"));

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/dashboard");
    expect(res.headers.get("cache-control")).toBe(
      "private, no-store, no-cache, max-age=0, must-revalidate",
    );
  });

  it("returns 401 for protected WhatsApp API routes when signed out", async () => {
    const res = await middleware(new NextRequest("https://app.test/api/whatsapp/send"));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("returns 401 for protected Disparador API routes when signed out", async () => {
    const res = await middleware(new NextRequest("https://app.test/api/disparador/campaigns/1"));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("allows an authenticated protected route", async () => {
    const res = await middleware(authedRequest("https://app.test/flows"));

    expect(res.headers.get("location")).toBeNull();
  });

  // These exercise hasSessionCookie's actual parsing logic directly —
  // the new implementation's real "core" (see middleware.ts), which
  // the SDK-mocked tests above never touched at all.
  describe("session cookie parsing", () => {
    it("accepts a base64url-encoded cookie value (@supabase/ssr's default cookieEncoding)", async () => {
      const encoded =
        "base64-" + Buffer.from(sessionCookieJson(), "utf-8").toString("base64url");

      const res = await middleware(
        requestWithCookie("https://app.test/dashboard", AUTH_COOKIE_NAME, encoded),
      );

      expect(res.headers.get("location")).toBeNull();
    });

    it("reassembles a session cookie chunked across .0/.1/... cookies", async () => {
      const encoded =
        "base64-" + Buffer.from(sessionCookieJson(), "utf-8").toString("base64url");
      const mid = Math.floor(encoded.length / 2);

      const req = new NextRequest("https://app.test/dashboard");
      req.cookies.set(`${AUTH_COOKIE_NAME}.0`, encoded.slice(0, mid));
      req.cookies.set(`${AUTH_COOKIE_NAME}.1`, encoded.slice(mid));
      const res = await middleware(req);

      expect(res.headers.get("location")).toBeNull();
    });

    it("treats a session cookie with no access_token as unauthenticated", async () => {
      const req = requestWithCookie(
        "https://app.test/dashboard",
        AUTH_COOKIE_NAME,
        JSON.stringify({ refresh_token: "only-a-refresh-token" }),
      );
      const res = await middleware(req);

      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toContain("/login");
    });

    it("treats a corrupt cookie value as unauthenticated instead of throwing", async () => {
      const req = requestWithCookie(
        "https://app.test/dashboard",
        AUTH_COOKIE_NAME,
        "not-valid-json-or-base64",
      );
      const res = await middleware(req);

      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toContain("/login");
    });
  });
});
