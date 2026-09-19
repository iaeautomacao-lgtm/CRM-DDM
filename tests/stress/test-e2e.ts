// Teste end-to-end (via banco direto, sem HTTP) do fluxo do BEN.
//
// Histórico: a versão original deste teste injetava webhooks HTTP no
// canal WAHA 'forceia' — mas esse canal (conta 311b108c) não tem nenhum
// flow configurado, e a conta inteira (wacrm.flows) só tem 3 linhas no
// total. O flow do "BEN" é na verdade `1b02d801-18e9-4951-a1d6-a03589dd5cf8`
// ("Atendimento -  Principal", conta c8eb3c16), vinculado ao canal Meta
// `3b1370a6-a50f-44b4-882a-b9155aa46d38` — confirmado ao vivo: um
// flow_run real desse flow tem um evento message_sent com o texto
// "Olá, eu sou o Ben...". Esta versão testa contra esse canal/flow real,
// mas SEM disparar o motor de verdade — só cria os dados (contato +
// conversa) e replica a lógica de resolução de entrada do engine
// (findEntryFlow em src/lib/flows/engine.ts) para verificar o que
// aconteceria, e inspeciona o estado real de flow_runs/flow_run_events
// (somente leitura). Isso evita qualquer risco de acionar de verdade o
// agente de IA de produção (que enviaria uma mensagem real via Meta) ou
// de poluir flow_runs/flow_run_events com dados sintéticos.
import fs from "node:fs";
import path from "node:path";
import { randomInt } from "node:crypto";
import { ACCOUNT_ID, RESULTS_DIR, STRESS_PREFIX, USER_ID, supabaseAdmin } from "./config";

const E2E_PREFIX = `${STRESS_PREFIX}_E2E`;

// Canal Meta real "Atendimento - Principal" (produção, conta c8eb3c16) —
// é a esse canal que o flow do BEN está vinculado via whatsapp_config.flow_id.
const TARGET_CONFIG_ID = "3b1370a6-a50f-44b4-882a-b9155aa46d38";
const EXPECTED_FLOW_ID = "1b02d801-18e9-4951-a1d6-a03589dd5cf8";

type StepStatus = "pass" | "fail" | "partial";

interface StepResult {
  name: string;
  label: string;
  status: StepStatus;
  durationMs: number;
  details: unknown;
  error?: string;
}

const steps: StepResult[] = [];

async function runStep(
  name: string,
  label: string,
  fn: () => Promise<{ status: StepStatus; details: unknown }>
): Promise<StepResult> {
  const start = Date.now();
  let result: StepResult;
  try {
    const { status, details } = await fn();
    result = { name, label, status, durationMs: Date.now() - start, details };
  } catch (err: any) {
    result = {
      name,
      label,
      status: "fail",
      durationMs: Date.now() - start,
      details: null,
      error: err.message,
    };
  }
  steps.push(result);
  const icon = result.status === "pass" ? "✅" : result.status === "partial" ? "⚠️" : "❌";
  console.log(`[test-e2e] ${icon} ${label} (${result.durationMs}ms)`);
  if (result.error) console.log(`           erro: ${result.error}`);
  return result;
}

// Telefone fictício no mesmo padrão de generate-csv.ts (DDD 99, nunca
// atribuído a área real) — único por execução via sufixo aleatório.
function fakePhone(): string {
  const subscriber = "9" + String(randomInt(0, 100_000_000)).padStart(8, "0");
  return `+5599${subscriber}`;
}

// ETAPA 1 — cria o contato de teste.
async function createTestContact(): Promise<{ id: string; phone: string }> {
  const db = supabaseAdmin();
  const phone = fakePhone();
  const { data, error } = await db
    .from("contacts")
    .insert({
      account_id: ACCOUNT_ID(),
      user_id: USER_ID(),
      phone,
      name: `${E2E_PREFIX}_Contato`,
    })
    .select("id, phone")
    .single();
  if (error || !data) throw new Error(`Falha ao criar contato: ${error?.message}`);
  return data;
}

// ETAPA 2 — cria a conversa de teste, já vinculada ao canal do BEN.
async function createTestConversation(contactId: string): Promise<string> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("conversations")
    .insert({
      account_id: ACCOUNT_ID(),
      user_id: USER_ID(),
      contact_id: contactId,
      config_id: TARGET_CONFIG_ID,
      status: "open",
      unread_count: 0,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`Falha ao criar conversa: ${error?.message}`);
  return data.id;
}

interface FlowTriggerCheck {
  wouldTrigger: boolean;
  matchesExpectedFlow: boolean;
  resolutionPath: "channel_binding" | "channel_binding_inactive" | "account_scan_first_inbound" | "no_match";
  boundFlowId: string | null;
  resolvedFlow: { id: string; name: string; status: string; trigger_type: string } | null;
}

// ETAPA 3 — replica findEntryFlow (src/lib/flows/engine.ts:492) sem
// executar o engine de verdade. Mesma ordem de precedência do código
// real: um canal com flow_id vinculado (migration 056, setado via
// /canais) SEMPRE usa aquele flow em qualquer texto inbound — a
// vinculação É o trigger, sem checar trigger_type/keyword. Só cai para a
// varredura por conta (trigger_type='first_inbound_message'/'keyword')
// quando o canal não tem flow_id nenhum. Um flow_id vinculado mas
// inativo NÃO cai para a varredura (comportamento real, ver comentário
// original em engine.ts) — reportado como 'channel_binding_inactive'.
async function checkFlowWouldTrigger(): Promise<FlowTriggerCheck> {
  const db = supabaseAdmin();

  const { data: config } = await db
    .from("whatsapp_config")
    .select("flow_id")
    .eq("id", TARGET_CONFIG_ID)
    .maybeSingle();
  const boundFlowId: string | null = config?.flow_id ?? null;

  if (boundFlowId) {
    const { data: flow } = await db
      .from("flows")
      .select("id, name, status, trigger_type")
      .eq("id", boundFlowId)
      .maybeSingle();
    if (flow && flow.status === "active") {
      return {
        wouldTrigger: true,
        matchesExpectedFlow: flow.id === EXPECTED_FLOW_ID,
        resolutionPath: "channel_binding",
        boundFlowId,
        resolvedFlow: flow,
      };
    }
    return {
      wouldTrigger: false,
      matchesExpectedFlow: false,
      resolutionPath: "channel_binding_inactive",
      boundFlowId,
      resolvedFlow: flow ?? null,
    };
  }

  const { data: flows } = await db
    .from("flows")
    .select("id, name, status, trigger_type")
    .eq("account_id", ACCOUNT_ID())
    .eq("status", "active")
    .order("created_at", { ascending: true });
  const firstInboundFlow = (flows ?? []).find(
    (f: { trigger_type: string }) => f.trigger_type === "first_inbound_message"
  );

  return {
    wouldTrigger: !!firstInboundFlow,
    matchesExpectedFlow: firstInboundFlow?.id === EXPECTED_FLOW_ID,
    resolutionPath: firstInboundFlow ? "account_scan_first_inbound" : "no_match",
    boundFlowId: null,
    resolvedFlow: firstInboundFlow ?? null,
  };
}

interface FlowHealthReport {
  activeRunsTotal: number;
  activeRunsStartedLast24h: number;
  errorEventsLast24h: number;
  recentRuns: Array<{
    id: string;
    status: string;
    contact_id: string;
    started_at: string;
    ended_at: string | null;
    end_reason: string | null;
  }>;
  stuckRuns: Array<{
    id: string;
    contact_id: string;
    current_node_key: string | null;
    last_advanced_at: string;
    started_at: string;
  }>;
  health: "ok" | "atencao";
}

// ETAPA 4 — inspeciona o estado real de flow_runs/flow_run_events
// (somente leitura, nunca escreve nessas tabelas).
async function checkFlowEngineHealth(): Promise<FlowHealthReport> {
  const db = supabaseAdmin();
  const accountId = ACCOUNT_ID();
  const since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const since1h = new Date(Date.now() - 3600 * 1000).toISOString();

  const { count: activeRunsTotal } = await db
    .from("flow_runs")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId)
    .eq("status", "active");

  const { count: activeRunsStartedLast24h } = await db
    .from("flow_runs")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId)
    .eq("status", "active")
    .gte("started_at", since24h);

  // flow_run_events só tem account_id preenchido em alguns event_type
  // (ver amostra ao vivo: node_entered/message_sent/reply_received vêm
  // com account_id null) — para não perder eventos, escopa pela lista
  // de flow_run_id da conta em vez de filtrar por account_id direto na
  // tabela de eventos.
  const { data: recentRunRows } = await db
    .from("flow_runs")
    .select("id")
    .eq("account_id", accountId)
    .gte("started_at", since24h);
  const recentRunIds = (recentRunRows ?? []).map((r: { id: string }) => r.id);

  let errorEventsLast24h = 0;
  if (recentRunIds.length > 0) {
    const { count } = await db
      .from("flow_run_events")
      .select("id", { count: "exact", head: true })
      .in("flow_run_id", recentRunIds)
      .eq("status", "error")
      .gte("created_at", since24h);
    errorEventsLast24h = count ?? 0;
  }

  const { data: recentRuns } = await db
    .from("flow_runs")
    .select("id, status, contact_id, started_at, ended_at, end_reason")
    .eq("account_id", accountId)
    .order("started_at", { ascending: false })
    .limit(5);

  const { data: stuckRuns } = await db
    .from("flow_runs")
    .select("id, contact_id, current_node_key, last_advanced_at, started_at")
    .eq("account_id", accountId)
    .eq("status", "active")
    .lt("last_advanced_at", since1h);

  const health: "ok" | "atencao" =
    (stuckRuns?.length ?? 0) > 0 || errorEventsLast24h > 0 ? "atencao" : "ok";

  return {
    activeRunsTotal: activeRunsTotal ?? 0,
    activeRunsStartedLast24h: activeRunsStartedLast24h ?? 0,
    errorEventsLast24h,
    recentRuns: recentRuns ?? [],
    stuckRuns: stuckRuns ?? [],
    health,
  };
}

// ETAPA 6 — remove só o que este script criou (contato + conversa).
// Nunca toca flow_runs/flow_run_events (a ETAPA 4 é somente leitura).
async function cleanupTestData(
  contactId: string | null,
  conversationId: string | null
): Promise<{ conversation: boolean; contact: boolean }> {
  const db = supabaseAdmin();
  const removed = { conversation: false, contact: false };

  if (conversationId) {
    const { error } = await db.from("conversations").delete().eq("id", conversationId);
    removed.conversation = !error;
    if (error) console.error("[test-e2e] Falha ao remover conversa de teste:", error.message);
  }
  // conversations.contact_id é ON DELETE CASCADE (migration 001), então
  // apagar o contato já limparia a conversa mesmo se o delete acima
  // falhasse — mantido explícito acima só para o relatório distinguir
  // as duas remoções.
  if (contactId) {
    const { error } = await db.from("contacts").delete().eq("id", contactId);
    removed.contact = !error;
    if (error) console.error("[test-e2e] Falha ao remover contato de teste:", error.message);
  }
  return removed;
}

async function main() {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  console.log(`[test-e2e] Conta alvo: ${ACCOUNT_ID()}`);
  console.log(`[test-e2e] Canal alvo (BEN): ${TARGET_CONFIG_ID}`);
  console.log(`[test-e2e] Flow esperado: ${EXPECTED_FLOW_ID} ("Atendimento - Principal")\n`);

  let contactId: string | null = null;
  let conversationId: string | null = null;

  await runStep("1_criar_contato", "Etapa 1 — Criar contato de teste", async () => {
    const contact = await createTestContact();
    contactId = contact.id;
    return { status: "pass", details: contact };
  });

  await runStep("2_criar_conversa", "Etapa 2 — Criar conversa de teste", async () => {
    if (!contactId) throw new Error("Contato não foi criado na etapa anterior.");
    conversationId = await createTestConversation(contactId);
    return {
      status: "pass",
      details: { conversationId, contactId, configId: TARGET_CONFIG_ID },
    };
  });

  await runStep(
    "3_flow_seria_acionado",
    "Etapa 3 — Verificar se o flow do BEN seria acionado",
    async () => {
      const result = await checkFlowWouldTrigger();
      const status: StepStatus =
        result.wouldTrigger && result.matchesExpectedFlow
          ? "pass"
          : result.wouldTrigger
            ? "partial"
            : "fail";
      return { status, details: result };
    }
  );

  const step4 = await runStep(
    "4_saude_engine_flows",
    "Etapa 4 — Saúde do engine de flows (últimas 24h)",
    async () => {
      const result = await checkFlowEngineHealth();
      return { status: result.health === "ok" ? "pass" : "partial", details: result };
    }
  );

  await runStep("6_cleanup", "Etapa 6 — Limpeza dos dados de teste", async () => {
    const removed = await cleanupTestData(contactId, conversationId);
    const status: StepStatus = removed.conversation && removed.contact ? "pass" : "partial";
    return { status, details: removed };
  });

  // ETAPA 5 — relatório final (gerado por último de propósito, pra
  // incluir o resultado da limpeza na mesma tabela).
  console.log("\n=========================================");
  console.log(" RELATÓRIO — TESTE E2E (BEN)");
  console.log("=========================================\n");
  for (const s of steps) {
    const icon = s.status === "pass" ? "✅" : s.status === "partial" ? "⚠️" : "❌";
    console.log(`${icon} ${s.label} — ${s.durationMs}ms`);
    if (s.error) console.log(`   erro: ${s.error}`);
  }

  const flowHealth = step4.details as FlowHealthReport;
  console.log("\n-- Estado do engine de flows (conta c8eb3c16) --");
  console.log(`  Runs ativos agora (total): ${flowHealth.activeRunsTotal}`);
  console.log(`  Runs ativos iniciados nas últimas 24h: ${flowHealth.activeRunsStartedLast24h}`);
  console.log(`  Eventos de erro nas últimas 24h: ${flowHealth.errorEventsLast24h}`);
  console.log(`  Runs travados (ativos há +1h sem avançar): ${flowHealth.stuckRuns.length}`);
  if (flowHealth.stuckRuns.length > 0) {
    for (const r of flowHealth.stuckRuns) {
      console.log(`    - run ${r.id} — contact ${r.contact_id} — nó "${r.current_node_key}" — último avanço em ${r.last_advanced_at}`);
    }
  }
  console.log(`  Saúde geral: ${flowHealth.health === "ok" ? "OK" : "ATENÇÃO"}`);
  console.log(`  5 runs mais recentes:`);
  for (const r of flowHealth.recentRuns) {
    console.log(
      `    - ${r.id} — status=${r.status} — contact=${r.contact_id} — started=${r.started_at} — ended=${r.ended_at ?? "-"} — end_reason=${r.end_reason ?? "-"}`
    );
  }

  const allPassed = steps.every((s) => s.status === "pass");
  console.log(`\n[test-e2e] Resultado geral: ${allPassed ? "TODAS AS ETAPAS PASSARAM" : "VER ETAPAS ACIMA"}`);

  const outPath = path.join(RESULTS_DIR, "e2e-results.json");
  fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), steps }, null, 2), "utf-8");
  console.log(`[test-e2e] Resultados salvos em ${outPath}`);
}

main().catch((err) => {
  console.error("[test-e2e] Erro fatal:", err.message);
  process.exit(1);
});
