import { timingSafeEqual, createHmac } from "node:crypto";
import { NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { writeLog } from "@/lib/logger";
import { findActiveKeyByHash } from "@/lib/api-keys/store";
import { hashApiKey } from "@/lib/api-keys/keys";

// ============================================================
// POST /api/stress/run — health check automatizado de produção.
//
// Pensado pra rodar via crontab (uma vez por dia, ver README.md) e sob
// demanda pelo botão "Rodar agora" em /ddm-logs (aba Testes). Cada
// execução grava UM registro em wacrm.system_logs (event =
// 'automated_health_check') — é isso que a aba Testes lista.
//
// Autenticação: header x-stress-secret == env STRESS_RUN_SECRET.
// Mesmo padrão de comparação em tempo constante já usado em
// /api/flows/cron e /api/automations/cron.
// ============================================================

let _adminClient: SupabaseClient | null = null;
function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || "",
      process.env.SUPABASE_SERVICE_ROLE_KEY || "",
      { db: { schema: "wacrm" } }
    ) as any;
  }
  return _adminClient!;
}

function getBaseUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || "https://omnicrm.grupoddm.ia.br";
}

type TestStatus = "pass" | "fail" | "warn";

interface TestResult {
  name: string;
  status: TestStatus;
  duration_ms: number;
  message: string;
}

interface TestOutcome {
  status: TestStatus;
  message: string;
}

// Timeout por teste via AbortController — tanto fetch() quanto o
// .abortSignal() do supabase-js respeitam o mesmo signal, então o
// mesmo helper cobre os dois tipos de teste (HTTP e DB direto).
async function runTest(
  name: string,
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<TestOutcome>
): Promise<TestResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { status, message } = await fn(controller.signal);
    return { name, status, duration_ms: Date.now() - start, message };
  } catch (err: any) {
    const isAbort = err?.name === "AbortError";
    return {
      name,
      status: "fail",
      duration_ms: Date.now() - start,
      message: isAbort ? `timeout após ${timeoutMs}ms` : err?.message || String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

function signMetaPayload(rawBody: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
}

// ---- 1. smoke_webhook ----
// Payload com entry:[] é inerte no processWebhook (o loop `for (const
// entry of body.entry)` não itera nada) — seguro de chamar de verdade,
// sem risco de criar contato/mensagem nem de qualquer efeito colateral.
// Só tem phone_number_id quando o payload tem uma entry de verdade, o
// que não é o caso aqui — então a verificação de assinatura SEMPRE cai
// no fallback global META_APP_SECRET (nunca no app_secret por canal).
// Se a conta só usa app_secret por canal e nunca configurou o fallback
// global, este teste falha mesmo com o webhook saudável pra tráfego
// real — falso negativo conhecido, não indica problema de verdade.
async function testSmokeWebhook(signal: AbortSignal): Promise<TestOutcome> {
  const secret = process.env.META_APP_SECRET;
  if (!secret) {
    return {
      status: "fail",
      message:
        "META_APP_SECRET não configurado (fallback global) — canais com app_secret próprio podem estar OK mesmo assim",
    };
  }
  const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
  const signature = signMetaPayload(body, secret);
  const res = await fetch(`${getBaseUrl()}/api/whatsapp/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-hub-signature-256": signature },
    body,
    signal,
  });
  if (res.status !== 200) {
    return { status: "fail", message: `status ${res.status} (esperado 200)` };
  }
  return { status: "pass", message: "Webhook respondeu 200" };
}

// ---- 2. smoke_cron_disparador ----
// Chama a rota de produção de verdade — não é um mock. processQueueItem
// já é seguro sob invocações concorrentes (claim atômico via UPDATE
// condicional, ver processQueue.ts), então rodar isso a mais (fora do
// crontab de ~60s que já existe) não introduz risco de double-send.
async function testSmokeCronDisparador(signal: AbortSignal): Promise<TestOutcome> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return { status: "fail", message: "CRON_SECRET não configurado no servidor" };
  }
  const res = await fetch(`${getBaseUrl()}/api/disparador/cron`, {
    method: "POST",
    headers: { "x-cron-secret": secret },
    signal,
  });
  if (res.status !== 200) {
    return { status: "fail", message: `status ${res.status} (esperado 200)` };
  }
  return { status: "pass", message: "Cron do disparador respondeu 200" };
}

// ---- 3. smoke_cron_flows ----
// Idem — chama /api/flows/cron de verdade. Efeito colateral desejável:
// esse sweep (timeout de flow_runs travados) hoje só roda quando algo
// bate essa rota; incluir aqui + o crontab diário do README passa a dar
// a ele uma execução garantida por dia, mesmo que nenhum outro agendador
// externo esteja configurado.
async function testSmokeCronFlows(signal: AbortSignal): Promise<TestOutcome> {
  const secret = process.env.AUTOMATION_CRON_SECRET;
  if (!secret) {
    return { status: "fail", message: "AUTOMATION_CRON_SECRET não configurado no servidor" };
  }
  const res = await fetch(`${getBaseUrl()}/api/flows/cron`, {
    method: "GET",
    headers: { "x-cron-secret": secret },
    signal,
  });
  if (res.status !== 200) {
    return { status: "fail", message: `status ${res.status} (esperado 200)` };
  }
  return { status: "pass", message: "Cron de flows respondeu 200" };
}

// ---- 4. smoke_db ----
async function testSmokeDb(signal: AbortSignal): Promise<TestOutcome> {
  const { count, error } = await supabaseAdmin()
    .from("contacts")
    .select("id", { count: "exact", head: true })
    .abortSignal(signal);
  if (error) return { status: "fail", message: error.message };
  return { status: "pass", message: `${count ?? 0} contatos no banco` };
}

// ---- 5. queue_health ----
// CAVEAT conhecido (ver memória do projeto): disp_message_queue.updated_at
// não é mantida por nenhum trigger — nada reescreve essa coluna quando um
// item vira 'enviando'. Na prática ela reflete o momento em que a LINHA
// foi criada (enqueue), não quando o processamento começou. Isso pode
// gerar falso-positivo de "travado" pra itens que só estão demorando o
// pacing normal entre enqueue e claim. Implementado literalmente como
// pedido; se virar ruído no dashboard, o fix correto é trocar por uma
// coluna mantida de verdade (ex: um trigger dedicado), não ajustar o
// threshold aqui.
async function testQueueHealth(signal: AbortSignal): Promise<TestOutcome> {
  const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { count, error } = await supabaseAdmin()
    .from("disp_message_queue")
    .select("id", { count: "exact", head: true })
    .eq("status", "enviando")
    .lt("updated_at", cutoff)
    .abortSignal(signal);
  if (error) return { status: "fail", message: error.message };
  const n = count ?? 0;
  if (n > 0) return { status: "warn", message: `${n} itens presos em enviando` };
  return { status: "pass", message: "Nenhum item preso em enviando" };
}

// ---- 6. flow_runs_health ----
// last_advanced_at É mantida de verdade (confirmado ao vivo) — diferente
// do caveat acima, este check é confiável.
async function testFlowRunsHealth(signal: AbortSignal): Promise<TestOutcome> {
  const cutoff = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  const { count, error } = await supabaseAdmin()
    .from("flow_runs")
    .select("id", { count: "exact", head: true })
    .eq("status", "active")
    .lt("last_advanced_at", cutoff)
    .abortSignal(signal);
  if (error) return { status: "fail", message: error.message };
  const n = count ?? 0;
  if (n > 0) return { status: "warn", message: `${n} flow_runs travados além do timeout` };
  return { status: "pass", message: "Nenhum flow_run travado" };
}

// ---- 7. pending_conversations ----
async function testPendingConversations(signal: AbortSignal): Promise<TestOutcome> {
  const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { count, error } = await supabaseAdmin()
    .from("conversations")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending")
    .lt("updated_at", cutoff)
    .abortSignal(signal);
  if (error) return { status: "fail", message: error.message };
  const n = count ?? 0;
  if (n > 5) return { status: "warn", message: `${n} conversas pendentes sem agente` };
  return { status: "pass", message: `${n} conversa(s) pendente(s) (dentro do normal)` };
}

// ---- 8. ddm_api_health ----
// Health check de um sistema externo do mesmo grupo (ddmacordos.com),
// não do próprio CRM — verifica se a API de débitos está respondendo
// antes de qualquer integração do disparador/CRM depender dela.
async function testDdmApiHealth(signal: AbortSignal): Promise<TestOutcome> {
  const token = process.env.DDM_ACORDOS_API_TOKEN;
  if (!token) {
    return { status: "fail", message: "DDM_ACORDOS_API_TOKEN não configurado no servidor" };
  }
  const idDev = "1599911302107525132";
  const url = `https://ddmacordos.com/calc/?tk=${token}&idDev=${idDev}&cli=ddm`;
  const res = await fetch(url, { signal });
  if (res.status !== 200) {
    return { status: "fail", message: `status ${res.status} (esperado 200)` };
  }
  const body = await res.json().catch(() => null);
  if (body && typeof body === "object" && !Array.isArray(body) && (body as any).error === "invalid_client") {
    return { status: "fail", message: "API DDM retornou invalid_client" };
  }
  if (Array.isArray(body)) {
    return { status: "pass", message: "API DDM respondendo corretamente" };
  }
  return { status: "warn", message: "API DDM respondeu 200 com formato inesperado" };
}

// ---- 9/10/11. api_v1_* ----
// Smoke test de autenticação da API pública: bate cada rota sem
// Authorization header e espera 401 unauthorized (não 500). Não é um
// teste de negócio (não manda bearer válido) — só confirma que o
// plumbing de auth (requireApiKey) está de pé antes de qualquer
// integrador real depender dele. Mesmo padrão de resposta esperado
// pelas 3 rotas, então usa um helper único.
async function testApiV1Unauthorized(
  method: "GET" | "POST",
  path: string,
  signal: AbortSignal
): Promise<TestOutcome> {
  const res = await fetch(`${getBaseUrl()}${path}`, { method, signal });
  if (res.status !== 401) {
    return { status: "fail", message: `status ${res.status} (esperado 401)` };
  }
  const body = await res.json().catch(() => null);
  if (body?.error?.code !== "unauthorized") {
    return {
      status: "fail",
      message: `401 mas error.code inesperado: ${body?.error?.code ?? "(sem body)"}`,
    };
  }
  return { status: "pass", message: "401 unauthorized como esperado" };
}

async function testApiV1Me(signal: AbortSignal): Promise<TestOutcome> {
  return testApiV1Unauthorized("GET", "/api/v1/me", signal);
}

async function testApiV1Campaigns(signal: AbortSignal): Promise<TestOutcome> {
  return testApiV1Unauthorized("POST", "/api/v1/disparador/campaigns", signal);
}

async function testApiV1WhatsappSend(signal: AbortSignal): Promise<TestOutcome> {
  return testApiV1Unauthorized("POST", "/api/v1/whatsapp/send", signal);
}

// ---- 12. api_v1_campaign_status ----
// Teste de negócio (não só de auth): confirma que GET /api/v1/disparador/
// campaigns/{id} funciona de ponta a ponta contra uma campanha real,
// criada de verdade via API — não um mock. Depende de wacrm.campaigns.
// source (migration 100), que distingue campanhas criadas por esta rota
// pública de campanhas criadas pelo wizard do dashboard (created_by
// sozinho não serve: as duas o preenchem).
async function testApiV1CampaignStatus(signal: AbortSignal): Promise<TestOutcome> {
  const apiKey = process.env.STRESS_API_KEY;
  if (!apiKey) {
    return { status: "fail", message: "STRESS_API_KEY não configurado no servidor" };
  }

  const apiKeyRow = await findActiveKeyByHash(hashApiKey(apiKey));
  if (!apiKeyRow) {
    return { status: "fail", message: "STRESS_API_KEY inválido, revogado ou expirado" };
  }

  const { data: campaign, error } = await supabaseAdmin()
    .from("campaigns")
    .select("id")
    .eq("source", "api_v1")
    .eq("account_id", apiKeyRow.account_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .abortSignal(signal)
    .maybeSingle();
  if (error) return { status: "fail", message: error.message };
  if (!campaign) {
    return {
      status: "warn",
      message: "Nenhuma campanha api_v1 encontrada para a conta da STRESS_API_KEY",
    };
  }

  const res = await fetch(`${getBaseUrl()}/api/v1/disparador/campaigns/${campaign.id}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  });
  if (res.status !== 200) {
    return { status: "fail", message: `status ${res.status} (esperado 200)` };
  }
  const body = await res.json().catch(() => null);
  if (!body?.data?.campaign_id) {
    return { status: "fail", message: "200 mas data.campaign_id ausente" };
  }
  return { status: "pass", message: `Campanha ${campaign.id} consultada com sucesso` };
}

export async function POST(request: Request) {
  const expected = process.env.STRESS_RUN_SECRET;
  if (!expected) {
    return NextResponse.json({ error: "STRESS_RUN_SECRET não configurado" }, { status: 503 });
  }

  const supplied = request.headers.get("x-stress-secret") ?? "";
  const suppliedBuf = Buffer.from(supplied);
  const expectedBuf = Buffer.from(expected);
  const authorized =
    suppliedBuf.length === expectedBuf.length && timingSafeEqual(suppliedBuf, expectedBuf);
  if (!authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const overallStart = Date.now();

  // Sequencial de propósito (não Promise.all) — os testes de cron
  // batem endpoints que fazem trabalho real; rodar em paralelo
  // multiplicaria a carga simultânea à toa sem nenhum ganho pro
  // objetivo do health check.
  const results: TestResult[] = [];
  results.push(await runTest("smoke_webhook", 2000, testSmokeWebhook));
  results.push(await runTest("smoke_cron_disparador", 3000, testSmokeCronDisparador));
  results.push(await runTest("smoke_cron_flows", 3000, testSmokeCronFlows));
  results.push(await runTest("smoke_db", 5000, testSmokeDb));
  results.push(await runTest("queue_health", 5000, testQueueHealth));
  results.push(await runTest("flow_runs_health", 5000, testFlowRunsHealth));
  results.push(await runTest("pending_conversations", 5000, testPendingConversations));
  results.push(await runTest("ddm_api_health", 5000, testDdmApiHealth));
  results.push(await runTest("api_v1_me", 5000, testApiV1Me));
  results.push(await runTest("api_v1_campaigns", 5000, testApiV1Campaigns));
  results.push(await runTest("api_v1_whatsapp_send", 5000, testApiV1WhatsappSend));
  results.push(await runTest("api_v1_campaign_status", 5000, testApiV1CampaignStatus));

  const duration_total_ms = Date.now() - overallStart;

  const hasFail = results.some((r) => r.status === "fail");
  const hasWarn = results.some((r) => r.status === "warn");
  const overall: TestStatus = hasFail ? "fail" : hasWarn ? "warn" : "pass";

  const passCount = results.filter((r) => r.status === "pass").length;
  const warnCount = results.filter((r) => r.status === "warn").length;
  const failCount = results.filter((r) => r.status === "fail").length;

  const level = overall === "pass" ? "info" : overall === "warn" ? "warn" : "error";
  const message = `Health check: ${passCount}/12 pass, ${warnCount} warn, ${failCount} fail`;

  await writeLog({
    level,
    source: "system",
    event: "automated_health_check",
    message,
    payload: { results, duration_total_ms },
  });

  return NextResponse.json({ overall, results, duration_total_ms, message });
}
