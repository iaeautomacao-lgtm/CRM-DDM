import { describe, expect, it } from "vitest";

import { MAX_WEBHOOK_BODY_BYTES, isWellFormedHubSignature, readCappedBody } from "./webhook-body";

// PRD 14, 14.10 (SW-5): corpo de webhook com teto (Content-Length E leitura do stream).

const enc = new TextEncoder();

function streamOf(chunks: Uint8Array[], onPull?: () => void): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      onPull?.();
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
}

describe("readCappedBody", () => {
  it("lê um corpo normal como texto", async () => {
    const res = await readCappedBody(new Request("http://x", { method: "POST", body: JSON.stringify({ a: 1 }) }));
    expect(res).toEqual({ ok: true, text: '{"a":1}' });
  });

  it("sem corpo: texto vazio", async () => {
    expect(await readCappedBody(new Request("http://x", { method: "POST" }))).toEqual({ ok: true, text: "" });
  });

  it("Content-Length acima do teto: 413 sem ler nada", async () => {
    const request = new Request("http://x", {
      method: "POST",
      headers: { "content-length": String(MAX_WEBHOOK_BODY_BYTES + 1) },
      body: streamOf([enc.encode("x")]),
      // @ts-expect-error duplex é exigido pelo Node para corpo em stream
      duplex: "half",
    });
    expect(await readCappedBody(request)).toEqual({ ok: false, status: 413 });
    expect(request.bodyUsed).toBe(false); // recusou pelo cabeçalho, sem consumir o corpo
  });

  it("corpo em stream SEM Content-Length (chunked) é interrompido ao passar do teto", async () => {
    const chunk = new Uint8Array(100_000).fill(97); // 100 KB
    let pulls = 0;
    const request = new Request("http://x", {
      method: "POST",
      body: streamOf(Array.from({ length: 50 }, () => chunk), () => pulls++), // 5 MB no total
      // @ts-expect-error duplex é exigido pelo Node para corpo em stream
      duplex: "half",
    });
    const res = await readCappedBody(request);
    expect(res).toEqual({ ok: false, status: 413 });
    expect(pulls).toBeLessThan(20); // parou perto do 1 MB, não leu os 5 MB
  });

  it("respeita um teto explícito menor", async () => {
    const res = await readCappedBody(new Request("http://x", { method: "POST", body: "x".repeat(100) }), 50);
    expect(res).toEqual({ ok: false, status: 413 });
  });

  it("exatamente no teto passa; um byte a mais não", async () => {
    expect((await readCappedBody(new Request("http://x", { method: "POST", body: "x".repeat(64) }), 64)).ok).toBe(true);
    expect((await readCappedBody(new Request("http://x", { method: "POST", body: "x".repeat(65) }), 64)).ok).toBe(false);
  });

  it("caractere multi-byte partido entre dois chunks é decodificado inteiro", async () => {
    const bytes = enc.encode("ação 😀 ok");
    const request = new Request("http://x", {
      method: "POST",
      body: streamOf([bytes.slice(0, 2), bytes.slice(2, 9), bytes.slice(9)]),
      // @ts-expect-error duplex é exigido pelo Node para corpo em stream
      duplex: "half",
    });
    expect(await readCappedBody(request)).toEqual({ ok: true, text: "ação 😀 ok" });
  });
});

describe("isWellFormedHubSignature", () => {
  it("aceita sha256=<64 hex> (qualquer caixa) e recusa o resto", () => {
    const good = "sha256=" + "a".repeat(64);
    expect(isWellFormedHubSignature(good)).toBe(true);
    expect(isWellFormedHubSignature(good.toUpperCase().replace("SHA256", "sha256"))).toBe(true);
    for (const bad of [null, undefined, "", "sha256=", "sha256=" + "a".repeat(63), "sha256=" + "g".repeat(64), "sha1=" + "a".repeat(40), "a".repeat(64)]) {
      expect(isWellFormedHubSignature(bad), String(bad)).toBe(false);
    }
  });
});
