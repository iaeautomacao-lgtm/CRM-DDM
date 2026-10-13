import { beforeEach, describe, expect, it } from "vitest";
import { __resetRateLimitForTests, __setSharedBackendForTests } from "@/lib/rate-limit";
import { enforceRateLimit, rejectOversizedBody } from "./guards";

beforeEach(() => {
  __resetRateLimitForTests();
  __setSharedBackendForTests(null); // só o Map do processo
});

describe("enforceRateLimit", () => {
  it("deixa passar até o limite e devolve 429 com Retry-After depois", async () => {
    const opts = { limit: 2, windowMs: 60_000 };
    expect(await enforceRateLimit("t:a", opts)).toBeNull();
    expect(await enforceRateLimit("t:a", opts)).toBeNull();
    const res = await enforceRateLimit("t:a", opts);
    expect(res?.status).toBe(429);
    expect(res?.headers.get("retry-after")).toBeTruthy();
  });

  it("o limite é por chave (outro usuário não é afetado)", async () => {
    const opts = { limit: 1, windowMs: 60_000 };
    expect(await enforceRateLimit("t:u1", opts)).toBeNull();
    expect((await enforceRateLimit("t:u1", opts))?.status).toBe(429);
    expect(await enforceRateLimit("t:u2", opts)).toBeNull();
  });
});

describe("rejectOversizedBody", () => {
  const req = (headers: Record<string, string>) => new Request("http://x.test/", { method: "POST", headers });

  it("413 quando o Content-Length declarado passa do teto", async () => {
    const res = rejectOversizedBody(req({ "content-length": "2000" }), 1000);
    expect(res?.status).toBe(413);
    expect(await res?.json()).toMatchObject({ code: "payload_too_large" });
  });

  it("segue quando está no teto, ausente ou ilegível", () => {
    expect(rejectOversizedBody(req({ "content-length": "1000" }), 1000)).toBeNull();
    expect(rejectOversizedBody(req({}), 1000)).toBeNull();
    expect(rejectOversizedBody(req({ "content-length": "abc" }), 1000)).toBeNull();
  });
});
