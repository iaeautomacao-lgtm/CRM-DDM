// F13: 2xx da Meta sem messages[0].id (corpo truncado/timeout no meio/formato inesperado) = resultado INCERTO.
// Nunca reenvia (isDefinitiveRejection=false) e não vira TypeError fora de MetaApiError.
import { describe, expect, it } from "vitest";
import { MetaApiError, MetaUncertainResponseError, readSentMessageId } from "@/lib/whatsapp/meta-api";
import { isDefinitiveRejection } from "./processQueue";
import { classifyProviderError } from "./provider-signals";

const res = (body: string, status = 200) => new Response(body, { status });

describe("readSentMessageId", () => {
  it("corpo normal: devolve o id", async () => {
    expect(await readSentMessageId(res(JSON.stringify({ messages: [{ id: "wamid.ABC" }] })))).toBe("wamid.ABC");
  });

  it.each([
    ["200 sem messages", "{}"],
    ["messages vazio", '{"messages":[]}'],
    ["id ausente", '{"messages":[{}]}'],
    ["id vazio", '{"messages":[{"id":""}]}'],
    ["id não-texto", '{"messages":[{"id":123}]}'],
    ["corpo truncado (JSON cortado)", '{"messages":[{"id":"wamid.A'],
    ["corpo vazio (timeout no meio)", ""],
    ["null", "null"],
  ])("%s → MetaUncertainResponseError (e não TypeError)", async (_name, body) => {
    const err = await readSentMessageId(res(body)).catch((e) => e);
    expect(err).toBeInstanceOf(MetaUncertainResponseError);
    expect(err).not.toBeInstanceOf(TypeError);
    expect(err).not.toBeInstanceOf(MetaApiError);
  });
});

describe("classificação do erro de corpo da Meta", () => {
  const uncertain = new MetaUncertainResponseError("sem id");

  it("é INCERTO: não é rejeição definitiva (nunca retenta nem reenvia) — mesmo com status 200", () => {
    expect(isDefinitiveRejection(uncertain)).toBe(false);
    // contraste: um MetaApiError 4xx é definitivo; se o corpo vazio fosse MetaApiError(200) viraria "retentável" por engano
    expect(isDefinitiveRejection(new MetaApiError("x", null, 200))).toBe(true);
  });

  it("sem freio no número: o sinal é neutro (não conta como 429/5xx)", () => {
    expect(classifyProviderError(uncertain)).toEqual({ reason: null, code: "meta:uncertain_body" });
  });
});
