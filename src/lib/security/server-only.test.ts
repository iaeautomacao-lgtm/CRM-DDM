// PRD 14, 14.12 — módulos só de servidor: UMA lista (scripts/ci/server-only-modules.json) para o `import "server-only"`, o client-scan e o
// ESLint. Este teste impede que as três coisas divirjam e que o grafo cliente→servidor volte (incidente #144).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import * as serverOnlyModules from "../../../scripts/ci/server-only-modules.mjs";

const { hasServerOnlyMarker, loadServerOnlyConfig, withServerOnlyMarker } = serverOnlyModules as {
  hasServerOnlyMarker: (source: string) => boolean;
  loadServerOnlyConfig: () => { modules: string[]; relativeModules: string[]; clientOnlyDirs: string[] };
  withServerOnlyMarker: (source: string) => string;
};

const ROOT = process.cwd();
const config = loadServerOnlyConfig();

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("lista única de módulos só de servidor", () => {
  it("todo módulo listado existe e tem `import \"server-only\"`", () => {
    for (const file of config.modules) {
      expect(readFileSync(file, "utf8").length, file).toBeGreaterThan(0);
      expect(hasServerOnlyMarker(readFileSync(file, "utf8")), relative(ROOT, file)).toBe(true);
    }
  });

  it("todo arquivo com `import \"server-only\"` está na lista (sem marcador órfão)", () => {
    const listed = new Set(config.modules.map((m) => resolve(m)));
    const orphans = walk(join(ROOT, "src"))
      .filter((f) => hasServerOnlyMarker(readFileSync(f, "utf8")) && !listed.has(resolve(f)))
      .map((f) => relative(ROOT, f));
    expect(orphans).toEqual([]);
  });

  it("cobre o que o PRD manda: admin clients, meta-api/dispatcher, cifra, gate da bancada, cofre e service role", () => {
    const listed = config.relativeModules.join("\n");
    for (const needle of [
      "disparador/admin-client.ts",
      "flows/admin-client.ts",
      "whatsapp/meta-api.ts",
      "whatsapp/meta-dispatcher.ts",
      "whatsapp/encryption.ts",
      "loadtest/gate.ts",
      "ai/account-secrets.ts",
      "src/lib/logger.ts",
      "src/lib/audit/log-event.ts",
    ]) {
      expect(listed, needle).toContain(needle);
    }
  });

  it("componentes e hooks de cliente (clientOnlyDirs) NÃO importam módulo da lista (a mesma regra do ESLint)", () => {
    const offenders: string[] = [];
    for (const dir of config.clientOnlyDirs) {
      for (const file of walk(join(ROOT, dir))) {
        const src = readFileSync(file, "utf8");
        for (const m of config.relativeModules) {
          const bare = m.replace(/^src\//, "").replace(/\.tsx?$/, "");
          if (new RegExp(`from\\s+["'][^"']*${bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`).test(src)) {
            offenders.push(`${relative(ROOT, file)} → ${m}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("withServerOnlyMarker (usado por --apply)", () => {
  it("insere depois dos comentários e diretivas, antes do primeiro import", () => {
    const out = withServerOnlyMarker("// cabeçalho\n/* bloco\n   multi */\nimport a from 'a'\nexport const x = 1\n");
    expect(out.split("\n")).toEqual(["// cabeçalho", "/* bloco", "   multi */", 'import "server-only";', "import a from 'a'", "export const x = 1", ""]);
  });

  it("é idempotente e preserva CRLF", () => {
    const once = withServerOnlyMarker("import a from 'a'\r\n");
    expect(once).toBe('import "server-only";\r\nimport a from \'a\'\r\n');
    expect(withServerOnlyMarker(once)).toBe(once);
  });

  it("respeita 'use strict' no topo", () => {
    expect(withServerOnlyMarker("'use strict'\nimport a from 'a'\n").split("\n")[1]).toBe('import "server-only";');
  });
});
