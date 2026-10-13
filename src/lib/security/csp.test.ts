import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { buildContentSecurityPolicy, CSP_REPORT_PATH, originOf, SCALAR_CDN } from "./csp";

const directive = (csp: string, name: string) =>
  csp
    .split("; ")
    .find((d) => d.startsWith(`${name} `))
    ?.slice(name.length + 1)
    .split(" ") ?? [];

describe("buildContentSecurityPolicy (produção, passo 1)", () => {
  const csp = buildContentSecurityPolicy();

  it("nunca tem 'unsafe-eval' em produção", () => {
    expect(csp).not.toMatch(/(?<!wasm-)unsafe-eval/);
  });

  it("script-src: próprio, inline (passo 1), WebAssembly e só o Scalar fixado", () => {
    expect(directive(csp, "script-src")).toEqual(["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'", SCALAR_CDN]);
  });

  it("conexões do navegador: o próprio servidor e o Supabase (REST e realtime); nada de Meta/OpenAI/WAHA", () => {
    expect(directive(csp, "connect-src")).toEqual(["'self'", "https://*.supabase.co", "wss://*.supabase.co"]);
    for (const outsider of ["facebook.com", "openai.com", "meuchatia", "elevenlabs"]) expect(csp).not.toContain(outsider);
  });

  it("frames: próprio, Supabase e o Extrator de Leads (padrão e o configurado)", () => {
    expect(directive(csp, "frame-src")).toEqual(["'self'", "https://*.supabase.co", "https://grupoddmlead.lovable.app"]);
    expect(directive(buildContentSecurityPolicy({ leadExtractorUrl: "https://leads.cliente.com/app?x=1" }), "frame-src")).toContain("https://leads.cliente.com");
    // URL inválida ou de esquema perigoso não vira origem
    expect(directive(buildContentSecurityPolicy({ leadExtractorUrl: "javascript:alert(1)" }), "frame-src")).toEqual(["'self'", "https://*.supabase.co"]);
  });

  it("fecha o que não usamos: object-src none, frame-ancestors none, base-uri e form-action próprios, worker self/blob", () => {
    expect(directive(csp, "object-src")).toEqual(["'none'"]);
    expect(directive(csp, "frame-ancestors")).toEqual(["'none'"]);
    expect(directive(csp, "base-uri")).toEqual(["'self'"]);
    expect(directive(csp, "form-action")).toEqual(["'self'"]);
    expect(directive(csp, "worker-src")).toEqual(["'self'", "blob:"]);
    expect(directive(csp, "default-src")).toEqual(["'self'"]);
  });

  it("manda as violações para o endpoint de relatório", () => {
    expect(csp).toContain(`report-uri ${CSP_REPORT_PATH}`);
    expect(buildContentSecurityPolicy({ reportUri: null })).not.toContain("report-uri");
  });
});

describe("buildContentSecurityPolicy (desenvolvimento e nonce)", () => {
  it("desenvolvimento libera 'unsafe-eval' e o websocket local (HMR)", () => {
    const dev = buildContentSecurityPolicy({ isDev: true });
    expect(directive(dev, "script-src")).toContain("'unsafe-eval'");
    expect(directive(dev, "connect-src")).toContain("ws://localhost:*");
  });

  it("com nonce (passo 2): script-src troca 'unsafe-inline' por nonce + strict-dynamic, sem 'unsafe-eval'", () => {
    const csp = buildContentSecurityPolicy({ nonce: "abc123" });
    const script = directive(csp, "script-src");
    expect(script).toContain("'nonce-abc123'");
    expect(script).toContain("'strict-dynamic'");
    expect(script).not.toContain("'unsafe-inline'");
    expect(csp).not.toMatch(/(?<!wasm-)unsafe-eval/);
  });
});

describe("originOf", () => {
  it("só origem http(s)", () => {
    expect(originOf("https://a.b.com/x?y=1")).toBe("https://a.b.com");
    expect(originOf("http://localhost:3000/p")).toBe("http://localhost:3000");
    expect(originOf("ftp://x.com")).toBeNull();
    expect(originOf("lixo")).toBeNull();
    expect(originOf(undefined)).toBeNull();
  });
});

describe("coerência com o resto do código", () => {
  it("a versão do Scalar do CSP é a mesma do componente da documentação", () => {
    const src = readFileSync(resolve(process.cwd(), "src/components/docs/api-reference.tsx"), "utf8");
    const version = /SCALAR_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(src)?.[1];
    expect(version).toBeTruthy();
    expect(SCALAR_CDN).toBe(`https://cdn.jsdelivr.net/npm/@scalar/api-reference@${version}/`);
  });

  it("o next.config.ts usa o construtor (sem unsafe-eval fixo no cabeçalho)", () => {
    const cfg = readFileSync(resolve(process.cwd(), "next.config.ts"), "utf8");
    expect(cfg).toContain("buildContentSecurityPolicy");
    expect(cfg).not.toContain("'unsafe-eval'");
  });
});
