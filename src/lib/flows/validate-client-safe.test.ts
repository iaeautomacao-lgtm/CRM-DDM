import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// validate.ts roda no NAVEGADOR (editor de fluxos). Importar meta-api.ts levou
// junto o undici (meta-dispatcher) e o gate da bancada, e nenhum fluxo abria
// em produção. Este teste trava esse caminho.
describe("validate.ts é seguro para o navegador", () => {
  it("não importa módulos só de servidor", () => {
    const src = readFileSync(join(__dirname, "validate.ts"), "utf8");
    const imports = [...src.matchAll(/(?:^|\n)\s*import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    const serverOnly = imports.filter((s) => /whatsapp\/meta-api$|meta-dispatcher|loadtest\/gate|undici|admin-client|supabase\/admin/.test(s));
    expect(serverOnly).toEqual([]);
  });
});
