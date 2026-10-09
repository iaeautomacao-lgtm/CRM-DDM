// Lista ÚNICA dos módulos só de servidor (PRD 14, 14.12): scripts/ci/server-only-modules.json.
//
//   node scripts/ci/server-only-modules.mjs --check   # todo módulo listado tem `import "server-only"` e vice-versa (sai 1 se divergir)
//   node scripts/ci/server-only-modules.mjs --apply   # insere `import "server-only"` nos listados que ainda não têm
//
// Consumidores da MESMA lista: o client-scan (scripts/ci/client-scan.mjs), a regra de ESLint (eslint.config.mjs) e o teste
// src/lib/security/server-only.test.ts. `import "server-only"` faz o build do Next FALHAR se um client component alcançar o módulo
// (causa do incidente #144: componente "use client" importando código de servidor).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

/** `import "server-only"` no começo de uma linha (aspas simples ou duplas, `;` opcional). */
export const SERVER_ONLY_MARKER = /^\s*import\s+["']server-only["'];?\s*$/m;

export function loadServerOnlyConfig(root = repoRoot) {
  const config = JSON.parse(fs.readFileSync(path.join(here, "server-only-modules.json"), "utf8"));
  return {
    modules: config.modules.map((m) => path.join(root, m)),
    relativeModules: config.modules,
    clientOnlyDirs: config.clientOnlyDirs ?? [],
  };
}

export function hasServerOnlyMarker(source) {
  return SERVER_ONLY_MARKER.test(source);
}

/** Insere o marcador antes do primeiro `import`/código, depois dos comentários e diretivas de topo. */
export function withServerOnlyMarker(source) {
  if (hasServerOnlyMarker(source)) return source;
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  let i = 0;
  let inBlock = false;
  for (; i < lines.length; i++) {
    const t = lines[i].trim();
    if (inBlock) {
      if (t.includes("*/")) inBlock = false;
      continue;
    }
    if (t === "" || t.startsWith("//")) continue;
    if (t.startsWith("/*")) {
      if (!t.includes("*/")) inBlock = true;
      continue;
    }
    if (/^["']use (strict|client|server)["'];?$/.test(t)) continue;
    break;
  }
  lines.splice(i, 0, 'import "server-only";');
  return lines.join(eol);
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(p);
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2];
  const { modules } = loadServerOnlyConfig();
  if (arg === "--apply") {
    let changed = 0;
    for (const file of modules) {
      const source = fs.readFileSync(file, "utf8");
      const next = withServerOnlyMarker(source);
      if (next !== source) {
        fs.writeFileSync(file, next);
        changed++;
      }
    }
    console.log(`server-only: ${changed} arquivo(s) marcado(s)`);
  } else if (arg === "--check") {
    const problems = [];
    const listed = new Set(modules.map((m) => path.resolve(m)));
    for (const file of modules) {
      if (!fs.existsSync(file)) problems.push(`listado mas não existe: ${path.relative(repoRoot, file)}`);
      else if (!hasServerOnlyMarker(fs.readFileSync(file, "utf8"))) problems.push(`listado sem import "server-only": ${path.relative(repoRoot, file)}`);
    }
    for (const file of walk(path.join(repoRoot, "src"))) {
      if (!listed.has(path.resolve(file)) && hasServerOnlyMarker(fs.readFileSync(file, "utf8"))) {
        problems.push(`tem import "server-only" mas não está na lista: ${path.relative(repoRoot, file)}`);
      }
    }
    if (problems.length > 0) {
      for (const p of problems) console.error(p);
      process.exit(1);
    }
    console.log("server-only: lista e marcadores em dia");
  } else {
    console.error("uso: node scripts/ci/server-only-modules.mjs --check | --apply");
    process.exit(2);
  }
}
