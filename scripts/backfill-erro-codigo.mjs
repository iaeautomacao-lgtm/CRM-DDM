// Backfill de disp_message_queue.erro_codigo (migration 187) em LOTES por id.
//
// Chama wacrm.backfill_erro_codigo(p_limit, p_after) repetidamente (um lote por chamada, com pausa
// entre lotes) até acabar — nunca um UPDATE único de milhões de linhas. Idempotente: só preenche
// linhas com `erro` e sem `erro_codigo`; rodar de novo não muda nada. Não imprime texto de erro.
//
// Uso (na raiz do projeto, com o .env da produção):
//   node scripts/backfill-erro-codigo.mjs                 # lotes de 5000, pausa de 200 ms
//   node scripts/backfill-erro-codigo.mjs --limit 2000 --sleep 500
//   node scripts/backfill-erro-codigo.mjs --max-batches 10   # só os 10 primeiros lotes (teste)
import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync } from "node:fs";

for (const file of [".env.local", ".env.production.local", ".env.production", ".env"]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[m[1]] = value;
  }
}

function argNumber(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const n = Number(process.argv[i + 1]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

const LIMIT = argNumber("--limit", 5000);
const SLEEP_MS = argNumber("--sleep", 200);
const MAX_BATCHES = argNumber("--max-batches", Number.POSITIVE_INFINITY);

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Defina NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
const db = createClient(url, key, { db: { schema: "wacrm" } });

let after = null;
let batches = 0;
let scanned = 0;
let updated = 0;
while (batches < MAX_BATCHES) {
  const { data, error } = await db.rpc("backfill_erro_codigo", { p_limit: LIMIT, p_after: after });
  if (error) {
    console.error("Falha no lote:", error.message, "(rode a migration 187 antes)");
    process.exit(1);
  }
  const row = Array.isArray(data) ? data[0] : data;
  batches++;
  scanned += row?.scanned ?? 0;
  updated += row?.updated ?? 0;
  console.log(`lote ${batches}: olhou ${row?.scanned ?? 0}, preencheu ${row?.updated ?? 0}`);
  if (!row?.last_id || (row.scanned ?? 0) < LIMIT) break;
  after = row.last_id;
  await new Promise((r) => setTimeout(r, SLEEP_MS));
}
console.log(`Concluído: ${batches} lote(s), ${scanned} linha(s) olhadas, ${updated} preenchida(s).`);
