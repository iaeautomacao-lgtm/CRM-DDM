import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { SESSION_COOKIE_MAX_AGE_SECONDS, sessionCookieOptions } from "./cookie-options";

describe("sessionCookieOptions", () => {
  it("produção: Secure, SameSite=Lax, vida de 7 dias (não os 400 dias do padrão)", () => {
    expect(sessionCookieOptions("production")).toEqual({ path: "/", sameSite: "lax", secure: true, maxAge: 7 * 24 * 60 * 60 });
    expect(SESSION_COOKIE_MAX_AGE_SECONDS).toBeLessThan(400 * 24 * 60 * 60);
  });

  it("desenvolvimento e teste: sem Secure (http://localhost descartaria o cookie)", () => {
    for (const env of ["development", "test", undefined]) expect(sessionCookieOptions(env).secure).toBe(false);
  });

  it("não define `name` nem `domain` (o middleware deriva o nome sb-<ref>-auth-token e o cookie fica no host)", () => {
    expect(Object.keys(sessionCookieOptions("production")).sort()).toEqual(["maxAge", "path", "sameSite", "secure"]);
  });
});

describe("os 3 clientes Supabase usam as mesmas opções", () => {
  for (const file of ["src/lib/supabase/client.ts", "src/lib/supabase/server.ts", "src/app/auth/callback/route.ts"]) {
    it(file, () => {
      const src = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(src).toContain("cookieOptions: sessionCookieOptions()");
    });
  }
});
