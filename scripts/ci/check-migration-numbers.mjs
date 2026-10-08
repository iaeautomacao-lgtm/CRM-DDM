// CI: falha se dois arquivos de supabase/migrations tiverem o mesmo número (ex.: dois `194_…`).
// `187` e `187b` não são duplicata. Os 4 números legados (113, 132, 133, 143) são ignorados.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findDuplicateNumbers, listMigrations } from "../lib/migrations-registry.mjs";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "supabase", "migrations");
const duplicates = findDuplicateNumbers(listMigrations(dir));

if (duplicates.length > 0) {
  for (const { key, files } of duplicates) console.error(`número de migration repetido ${key}: ${files.join(", ")}`);
  console.error("Renumere a migration nova (próximo número livre na faixa do PRD) e atualize scripts/required-migrations.json.");
  process.exit(1);
}
console.log("migrations: nenhum número repetido");
