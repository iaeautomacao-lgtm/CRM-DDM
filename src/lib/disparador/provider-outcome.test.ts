import { describe, expect, it } from "vitest";
import { isNotConnectedError } from "./provider-outcome";

describe("isNotConnectedError", () => {
  it("reconhece falhas de conexão (incl. causa aninhada e AggregateError)", () => {
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "EHOSTUNREACH", "ENETUNREACH"]) {
      expect(isNotConnectedError(new TypeError("fetch failed", { cause: { code } }))).toBe(true);
      expect(isNotConnectedError(new TypeError("fetch failed", { cause: new Error("x", { cause: { code } }) }))).toBe(true);
    }
    expect(isNotConnectedError(new AggregateError([{ code: "ECONNREFUSED" }, { code: "ECONNREFUSED" }]))).toBe(true);
  });
  it("não trata como 'não saiu' o que pode ter saído: reset, timeout de resposta, abort, 5xx, texto livre", () => {
    expect(isNotConnectedError(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }))).toBe(false);
    expect(isNotConnectedError(new TypeError("fetch failed", { cause: { code: "UND_ERR_SOCKET" } }))).toBe(false);
    expect(isNotConnectedError(Object.assign(new Error("timeout"), { name: "TimeoutError" }))).toBe(false);
    expect(isNotConnectedError(new Error("connect ECONNREFUSED 1.2.3.4:443"))).toBe(false);
    expect(isNotConnectedError(null)).toBe(false);
    expect(isNotConnectedError("ECONNREFUSED")).toBe(false);
  });
});
