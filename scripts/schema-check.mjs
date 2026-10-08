// npm run schema:check — o banco diz o que foi aplicado (PRD 15, 15.3).
//
// Lê scripts/required-migrations.json (gerado da lista de arquivos de supabase/migrations) e o relatório do banco
// (wacrm.schema_check_report(), migration 202), imprime "aplicada / faltando / índice inválido" e sai com código
// diferente de 0 se faltar alguma migration ou houver índice inválido (CREATE INDEX CONCURRENTLY interrompido).
//
//   node scripts/schema-check.mjs              # verifica o banco
//   node scripts/schema-check.mjs --generate   # regenera scripts/required-migrations.json a partir dos arquivos
//   node scripts/schema-check.mjs --check-json # falha se o JSON estiver desatualizado (usado no CI)
//
// Códigos de saída: 0 tudo aplicado · 1 faltando/índice inválido · 2 erro (sem env, 202 não aplicada, JSON desatualizado).
// (As sondas de compatibilidade do deploy continuam em `npm run schema:readiness`.)
import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRequired, runSchemaCheck } from "./lib/migrations-registry.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "supabase", "migrations");
const requiredPath = join(here, "required-migrations.json");

const serialize = (required) => JSON.stringify(required, null, 2) + "\n";

const arg = process.argv[2];
if (arg === "--generate") {
  writeFileSync(requiredPath, serialize(buildRequired(migrationsDir)));
  console.log(`[schema-check] ${requiredPath} regenerado`);
  process.exit(0);
}
if (arg === "--check-json") {
  const current = existsSync(requiredPath) ? readFileSync(requiredPath, "utf8").replace(/\r\n/g, "\n") : "";
  if (current !== serialize(buildRequired(migrationsDir))) {
    console.error("[schema-check] scripts/required-migrations.json está desatualizado: rode `node scripts/schema-check.mjs --generate` e commite.");
    process.exit(2);
  }
  console.log("[schema-check] required-migrations.json em dia");
  process.exit(0);
}

// O Next carrega .env sozinho no build; aqui (node puro) carregamos os mesmos arquivos sem sobrescrever o ambiente.
for (const file of [".env.local", ".env.production.local", ".env.production", ".env"]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[m[1]] = value;
  }
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("[schema-check] NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios.");
  process.exit(2);
}

// O supabase-js cria o cliente de realtime no construtor e, no Node 20 (sem WebSocket nativo), aborta; este script
// nunca usa realtime: um transporte que só falha se alguém tentar conectar.
class NoRealtimeTransport {
  constructor() {
    throw new Error("realtime não é usado neste script");
  }
}

const required = JSON.parse(readFileSync(requiredPath, "utf8"));
const client = createClient(url, key, {
  realtime: { transport: NoRealtimeTransport },
  auth: { persistSession: false, autoRefreshToken: false },
  db: { schema: "wacrm" },
});

const { code, output } = await runSchemaCheck(client, required);
console.log(output);
process.exit(code);
