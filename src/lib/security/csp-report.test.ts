import { describe, expect, it } from "vitest";

import { sanitizeCspReports } from "./csp-report";

describe("sanitizeCspReports", () => {
  it("formato report-uri: guarda só o útil e tira query, fragmento, script-sample, referrer e a política original", () => {
    const out = sanitizeCspReports({
      "csp-report": {
        "document-uri": "https://crm.test/inbox?token=SEGREDO#frag",
        referrer: "https://crm.test/login?x=1",
        "violated-directive": "script-src-elem",
        "effective-directive": "script-src-elem",
        "original-policy": "default-src 'self'; ...",
        disposition: "report",
        "blocked-uri": "https://cdn.evil.example/a.js?k=SEGREDO",
        "line-number": 12,
        "column-number": 3,
        "source-file": "https://crm.test/_next/static/chunk.js?v=1",
        "script-sample": "alert('conteúdo do usuário')",
      },
    });
    expect(out).toEqual([
      {
        documentPath: "https://crm.test/inbox",
        directive: "script-src-elem",
        blocked: "https://cdn.evil.example",
        sourceFile: "https://crm.test/_next/static/chunk.js",
        line: 12,
        column: 3,
        disposition: "report",
      },
    ]);
    expect(JSON.stringify(out)).not.toMatch(/SEGREDO|alert|original-policy/);
  });

  it("Reporting API (lista de csp-violation)", () => {
    const out = sanitizeCspReports([
      { type: "csp-violation", body: { documentURL: "https://crm.test/x", effectiveDirective: "img-src", blockedURL: "inline", lineNumber: 1 } },
      { type: "deprecation", body: {} },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ directive: "img-src", blocked: "inline", line: 1 });
  });

  it("palavras-chave (inline, eval, data) passam; URL vira só origem; texto qualquer vira null", () => {
    const blocked = (v: unknown) => sanitizeCspReports({ "csp-report": { "blocked-uri": v } })[0].blocked;
    expect(blocked("eval")).toBe("eval");
    expect(blocked("data")).toBe("data");
    expect(blocked("https://x.example/a/b/c?token=1")).toBe("https://x.example");
    expect(blocked("nao é url")).toBeNull();
    expect(blocked(42)).toBeNull();
  });

  it("corpo estranho devolve lista vazia; no máximo 10 por chamada; strings gigantes são cortadas", () => {
    expect(sanitizeCspReports(null)).toEqual([]);
    expect(sanitizeCspReports("texto")).toEqual([]);
    expect(sanitizeCspReports({ outra: "coisa" })).toEqual([]);
    expect(sanitizeCspReports(Array.from({ length: 50 }, () => ({ "csp-report": { "blocked-uri": "inline" } })))).toHaveLength(10);
    const big = sanitizeCspReports({ "csp-report": { "effective-directive": "x".repeat(5000) } })[0];
    expect(big.directive?.length).toBeLessThanOrEqual(80);
  });
});
