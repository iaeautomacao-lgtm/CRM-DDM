import { afterEach, describe, expect, it } from "vitest";
import {
  generateWebchatToken,
  hashWebchatToken,
  isWellFormedWebchatToken,
  webchatUrl,
} from "./token";

describe("webchat token", () => {
  const originalUrl = process.env.NEXT_PUBLIC_APP_URL;
  afterEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = originalUrl;
  });

  it("generates url-safe, well-formed, unique tokens", () => {
    const a = generateWebchatToken();
    const b = generateWebchatToken();
    expect(a).not.toBe(b);
    expect(isWellFormedWebchatToken(a)).toBe(true);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("stores only a stable sha256 of the token", () => {
    const token = generateWebchatToken();
    expect(hashWebchatToken(token)).toBe(hashWebchatToken(token));
    expect(hashWebchatToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashWebchatToken(token)).not.toContain(token);
  });

  it("rejects malformed tokens before any lookup", () => {
    expect(isWellFormedWebchatToken("")).toBe(false);
    expect(isWellFormedWebchatToken("short")).toBe(false);
    expect(isWellFormedWebchatToken("../../etc/passwd-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(false);
  });

  it("builds the public URL from NEXT_PUBLIC_APP_URL", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://crm.example.com";
    expect(webchatUrl("abc")).toBe("https://crm.example.com/w/abc");
  });

  it("refuses to build a link without an explicit app URL", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(() => webchatUrl("abc")).toThrow(/NEXT_PUBLIC_APP_URL/);
  });
});
