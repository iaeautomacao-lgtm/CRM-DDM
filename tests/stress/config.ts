// Configuração compartilhada da stress suite. Todos os scripts em
// tests/stress/ importam daqui — nenhum lê process.env diretamente, então
// há um único lugar para saber quais variáveis são necessárias.
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `[stress-config] Variável de ambiente ${name} não definida. Veja tests/stress/README.md.`
    );
  }
  return value;
}

// Cookies de sessão têm 2000+ caracteres — colar um valor desse tamanho
// numa variável de ambiente via terminal (ou pior, através de um agente
// que precisa re-digitar o valor entre chamadas de ferramenta) é um
// convite a truncamento silencioso na última linha, que vira um 401
// difícil de diagnosticar (o valor "parece" certo, só falta o final).
// Escrever direto num arquivo local evita qualquer retransmissão do
// valor depois do paste original. Arquivo é opcional: se não existir,
// cai de volta na env var de sempre.
const SESSION_TOKEN_FILE = path.join(__dirname, ".session-token");

// Projeto Supabase de produção (ver contexto do task) — usado só para
// montar o nome do cookie que @supabase/ssr espera, não para nenhuma
// chamada de rede. Hardcoded (em vez de derivado de STRESS_SUPABASE_URL)
// porque test-import.ts precisa normalizar o cookie sem exigir
// STRESS_SUPABASE_URL, que só é usada por scripts que tocam o banco
// direto (queue, webhook, cleanup, report).
const SUPABASE_PROJECT_REF = "mkrkkvbseobdqsalrorl";

// DevTools mostra só o VALOR do cookie de sessão (o que fica depois do
// "="), não o par "nome=valor" completo — na prática, todo mundo que
// copia isso (inclusive eu, entre chamadas de ferramenta) acaba colando
// só o valor puro (`base64-eyJ...`), sem o prefixo
// `sb-<project-ref>-auth-token=` que o parser de cookies do
// @supabase/ssr exige para reconhecer a sessão. Em vez de depender de
// ninguém lembrar de montar isso à mão toda vez, detecta e completa
// automaticamente.
function normalizeSessionCookie(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith(`sb-${SUPABASE_PROJECT_REF}-auth-token=`)) {
    return trimmed;
  }
  return `sb-${SUPABASE_PROJECT_REF}-auth-token=${trimmed}`;
}

function requiredSessionToken(): string {
  if (fs.existsSync(SESSION_TOKEN_FILE)) {
    const fromFile = fs.readFileSync(SESSION_TOKEN_FILE, "utf-8").trim();
    if (fromFile) return normalizeSessionCookie(fromFile);
  }
  return normalizeSessionCookie(required("STRESS_SESSION_TOKEN"));
}

// Prefixo usado em TODOS os dados fictícios criados por esta suite —
// contatos, campanhas, tags, whatsapp_config de teste. cleanup.ts usa este
// mesmo valor para identificar o que apagar, então nunca deve ser alterado
// entre generate/import/queue/webhook e cleanup na mesma rodada.
export const STRESS_PREFIX = "STRESS_TEST";

export const PRODUCTION_URL =
  process.env.STRESS_PRODUCTION_URL || "https://omnicrm.grupoddm.ia.br";

// Base usada pelos testes que batem em HTTP (import, queue). O teste de
// webhook (Passo 4) é sempre local por restrição do enunciado — ver
// LOCAL_URL abaixo — independente do valor aqui.
export const TARGET_URL = process.env.STRESS_TARGET_URL || PRODUCTION_URL;

// O webhook NUNCA deve ser testado contra produção (evita qualquer risco
// de side-effect real). test-webhook.ts sempre usa esta URL.
export const LOCAL_URL = process.env.STRESS_LOCAL_URL || "http://localhost:3000";

export const SUPABASE_URL = () => required("STRESS_SUPABASE_URL");
export const SUPABASE_SERVICE_KEY = () => required("STRESS_SERVICE_KEY");

// Cookie de sessão do Supabase (copiado do DevTools) — autentica as
// chamadas HTTP que passam por createServerClient() (import, start de
// campanha). Não é necessário para scripts que só usam o service role
// (queue setup, cleanup, report). Lido de tests/stress/.session-token se
// existir, senão de STRESS_SESSION_TOKEN — ver requiredSessionToken().
export const SESSION_TOKEN = () => requiredSessionToken();

// Necessário só para test-queue.ts (cria a campanha de teste direto via
// service role) — resolvido manualmente porque wacrm.profiles não é
// exposta por um endpoint próprio. Ver README.md para a query SQL.
export const ACCOUNT_ID = () => required("STRESS_ACCOUNT_ID");

// Idem — deve ser o MESMO usuário dono do STRESS_SESSION_TOKEN, senão
// POST /api/disparador/campaigns/[id]/start rejeita com 403 (a rota exige
// campaign.created_by === sessão atual). Ver README.md.
export const USER_ID = () => required("STRESS_USER_ID");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null;
// Cliente service-role compartilhado, schema wacrm — usado por qualquer
// script que precise ler/escrever direto no banco (test-queue, cleanup,
// report). Nunca passa por RLS: nunca usar para nada além de dados
// prefixados STRESS_TEST.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function supabaseAdmin(): any {
  if (!_adminClient) {
    _adminClient = createClient(SUPABASE_URL(), SUPABASE_SERVICE_KEY(), {
      db: { schema: "wacrm" },
    });
  }
  return _adminClient;
}

// Assinatura HMAC do webhook (Passo 4). Em dev local, corresponde ao
// META_APP_SECRET configurado no .env.local do servidor Next — sem isso o
// webhook rejeita toda requisição com 401 antes de tocar no banco.
export const META_APP_SECRET = () => required("STRESS_META_APP_SECRET");

// Opcional — só necessário para o teste "Tier B" (pipeline completo) em
// test-webhook.ts. Ver tests/stress/README.md, seção "Teste de webhook",
// para o SQL de provisionamento do canal de teste e por que isso NÃO é
// feito automaticamente pelo script.
export const WEBHOOK_TEST_PHONE_NUMBER_ID = () =>
  process.env.STRESS_WEBHOOK_PHONE_NUMBER_ID || null;

export const WEBHOOK_CONCURRENCY_LEVELS = [10, 50, 100] as const;

export const CSV_SIZES = [100, 500, 1000, 5000, 10000] as const;

export const DATA_DIR = path.join(__dirname, "data");
export const RESULTS_DIR = path.join(__dirname, "results");

export const IMPORT_REQUEST_TIMEOUT_MS = 120_000;
export const QUEUE_POLL_INTERVAL_MS = 30_000;
export const QUEUE_TEST_TIMEOUT_MS = 10 * 60_000;
export const QUEUE_TEST_CONTACT_COUNT = 1000;
