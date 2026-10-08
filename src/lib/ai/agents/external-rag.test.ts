import { describe, expect, it, vi } from "vitest";
import { fetchExternalRagContext, externalRagEnabledByFlag } from "./external-rag";

const rag = { enabled: true, url: "https://rag.example.com/q", credential: "{{cred.RAG_KEY}}" } as never;
const account = { creds: new Map([["RAG_KEY", { value: "s3cr3t-token", hosts: ["rag.example.com"] }]]) } as never;
const on = { AI_EXTERNAL_RAG_ENABLED: "true" };
const ok = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as never;

describe("RAG externo", () => {
  it("flag desligada por padrão", async () => {
    expect(externalRagEnabledByFlag({})).toBe(false);
    const f = ok({ context: "x" });
    expect(await fetchExternalRagContext({ rag, query: "q", account, env: {}, fetchImpl: f })).toBe("");
    expect(f).not.toHaveBeenCalled();
  });
  it("busca com flag + perfil + credencial", async () => {
    const out = await fetchExternalRagContext({ rag, query: "q", account, env: on, fetchImpl: ok({ results: [{ text: "a" }, { content: "b" }] }) });
    expect(out).toBe("a\n---\nb");
  });
  it("host fora da credencial não chama", async () => {
    const f = ok({ context: "x" });
    const acc = { creds: new Map([["RAG_KEY", { value: "t", hosts: ["outro.com"] }]]) } as never;
    expect(await fetchExternalRagContext({ rag, query: "q", account: acc, env: on, fetchImpl: f })).toBe("");
    expect(f).not.toHaveBeenCalled();
  });
  it("falha segue sem RAG", async () => {
    const boom = vi.fn(async () => {
      throw new Error("timeout");
    }) as never;
    expect(await fetchExternalRagContext({ rag, query: "q", account, env: on, fetchImpl: boom })).toBe("");
    const bad = vi.fn(async () => new Response("x", { status: 500 })) as never;
    expect(await fetchExternalRagContext({ rag, query: "q", account, env: on, fetchImpl: bad })).toBe("");
  });
  it("eco da credencial é removido", async () => {
    const out = await fetchExternalRagContext({ rag, query: "q", account, env: on, fetchImpl: ok({ context: "chave s3cr3t-token fim" }) });
    expect(out).not.toContain("s3cr3t-token");
  });
});
