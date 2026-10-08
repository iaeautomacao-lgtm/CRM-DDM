import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// O bucket `relatorio-exports` (migration 055) só aceita alguns tipos. Upload com outro contentType é recusado pelo
// Supabase real — os testes com Storage simulado não pegam isso. Aqui conferimos o texto dos módulos que gravam nele.
const root = process.cwd();
const migration = readFileSync(resolve(root, "supabase/migrations/055_export_history.sql"), "utf8");
const allowed = new Set(Array.from(migration.matchAll(/'([a-z]+\/[a-z0-9.+-]+)'/gi), (m) => m[1]));

describe("uploads no bucket relatorio-exports usam tipo aceito pela 055", () => {
  it.each(["src/lib/disparador/import-jobs.ts", "src/lib/disparador/export-jobs.ts"])("%s", (file) => {
    const src = readFileSync(resolve(root, file), "utf8");
    const types = Array.from(src.matchAll(/contentType:\s*"([^"]+)"/g), (m) => m[1]);
    expect(types.length).toBeGreaterThan(0);
    for (const t of types) expect(allowed, `${file}: ${t}`).toContain(t);
  });
});
