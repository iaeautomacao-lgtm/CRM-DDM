import { resolveProviderMedia } from '@/lib/storage/provider-media';
import { classifyPriorityIntent } from "@/lib/ai/priority-intents";
import { formatBrazilianPhone } from "@/lib/disparador/phone-key";
import { persistOutboundMessage } from '@/lib/messages/persist-outbound';
import { writeLog } from '@/lib/logger';
import { resolveToolSecrets } from '@/lib/ai/tool-secrets';
import {
  getAiModelDefinition,
  isModelCompatibleWithProvider,
  resolveAiModel,
} from "@/lib/ai/models";
import { describeAttemptStop, effectivePromptVersion, newAttemptTrace, type AiAttemptTrace } from '@/lib/ai/attempt-telemetry';
import { auditFetch } from '@/lib/audit/context'
import { chatMediaReference } from '@/lib/storage/chat-media';
import { createClient } from "@supabase/supabase-js";
import type { AiAgentTool } from "@/lib/flows/types";
import {
  classifyFetchFailure,
  classifyHttpFailure,
  classifyToolBodyFailure,
  fullyFailedIntegrations,
  prepareToolArgs,
  retryDelayMs,
  serializeToolFailure,
  shouldRetryTool,
  tallyToolResult,
  type ToolExecutionMeta,
  type ToolRoundTally,
} from "@/lib/ai/tool-recovery";
import { detectAbusiveInput } from "@/lib/ai/abuse-guard";
import { createAiHeartbeat, type AiHeartbeat } from "@/lib/ai/heartbeat";
import { gatedFetch } from "@/lib/ai/llm-gate";
import { buildKnowledgeBaseContext } from "@/lib/ai/kb-context";
import { BOT_LOOP_MIN_MESSAGES, BOT_LOOP_WINDOW_SECONDS, detectBotLoop } from "@/lib/ai/loop-guard";
import { handOffToTeamQueue } from "@/lib/ai/team-handoff";
import { decrypt, tryDecrypt } from "@/lib/whatsapp/encryption";
import { sendTextMessage, sendMediaMessage } from "@/lib/whatsapp/meta-api";
import {
  extractAiExitTag,
  shouldLegacyAssignHuman,
  stripAiExitTag,
} from "@/lib/ai/exit-tags";
import { sendWahaTextMessage, sendWahaMediaMessage } from "@/lib/whatsapp/waha-api";
import { getConversationChannel, isSocialChannel, sendWebchatMessage } from "@/lib/webchat/send";
import { sendSocialMessage } from "@/lib/channels/social";
import {
  sanitizePhoneForMeta,
  phoneVariants,
  isValidE164,
  isRecipientNotAllowedError,
} from "@/lib/whatsapp/phone-utils";

// fetch com teto de 15s para todas as chamadas externas da IA (OpenAI,
// Gemini, Claude, API DDM, TTS, download de mídia). Sem isso uma API lenta
// segurava a requisição indefinidamente. Se o chamador já passar um
// signal próprio (ex.: timeout de 10s), vale o que disparar primeiro.
function boundedFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const timeout = AbortSignal.timeout(15_000);
  return globalThis.fetch(input, { ...init, signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabaseAdmin = () => createClient(supabaseUrl, supabaseServiceKey, {
  db: {
    schema: 'wacrm'
  },
        // Auditoria (migration 131): escritas da IA saem como ator "ai".
        global: { fetch: auditFetch, headers: { 'x-audit-actor-type': 'ai', 'x-audit-source': 'ia' } },
});

// Enviada quando o modelo retorna "" tanto na primeira tentativa quanto
// no retry automático (ver handleAiAutoResponse, passo 5) — mantém a
// conversa andando em vez de deixar o cliente sem resposta. O resultado
// estruturado devolvido ao Flow Engine inclui o id e o conteúdo exatos da
// mensagem persistida, então o engine não precisa inferir a resposta
// procurando outra linha sender_type="bot" por timestamp.
export const AI_EMPTY_REPLY_FALLBACK_TEXT =
  "Olá! 😊 Tudo bem? Sou o Ben, do Grupo DDM. Para verificarmos sua situação, preciso do seu CPF (apenas os números). Pode me passar?";

// Enviada quando uma integração (API DDM etc.) falha de vez e o modelo não
// encerrou com tag — vai junto com #INSTABILIDADE para o fluxo transferir.
export const AI_INSTABILITY_TEXT =
  "Estamos com uma instabilidade no sistema para consultar seus dados agora. Vou te encaminhar para um de nossos atendentes, que continua seu atendimento por aqui. Só um instante!";

/**
 * Token da API DDM Acordos (localiza_dev, calc, CalculaDebitos). Só vem do
 * ambiente do servidor — nunca com valor padrão no código (o antigo vazou
 * no repositório). DDM_ACORDOS_API_TOKEN é o nome documentado; DDM_TOKEN e
 * DDM_API_KEY seguem aceitos para não quebrar servidores já configurados.
 */
function ddmApiToken(): string | null {
  const token = [process.env.DDM_ACORDOS_API_TOKEN, process.env.DDM_TOKEN, process.env.DDM_API_KEY].find(
    (v) => v && v.trim(),
  );
  if (!token) {
    console.error("[AI Agent] DDM_ACORDOS_API_TOKEN não configurado — consulta/formalização na DDM desativada");
    return null;
  }
  return token.trim();
}

interface DdmCpfResponse {
  instituicao?: string;
  valor_divida?: number | string;
  [key: string]: any;
}

async function fetchDdmCpfDetails(cpf: string): Promise<DdmCpfResponse | null> {
  const token = ddmApiToken();
  if (!token) return null;

  try {
    // Passo 1: Localizar devedor por CPF no localiza_dev.php com timeout de 10s
    const localizaUrl = `https://www.ddmacordos.com/calc/localiza_dev.php?tk=${token}&cpf=${cpf}`;
    const resLocaliza = await boundedFetch(localizaUrl, { signal: AbortSignal.timeout(10000) });
    if (!resLocaliza.ok) {
      console.warn(`[AI Agent] DDM localiza_dev failed with status: ${resLocaliza.status}`);
      return null;
    }

    const localizaData = await resLocaliza.json();
    if (!Array.isArray(localizaData) || localizaData.length === 0) {
      console.log(`[AI Agent] No debtor found for CPF ${cpf}`);
      return null;
    }

    const debtor = localizaData[0];
    const iddev = debtor.iddev;
    const sistema = debtor.sistema; // ex: 'cruzeiro'
    const instituicao = debtor.apelido || debtor.Apelido || debtor.instituicao || "Cruzeiro";
    const nome = debtor.nome || "";

    if (!iddev || !sistema) {
      console.warn("[AI Agent] Missing iddev or sistema in debtor localiza data");
      return { nome, instituicao };
    }

    // Passo 2: Buscar detalhes de cálculo com timeout de 10s
    const calcUrl = `https://ddmacordos.com/calc/?tk=${token}&idDev=${iddev}&cli=${sistema}&Desconto=40`;
    const resCalc = await boundedFetch(calcUrl, { signal: AbortSignal.timeout(10000) });
    if (!resCalc.ok) {
      console.warn(`[AI Agent] DDM calc failed with status: ${resCalc.status}`);
      return { nome, instituicao };
    }

    const calcData = await resCalc.json();
    let valor_divida = "0,00";
    let opcoes_cartao = "";
    let campanha = "2025.1";
    let resumo_parcelamento: any[] = [];
    let acordos: any[] = [];

    let calculoId = "";

    const calcArray = Array.isArray(calcData) ? calcData : [calcData];

    if (calcArray.length > 0) {
      const dadosObj = calcArray.find((obj: any) => obj.Dados);
      if (dadosObj && dadosObj.Dados) {
        calculoId = String(dadosObj.Dados.CalculoID || dadosObj.Dados.idcalc || "");
      }

      const pgtoAvista = calcArray.find((obj: any) => obj.PgtoAvista);
      if (pgtoAvista && pgtoAvista.PgtoAvista && pgtoAvista.PgtoAvista.ValorFinal) {
        valor_divida = pgtoAvista.PgtoAvista.ValorFinal;
      }

      // Extract agreements (case-insensitive key handling)
      const acordosObj = calcArray.find((obj: any) => obj.acordos || obj.Acordos);
      if (acordosObj) {
        const rawAcordos = acordosObj.acordos || acordosObj.Acordos;
        if (Array.isArray(rawAcordos)) {
          acordos = rawAcordos;
        }
      }

      // Extract boleto installments (case-insensitive key handling)
      const pgtoBoletoObj = calcArray.find((obj: any) => obj.PgtoParceladoBoleto || obj.pgtoParceladoBoleto || obj.resumo_parcelamento);
      const rawBoleto = pgtoBoletoObj?.PgtoParceladoBoleto || pgtoBoletoObj?.pgtoParceladoBoleto || pgtoBoletoObj?.resumo_parcelamento;
      if (rawBoleto) {
        if (Array.isArray(rawBoleto)) {
          resumo_parcelamento = rawBoleto.map((item: any) => ({
            entrada: item.entrada || "0,00",
            parcelas: item.parcelas || 1,
            valor_parcela: item.valor_parcela || item.valor || "0,00"
          }));
        } else if (typeof rawBoleto === "object") {
          resumo_parcelamento = Object.entries(rawBoleto).map(([key, val]: [string, any]) => ({
            entrada: val.entrada || "0,00",
            parcelas: parseInt(key) || val.parcelas || 1,
            valor_parcela: val.valor_parcela || val.valor || "0,00"
          }));
        }
      }

      // Extrai os débitos para analisar o ano de cada parcela
      const calculosObj = calcArray.find((obj: any) => obj.Calculos);
      const calculosList = calculosObj?.Calculos || [];

      let temDebitoAte2019 = false;
      for (const calc of calculosList) {
        const dataParc = calc?.debitos?.data_parcela; // YYYY-MM-DD
        if (dataParc) {
          const ano = parseInt(dataParc.split("-")[0]);
          if (ano <= 2019) {
            temDebitoAte2019 = true;
          }
        }
      }

      let maxParcelas = 6;
      let parcelaMinima = 150.0;
      if (temDebitoAte2019) {
        campanha = "Até 2019";
        maxParcelas = 10;
        parcelaMinima = 100.0;
      } else {
        campanha = "2025.1";
      }

      const cleanVal = String(valor_divida).replace(/\./g, "").replace(",", ".");
      const totalFloat = parseFloat(cleanVal);

      if (!isNaN(totalFloat) && totalFloat > 0) {
        const validParcels = [];
        for (let p = 1; p <= maxParcelas; p++) {
          const valParcela = totalFloat / p;
          if (p === 1 || valParcela >= parcelaMinima) {
            validParcels.push(`${p}x de R$ ${valParcela.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
          }
        }
        opcoes_cartao = validParcels.join(", ");
      }
    }

    return {
      nome,
      instituicao,
      valor_divida,
      iddev,
      sistema,
      opcoes_cartao,
      campanha,
      resumo_parcelamento,
      acordos,
      calculoId
    };
  } catch (err) {
    console.error("[AI Agent] DDM API sequence error:", err);
    return null;
  }
}

function extractInstallmentsFromHistory(history: any[]): number {
  for (let idx = history.length - 1; idx >= 0; idx--) {
    const text = (history[idx].content_text || "").toLowerCase();
    const sender = history[idx].sender_type;

    if (sender === "customer") {
      const matchX = text.match(/\b(\d+)\s*x\b/);
      if (matchX) {
        const num = parseInt(matchX[1]);
        if (num >= 1 && num <= 12) return num;
      }

      const matchVezes = text.match(/\b(\d+)\s*(vezes|parcela|parc|pgto|parcels)/);
      if (matchVezes) {
        const num = parseInt(matchVezes[1]);
        if (num >= 1 && num <= 12) return num;
      }

      if (/^\s*\d+\s*$/.test(text)) {
        const num = parseInt(text.trim());
        if (num >= 1 && num <= 12) return num;
      }
    }
  }
  return 1;
}

/**
 * Tag de saída imposta pelo código, não escolhida pelo modelo (hoje só
 * #INSTABILIDADE quando todas as chamadas de uma integração falharam).
 * Vai para a telemetria do handoff (ai_decisions.decision.forced).
 */
export interface ForcedAiExit {
  tag: string;
  /** tool → código da última falha (todas as chamadas da rodada falharam). */
  tools: Record<string, string>;
}

/**
 * Decide se a resposta do modelo é trocada por #INSTABILIDADE: só quando
 * alguma tool teve TODAS as chamadas da rodada fora do ar (tally, ver
 * tool-recovery.ts) e o modelo não encerrou com uma tag. null = mantém a
 * resposta do modelo.
 */
export function decideForcedInstability(
  toolTally: Map<string, ToolRoundTally>,
  generatedText: string,
  flowExitTags?: string[],
): ForcedAiExit | null {
  const downIntegrations = fullyFailedIntegrations(toolTally);
  if (Object.keys(downIntegrations).length === 0) return null;
  if (extractAiExitTag(generatedText, flowExitTags)) return null;
  return { tag: "#INSTABILIDADE", tools: downIntegrations };
}

/** Trava que tirou a conversa da IA antes do modelo (anti-abuso/anti-loop). */
export interface AiGuardDetail {
  subreason: string;
  [key: string]: unknown;
}

export type AiAutoResponseResult =
  | {
      outcome: "sent";
      messageId: string;
      providerMessageId: string | null;
      content: string;
      detectedTag: string | null;
      modelUsed: string | null;
      forcedExit?: ForcedAiExit | null;
      /**
       * Versão (hash curto) do prompt da CONTA, ou "default" quando o
       * responder usou o prompt interno. Null com override de nó: o texto
       * chega com variáveis já substituídas — quem chama conhece o cru.
       */
      promptVersion?: string | null;
    }
  | {
      outcome: "skipped";
      reason: string;
      detectedTag: string | null;
      modelUsed: string | null;
      forcedExit?: ForcedAiExit | null;
      guard?: AiGuardDetail;
      /**
       * Versão (hash curto) do prompt da CONTA, ou "default" quando o
       * responder usou o prompt interno. Null com override de nó: o texto
       * chega com variáveis já substituídas — quem chama conhece o cru.
       */
      promptVersion?: string | null;
    }
  | {
      outcome: "failed";
      reason: string;
      detectedTag: string | null;
      modelUsed: string | null;
      providerMessageId?: string | null;
      /**
       * true = falhou ANTES de qualquer efeito externo (nenhuma tool
       * chamada, nada enviado ao cliente) e a reserva da mensagem foi
       * liberada: pode tentar de novo sem risco de duplicar mensagem ou
       * formalizar acordo duas vezes.
       */
      retryable?: boolean;
      /**
       * Versão (hash curto) do prompt da CONTA, ou "default" quando o
       * responder usou o prompt interno. Null com override de nó: o texto
       * chega com variáveis já substituídas — quem chama conhece o cru.
       */
      promptVersion?: string | null;
    };

/**
 * Acompanha uma tentativa de resposta: qual mensagem foi reservada
 * (claim_ai_reply) e se já houve efeito externo.
 */
interface AiAttemptTracker {
  claim: { account: string; conversation: string; message: string; node: string } | null;
  externalEffect: boolean;
  /** Última etapa alcançada (ver attempt-telemetry.ts). */
  trace: AiAttemptTrace;
  /** Marca "IA trabalhando" para o vigia de IA travada (heartbeat.ts). */
  heartbeat?: AiHeartbeat;
  /** Versão do prompt efetivo (ver AiAutoResponseResult.promptVersion). */
  promptVersion?: string | null;
}

/**
 * Resposta da IA para a última mensagem do cliente, com UMA nova tentativa
 * segura: se a primeira falhar antes de qualquer efeito externo (nenhuma
 * tool chamada, nada enviado ao cliente — ex.: OpenAI fora do ar, erro ao
 * montar o histórico), a reserva da mensagem (claim_ai_reply) é liberada
 * (release_ai_reply, migration 146) e tenta de novo após AI_RETRY_DELAY_MS (3 s).
 * Depois de efeito externo não repete: poderia duplicar mensagem ou
 * formalizar acordo duas vezes — aí o vigia de IA travada leva ao humano.
 */
export async function handleAiAutoResponse(
  ...args: AttemptArgs
): Promise<AiAutoResponseResult> {
  const first = await runAiAttempt(args);
  if (!first.retryable) {
    logAttempt(args, first, 1, false);
    return first.finish();
  }
  logAttempt(args, first, 1, true);
  console.warn("[AI Agent] Falha antes de efeito externo — nova tentativa:", first.reason);
  await new Promise((resolve) => setTimeout(resolve, AI_RETRY_DELAY_MS));
  const second = await runAiAttempt(args);
  logAttempt(args, second, 2, false);
  return second.finish();
}

/**
 * Log `ai_attempt` com a etapa em que a tentativa parou — só quando NÃO
 * terminou em "sent" ou quando houve nova tentativa (sucesso normal não
 * gera log, para não inundar system_logs).
 */
function logAttempt(
  args: AttemptArgs,
  attempt: AttemptOutcome,
  number: 1 | 2,
  willRetry: boolean,
): void {
  if (attempt.outcome === "sent" && number === 1) return;
  const [accountId, , conversationId] = args;
  const failed = attempt.outcome === "failed" || attempt.outcome === "error";
  void writeLog({
    account_id: accountId,
    level: failed ? (willRetry ? "warn" : "error") : "info",
    source: "ai_agent",
    event: "ai_attempt",
    message: describeAttemptStop(attempt.trace, attempt.outcome),
    payload: {
      conversation_id: conversationId,
      attempt: number,
      will_retry: willRetry,
      outcome: attempt.outcome,
      reason: attempt.reason,
      phase: attempt.trace.phase,
      tools: attempt.trace.tools,
      prompt_version: attempt.promptVersion ?? null,
      duration_ms: Date.now() - attempt.trace.startedAt,
    },
  });
}

const AI_RETRY_DELAY_MS = 3000;

type AttemptArgs = Parameters<typeof handleAiAutoResponseAttempt> extends [...infer P, AiAttemptTracker?]
  ? P
  : never;

interface AttemptOutcome {
  retryable: boolean;
  reason: string | null;
  /** "error" = exceção relançada (efeito externo já iniciado). */
  outcome: AiAutoResponseResult["outcome"] | "error";
  trace: AiAttemptTrace;
  promptVersion?: string | null;
  finish: () => AiAutoResponseResult;
}

/** Uma tentativa; `retryable` = falhou sem efeito externo e a reserva foi liberada. */
async function runAiAttempt(args: AttemptArgs): Promise<AttemptOutcome> {
  const [, , conversationId] = args;
  const heartbeat = createAiHeartbeat(supabaseAdmin(), conversationId);
  const tracker: AiAttemptTracker = {
    claim: null,
    externalEffect: false,
    trace: newAttemptTrace(),
    heartbeat,
  };
  try {
    return await runAiAttemptTracked(args, tracker);
  } finally {
    // Tentativa terminou (enviada, pulada, falha ou exceção): a IA não está
    // mais trabalhando nesta mensagem.
    await heartbeat.clear();
  }
}

async function runAiAttemptTracked(
  args: AttemptArgs,
  tracker: AiAttemptTracker,
): Promise<AttemptOutcome> {
  const trace = tracker.trace;
  const releaseIfSafe = async (): Promise<boolean> => {
    if (!tracker.claim || tracker.externalEffect) return false;
    const { error } = await supabaseAdmin().rpc("release_ai_reply", {
      p_account: tracker.claim.account,
      p_conversation: tracker.claim.conversation,
      p_message: tracker.claim.message,
      p_node: tracker.claim.node,
    });
    if (error) console.error("[AI Agent] Falha ao liberar a reserva da mensagem:", error.message);
    return !error;
  };
  try {
    const handled = await handleAiAutoResponseAttempt(...args, tracker);
    const result =
      tracker.promptVersion !== undefined
        ? { ...handled, promptVersion: tracker.promptVersion }
        : handled;
    const reason = result.outcome === "sent" ? null : result.reason;
    if (result.outcome === "failed" && (await releaseIfSafe())) {
      const failed = { ...result, retryable: true };
      return { retryable: true, reason, outcome: "failed", trace, promptVersion: tracker.promptVersion, finish: () => failed };
    }
    return { retryable: false, reason, outcome: result.outcome, trace, promptVersion: tracker.promptVersion, finish: () => result };
  } catch (err) {
    // Exceção (ex.: provedor do modelo fora do ar): mesma regra — sem
    // efeito externo, libera e devolve "failed" retentável; com efeito,
    // relança como antes.
    if (await releaseIfSafe()) {
      const failed: AiAutoResponseResult = {
        outcome: "failed",
        reason: `provider_error:${err instanceof Error ? err.message : String(err)}`,
        detectedTag: null,
        modelUsed: null,
        retryable: true,
      };
      return { retryable: true, reason: failed.reason, outcome: "failed", trace, finish: () => failed };
    }
    return {
      retryable: false,
      reason: err instanceof Error ? err.message : String(err),
      outcome: "error",
      trace,
      finish: () => {
        throw err;
      },
    };
  }
}

async function handleAiAutoResponseAttempt(
  accountId: string,
  contactId: string,
  conversationId: string,
  incomingText: string,
  systemPromptOverride?: string,
  skipDebounce?: boolean,
  historyAfter?: string,
  historyBefore?: string,
  tools?: AiAgentTool[],
  onToolCall?: (toolName: string, args: Record<string, unknown>) => Promise<void>,
  onToolResult?: (
    toolName: string,
    result: string,
    durationMs: number,
    meta?: ToolExecutionMeta,
  ) => Promise<void>,
  // Node key of the calling ai_agent flow node — only "agente_de_ia"
  // (BEN) gets the #NEGOCIACAO auto-exit in generateOpenAiResponse.
  // "agente_de_ia_2" (Aleh) needs consultar_debitos' data to present
  // installments to the customer, so it must never get suppressed.
  nodeKey?: string,
  // The wacrm.whatsapp_config row this inbound arrived on. Without it,
  // step 7 below scopes the config lookup by account_id alone, which
  // errors out (or, if RLS/`.maybeSingle()` semantics ever loosen,
  // silently picks an arbitrary row) once an account has more than one
  // WhatsApp channel. Callers should always pass this when they know
  // it — see the three call sites (Meta webhook, WAHA webhook,
  // flows/engine.ts's runAiAgentCore).
  configId?: string,
  // Tags de saída que o fluxo usa nos ramos do switch/condição
  // (subject_key "ai_exit_code") — aceitas além de KNOWN_AI_EXIT_TAGS,
  // para fluxos com tags próprias. Ver exit-tags.ts.
  flowExitTags?: string[],
  // Override opcional do nó ai_agent. Continua restrito ao provider
  // configurado na conta; callers fora do Flow Builder deixam undefined.
  modelOverride?: string | null,
  tracker?: AiAttemptTracker,
): Promise<AiAutoResponseResult> {
  const db = supabaseAdmin();

  // 1. Fetch AI Configuration
  const { data: aiConfig, error: aiConfigError } = await db
    .from("ai_config")
    .select("*")
    .eq("account_id", accountId)
    .maybeSingle();

  if (aiConfigError) {
    return {
      outcome: "failed",
      reason: `ai_config_load_failed:${aiConfigError.message}`,
      detectedTag: null,
      modelUsed: null,
    };
  }
  if (!aiConfig || !aiConfig.enabled) {
    return {
      outcome: "skipped",
      reason: "ai_config_disabled_or_missing",
      detectedTag: null,
      modelUsed: null,
    };
  }

  if (
    modelOverride?.trim() &&
    !isModelCompatibleWithProvider(modelOverride, aiConfig.api_provider)
  ) {
    return {
      outcome: "failed",
      reason: `ai_model_provider_mismatch:${modelOverride} is not compatible with ${aiConfig.api_provider}`,
      detectedTag: null,
      modelUsed: null,
    };
  }

  const resolvedModel = resolveAiModel({
    provider: aiConfig.api_provider,
    nodeModel: modelOverride,
    accountModel:
      typeof (aiConfig as { api_model?: unknown }).api_model === "string"
        ? (aiConfig as { api_model: string }).api_model
        : null,
  });
  if (!resolvedModel) {
    return {
      outcome: "failed",
      reason: `unsupported_ai_provider:${aiConfig.api_provider}`,
      detectedTag: null,
      modelUsed: null,
    };
  }
  const responseModel = resolvedModel.model;

  // --- DEBOUNCE E DELAY DE DIGITAÇÃO ---
  // Aguarda 4 segundos antes de prosseguir. Se uma nova mensagem chegar durante esse intervalo,
  // a execução anterior é interrompida porque o histórico de mensagens mudará e haverá um novo gatilho.
  //
  // Skipped when the caller already debounced (the ai_agent flow node —
  // see debounceAiAgentReply in flows/engine.ts, which serializes replies
  // per run_id before ever calling in here). Stacking both meant every
  // flow-driven AI turn paid this 4s twice for no extra protection.
  if (!skipDebounce) {
    await new Promise((resolve) => setTimeout(resolve, 4000));

    // Recarrega as últimas mensagens para ver se o cliente enviou algo novo depois do gatilho inicial.
    // Se a última mensagem não for a que disparou esta execução, encerramos esta chamada para deixar a mais recente responder.
    //
    // Compara contra received_at (marcado por NOW() no INSERT, isto é,
    // o relógio do nosso servidor), não created_at (o timestamp que o
    // WAHA/Meta manda no payload). created_at reflete o relógio do
    // provedor — qualquer atraso de entrega/fila entre o provedor gerar
    // aquele timestamp e nosso webhook inserir a linha invalidava essa
    // conta de tempo decorrido, deixando duas mensagens rápidas do
    // cliente gerarem duas respostas da IA.
    const { data: latestCheckMsg } = await db
      .from("messages")
      .select("id, content_text, received_at, sender_type")
      .eq("conversation_id", conversationId)
      .order("received_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestCheckMsg && latestCheckMsg.sender_type === "customer") {
      // Se o cliente mandou mais mensagens, esse webhook antigo cancela para o novo responder com todo o contexto junto.
      const lastCheckTime = new Date(latestCheckMsg.received_at).getTime();
      // Adiciona uma tolerância de 500ms para evitar falsos cancelamentos
      if (Date.now() - lastCheckTime < 3800) {
        console.log(`[AI Agent] Debounce triggered on conversation ${conversationId}. Cancelling old execution.`);
        return {
          outcome: "skipped",
          reason: "debounced",
          detectedTag: null,
          modelUsed: responseModel,
        };
      }
    }
  }

  // 2. Load recent conversation history (last 10 messages)
  // Uma única resposta da IA por mensagem recebida. Retries do webhook,
  // debounce concorrente ou múltiplos workers podem chamar esta função
  // para a mesma mensagem; claim_ai_reply (migration 122) insere a
  // intenção (conta, conversa, mensagem, nó) com ON CONFLICT DO NOTHING e
  // só o primeiro chamador recebe true — os demais saem sem responder.
  const { data: inbound, error: inboundError } = await db.from('messages')
    .select('id').eq('conversation_id', conversationId).eq('account_id', accountId)
    .eq('sender_type', 'customer').order('received_at', { ascending: false }).limit(1).maybeSingle();
  if (inboundError) {
    return {
      outcome: "failed",
      reason: `inbound_lookup_failed:${inboundError.message}`,
      detectedTag: null,
      modelUsed: responseModel,
    };
  }
  if (!inbound) {
    return {
      outcome: "skipped",
      reason: "no_inbound_message",
      detectedTag: null,
      modelUsed: responseModel,
    };
  }
  const { data: ownsReply, error: replyClaimError } = await db.rpc('claim_ai_reply', {
    p_account: accountId, p_conversation: conversationId, p_message: inbound.id, p_node: nodeKey ?? '',
  });
  if (replyClaimError) {
    return {
      outcome: "failed",
      reason: `reply_claim_failed:${replyClaimError.message}`,
      detectedTag: null,
      modelUsed: responseModel,
    };
  }
  if (!ownsReply) {
    return {
      outcome: "skipped",
      reason: "already_claimed",
      detectedTag: null,
      modelUsed: responseModel,
    };
  }
  if (tracker) {
    tracker.claim = { account: accountId, conversation: conversationId, message: inbound.id, node: nodeKey ?? '' };
    tracker.trace.phase = "claimed";
    // "IA trabalhando": o vigia de IA travada não transfere enquanto a
    // marca for recente (heartbeat.ts). Limpa em runAiAttempt.
    await tracker.heartbeat?.beat(true);
  }
  // Se o processo cair depois daqui, a intenção continua registrada e a IA
  // não responde de novo a essa mensagem: preferimos revisão manual a
  // repetir efeitos (mensagem duplicada, acordo formalizado duas vezes).
  let messagesQuery = db
    .from("messages")
    .select("id, content_text, content_type, media_url, created_at, sender_type")
    .eq("conversation_id", conversationId);

  if (historyAfter) {
    messagesQuery = messagesQuery.gt("received_at", historyAfter);
  }
  if (historyBefore) {
    messagesQuery = messagesQuery.lt("received_at", historyBefore);
  }

  const { data: messages, error: messagesError } = await messagesQuery
    .order("created_at", { ascending: false })
    .limit(10);

  if (messagesError) {
    console.error("[AI Agent] failed to load messages context:", messagesError);
    return {
      outcome: "failed",
      reason: `history_load_failed:${messagesError.message}`,
      detectedTag: null,
      modelUsed: responseModel,
    };
  }

  // High-priority intents must be deterministic. These cases should not
  // depend on prompt compliance because they change routing/suppression.
  const priorityIntent = classifyPriorityIntent(incomingText);

  if (priorityIntent?.kind === "opt_out" || priorityIntent?.kind === "wrong_person") {
    const { data: contactForBlock, error: contactForBlockError } = await db
      .from("contacts")
      .select("phone")
      .eq("id", contactId)
      .eq("account_id", accountId)
      .maybeSingle();

    if (contactForBlockError) {
      console.error("[AI Agent] Failed to load contact for suppression:", contactForBlockError);
    } else if (contactForBlock?.phone) {
      const normalizedPhone = formatBrazilianPhone(contactForBlock.phone);
      if (normalizedPhone) {
        const { error: blacklistError } = await db
          .from("blacklist")
          .upsert(
            {
              telefone: normalizedPhone,
              motivo: priorityIntent.kind === "opt_out" ? "opt_out" : "reclamacao",
              mensagem_detectada: incomingText,
              bloqueado_por: "ai_priority_guard",
              data_bloqueio: new Date().toISOString(),
              account_id: accountId,
            },
            { onConflict: "telefone" },
          );
        if (blacklistError) {
          console.error("[AI Agent] Failed to persist suppression:", blacklistError);
        }
      }
    }
  }

  // --- TRAVA DE OFENSA / JAILBREAK (ANTI-SCAM) ---
  // Impede gasto de tokens com xingamento ou tentativa clara de "quebrar"
  // o agente. Palavra inteira, sem acento — ver abuse-guard.ts (a versão
  // antiga casava "enviado", "computador", "sistema", "botão"…).
  // Comportamento mantido (vai para humano; decisão de produto pendente),
  // mas para a FILA DA EQUIPE como o nó handoff_team — não mais para o
  // dono da conversa/do número.
  const abuse = priorityIntent ? null : detectAbusiveInput(incomingText || "");

  if (abuse) {
    console.warn(`[AI Agent] Anti-scam (${abuse.kind}: "${abuse.term}") na conversa ${conversationId}. Transferindo para a fila humana.`);

    // Só declara handoff depois que a persistência for confirmada (ver
    // team-handoff.ts).
    const handoff = await handOffToTeamQueue(db, accountId, conversationId, "[AI Agent] Anti-scam");
    if (!handoff.ok) {
      return {
        outcome: "failed",
        reason: `handoff_anti_scam_assignment_failed:${handoff.error}`,
        detectedTag: null,
        modelUsed: responseModel,
      };
    }

    return {
      outcome: "skipped",
      reason: "handoff_anti_scam",
      detectedTag: null,
      modelUsed: responseModel,
      guard: {
        subreason: abuse.kind === "jailbreak" ? "JAILBREAK" : "OFENSA",
        term: abuse.term,
        team_id: handoff.teamId,
        assigned_to: handoff.assignedTo,
      },
    }; // Interrompe a geração da IA imediatamente sem gastar tokens
  }

  // --- ANTI-LOOP GUARD ---
  // Nosso bot em loop (respondendo a outro robô): conta só mensagens do
  // BOT na janela, pelo relógio do servidor (received_at) — ver
  // loop-guard.ts. Cliente mandando várias fotos/mensagens seguidas não
  // dispara. Transfere para a fila da equipe, como a trava anti-abuso.
  if (!priorityIntent) {
    const { data: botRows, error: botRowsError } = await db
      .from("messages")
      .select("received_at")
      .eq("conversation_id", conversationId)
      .eq("sender_type", "bot")
      .gte("received_at", new Date(Date.now() - BOT_LOOP_WINDOW_SECONDS * 1000).toISOString())
      .order("received_at", { ascending: false })
      .limit(BOT_LOOP_MIN_MESSAGES);
    if (botRowsError) {
      // Leitura falhou: segue sem a trava (não bloqueia a resposta).
      console.error("[AI Agent] Anti-loop: falha ao ler mensagens do bot:", botRowsError.message);
    }
    const loop = detectBotLoop(
      ((botRows ?? []) as Array<{ received_at: string | null }>).map((r) => r.received_at),
    );

    if (loop) {
      console.warn(
        `[AI Agent] Bot em loop na conversa ${conversationId}: ${loop.botMessages} mensagens do bot em ${loop.windowSeconds}s. Transferindo para a fila humana.`,
      );
      const handoff = await handOffToTeamQueue(db, accountId, conversationId, "[AI Agent] Anti-loop");
      if (!handoff.ok) {
        return {
          outcome: "failed",
          reason: `handoff_anti_loop_assignment_failed:${handoff.error}`,
          detectedTag: null,
          modelUsed: responseModel,
        };
      }

      return {
        outcome: "skipped",
        reason: "handoff_anti_loop",
        detectedTag: null,
        modelUsed: responseModel,
        guard: {
          subreason: "BOT_EM_LOOP",
          bot_messages: loop.botMessages,
          window_seconds: loop.windowSeconds,
          team_id: handoff.teamId,
          assigned_to: handoff.assignedTo,
        },
      }; // Interrompe a resposta automática da IA
    }
  }

  // Order chronologically for the LLM
  const history = (messages || []).reverse();

  // ai_config.api_key agora é gravada criptografada (migration 084);
  // tryDecrypt cai pro valor bruto se ainda estiver em texto puro.
  const rawConfigKey = aiConfig.api_key?.trim();
  const configKey = rawConfigKey ? tryDecrypt(rawConfigKey) : rawConfigKey;

  let masterKey = "";
  if (aiConfig.api_provider === "hermes") {
    masterKey = process.env.OPENROUTER_API_KEY || "";
  } else if (aiConfig.api_provider === "openai") {
    masterKey = process.env.OPENAI_API_KEY || "";
  } else if (aiConfig.api_provider === "claude") {
    masterKey = process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY || "";
  } else if (aiConfig.api_provider === "gemini") {
    masterKey = process.env.GEMINI_API_KEY || "";
  }

  const activeKey = !configKey ? masterKey : configKey;

  if (!activeKey) {
    console.warn(`[AI Agent] Missing API Key for provider: ${aiConfig.api_provider}`);
    return {
      outcome: "failed",
      reason: "missing_provider_api_key",
      detectedTag: null,
      modelUsed: responseModel,
    };
  }

  // 3. Audio Message Transcription (Whisper)
  let incomingWasAudio = false;
  const lastMsg = history[history.length - 1];

  if (lastMsg && lastMsg.content_type === "audio" && lastMsg.media_url && aiConfig.multimodal_enabled) {
    incomingWasAudio = true;
    const whisperKey = aiConfig.api_provider === "openai" ? activeKey : (process.env.OPENAI_API_KEY || "");

    if (whisperKey) {
      try {
        console.log("[AI Agent] Transcribing audio with Whisper...", lastMsg.media_url);
        let fetchUrl = lastMsg.media_url;
        if (!fetchUrl.startsWith("http")) {
          const { data: publicUrlData } = db.storage.from("chat-media").getPublicUrl(fetchUrl);
          fetchUrl = publicUrlData.publicUrl;
        }

        fetchUrl = await resolveProviderMedia(lastMsg.media_url, accountId);
        const audioRes = await boundedFetch(fetchUrl);
        if (audioRes.ok) {
          const arrayBuffer = await audioRes.arrayBuffer();
          const formData = new FormData();
          const blob = new Blob([arrayBuffer], { type: "audio/ogg" });
          formData.append("file", blob, "audio.ogg");
          formData.append("model", "whisper-1");
          formData.append("language", "pt");

          const whisperRes = await boundedFetch("https://api.openai.com/v1/audio/transcriptions", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${whisperKey}`,
            },
            body: formData,
          });

          if (whisperRes.ok) {
            const whisperData = await whisperRes.json();
            if (whisperData.text) {
              const transcribedText = whisperData.text;
              console.log("[AI Agent] Whisper transcribed:", transcribedText);
              
              // Update local history
              lastMsg.content_text = transcribedText;
              incomingText = transcribedText;
              
              // Update in database so it shows up in CRM chat
              await db
                .from("messages")
                .update({ content_text: `🎙️ _Áudio transcrito:_ "${transcribedText}"` })
                .eq("id", lastMsg.id);
            }
          } else {
            console.error("[AI Agent] Whisper API error:", await whisperRes.text());
          }
        }
      } catch (err) {
        console.error("[AI Agent] Whisper error:", err);
      }
    }
  }

  // Garante que a mensagem atual do cliente (incomingText) esteja no
  // histórico enviado ao GPT. O filtro historyAfter (nós ai_agent do
  // Flow Builder passam run.started_at) pode excluir da tabela
  // `messages` a própria mensagem que disparou o run, já que ela é
  // inserida ANTES do run existir — received_at fica <= started_at e
  // o `.gt()` do filtro a corta, deixando o GPT sem nenhum turno do
  // cliente. Só adiciona se a última mensagem do cliente no histórico
  // ainda não contiver esse texto (evita duplicar no caminho normal).
  const trimmedIncoming = (incomingText || "").trim();
  if (trimmedIncoming) {
    const lastCustomerMsg = [...history]
      .reverse()
      .find((m: any) => m.sender_type === "customer");
    const alreadyIncluded =
      lastCustomerMsg &&
      (lastCustomerMsg.content_text || "").includes(trimmedIncoming);
    if (!alreadyIncluded) {
      history.push({
        id: null,
        content_text: incomingText,
        content_type: "text",
        media_url: null,
        created_at: new Date().toISOString(),
        sender_type: "customer",
      });
    }
  }

  // 3b. Normalize non-text history entries before any provider call.
  //
  // Placed AFTER the Whisper transcription block above (not immediately
  // after `history` is built) on purpose — transcription mutates
  // `lastMsg.content_text` in place but reads `lastMsg.media_url` to
  // fetch the audio first. Running this normalization any earlier would
  // null out `media_url` before Whisper ever sees it, silently breaking
  // transcription for the very message this feature exists for.
  //
  // Every provider function (generateOpenAiResponse/generateGeminiResponse/
  // generateClaudeResponse/generateHermesResponse) builds its own message
  // array from this same `history`, and only two of them (OpenAI, Gemini)
  // special-case `content_type === "image"` — everything else (audio,
  // video, document, sticker, and images on Claude/Hermes) falls through
  // to a plain `content_text || ""` turn. A WhatsApp media_url is
  // short-lived/authenticated, so passing it straight through for a type
  // no provider fetches specially (or handing OpenAI's Vision branch an
  // already-expired URL) is what produces `invalid_image_url` and a
  // silent run_error. Fix: give every non-text entry a readable
  // placeholder when it has no real transcribed/captioned text, and drop
  // media_url except where a provider still needs it (OpenAI/Gemini's
  // Vision branch for an un-captioned image).
  const CONTENT_TYPE_PLACEHOLDERS: Record<string, string> = {
    audio: "[Cliente enviou um áudio]",
    video: "[Cliente enviou um vídeo]",
    image: "[Cliente enviou uma imagem]",
    document: "[Cliente enviou um documento]",
    sticker: "[Cliente enviou uma figurinha]",
  };
  for (const msg of history) {
    if (msg.content_type && msg.content_type !== "text") {
      const hadText = !!msg.content_text?.trim();
      if (!hadText) {
        msg.content_text =
          CONTENT_TYPE_PLACEHOLDERS[msg.content_type] ?? "[Cliente enviou conteúdo não suportado]";
      }
      // Remove media_url to avoid the provider trying to download an
      // expired/authenticated WhatsApp URL. Images are the one
      // exception — but only when there's no caption/transcription
      // already (that's the case OpenAI/Gemini's Vision branch exists
      // for — see generateOpenAiResponse/generateGeminiResponse, both
      // gated on `content_type === "image" && media_url`) AND the URL
      // is actually resolvable to something externally fetchable.
      // Supabase storage paths ("/storage/..." or "storage/...") are
      // fine — both provider functions already turn those into a real
      // public URL via .storage.from("chat-media").getPublicUrl()
      // before fetching. A raw internal proxy path like
      // "/api/whatsapp/media/<id>" is not — it only resolves inside
      // our own server, so Vision (running on OpenAI's infra) can
      // never reach it. That's what invalid_image_url comes from, so
      // even an un-captioned image with one of those has to fall back
      // to the text placeholder instead.
      if (msg.content_type === "image" && msg.media_url) {
        try { msg.media_url = await resolveProviderMedia(msg.media_url, accountId); }
        catch { msg.media_url = null; }
      }
      const isPublicUrl =
        !!msg.media_url?.startsWith("https://") ||
        !!msg.media_url?.startsWith("/storage/") ||
        !!msg.media_url?.startsWith("storage/");
      if (msg.content_type !== "image" || hadText || !isPublicUrl) {
        msg.media_url = null;
      }
    }
  }

  // 4. Load Knowledge Base (File Search RAG) Context
  const { data: kbFiles } = await db
    .from("knowledge_base_files")
    .select("name, content")
    .eq("account_id", accountId);

  // Node-level override wins over the account's global ai_config prompt,
  // which in turn wins over the hardcoded Aleh default. A flow node override
  // must remain isolated from the legacy CPF/institution blocks below: those
  // blocks belong to the standalone global responder and can contradict a
  // node's own policy. Knowledge-base context still appends to the base.
  const hasOverride = !!systemPromptOverride && systemPromptOverride.trim() !== "";
  let systemPromptWithKb = hasOverride
    ? systemPromptOverride!
    : aiConfig.system_prompt || 'Você é um assistente virtual. Aguarde um momento.';
  // Versão do prompt efetivo para a telemetria (texto cru, antes de KB/dados).
  if (tracker) {
    tracker.promptVersion = effectivePromptVersion({ hasOverride, accountPrompt: aiConfig.system_prompt });
  }
  if (kbFiles && kbFiles.length > 0) {
    // Dieta de tokens: com teto de tamanho (kb-context.ts); abaixo do teto o
    // texto é idêntico ao de antes, acima entram os arquivos mais relevantes
    // para o que o cliente acabou de dizer.
    const recentCustomerText = history
      .filter((m: any) => m.sender_type === "customer")
      .slice(-3)
      .map((m: any) => m.content_text || "")
      .join("\n");
    const kbContext = buildKnowledgeBaseContext(kbFiles, recentCustomerText);

    systemPromptWithKb = `${systemPromptWithKb}

=== BASE DE CONHECIMENTO DISPONÍVEL ===
${kbContext}
=== FIM DA BASE DE CONHECIMENTO ===

Use as informações da base de conhecimento acima para responder às dúvidas do cliente com a maior precisão possível. Se a informação não estiver na base, aja de acordo com suas instruções normais.`;
  }

  // 4b. Orquestrador de Agentes (Lógica Gojenier com API DDM)
  const cpfRegex = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/;
  let foundCpf: string | null = null;

  for (let idx = history.length - 1; idx >= 0; idx--) {
    const textToSearch = history[idx].content_text || "";
    const m = textToSearch.match(cpfRegex);
    if (m) {
      foundCpf = m[0].replace(/\D/g, "");
      break;
    }
  }

  let ddmData: DdmCpfResponse | null = null;
  if (foundCpf && foundCpf.length === 11) {
    console.log(`[AI Agent] Found CPF ${foundCpf} in conversation. Calling DDM API...`);
    ddmData = await fetchDdmCpfDetails(foundCpf);
  }

  let forceTransferHumanMsg = "";

  if (ddmData) {
    const inst = ddmData.instituicao || ddmData.institution || "Cruzeiro";
    const debt = ddmData.valor_divida || ddmData.valor || "0,00";
    const sistema = ddmData.sistema || "";
    const hasActiveDebt = debt && debt !== "0,00" && debt !== "0" && debt !== 0;

    // O bloco isEducational (detecção de instituição + transferência
    // forçada) só roda quando o agente global está respondendo. Um nó
    // ai_agent do Flow Builder com system_prompt_override (BEN/Aleh) já
    // tem sua própria lógica via tools — isEducational nunca calculado
    // (fica false) e forceTransferHumanMsg nunca setado nesse caso.
    let isEducational = false;
    if (!hasOverride) {
    isEducational =
      inst.toLowerCase().includes("uva") ||
      inst.toLowerCase().includes("veiga") ||
      inst.toLowerCase().includes("unijorge") ||
      inst.toLowerCase().includes("unisuam") ||
      inst.toLowerCase().includes("castelo") ||
      inst.toLowerCase().includes("bezerra") ||
      inst.toLowerCase().includes("potiguar") ||
      inst.toLowerCase().includes("multivix") ||
      sistema.toLowerCase().includes("uva") ||
      sistema.toLowerCase().includes("veiga") ||
      sistema.toLowerCase().includes("unijorge") ||
      sistema.toLowerCase().includes("unisuam") ||
      sistema.toLowerCase().includes("castelo") ||
      sistema.toLowerCase().includes("bezerra") ||
      sistema.toLowerCase().includes("potiguar") ||
      sistema.toLowerCase().includes("multivix");

    if (isEducational) {
      const acordosList = ddmData.acordos || [];
      const hasPendingAgreement = acordosList.some((acordo: any) => {
        const status = (acordo.status || "").toLowerCase().trim();
        return status !== "" && status !== "quitado";
      });

      // Look at due dates
      const calculosObj = ddmData.Calculos || ddmData.calculos || [];
      const todayStr = new Date().toISOString().split("T")[0];
      let hasNotYetDueDebt = false;
      if (Array.isArray(calculosObj)) {
        for (const calc of calculosObj) {
          const dataParc = calc?.debitos?.data_parcela;
          if (dataParc && dataParc > todayStr) {
            hasNotYetDueDebt = true;
          }
        }
      }

      if (hasPendingAgreement) {
        forceTransferHumanMsg = "Localizei um acordo ativo/pendente em seu cadastro. Para garantir a melhor negociação, vou te transferir agora mesmo para nossa equipe de atendimento humano. Só um instante! #EQUIPEHUMANA";
      } else if (!hasActiveDebt) {
        forceTransferHumanMsg = "Meu sistema está passando por atualizações, um momento. #EQUIPEHUMANA";
      } else if (hasNotYetDueDebt) {
        forceTransferHumanMsg = "Verifiquei que há pendências em aberto, mas com vencimento futuro. Vou te transferir para um atendente para maiores informações. Um momento! #EQUIPEHUMANA";
      }
    }
    }

    if ((inst.toLowerCase().includes("cruzeiro") || sistema.toLowerCase() === "cruzeiro") && hasActiveDebt) {
      // hasOverride: mantém o override do nó ai_agent intacto — não
      // sobrescreve com aiConfig.system_prompt (nem com o default Sabrina).
      if (!hasOverride) {
      systemPromptWithKb = aiConfig.system_prompt
        ? `${aiConfig.system_prompt}

=== DADOS DO CLIENTE (DDM API) ===
- Nome do Cliente: ${ddmData.nome || "Não informado"}
- CPF consultado: ${foundCpf}
- Instituição: Cruzeiro do Sul
- Valor para Quitação à Vista (ValorFinal): R$ ${debt}`
        : `Você é Sabrina, Representante Financeiro da Universidade Cruzeiro do Sul, atuando como analista financeira consultiva da assessoria DDM.

=== DADOS DO CLIENTE (DDM API) ===
- Nome do Cliente: ${ddmData.nome || "Não informado"}
- CPF consultado: ${foundCpf}
- Instituição: Universidade Cruzeiro do Sul
- Valor para Quitação à Vista (ValorFinal): R$ ${debt}

=== COMPORTAMENTO E TOM ===
Você é uma especialista financeira. Seja cordial, um pouco descontraída, educada e muito profissional.
Sua saudação inicial preferencial: "Olá! Tudo bem? Me chamo Sabrina, sou Representante Financeiro da Universidade Cruzeiro do Sul."

=== INSTRUÇÕES DE NEGOCIAÇÃO ===
Sua missão é ajudar o aluno a regularizar sua situação financeira de forma consultiva:
1. **Confirmação:** Confirme que localizou os débitos referentes à Cruzeiro do Sul para o CPF informado.
2. **Escada de Negociação (Passo a Passo):**
   - **1ª Tentativa (À Vista):** Apresente o valor à vista de R$ ${debt} (do campo ValorFinal da API) com foco em quitar e encerrar a dívida.
   - **2ª Tentativa (Cartão de Crédito):** Se o aluno recusar o valor à vista ou pedir parcelamento, ofereça a opção de parcelar no cartão de crédito através do link oficial: https://novoportal.cruzeirodosul.edu.br/
   - **3ª Tentativa (Boleto Bancário):** Se o aluno disser explicitamente que não consegue pagar no cartão, informe que há opções de parcelamento em boleto. Peça para ele dizer em quantas parcelas gostaria de pagar.
3. **Regra Crítica de Mensagens:**
   - Mantenha mensagens curtas, diretas e objetivas (entre 80 e 120 caracteres, cerca de 2 frases curtas).
   - Apresente apenas uma option de negociação por vez. Sempre aguarde a resposta do aluno antes de enviar a próxima.
   - Nunca faça cálculos manuais ou estimativas de parcelas.
4. **Regra Crítica de Formalização:**
   - NUNCA feche ou formalize o acordo sem a confirmação explícita e inequívoca do cliente (ex: "sim", "quero fechar", "fechado").
   - Antes de formalizar, confirme apenas as condições do acordo (vencimento, valor, forma de pagamento). Você NÃO deve pedir e-mail e nem número de celular do cliente, pois você já está conversando com ele diretamente por aqui.
   - Quando o acordo for confirmado de forma explícita, retorne a tag especial #ACORDOFORMALIZADO ao final do resumo.
5. **Tratamento de Recusas e Solicitação de Atendente:**
   - Se o cliente solicitar falar com um atendente humano, transferir ou disser que prefere falar com uma pessoa, diga que está transferindo o atendimento e termine a mensagem obrigatoriamente com a tag #EQUIPEHUMANA.
   - Se o cliente recusar, argumente gentilmente até 3 vezes lembrando-o das consequências (acúmulo de juros, ações de cobrança e órgãos de proteção de crédito) antes de desistir. Caso ele mantenha a recusa após as 3 tentativas, retorne #RECUSA no final da mensagem.`;
      }
    } else if (isEducational && hasActiveDebt) {
      const formattedBoleto = JSON.stringify(ddmData.resumo_parcelamento || []);
      const formattedAcordos = JSON.stringify(ddmData.acordos || []);
      const currentDate = new Date().toLocaleDateString("pt-BR");

      const cardPayUrl = ddmData.calculoId 
        ? `https://ddmpay.ddmacordos.com/acesso/?c=${ddmData.calculoId}&u=` 
        : `https://ddmpay.ddmacordos.com/acesso/?c=&u=`;

      let customPrompt = aiConfig.system_prompt || "";
      if (customPrompt) {
        customPrompt = customPrompt
          .replace(/\{\{valor_final\}\}/g, `R$ ${debt}`)
          .replace(/\{\{resumo_parcelamento\}\}/g, formattedBoleto)
          .replace(/c=&u=/g, `c=${ddmData.calculoId || ""}&u=`);
      }

      // hasOverride: na prática isEducational já vem false nesse caso
      // (bloco acima), então este branch nem é alcançado — guard
      // explícito mantido por segurança, mesma regra do branch Cruzeiro.
      if (!hasOverride) {
      systemPromptWithKb = customPrompt
        ? `${customPrompt}

=== DADOS DO CLIENTE E CONTEXTO ===
- Data Atual: ${currentDate}
- Nome do Cliente: ${ddmData.nome || "Não informado"}
- CPF consultado: ${foundCpf}
- Instituição: ${inst}
- Valor para Quitação à Vista (ValorFinal): R$ ${debt}
- Opções de Parcelamento no Cartão (NUNCA apresentar na primeira resposta, apenas se o cliente recusar o valor à vista): ${ddmData.opcoes_cartao || "Não disponível"}
- Resumo do Parcelamento em Boleto (resumo_parcelamento): ${formattedBoleto}
- Lista de Acordos do Cliente: ${formattedAcordos}

⚠️ REGRA CRÍTICA DE ESCADA DE NEGOCIAÇÃO: Na primeira mensagem após consultar o CPF, você deve apresentar APENAS o valor para quitação à vista (ValorFinal). É TERMINANTEMENTE PROIBIDO listar qualquer opção de parcelamento (tanto cartão de crédito quanto boleto) na primeira mensagem. Aguarde a resposta do cliente. Se ele recusar ou pedir parcelamento, aí sim você oferece o cartão na próxima mensagem.`
        : `Você é Julia, analista financeira consultiva da assessoria DDM, parceira da instituição de ensino.
Sua saudação preferencial: "Olá! Tudo bem? Me chamo Julia, sou Representante Financeiro da sua Instituição de ensino."

=== DADOS DO CLIENTE E CONTEXTO ===
- Data Atual: ${currentDate}
- Nome do Cliente: ${ddmData.nome || "Não informado"}
- CPF consultado: ${foundCpf}
- Instituição: ${inst}
- Valor para Quitação à Vista (ValorFinal): R$ ${debt}
- Opções de Parcelamento no Cartão (NUNCA apresentar na primeira resposta, apenas se o cliente recusar o valor à vista): ${ddmData.opcoes_cartao || "Não disponível"}
- Resumo do Parcelamento em Boleto (resumo_parcelamento): ${formattedBoleto}
- Lista de Acordos do Cliente: ${formattedAcordos}

⚠️ REGRA CRÍTICA DE ESCADA DE NEGOCIAÇÃO: Na primeira mensagem após consultar o CPF, você deve apresentar APENAS o valor para quitação à vista (ValorFinal). É TERMINANTEMENTE PROIBIDO listar qualquer opção de parcelamento (tanto cartão de crédito quanto boleto) na primeira mensagem. Aguarde a resposta do cliente. Se ele recusar ou pedir parcelamento, aí sim você oferece o cartão na próxima mensagem.

=== OBJETIVO ===
Você precisa descobrir mais sobre as necessidades e desafios que o cliente está enfrentando, então descubra as necessidades, qualifique e crie proposta de valor com os passos abaixo.

=== PASSOS DO FLUXO (ESTRITO) ===
1. Busque a data atual para saber se há vencimentos ou não nos débitos dos clientes. Débitos com datas de vencimentos anteriores a atual são considerados vencidos.
2. Busque pelo CPF do cliente, caso não tenha pergunte, e retorne as seguintes informações: nome do cliente, nome da instituição em que ele está matriculado e o número de matrícula (você não deve falar o número de matrícula do aluno).
3. Só deve apresentar débitos que estejam registrados no sistema. Caso o cliente pergunte sobre algum valor e esse valor não conste no sistema, você deve responder #EQUIPEHUMANA.
4. Verifique no array "acordos" retornado pela integração se existe algum acordo com status diferente de "Quitado" (ex.: "Acordo na DDM", "Aguardando Pgto"). Caso exista ao menos um acordo pendente, não apresente débitos nem monte proposta de negociação: retorne imediatamente #EQUIPEHUMANA.
5. Se o aluno não possuir nenhum acordo pendente (array "acordos" vazio, quantidade_acordos igual a 0, ou todos os acordos com status "Quitado"), apresente os débitos dele com base na integração "Resposta API" (variáveis debitos, valor_total, valor_final).
6. Opção de Quitação: Apresente primeiro o valor à vista com foco no encerramento da dívida e confirme novamente se ele deseja formalizar o acordo.
7. Confirme com o cliente o e-mail e o número de celular, além das informações do acordo como vencimento, "ValorFinal", forma de pagamento.
8. Caso ele confirme explicitamente que deseja formalizar o acordo, formalize o acordo e apresente ao cliente o resumo do acordo dele, contendo as informações com base na pesquisa: número do acordo, vencimento, valor do pagamento, e-mail, e retorne #ACORDOFORMALIZADO.
9. Caso o cliente confirme explicitamente que deseja formalizar o acordo, você deve acionar a integração responsável por formalizar acordos. Essa integração se chama Formalizar Acordo e ela deve receber o CPF e a quantidade de parcelas solicitadas pelo cliente na conversa. A informação de CPF e parcelas devem ser enviadas em JSON com dois campos diferentes.
   Se o aluno desejar parcelar em 2 vezes, você irá enviar para a integração o número 3 por conta da entrada.
   Se o aluno desejar parcelar em 3 vezes, você irá enviar para a integração o número 4 por conta da entrada.
   Se o aluno desejar parcelar em 4 vezes, você irá enviar para a integração o número 5 por conta da entrada.
   E assim sucessivamente...
   Nunca envie para a integração a quantidade de parcelas do resumo_parcelamento, envie a quantidade que o cliente solicitou na conversa.
10. Se o cliente disser que não, pergunte a ele como você pode ajudá-lo a melhorar a negociação e entenda o motivo dele não querer formalizar o acordo, sempre buscando fechar a negociação, e faça isso sem oferecer a opção de novos valores.
11. Você não tem permissão de apresentar negociação parcelada diferente das disponíveis na integração Resposta Api, todo o parcelamento apresentado, precisa estar dentro do JSON ${formattedBoleto}.
12. Quando o aluno solicitar parcelamento no boleto, pergunte quantas parcelas ele deseja para realizar a negociação.
13. Progressão de Parcelamento (Gradativa):
    - Nunca apresente todas as opções de parcelamento ao mesmo tempo.
    - Use obrigatoriamente a variável: resumo_parcelamento.
    - Fluxo de negociação:
      1. Primeiro apresente apenas o pagamento à vista utilizando: R$ ${debt}
      2. Caso o aluno informe que não consegue pagar à vista ou solicite parcelamento:
         - Primeiro ofereça parcelamento no cartão de crédito com o link original do portal: ${cardPayUrl}
      3. Somente se o aluno disser explicitamente que não consegue pagar no cartão, utilize as opções disponíveis em: resumo_parcelamento
      4. Apresente apenas UMA opção por vez seguindo a ordem de parcelas.
    - REGRA CRÍTICA SOBRE PARCELAS:
      - O campo "Parcelas" da API representa exatamente o número de parcelas do acordo após a entrada.
      - A entrada é um pagamento separado e nunca deve ser considerada uma parcela.
      - O agente não pode calcular, subtrair ou alterar o número de parcelas.
      - Estrutura correta da apresentação:
        Entrada: R$ {entrada}
        Parcelas: {parcelas}x de R$ {valor_parcela}
      - Exemplo: Vamos supor que a integração retorne Entrada de R$ 2.404,81 + 1x parcelas de R$ 12.024,08. Você exibirá:
        Entrada: R$ 2.404,81
        Parcelas: 1x parcelas de R$ 12.024,08
      - Nunca faça cálculos.
      - Sempre aguarde a resposta do aluno antes de apresentar outra opção.
14. Escada de Negociação:
    1️⃣ Primeira tentativa: Apresente apenas o valor à vista: R$ ${debt}
    2️⃣ Segunda tentativa: Ofereça parcelamento no cartão
    3️⃣ Terceira tentativa: Use o primeiro item disponível do array: resumo_parcelamento
    4️⃣ Caso o aluno peça mais prazo: apresente a próxima opção do array.
    - Nunca pule diretamente para o maior parcelamento.
    - Nunca mostre mais de uma opção de parcelamento por mensagem.
15. Analise o histórico da conversa antes de oferecer uma nova condição. Se já apresentou uma opção de parcelamento, apresente apenas a próxima opção disponível no array resumo_parcelamento. Nunca repita opções já apresentadas. Nunca apresente o máximo de parcelas antes que o aluno demonstre dificuldade.
16. Com base no histórico da conversa, identifique o que o aluno deseja. Se ele pediu parcelamento, olhe para o array resumo_parcelamento e escolha apenas uma opção que seja superior à oferecida anteriormente, mas que ainda não seja o limite máximo, a menos que ele tenha pedido especificamente o maior prazo possível.
17. Quando o cliente informar que não reconhece os débitos, informe que todas as inadimplências que constam em nosso sistema vêm diretamente da Instituição, solicite mais detalhes sobre sua resposta.
18. Caso o aluno afirme que não reconhece o débito, o agente deve tentar argumentar até 3 vezes antes de transferir, a cada tentativa, ele deve variar a abordagem, mantendo o foco em reforçar que as informações vêm da instituição e incentivando a regularização, somente após a terceira negativa, o agente pode retornar #RECUSA.
19. Quando o cliente informar o melhor dia e horário, agradeça, peça educadamente que ele entre em contato no tempo definido, e retorne #AGENDAMENTO.
20. Se houve acordo formalizado: Negociação concluída com sucesso! Qualquer dúvida, estarei por aqui para te ajudar, obrigado pela confiança, retorne #ACORDOFORMALIZADO.
21. PROIBIÇÃO DE LINKS PLACEHOLDER (CRÍTICO): Você está terminantemente proibido de inventar ou gerar links markdown falsos ou vazios (como \"[Pagar](#)\", \"[Boleto](#)\", \"[Pagar Primeira Parcela](#)\"). Nunca tente criar links manuais com \"#\" no lugar da URL. Limite-se a confirmar o acordo por texto e retornar a tag #ACORDOFORMALIZADO no final da mensagem. O link real e o PDF do boleto serão integrados e enviados automaticamente pelo sistema após a tag ser enviada.

=== REGRAS DE ATENDIMENTO E OUTRAS REGRAS ===
- Quando o Resultado da variável Cliente for "Centro de Formacao Profissional Bezerra de Araujo Ltda" não afirme que ele pode parcelar no Boleto, esse cliente só funciona o parcelamento no cartão.
- Quando o Resultado da variável Cliente for "UNIJORGE NOVO" não afirme que ele pode parcelar no Boleto, esse cliente só funciona o parcelamento no cartão.
- Você não tem autorização para formalizar fora das negociações permitidas na integração "Resposta API".
- REGRA DE PARCELAMENTO:
  - Caso a entrada retorne 0,00, pode informar ao aluno que são parcelas iguais.
  - Nunca diga ao aluno ou formalize um acordo com valor diferente do consultado no sistema.
  - Nunca afirme que a regularização da dívida garante a rematrícula do aluno. O agente deve informar que a regularização é um passo importante, mas a decisão sobre rematrícula depende da Universidade.
  - Para parcelamento em boleto, os valores devem ser utilizados EXCLUSIVAMENTE do array: resumo_parcelamento. Campos permitidos: entrada, valor_parcela, parcelas.
  - O campo resumo_parcelamentos NÃO pode ser utilizado para calcular valores. Ele serve apenas para te ajudar a apresentar o resumo dos débitos ao aluno.
  - Caso o aluno solicite que envie o boleto, direcione o aluno ao portal do aluno de sua instituição.
  - Ao apresentar parcelamento em boleto, the agent must use EXCLUSIVAMENTE values returned by API. É proibido calcular, alterar, estimar ou ajustar qualquer valor.
  - Formato obrigatório da apresentação:
    Entrada: R$ {entrada}
    Parcelas: {parcelas}x de R$ {valor_parcela}
- Regras para consulta de cpf no banco de dados:
  - Para cada solicitação de flexibilidade nas parcelas consulte o CPF do cliente no banco antes de responder, sempre.
  - Para exibir todas as opções de parcelamento, sempre consulte o CPF do cliente a cada opção de parcelamento.
  - Para qualquer solicitação do cliente envolvendo (faturas, próximas propostas de parcelamento, parcelamento por boleto, e quaisquer solicitações financeiras) sempre reconsulte o cpf do cliente no banco para ter total certeza dos valores e parcelas.
  - Sempre que precisar consultar a parcela da dívida do cliente em 4, 5, 6 ou 7 vezes, consulte o CPF do cliente no banco antes de responder, sempre.
- Regras adicionais de atendimento:
  - Você não deve falar o número de matrícula do aluno.
  - Se o aluno falar sobre financiamento ou pravaler, peça mais detalhes para ele.
  - Se o aluno perguntar sobre pagamento via PIX, informe que a chave pix vem junto com o boleto após a formalização do acordo.
  - Se você não localizar o débito do aluno após algumas tentativas, retorne #NAOLOCALIZADO.
  - Você não pode passar informações financeiras incorretas para o cliente, por isso sempre consulte o CPF do cliente no banco para responder.
  - Sempre que for responder sobre algo financeiro sempre consulte a integração novamente para ter certeza do que irá passar para o cliente.
  - Quando houver o parcelamento no boleto é preciso enviar ao aluno o valor da "entrada" mais o valor das "valor_parcela" ambas as informações disponíveis na integração "Resposta API" e no array "resumo_parcelamento".
  - Não é permitido apresentar ao aluno as opções de negociação que não existam na integração Resposta API.
  - Selecione sempre o próximo objeto disponível no array resumo_parcelamento.
  - Nunca calcule novas parcelas.
  - Use a variável "resumo_parcelamento" para apresentar o parcelamento ao aluno, o "resumo_parcelamentos" deverá ser apresentado uma de cada vez, conforme o retorno do aluno.
  - O "ValorFinal" do aluno corresponde ao valor final para pagamento, já incluindo encargos ou atualizações.
  - O "valor_nominal" corresponde apenas à soma original dos débitos, sem qualquer atualização, juros ou encargos aplicados.
  - Você não pode gerar ou oferecer ao aluno uma negociação que não esteja disponível na integração Resposta API.
  - A negociação com o aluno deve ser gradativa, ou seja, deve ser apresentado uma opção por vez.
  - Tratamento de Dados Financeiros: Formate todos os valores numéricos para o padrão de moeda brasileiro (R$ 0.000,00) ao exibir para o usuário.
  - Caso não encontre débitos, nunca informe ao aluno que ele não possui pendências, ao invés disso, fale: "Meu sistema está passando por atualizações, um momento." e retorne #EQUIPEHUMANA.
  - Informe apenas o necessário e mantenha as mensagens curtas e objetivas.
  - Nunca informe o cliente que seus débitos não estão vencidos, apenas siga com a negociação.
  - Diferencie os débitos de contratos diferentes caso o cliente tenha mais de um contrato.
  - Nunca apresente os valores mais de uma vez durante a conversa.
  - Nunca transfira o cliente para o atendimento humano sem antes enviar uma proposta para ele.
  - Nunca formalize um valor diferente do consultado no sistema.
  - Questione a ele o porquê a negociação não foi vantajosa para ele, e o relembre da importância de quitar seus débitos.
  - Nunca formalize um acordo sem a confirmação do aluno.
  - Etapa 1 — Parcelamento no cartão: Quando o aluno solicitar parcelamento no cartão, o agente deve informar que é possível parcelar no cartão de crédito, depois disso apresentar as formas de negociação conforme disponível na integração: Resposta API.
  - Etapa 2 — Negativa do aluno ao cartão: Somente se o aluno informar explicitamente que não consegue pagar à vista e nem parcelar no cartão de crédito, o agente deve então apresentar a opção de parcelamento em boleto. Após isso, aguarde as respostas do aluno antes de qualquer transferência.
- Regras de Transferências:
  - Sempre que ocorrer algum erro de busca, diga que está verificando e retorne #EQUIPEHUMANA.
  - Caso o aluno confirme que não vai pagar a negociação, tente novamente informando as vantagens de quitar o débito dele.
  - Sempre que o agente identificar que a data de vencimento do débito ainda não foi atingida ele deve considerar que o débito está em aberto, mas ainda não vencido, retorne #EQUIPEHUMANA.
  - Caso seja da Sociedade Potiguar de Educação e Cultura Ltda., não fale sobre suas dívidas, retorne #ANIMA.
  - Caso identifique um valor zerado, sempre retorne #EQUIPEHUMANA.
  - Se o aluno afirmar que já realizou o pagamento do débito, o agente deve demonstrar compreensão e, em seguida, fazer uma sondagem educada para confirmar as informações. O agente deve: Agradecer pela informação de forma cordial, perguntar quando foi feito o pagamento, solicitar, de forma gentil, o comprovante, explicar que essas informações ajudam a atualizar o sistema corretamente, e sempre retorne #EQUIPEHUMANA.
  - Caso o array "acordos" contenha algum acordo com status diferente de "Quitado" (acordo pendente), retorne imediatamente #EQUIPEHUMANA, sem apresentar débitos, sem montar proposta de negociação e sem tentar formalizar novo acordo.
  - Sempre que o cliente apresentar um cadastro que já tem um acordo, retorne #EQUIPEHUMANA.
- Em informação de recusa:
  - Utilize os seguintes contra-argumentos:
    - "Importante negociar e quitar as pendencias financeiras para evitar o acúmulo de juros e multa"
    - "As ações de cobrança continuarão, em função do não pagamento do débito"
    - "Caso não efetue o pagamento, você poderá ter o seu CPF incluído nos órgãos de proteção de crédito, e com isso, prejudicar a sua saúde financeira"
  - Apenas após no mínimo três tentativas de contra-argumentos retorne #RECUSA.
- Regras de negociação:
  - Caso o cliente não aceite as propostas 3 vezes, diga que vai verificar uma nova proposta utilizando a integração Resposta API e informe ao cliente sobre um novo método de pagamento.
  - Caso o cliente pergunte se pode fazer parcelamento, informe para ele as opções de negociação conforme a integração Resposta API, caso ele não queira, informe a importância de quitar o débito.
  - Sempre que a negociação for concluída ou o cliente informar que é somente isso, envie um resumo com as informações de data de vencimento, valor combinado e caso seja parcelado, informe a entrada e as parcelas, retorne também as datas de vencimentos e valores, retorne #ACORDOFORMALIZADO.
  - Caso o aluno não consiga pagar na data informada ou informe que gostaria de pagar em uma data específica, pergunte se ele quer agendar o contato, se ele confirmar retorne #AGENDAMENTO.
  - Apenas formalize o acordo se o aluno confirmar explicitamente que quer fechar o acordo apresentado.
  - Caso o aluno questione por que o valor atualizado está mais alto que o nominal, diga que o valor foi atualizado por encargos.
  - Se o aluno perguntar se o pagamento irá quitar todas as dívidas, nunca afirme que o aluno estará quitando todas as dívidas dele, o agente sempre deve responder o seguinte: “Esses são os débitos que localizei até o momento. Em alguns casos, pode haver mais de um contrato vinculado ao mesmo CPF. Caso haja outra pendência ativa, ela poderá ser verificada separadamente por um especialista.”
  - Caso o aluno pergunte sobre o vencimento do acordo ou boleto, diga que o vencimento do acordo é para o dia seguinte da formalização, e que é importante realizar o pagamento até essa data para manter a condição negociada.
  - Nunca afirme que a regularização da dívida garante a rematrícula do aluno. O agente deve informar que a regularização é um passo importante, mas a decisão sobre rematrícula depende da instituição, e pergunte se pode ajudá-lo com algo mais.
  - Caso o cliente da Instituição Unisuam fale sobre atendimento presencial, diga para ele: "Para tratativas presenciais, temos um funcionário na Unidade de Bonsucesso, estamos à disposição para ajuda-lo."
  - Caso o cliente da Instituição Veiga de Almeida fale sobre atendimento presencial, diga para ele: "Para tratativas presenciais, temos um funcionário na Unidade da Tijuca, estamos à disposição para ajuda-lo."
  - Caso o cliente da Instituição Castelo Branco fale sobre atendimento presencial, diga para ele: "Para tratativas presenciais, temos um funcionário na Unidade de Realengo. Estamos à disposição para ajudá-lo."
- Regra de Adaptação de Tom por Frustração:
  Se o aluno demonstrar frustração, irritação, impaciência ou confusão, a agente deve adaptar imediatamente o tom para uma abordagem mais empática, calma e paciente. Nesses casos, a agente deve:
  - reconhecer a frustração do aluno;
  - evitar soar robótica ou insistente;
  - usar frases mais curtas e claras;
  - reforçar que o objetivo é ajudar.`;
      }
    } else if (!hasOverride && !hasActiveDebt) {
      systemPromptWithKb = `${systemPromptWithKb}

=== INFORMAÇÕES DE CONSULTA (DDM API) ===
O cliente informou o CPF e possui cadastro na instituição ${inst}, porém NÃO foram localizadas dívidas ativas (valor de débitos em aberto é de R$ 0,00 ou sem pendências).

=== INSTRUÇÃO DE ATENDIMENTO (SEM DÍVIDA ATIVA) ===
Você é o(a) Aleh.
1. Informe de maneira simpática e educada que realizou a consulta baseada no CPF enviado e não localizou nenhuma pendência financeira em aberto para a instituição ${inst} no momento.
2. Pergunte de forma simpática se pode ajudá-lo em mais alguma coisa.
3. Não fale sobre acordos, cobranças ou valores pendentes.
4. Caso o cliente solicite falar com um atendente ou transferir para um humano, transfira e retorne a tag #EQUIPEHUMANA.`;
    } else if (!hasOverride) {
      systemPromptWithKb = `${systemPromptWithKb}

=== INFORMAÇÕES DE CONSULTA (DDM API) ===
O cliente informou o CPF e foi localizado na DDM, porém na instituição: ${inst}.
O valor da dívida cadastrado é R$ ${debt}.

=== INSTRUÇÃO DE ATENDIMENTO (OUTRAS INSTITUIÇÕES) ===
Você é o(a) Aleh. Como o cadastro do cliente é na instituição ${inst}:
1. Informe de maneira simpática e educada que localizou a pendência dele referente à instituição ${inst}.
2. Pergunte de forma simpática como você pode ajudá-lo ou se ele gostaria de tirar alguma dúvida geral sobre o débito.
3. Ofereça-se para transferi-lo para falar com um especialista humano especializado na ${inst} caso ele queira. Se ele concordar ou solicitar explicitamente a transferência, encerre obrigatoriamente com a tag #EQUIPEHUMANA.`;
    }
  } else if (!hasOverride && foundCpf) {
    systemPromptWithKb = `${systemPromptWithKb}

=== INFORMAÇÕES DE CONSULTA (DDM API) ===
O cliente informou o CPF (${foundCpf}), mas a pesquisa na API da DDM retornou que não há registros ou pendências ativas.

=== INSTRUÇÃO DE DEVOLUÇÃO (CPF NÃO LOCALIZADO) ===
Você é o(a) Aleh.
1. Informe de forma amigável que não localizou nenhuma pendência em aberto para o CPF digitado em nosso sistema.
2. Pergunte de forma aberta e simpática como você pode ajudá-lo hoje.
3. Caso ele solicite falar com um atendente ou peça transferência para um humano, transfira e retorne a tag #EQUIPEHUMANA.`;
  } else if (!hasOverride) {
    systemPromptWithKb = `${systemPromptWithKb}

=== INFORMAÇÃO OBRIGATÓRIA ANTES DE INICIAR ===
Você é o orquestrador geral de atendimento.
Você NÃO deve passar nenhuma informação sobre dívidas, simulações ou acordos até que o cliente forneça o CPF.
1. Se o cliente ainda não enviou o CPF dele nesta conversa, peça-o educadamente e de forma natural (ex: "Para que eu possa consultar suas pendências, poderia me informar o seu CPF?").
2. Não invente nenhuma informação ou simulação antes de receber o CPF.`;
  }

  // 5. Generate response using chosen LLM API
  //
  // Resultado final (já depois das tentativas) de CADA chamada de tool
  // nesta resposta. Só força #INSTABILIDADE a tool cujas chamadas TODAS
  // caíram por falha de integração — 1 de N registros falhando, ou uma
  // resposta de negócio (404, "CPF não encontrado"), deixa o modelo
  // responder com o que tem. Ver fullyFailedIntegrations abaixo.
  const toolTally = new Map<string, ToolRoundTally>();
  const trackedOnToolResult = async (
    toolName: string,
    result: string,
    durationMs: number,
    meta?: ToolExecutionMeta,
  ) => {
    tallyToolResult(toolTally, toolName, meta?.failureCode);
    // Tool terminou: o modelo volta a trabalhar com o resultado.
    if (tracker) {
      tracker.trace.phase = "llm";
      await tracker.heartbeat?.beat();
    }
    if (onToolResult) await onToolResult(toolName, result, durationMs, meta);
  };

  // Isolado num closure pra poder chamar duas vezes (tentativa + retry
  // automático abaixo) sem duplicar o if/else de provider.
  const callProvider = (): Promise<string> => {
    if (tracker) tracker.trace.phase = "llm";
    if (aiConfig.api_provider === "openai") {
      return generateOpenAiResponse(
        activeKey,
        systemPromptWithKb,
        history,
        tools,
        async (toolName: string, toolArgs: Record<string, unknown>) => {
          // A partir daqui pode haver efeito externo (ex.: efetiva_acordo):
          // uma falha posterior não libera a reserva da mensagem.
          if (tracker) {
            tracker.externalEffect = true;
            tracker.trace.phase = "tool";
            tracker.trace.tools.push(toolName);
            await tracker.heartbeat?.beat();
          }
          if (onToolCall) await onToolCall(toolName, toolArgs);
        },
        trackedOnToolResult,
        nodeKey,
        responseModel,
        // Esperando vaga/429 conta como "IA trabalhando" para o vigia.
        () => tracker?.heartbeat?.beat() ?? Promise.resolve(),
      );
    } else if (aiConfig.api_provider === "claude") {
      return generateClaudeResponse(activeKey, systemPromptWithKb, history, responseModel);
    } else if (aiConfig.api_provider === "hermes") {
      return generateHermesResponse(activeKey, systemPromptWithKb, history, responseModel);
    }
    return generateGeminiResponse(activeKey, systemPromptWithKb, history, responseModel);
  };

  let generatedText = "";
  if (priorityIntent) {
    generatedText = `${priorityIntent.reply} ${priorityIntent.tag}`;
  } else if (forceTransferHumanMsg) {
    generatedText = forceTransferHumanMsg;
  } else {
    try {
      generatedText = (await callProvider()).trim();

      // Retry automático: o modelo ocasionalmente retorna "" sem lançar
      // exceção (hiccup do provider, resposta filtrada) — isso não cai
      // no catch abaixo, que só trata falhas de verdade. Uma segunda
      // tentativa com o mesmo histórico/system prompt resolve a maioria
      // dos casos sem precisar envolver o cliente no fallback abaixo.
      // claim_ai_reply (migration 122) já reivindicou esta invocação
      // antes de chegarmos aqui, então o retry precisa acontecer dentro
      // desta mesma chamada — chamar handleAiAutoResponse de novo a
      // partir do engine.ts seria descartado silenciosamente pelo claim.
      if (!generatedText) {
        console.warn("[AI Agent] Resposta vazia do modelo, tentando novamente (retry automático)...");
        generatedText = (await callProvider()).trim();
      }
    } catch (err) {
      // Rethrown (not just logged + returned) so the Flow Builder's
      // ai_agent node sees this as a real failure — its own try/catch
      // around handleAiAutoResponse turns this into a node_error with
      // error_message instead of a silently-empty last_reply. Callers
      // that fire-and-forget this function (the WhatsApp webhook
      // routes, outside any flow) must `.catch()` this call — see
      // those call sites for why that matters.
      console.error("[AI Agent] LLM generation error:", err);
      throw err;
    }
  }

  generatedText = generatedText.trim();

  // Integração fora do ar (ex.: API DDM respondeu "Erro ao executar a
  // query") e o modelo não encerrou com nenhuma tag: a política "falha de
  // tool → #INSTABILIDADE" não pode depender só do prompt — senão a
  // conversa fica parada no nó de IA. Força a mensagem de instabilidade com
  // a tag, que leva o fluxo ao caminho de transferência.
  const forcedExit = decideForcedInstability(toolTally, generatedText, flowExitTags);
  if (forcedExit) {
    console.warn("[AI Agent] Integração indisponível sem tag de saída — forçando #INSTABILIDADE:", forcedExit.tools);
    generatedText = `${AI_INSTABILITY_TEXT} #INSTABILIDADE`;
  }

  // Mesmo depois do retry acima, o modelo não produziu nenhum texto —
  // em vez de deixar o cliente sem resposta (comportamento anterior:
  // retornava aqui sem enviar nada), envia uma mensagem fixa pedindo o
  // CPF, pelo MESMO caminho de envio/persistência de uma resposta
  // normal logo abaixo (WAHA/Meta + insert em messages como
  // sender_type: "bot") — não duplica lógica de envio aqui.
  //
  // runAiAgentCore (flows/engine.ts) detecta este caso comparando
  // last_reply com AI_EMPTY_REPLY_FALLBACK_TEXT (exportada abaixo) para
  // registrar o motivo certo no evento node_completed, em vez de mudar
  // o contrato de retorno desta função — usado também pelos dois
  // webhooks (Meta/WAHA), que ignoram o valor de retorno.
  if (!generatedText && !forceTransferHumanMsg) {
    generatedText = AI_EMPTY_REPLY_FALLBACK_TEXT;
  }

  if (!generatedText) {
    return {
      outcome: "skipped",
      reason: "empty_response",
      detectedTag: null,
      modelUsed: responseModel,
    };
  }

  // Captured BEFORE the known-tag strip below removes it from the text
  // that actually gets sent/persisted — this is what the ai_agent flow
  // node needs back as `ai_exit_code`. Re-reading the saved message and
  // regex-matching it (the old approach) never found anything, because
  // by the time it's saved the tag is already gone.
  const detectedTag = extractAiExitTag(generatedText, flowExitTags);

  let payBoletoUrl = "";
  let shouldTransferToHuman = false;
  let hasAgreedAcordo = false;

  // Autodetecção preventiva caso a IA esqueça de adicionar a tag #ACORDOFORMALIZADO
  const lowercaseGenerated = generatedText.toLowerCase();
  const hasAgreedText = 
    lowercaseGenerated.includes("dados do acordo") || 
    lowercaseGenerated.includes("confirmar os dados") || 
    lowercaseGenerated.includes("acordo formalizado") || 
    lowercaseGenerated.includes("geração do boleto") || 
    lowercaseGenerated.includes("boleto oficial");

  if (
    generatedText.includes("#ACORDOFORMALIZADO(finalização)") ||
    generatedText.includes("#ACORDOFORMALIZADO") ||
    hasAgreedText
  ) {
    hasAgreedAcordo = true;
  }

  shouldTransferToHuman = shouldLegacyAssignHuman({
    tag: detectedTag,
    flowControlled: Boolean(systemPromptOverride || nodeKey),
    hasAgreedAcordo,
  });

  // Exit codes are control-plane markers, not customer-facing text.
  // Strip EVERY known/flow tag (not only the detected one) so a second
  // tag such as #RECUSA next to #EQUIPEHUMANA never leaks into chat.
  // Ver exit-tags.ts (inclui o sufixo legado "(finalização)").
  generatedText = stripAiExitTag(generatedText, detectedTag, flowExitTags);

  if (!generatedText) {
    return {
      outcome: "skipped",
      reason: "control_tag_only",
      detectedTag,
      modelUsed: responseModel,
      forcedExit,
    };
  }

  // Flow Builder nodes formalize through their configured tools (for
  // example, efetiva_acordo). Do not run the legacy CPF-based
  // CalculaDebitos.php side effect for those nodes: it can formalize a
  // second agreement and append a fabricated/placeholder payment URL.
  if (hasAgreedAcordo && foundCpf && !hasOverride) {
    console.log(`[AI Agent] Intercepted #ACORDOFORMALIZADO. Calling DDM formalization API for CPF ${foundCpf}...`);
    try {
      const activeKey = ddmApiToken();
      // Sem token não formaliza: o erro já foi registrado em ddmApiToken().
      if (!activeKey) throw new Error("DDM_ACORDOS_API_TOKEN ausente");
      let calculoId = ddmData?.calculoId || "";
      
      if (!calculoId) {
        // 1. Busca os débitos/cálculos no localiza_dev.php para pegar o CalculoID ativo
        const localizaUrl = `https://ddmacordos.com/calc/localiza_dev.php?tk=${activeKey}&cpf=${foundCpf.replace(/\D/g, "")}`;
        const resLocaliza = await boundedFetch(localizaUrl);
      if (resLocaliza.ok) {
        const localizaData = await resLocaliza.json();
        const iddev = localizaData?.[0]?.iddev;
        
        if (iddev) {
          const cli = (localizaData?.[0]?.sistema || "").trim().toLowerCase() === "cruzeirodosul" ? "cruzeiro" : "ddm";
          const calcUrl = `https://ddmacordos.com/calc/?tk=${activeKey}&idDev=${iddev}&cli=${cli}`;
          const resCalc = await boundedFetch(calcUrl);
          
          if (resCalc.ok) {
            const rawCalc = await resCalc.json();
            const calcArray = Array.isArray(rawCalc) ? rawCalc : [rawCalc];
            
            const dadosObj = calcArray.find((item: any) => item?.Dados)?.Dados;
            if (dadosObj) {
              calculoId = dadosObj.CalculoID || dadosObj.idcalc || "";
            }
          }
        }
      }
    }

      // Aguarda 3 segundos para garantir que a DDM limpou sessões de consulta anteriores
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // 2. Registra e formaliza o acordo na DDM enviando o CalculoID e a quantidade de parcelas solicitadas
      const installments = extractInstallmentsFromHistory(history);
      const opcaoAcordo = installments <= 1 ? 1 : installments + 1;
      console.log(`[AI Agent] Formalizing agreement for CPF ${foundCpf} with ${installments} requested installments (sending OpcaoAcordo=${opcaoAcordo} to integration).`);
      
      const formalizeUrl = `https://www.ddmacordos.com/ws_ddm/ws/CalculaDebitos.php?tk=${activeKey}&OpcaoAcordo=${opcaoAcordo}&TipoAcordo=1&Doc=${foundCpf}${calculoId ? `&idcalc=${calculoId}` : ""}`;
      const resFormalize = await boundedFetch(formalizeUrl);
      if (resFormalize.ok) {
        const resText = await resFormalize.text();
        console.log(`[AI Agent] DDM formalize success. Response payload: ${resText}`);
        
        const match = resText.match(/https?:\/\/[^\s"']+/i);
        if (match) {
          payBoletoUrl = match[0];
        }
      }

      // Aguarda mais 3 segundos para dar tempo ao sistema da DDM gerar a linha digitável e o PDF pós-registro
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // 3. Monta o link do ddmpay real caso o CalculaDebitos retorne uma URL vazia ou se quisermos forçar o link dinâmico
      if (!payBoletoUrl && calculoId) {
        payBoletoUrl = `https://ddmpay.ddmacordos.com/acesso/?c=${calculoId}&u=`;
      }

      // Adiciona o link do boleto/pagamento gerado à mensagem enviada pela IA no WhatsApp
      if (payBoletoUrl) {
        generatedText = `${generatedText}\n\nSegue o link oficial para pagamento: ${payBoletoUrl}`;
      }
    } catch (err) {
      console.error("[AI Agent] DDM formalize and boleto fetch error:", err);
    }
  }

  if (shouldTransferToHuman) {
    console.log(`[AI Agent] Intercepted transfer/closing event. Assigning conversation ${conversationId} to human agent...`);
    const { data: convData } = await db
      .from("conversations")
      .select("user_id")
      .eq("id", conversationId)
      .single();

    let targetAgentId = convData?.user_id;

    // Fallback: se a conversa não tiver user_id, pega o dono do whatsapp_config correspondente
    if (!targetAgentId) {
      const { data: wahaCfg } = await db
        .from("whatsapp_config")
        .select("user_id")
        .eq("account_id", accountId)
        .maybeSingle();
      if (wahaCfg?.user_id) {
        targetAgentId = wahaCfg.user_id;
      }
    }

    if (targetAgentId) {
      await db
        .from("conversations")
        .update({
          assigned_agent_id: targetAgentId,
          updated_at: new Date().toISOString()
        })
        .eq("id", conversationId);
    }
  }

  // 6. Voice Reply Generation (ElevenLabs)
  let voiceMediaUrl = "";
  // ai_config.elevenlabs_api_key agora é gravada criptografada
  // (migration 084); tryDecrypt cai pro valor bruto se ainda estiver em
  // texto puro. Sem fallback hardcoded — sem chave configurada pela
  // própria conta, a geração de voz é pulada (ver throw abaixo), não
  // usa mais uma chave compartilhada padrão.
  const rawElevenlabsConfigKey = aiConfig.elevenlabs_api_key
    ? tryDecrypt(aiConfig.elevenlabs_api_key)
    : aiConfig.elevenlabs_api_key;
  const elevenlabsApiKey: string | null = rawElevenlabsConfigKey || null;
  const elevenlabsVoiceId = aiConfig.elevenlabs_voice_id || "33B4UnXyTNbgLmdEDh5P";

  if (incomingWasAudio && aiConfig.elevenlabs_enabled && elevenlabsVoiceId) {
    try {
      if (!elevenlabsApiKey) {
        throw new Error("ElevenLabs API key não configurada");
      }
      console.log("[AI Agent] Generating voice reply with ElevenLabs...");
      const ttsUrl = `https://api.elevenlabs.io/v1/text-to-speech/${elevenlabsVoiceId}`;
      const ttsRes = await boundedFetch(ttsUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": elevenlabsApiKey,
        },
        body: JSON.stringify({
          text: generatedText,
          model_id: "eleven_multilingual_v2",
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
          },
        }),
      });

      if (ttsRes.ok) {
        const audioBuffer = await ttsRes.arrayBuffer();
        const filename = `voice-reply-${Date.now()}.mp3`;
        const storagePath = `account-${accountId}/${filename}`;

        const { error: uploadError } = await db.storage
          .from("chat-media")
          .upload(storagePath, Buffer.from(audioBuffer), {
            contentType: "audio/mpeg",
            cacheControl: "31536000",
            upsert: true,
          });

        if (!uploadError) {
          voiceMediaUrl = chatMediaReference(storagePath);
          console.log("[AI Agent] Voice reply generated and uploaded:", voiceMediaUrl);
        } else {
          console.error("[AI Agent] Failed to upload ElevenLabs audio to Storage:", uploadError.message);
        }
      } else {
        console.error("[AI Agent] ElevenLabs TTS API failed:", await ttsRes.text());
      }
    } catch (err) {
      console.error("[AI Agent] ElevenLabs error:", err);
    }
  }

  // 6b. Canais que não são WhatsApp. Webchat: a resposta (texto ou áudio) e
  // o boleto são gravados na conversa e a página do cliente os busca.
  // Instagram/Messenger: saem pela Graph API (src/lib/channels/social.ts).
  // A simulação de digitação e o retry por variante de telefone abaixo não
  // se aplicam a esses canais.
  const conversationChannel = await getConversationChannel(conversationId);
  if (conversationChannel === "webchat" || isSocialChannel(conversationChannel)) {
    const send = conversationChannel === "webchat" ? sendWebchatMessage : sendSocialMessage;
    try {
      const sent = await send({
        conversationId,
        senderType: "bot",
        contentType: voiceMediaUrl ? "audio" : "text",
        text: generatedText,
        mediaUrl: voiceMediaUrl || null,
      });
      if (payBoletoUrl && payBoletoUrl.toLowerCase().includes(".pdf")) {
        await send({
          conversationId,
          senderType: "bot",
          contentType: "document",
          text: "Boleto-Acordo.pdf",
          mediaUrl: payBoletoUrl,
        });
      }
      if (!sent.id) {
        return {
          outcome: "failed",
          reason: "persist_failed_after_send",
          detectedTag,
          modelUsed: responseModel,
          providerMessageId: sent.whatsapp_message_id || null,
        };
      }
      return {
        outcome: "sent",
        messageId: sent.id,
        providerMessageId: sent.whatsapp_message_id || null,
        content: generatedText,
        detectedTag,
        modelUsed: responseModel,
        forcedExit,
      };
    } catch (err) {
      console.error(`[AI Agent] ${conversationChannel} send error:`, err);
      return {
        outcome: "failed",
        reason: `channel_send_failed:${err instanceof Error ? err.message : String(err)}`,
        detectedTag,
        modelUsed: responseModel,
      };
    }
  }

  // 7. Load WhatsApp configuration
  let configQuery = db
    .from("whatsapp_config")
    .select("*")
    .eq("account_id", accountId);
  if (configId) configQuery = configQuery.eq("id", configId);
  const { data: config, error: configError } = await configQuery.maybeSingle();

  if (configError || !config) {
    console.error("[AI Agent] WhatsApp config not found");
    return {
      outcome: "failed",
      reason: configError
        ? `whatsapp_config_load_failed:${configError.message}`
        : "whatsapp_config_missing",
      detectedTag,
      modelUsed: responseModel,
    };
  }

  // Scoped by account_id for defense in depth, matching the same
  // rationale used in automations/engine.ts, automations/meta-send.ts,
  // flows/engine.ts, flows/meta-send.ts, and whatsapp/send/route.ts —
  // a future caller that skips the entry-point guard still can't read
  // across tenants via the service-role client.
  const { data: contact } = await db
    .from("contacts")
    .select("phone")
    .eq("id", contactId)
    .eq("account_id", accountId)
    .single();

  if (!contact?.phone) {
    return {
      outcome: "failed",
      reason: "contact_phone_missing",
      detectedTag,
      modelUsed: responseModel,
    };
  }

  const sanitized = sanitizePhoneForMeta(contact.phone);
  const variants = phoneVariants(sanitized);
  let sentMessageId = "";
  let workingPhone = sanitized;

  const isWaha = config.provider === "waha";
  const wahaConfig = isWaha
    ? {
        waha_url: config.waha_url,
        waha_session: config.waha_session,
        waha_api_key: config.waha_api_key ? decrypt(config.waha_api_key) : null,
      }
    : null;
  const accessToken = isWaha ? "" : decrypt(config.access_token);

  // Envio ao cliente: efeito externo — daqui em diante, nada de retry.
  if (tracker) {
    tracker.externalEffect = true;
    tracker.trace.phase = "send";
    await tracker.heartbeat?.beat();
  }

  // 8. Send message via WAHA or Meta
  // Simulação de digitação: aguarda 2 segundos adicionais antes de enviar a mensagem de fato
  await new Promise((resolve) => setTimeout(resolve, 2000));

  const voiceProviderUrl = voiceMediaUrl ? await resolveProviderMedia(voiceMediaUrl, accountId) : null;
  for (const variant of variants) {
    try {
      if (isWaha) {
        if (voiceMediaUrl) {
          const result = await sendWahaMediaMessage(wahaConfig!, variant, voiceProviderUrl!, "audio", "voice.mp3");
          sentMessageId = result.messageId;
        } else {
          const result = await sendWahaTextMessage(wahaConfig!, variant, generatedText);
          sentMessageId = result.messageId;
        }
        
        // Se houver boleto PDF, envia ele em seguida como documento anexo
        if (payBoletoUrl && payBoletoUrl.toLowerCase().includes(".pdf")) {
          try {
            console.log(`[AI Agent] Sending PDF document to client...`);
            await sendWahaMediaMessage(wahaConfig!, variant, payBoletoUrl, "document", "Boleto-Acordo.pdf");
          } catch (pdfErr) {
            console.error("[AI Agent] Failed to send PDF document via WAHA:", pdfErr);
          }
        }
      } else {
        if (voiceMediaUrl) {
          const result = await sendMediaMessage({
            phoneNumberId: config.phone_number_id,
            accessToken,
            to: variant,
            kind: "audio",
            link: voiceProviderUrl!,
          });
          sentMessageId = result.messageId;
        } else {
          const result = await sendTextMessage({
            phoneNumberId: config.phone_number_id,
            accessToken,
            to: variant,
            text: generatedText,
          });
          sentMessageId = result.messageId;
        }
        
        // Se houver boleto PDF, envia pelo Meta Cloud API
        if (payBoletoUrl && payBoletoUrl.toLowerCase().includes(".pdf")) {
          try {
            console.log(`[AI Agent] Sending PDF document via Meta to client...`);
            await sendMediaMessage({
              phoneNumberId: config.phone_number_id,
              accessToken,
              to: variant,
              kind: "document",
              link: payBoletoUrl,
              filename: "Boleto-Acordo.pdf"
            });
          } catch (pdfErr) {
            console.error("[AI Agent] Failed to send PDF document via Meta:", pdfErr);
          }
        }
      }
      workingPhone = variant;
      break;
    } catch (err) {
      if (isWaha) {
        console.error("[AI Agent] WAHA send error:", err);
        break;
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (!isRecipientNotAllowedError(msg)) {
        console.error("[AI Agent] Meta send error:", err);
        break;
      }
    }
  }

  if (!sentMessageId) {
    return {
      outcome: "failed",
      reason: "provider_send_failed",
      detectedTag,
      modelUsed: responseModel,
    };
  }

  if (workingPhone !== sanitized) {
    await db.from("contacts").update({ phone: workingPhone }).eq("id", contactId);
  }

  // 9. Save sent message to database — assumindo o eco do WAHA se ele
  // chegou antes (senão a resposta ia ao cliente e sumia do Inbox).
  const messageDate = new Date().toISOString();
  const persisted = await persistOutboundMessage(db, {
    conversation_id: conversationId,
    message_id: sentMessageId,
    content_type: voiceMediaUrl ? "audio" : "text",
    content_text: generatedText,
    media_url: voiceMediaUrl || null,
    status: "sent",
    sender_type: "bot",
    created_at: messageDate,
  });
  const newMsgErr = persisted.error;

  const savedMessageId = persisted.id;
  if (newMsgErr || !savedMessageId) {
    console.error("[AI Agent] Failed to save outbound message:", newMsgErr);
    void writeLog({
      account_id: accountId,
      level: "error",
      source: "ai_agent",
      event: "ai_outbound_not_persisted",
      message: "Resposta da IA enviada ao cliente, mas não gravada no Inbox",
      payload: { conversation_id: conversationId, message_id: sentMessageId, erro: newMsgErr?.message ?? "no_message_id" },
    });
    return {
      outcome: "failed",
      reason: newMsgErr
        ? `persist_failed_after_send:${newMsgErr.message}`
        : "persist_failed_after_send:no_message_id",
      detectedTag,
      modelUsed: responseModel,
      providerMessageId: sentMessageId,
    };
  }

  if (tracker) tracker.trace.phase = "persisted";

  // 10. Update conversation values
  await db
    .from("conversations")
    .update({
      last_message_text: voiceMediaUrl ? "🎙️ [Áudio de Voz]" : generatedText,
      last_message_at: messageDate,
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversationId);

  return {
    outcome: "sent",
    messageId: savedMessageId,
    providerMessageId: sentMessageId,
    content: generatedText,
    detectedTag,
    modelUsed: responseModel,
    forcedExit,
  };
}

async function generateGeminiResponse(
  apiKey: string,
  systemPrompt: string,
  history: any[],
  model: string,
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const contents = [];

  for (const msg of history) {
    const isCustomer = msg.sender_type === "customer";
    
    // Multi-modal image handler
    if (msg.content_type === "image" && msg.media_url) {
      try {
        let fetchUrl = msg.media_url;
        if (!fetchUrl.startsWith("http")) {
          const { data: publicUrlData } = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!,
            { db: { schema: 'wacrm' } }
          ).storage.from("chat-media").getPublicUrl(fetchUrl);
          fetchUrl = publicUrlData.publicUrl;
        }

        const imgRes = await boundedFetch(fetchUrl);
        if (imgRes.ok) {
          const buffer = await imgRes.arrayBuffer();
          const base64 = Buffer.from(buffer).toString("base64");
          const mimeType = imgRes.headers.get("content-type") || "image/jpeg";
          
          contents.push({
            role: isCustomer ? "user" : "model",
            parts: [
              { text: msg.content_text || "O que está nesta imagem?" },
              {
                inlineData: {
                  mimeType,
                  data: base64
                }
              }
            ],
          });
          continue;
        }
      } catch (err) {
        console.error("[AI Agent] Gemini failed to load image:", err);
      }
    }

    contents.push({
      role: isCustomer ? "user" : "model",
      parts: [{ text: msg.content_text || "" }],
    });
  }

  const systemInstruction = systemPrompt
    ? {
        parts: [{ text: systemPrompt }],
      }
    : undefined;

  const response = await boundedFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents,
      systemInstruction,
      generationConfig: {
        maxOutputTokens: 1000,
        temperature: 0.7,
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

// Exportada para os testes de ponta a ponta das tools (responder-tools.test.ts).
export async function generateOpenAiResponse(
  apiKey: string,
  systemPrompt: string,
  history: any[],
  tools?: AiAgentTool[],
  onToolCall?: (toolName: string, args: Record<string, unknown>) => Promise<void>,
  onToolResult?: (
    toolName: string,
    result: string,
    durationMs: number,
    meta?: ToolExecutionMeta,
  ) => Promise<void>,
  nodeKey?: string,
  model = "gpt-4o-mini",
  onWaiting?: () => void | Promise<void>,
): Promise<string> {
  const url = "https://api.openai.com/v1/chat/completions";

  // Build base messages array
  const baseMessages: any[] = [];
  if (systemPrompt) {
    baseMessages.push({ role: "system", content: systemPrompt });
  }
  for (const msg of history) {
    const isCustomer = msg.sender_type === "customer";
    if (msg.content_type === "image" && msg.media_url) {
      let fetchUrl = msg.media_url;
      if (!fetchUrl.startsWith("http")) {
        const { data: publicUrlData } = createClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!,
          { db: { schema: 'wacrm' } }
        ).storage.from("chat-media").getPublicUrl(fetchUrl);
        fetchUrl = publicUrlData.publicUrl;
      }
      const isWebp = fetchUrl.toLowerCase().includes(".webp");
      if (isWebp) {
        baseMessages.push({ role: isCustomer ? "user" : "assistant", content: msg.content_text || "[Imagem enviada]" });
      } else {
        baseMessages.push({
          role: isCustomer ? "user" : "assistant",
          content: [
            { type: "text", text: msg.content_text || "O que está nesta imagem?" },
            { type: "image_url", image_url: { url: fetchUrl } },
          ],
        });
      }
    } else {
      baseMessages.push({ role: isCustomer ? "user" : "assistant", content: msg.content_text || "" });
    }
  }

  // Tool calling loop (max 5 iterations to prevent infinite loops)
  const messages = [...baseMessages];
  const openAiTools = tools?.length
    ? tools.map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }))
    : undefined;

  // Raw tool_result payloads collected across the loop below, for the
  // #NEGOCIACAO auto-suppress check once GPT produces its final text.
  const collectedToolResults: { toolName: string; result: string }[] = [];

  for (let iteration = 0; iteration < 5; iteration++) {
    const modelDefinition = getAiModelDefinition("openai", model);
    const body: any = {
      model,
      messages,
    };
    if (modelDefinition?.openai_chat?.reasoning_effort) {
      body.reasoning_effort = modelDefinition.openai_chat.reasoning_effort;
      body.max_completion_tokens = 1000;
    } else {
      body.temperature = 0.7;
      body.max_tokens = 1000;
    }
    if (openAiTools?.length) {
      body.tools = openAiTools;
      body.tool_choice = "auto";
    }

    // Semáforo por processo + espera/nova tentativa em 429 (llm-gate.ts). O
    // timeout de 15s do boundedFetch só começa depois de obter a vaga.
    const response = await gatedFetch(
      () =>
        boundedFetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
        }),
      { onWaiting },
    );
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    const choice = data?.choices?.[0];
    const message = choice?.message;

    // No tool calls — final text response
    if (!message?.tool_calls?.length) {
      // Se consultar_debitos encontrou um débito com nominal > 0,
      // suprime o texto do GPT e retorna só o exit code — o cliente
      // não deve receber texto nesse turno, só o #NEGOCIACAO deve ser
      // processado pelo engine. Só se aplica ao nó BEN (agente_de_ia):
      // o Aleh (agente_de_ia_2) precisa apresentar os dados de
      // consultar_debitos ao cliente, não pode ser suprimido.
      if (nodeKey === "agente_de_ia") {
        const hasPositiveNominal = collectedToolResults.some((tr) => {
          if (tr.toolName !== "consultar_debitos") return false;
          // Formato 1 — Acordos: "nominal" com ponto decimal.
          const acordosMatch = tr.result.match(/"nominal"\s*:\s*"?(\d+\.?\d*)"?/);
          if (acordosMatch) {
            const value = parseFloat(acordosMatch[1]);
            if (!Number.isNaN(value) && value > 0) return true;
          }
          // Formato 2 — Calculos: "NominalPrinc" com vírgula decimal.
          const calculosMatch = tr.result.match(/"NominalPrinc"\s*:\s*"(\d+,\d+)"/);
          if (calculosMatch) {
            const value = parseFloat(calculosMatch[1].replace(",", "."));
            if (!Number.isNaN(value) && value > 0) return true;
          }
          return false;
        });
        if (hasPositiveNominal) {
          return "#NEGOCIACAO";
        }
      }
      return message?.content || "";
    }

    // Has tool calls — execute each and feed results back
    messages.push({ role: "assistant", content: message.content || null, tool_calls: message.tool_calls });

    for (const toolCall of message.tool_calls) {
      const toolName = toolCall.function?.name;
      const toolArgs = (() => {
        try { return JSON.parse(toolCall.function?.arguments || "{}"); } catch { return {}; }
      })();

      const toolDef = tools?.find((t) => t.name === toolName);
      let toolResult = "";

      if (toolDef) {
        const toolStartedAt = Date.now();
        const prepared = prepareToolArgs(
          toolName,
          toolArgs,
          toolDef.parameters.required ?? [],
        );
        const normalizedArgs = prepared.args;

        if (onToolCall) {
          await onToolCall(toolName, normalizedArgs).catch(() => {});
        }

        if (prepared.failure) {
          toolResult = serializeToolFailure(prepared.failure, 0);
          if (onToolResult) {
            await onToolResult(
              toolName,
              toolResult,
              Date.now() - toolStartedAt,
              {
                attempts: 0,
                recovered: false,
                failureCode: prepared.failure.code,
                httpStatus: prepared.failure.httpStatus,
              },
            ).catch(() => {});
          }
        } else {
          const interpolate = (str: string) =>
            str.replace(/\{\{(\w+)\}\}/g, (_, key) =>
              normalizedArgs[key] !== undefined
                ? String(normalizedArgs[key])
                : ""
            );

          // Segredos ({{secret.DDM_TOKEN}}) vêm do ambiente do servidor e
          // são trocados ANTES dos argumentos do modelo — ver tool-secrets.ts.
          const missingSecrets: string[] = [];
          const withSecrets = (str: string, encode: boolean) => {
            const r = resolveToolSecrets(str, toolDef.http.url, process.env, { encode });
            missingSecrets.push(...r.missing);
            return r.value;
          };

          const resolvedUrl = interpolate(withSecrets(toolDef.http.url, true));
          const resolvedBody = toolDef.http.body
            ? interpolate(withSecrets(toolDef.http.body, false))
            : undefined;
          const resolvedHeaders: Record<string, string> = {};
          for (const [k, v] of Object.entries(toolDef.http.headers || {})) {
            resolvedHeaders[k] = interpolate(withSecrets(v, false));
          }

          // Credencial da integração ausente no servidor: não chama a API
          // sem token (falharia de forma confusa) — vira falha da integração.
          const secretFailure = missingSecrets.length
            ? {
                code: "TOOL_PROVIDER_ERROR" as const,
                message: `Credencial da integração não configurada no servidor (${[...new Set(missingSecrets)].join(", ")}).`,
                retryable: false,
              }
            : null;
          if (secretFailure) {
            console.error("[AI Agent] Tool sem credencial no ambiente:", toolName, missingSecrets);
          }

          const maxAttempts = 3;
          let attempt = 0;
          let finalFailure:
            | ReturnType<typeof classifyFetchFailure>
            | null = secretFailure;
          if (secretFailure) toolResult = serializeToolFailure(secretFailure, 0);

          while (!secretFailure && attempt < maxAttempts) {
            attempt += 1;

            try {
              const httpRes = await boundedFetch(resolvedUrl, {
                method: toolDef.http.method,
                headers: {
                  "Content-Type": "application/json",
                  ...resolvedHeaders,
                },
                ...(resolvedBody ? { body: resolvedBody } : {}),
                signal: AbortSignal.timeout(30000),
              });

              const httpText = await httpRes.text();
              const failure =
                classifyHttpFailure(httpRes.status, httpText) ??
                classifyToolBodyFailure(httpText);

              if (!failure) {
                toolResult = httpText;
                finalFailure = null;
                break;
              }

              finalFailure = failure;
              toolResult = serializeToolFailure(failure, attempt);

              if (
                shouldRetryTool(
                  toolName,
                  toolDef.http.method,
                  failure,
                  attempt,
                  maxAttempts,
                )
              ) {
                await new Promise((resolve) =>
                  setTimeout(resolve, retryDelayMs(attempt)),
                );
                continue;
              }

              break;
            } catch (err) {
              const failure = classifyFetchFailure(err);
              finalFailure = failure;
              toolResult = serializeToolFailure(failure, attempt);

              if (
                shouldRetryTool(
                  toolName,
                  toolDef.http.method,
                  failure,
                  attempt,
                  maxAttempts,
                )
              ) {
                await new Promise((resolve) =>
                  setTimeout(resolve, retryDelayMs(attempt)),
                );
                continue;
              }

              break;
            }
          }

          if (onToolResult) {
            await onToolResult(
              toolName,
              toolResult,
              Date.now() - toolStartedAt,
              {
                attempts: attempt,
                recovered: !finalFailure && attempt > 1,
                failureCode: finalFailure?.code,
                httpStatus: finalFailure?.httpStatus,
              },
            ).catch(() => {});
          }
        }
      } else {
        toolResult = JSON.stringify({
          ok: false,
          error: "TOOL_SCHEMA_ERROR",
          message: `Tool "${toolName}" não encontrada na configuração do nó.`,
          retryable: false,
          attempts: 0,
        });
      }

      collectedToolResults.push({ toolName, result: toolResult });

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: toolResult,
      });
    }
    // Loop back to get GPT's response after tool results
  }

  return ""; // Fallback if max iterations reached
}

async function generateClaudeResponse(
  apiKey: string,
  systemPrompt: string,
  history: any[],
  model: string,
): Promise<string> {
  const url = "https://api.anthropic.com/v1/messages";
  const messages = [];

  for (const msg of history) {
    const isCustomer = msg.sender_type === "customer";
    messages.push({
      role: isCustomer ? ("user" as const) : ("assistant" as const),
      content: msg.content_text || "",
    });
  }

  const response = await boundedFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1000,
      system: systemPrompt,
      messages,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Claude API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  const textBlock = Array.isArray(data?.content)
    ? data.content.find((block: { type?: string; text?: string }) => block?.type === "text")
    : null;
  return textBlock?.text || "";
}

async function generateHermesResponse(
  apiKey: string,
  systemPrompt: string,
  history: any[],
  model: string,
): Promise<string> {
  const url = "https://openrouter.ai/api/v1/chat/completions";
  const messages = [];

  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }

  for (const msg of history) {
    const isCustomer = msg.sender_type === "customer";
    messages.push({
      role: isCustomer ? "user" : "assistant",
      content: msg.content_text || "",
    });
  }

  const response = await boundedFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://wacrm.vercel.app",
      "X-Title": "WA CRM",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.7,
      max_tokens: 1000,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Hermes OpenRouter API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  return data?.choices?.[0]?.message?.content || "";
}
