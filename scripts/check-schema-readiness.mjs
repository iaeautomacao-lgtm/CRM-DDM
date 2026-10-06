import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync } from "node:fs";

// O Next carrega .env/.env.local sozinho no build; este script roda com
// node puro (passo schema:check do deploy), então carrega os mesmos
// arquivos — sem sobrescrever o que já veio do ambiente.
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

const EXPECTED_SCHEMA_VERSION = 143;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceRoleKey) {
  console.error(
    "[schema-readiness] NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios.",
  );
  process.exit(1);
}

const db = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
  db: { schema: "wacrm" },
});

const failures = [];

const { data: schemaVersion, error: versionError } = await db.rpc(
  "app_schema_version",
);

if (versionError) {
  failures.push(
    `app_schema_version indisponível: ${versionError.message}. A migration 143 ainda não foi aplicada?`,
  );
} else if (Number(schemaVersion) < EXPECTED_SCHEMA_VERSION) {
  failures.push(
    `schema version ${schemaVersion} < versão exigida ${EXPECTED_SCHEMA_VERSION}`,
  );
}

const probes = [
  {
    table: "messages",
    columns: "id,account_id,received_at,campaign_id,queue_item_id",
  },
  {
    table: "conversations",
    columns: "id,closed_at,assignment_retry_at,channel_type",
  },
  {
    table: "ai_decisions",
    columns: "id,ai_node,tool_error,source_event_id",
  },
  { table: "ai_reply_intents", columns: "account_id,conversation_id,inbound_message_id,node_key" },
  { table: "disp_import_contacts", columns: "id" },
  // Chave da tabela é account_id (133_webchat_settings) — não há coluna id.
  { table: "webchat_settings", columns: "account_id" },
  // origin/api_key_id e api_keys.user_id: migration 154 (MCP do Intelligence).
  { table: "intelligence_tool_calls", columns: "id,origin,api_key_id" },
  { table: "api_keys", columns: "id,user_id" },
  { table: "quick_replies", columns: "id" },
];

for (const probe of probes) {
  const { error } = await db
    .from(probe.table)
    .select(probe.columns, { head: true })
    .limit(1);

  if (error) {
    failures.push(
      `${probe.table}(${probe.columns}): ${error.code ?? "erro"} ${error.message}`,
    );
  }
}

if (failures.length > 0) {
  console.error("[schema-readiness] BLOQUEANDO DEPLOY: banco incompatível com este build.");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `[schema-readiness] OK — schema >= ${EXPECTED_SCHEMA_VERSION} e objetos críticos disponíveis.`,
);
