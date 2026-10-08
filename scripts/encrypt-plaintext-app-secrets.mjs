// Criptografa (AES-256-GCM, mesmo formato de src/lib/whatsapp/encryption.ts)
// os segredos de canal que ficaram gravados em texto puro em
// wacrm.whatsapp_config — ex.: app_secret salvo direto no banco como
// workaround antigo.
//
// Uso (na raiz do projeto, com o mesmo .env da produção):
//   node scripts/encrypt-plaintext-app-secrets.mjs           # dry-run (padrão)
//   node scripts/encrypt-plaintext-app-secrets.mjs --apply   # grava
//
// Idempotente: só toca valores fora do formato cifrado; rodar de novo
// não muda nada. Nunca imprime valores de segredo — só ids e contagens.
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

// Mesmo carregamento de .env do scripts/check-schema-readiness.mjs — sem
// sobrescrever o que já veio do ambiente.
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

const APPLY = process.argv.includes("--apply");
const PAGE_SIZE = 500;

// Colunas cifradas com encrypt() em whatsapp_config.
const COLUMNS = ["app_secret", "verify_token", "access_token", "waha_api_key"];
// Valores que não são segredo (linhas WAHA guardam isto em access_token
// só por causa do NOT NULL — ver POST /api/whatsapp/config).
const NON_SECRET_PLACEHOLDERS = new Set(["waha-placeholder"]);

// Mesmos formatos estritos de isEncryptedSecret / isLegacyCbcSecret.
const GCM_RE = /^[0-9a-f]{24}:(?:[0-9a-f]{2})*:[0-9a-f]{32}$/i;
const CBC_RE = /^[0-9a-f]{32}:(?:[0-9a-f]{32})+$/i;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const keyHex = process.env.ENCRYPTION_KEY ?? "";

if (!url || !serviceRoleKey) {
  console.error("[encrypt-secrets] NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios.");
  process.exit(1);
}
if (!/^[0-9a-f]{64}$/i.test(keyHex)) {
  console.error("[encrypt-secrets] ENCRYPTION_KEY ausente ou inválida (precisa ter 64 caracteres hex).");
  process.exit(1);
}
const KEY = Buffer.from(keyHex, "hex");

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  let ct = cipher.update(text, "utf8", "hex");
  ct += cipher.final("hex");
  return `${iv.toString("hex")}:${ct}:${cipher.getAuthTag().toString("hex")}`;
}

function decrypt(value) {
  const parts = value.split(":");
  if (parts.length === 3) {
    const [ivHex, ctHex, tagHex] = parts;
    const d = crypto.createDecipheriv("aes-256-gcm", KEY, Buffer.from(ivHex, "hex"));
    d.setAuthTag(Buffer.from(tagHex, "hex"));
    return d.update(ctHex, "hex", "utf8") + d.final("utf8");
  }
  const [ivHex, ctHex] = parts;
  const d = crypto.createDecipheriv("aes-256-cbc", KEY, Buffer.from(ivHex, "hex"));
  return d.update(ctHex, "hex", "utf8") + d.final("utf8");
}

function classify(value) {
  if (value === null || value === undefined || value === "") return "empty";
  if (NON_SECRET_PLACEHOLDERS.has(value)) return "placeholder";
  if (GCM_RE.test(value) || CBC_RE.test(value)) {
    try {
      decrypt(value);
      return "encrypted";
    } catch {
      return "undecryptable";
    }
  }
  return "plaintext";
}

// O supabase-js 2.10x cria o cliente de realtime no construtor e, no Node 20 (sem
// WebSocket nativo), aborta. Este script nunca usa realtime (mesma correção do #147).
class NoRealtimeTransport {
  constructor() {
    throw new Error("realtime não é usado neste script");
  }
}

const db = createClient(url, serviceRoleKey, {
  realtime: { transport: NoRealtimeTransport },
  auth: { persistSession: false, autoRefreshToken: false },
  db: { schema: "wacrm" },
});

const rows = [];
for (let from = 0; ; from += PAGE_SIZE) {
  const { data, error } = await db
    .from("whatsapp_config")
    .select(["id", "provider", ...COLUMNS].join(","))
    .order("id", { ascending: true })
    .range(from, from + PAGE_SIZE - 1);
  if (error) {
    console.error(`[encrypt-secrets] falha ao ler whatsapp_config: ${error.message}`);
    process.exit(1);
  }
  rows.push(...data);
  if (data.length < PAGE_SIZE) break;
}

const stats = Object.fromEntries(
  COLUMNS.map((c) => [c, { encrypted: 0, plaintext: 0, undecryptable: 0, empty: 0, placeholder: 0 }]),
);
const pending = []; // { id, column, oldValue }
const undecryptable = [];

for (const row of rows) {
  for (const column of COLUMNS) {
    // Em linhas WAHA o access_token não é segredo (só preenche o NOT NULL).
    const kind =
      column === "access_token" && row.provider === "waha" ? "placeholder" : classify(row[column]);
    stats[column][kind] += 1;
    if (kind === "plaintext") pending.push({ id: row.id, provider: row.provider, column, oldValue: row[column] });
    if (kind === "undecryptable") undecryptable.push({ id: row.id, column });
  }
}

console.log(`[encrypt-secrets] ${rows.length} linha(s) em wacrm.whatsapp_config — modo ${APPLY ? "APPLY" : "DRY-RUN"}`);
console.table(stats);

if (undecryptable.length > 0) {
  console.warn(
    `[encrypt-secrets] ${undecryptable.length} valor(es) no formato cifrado que NÃO decifram com esta ENCRYPTION_KEY:`,
  );
  for (const u of undecryptable) console.warn(`  - ${u.id} ${u.column}`);
}

const totalCipher = COLUMNS.reduce((n, c) => n + stats[c].encrypted + stats[c].undecryptable, 0);
const anyDecrypts = COLUMNS.some((c) => stats[c].encrypted > 0);
if (totalCipher > 0 && !anyDecrypts) {
  // Nenhum ciphertext existente decifra: quase certamente a ENCRYPTION_KEY
  // aqui não é a da produção. Cifrar com ela tornaria os segredos ilegíveis.
  console.error(
    "[encrypt-secrets] Nenhum valor cifrado existente decifra com esta ENCRYPTION_KEY — ela não parece ser a da produção. Abortando.",
  );
  process.exit(1);
}

if (pending.length === 0) {
  console.log("[encrypt-secrets] Nada a fazer — nenhum segredo em texto puro.");
  process.exit(0);
}

console.log(`[encrypt-secrets] ${pending.length} valor(es) em texto puro:`);
for (const p of pending) console.log(`  - ${p.id} (${p.provider ?? "?"}) ${p.column}`);

if (!APPLY) {
  console.log("[encrypt-secrets] Dry-run: nada foi gravado. Rode com --apply para criptografar.");
  process.exit(0);
}

let ok = 0;
let skipped = 0;
let failed = 0;
for (const p of pending) {
  const encrypted = encrypt(p.oldValue);
  if (decrypt(encrypted) !== p.oldValue) {
    console.error(`  ✗ ${p.id} ${p.column}: round-trip falhou, não gravado`);
    failed += 1;
    continue;
  }
  // Relê a linha antes de gravar: se alguém salvou pela UI no meio tempo,
  // não sobrescreve. (Não usamos .eq(coluna, valor) como guarda porque
  // isso poria o segredo em texto puro na URL/logs do PostgREST.)
  const { data: fresh, error: readError } = await db
    .from("whatsapp_config")
    .select(p.column)
    .eq("id", p.id)
    .limit(1);
  if (readError) {
    console.error(`  ✗ ${p.id} ${p.column}: ${readError.message}`);
    failed += 1;
    continue;
  }
  if (!fresh?.[0] || fresh[0][p.column] !== p.oldValue) {
    console.warn(`  ~ ${p.id} ${p.column}: valor mudou desde a leitura, ignorado`);
    skipped += 1;
    continue;
  }
  const { error } = await db
    .from("whatsapp_config")
    .update({ [p.column]: encrypted })
    .eq("id", p.id);
  if (error) {
    console.error(`  ✗ ${p.id} ${p.column}: ${error.message}`);
    failed += 1;
  } else {
    console.log(`  ✓ ${p.id} ${p.column}`);
    ok += 1;
  }
}

console.log(`[encrypt-secrets] Concluído: ${ok} cifrado(s), ${skipped} ignorado(s), ${failed} falha(s).`);
process.exit(failed > 0 ? 1 : 0);
