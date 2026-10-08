// Uso: node scripts/ci/client-scan.mjs [raiz]  (padrão: diretório atual). Sai com código 1 se achar algo (CI).
// Varre componentes "use client" e lista os que alcançam código só de servidor.
import fs from "node:fs";
import path from "node:path";
const root = path.resolve(process.argv[2] ?? process.cwd());
const exts = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];
const norm = (p) => p.split(path.sep).join("/");
function resolve(from, spec) {
  let base;
  if (spec.startsWith("@/")) base = path.join(root, "src", spec.slice(2));
  else if (spec.startsWith(".")) base = path.join(path.dirname(from), spec);
  else return null;
  for (const e of exts) {
    const p = base + e;
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  return null;
}
function imports(f) {
  const s = fs.readFileSync(f, "utf8");
  const out = [];
  for (const m of s.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/g)) out.push(m[1]);
  for (const m of s.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]);
  return out;
}
const all = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.tsx?$/.test(p) && !/\.test\./.test(p)) all.push(p);
  }
})(path.join(root, "src"));
const clients = all.filter((f) => /^\s*["']use client["']/.test(fs.readFileSync(f, "utf8")));
const bad = /whatsapp[\\/]meta-dispatcher|loadtest[\\/]gate|whatsapp[\\/]meta-api\.ts$|disparador[\\/]admin-client|supabase[\\/]admin/;
const found = new Map();
for (const c of clients) {
  const seen = new Set([c]);
  const stack = [[c, [c]]];
  while (stack.length) {
    const [f, trail] = stack.pop();
    for (const sp of imports(f)) {
      const r = resolve(f, sp);
      if (!r || seen.has(r)) continue;
      seen.add(r);
      const t = [...trail, r];
      if (bad.test(r)) { if (!found.has(c)) found.set(c, t); }
      else stack.push([r, t]);
    }
  }
}
console.log("componentes client que alcançam código de servidor:", found.size);
for (const [, t] of found) console.log(" -", t.map((x) => norm(path.relative(root, x))).join(" -> "));
if (found.size > 0) process.exit(1);
