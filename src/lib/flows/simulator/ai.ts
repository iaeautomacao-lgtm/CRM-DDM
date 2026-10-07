import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AI_EMPTY_REPLY_FALLBACK_TEXT,
  AI_INSTABILITY_TEXT,
  decideForcedInstability,
  generateClaudeResponse,
  generateGeminiResponse,
  generateHermesResponse,
  generateOpenAiResponse,
  type AiAutoResponseResult,
  buildPromptVersion,
  type ToolRealRequest,
} from "@/lib/ai/responder";
import { composeAgentPromptDetailed } from "@/lib/ai/agents/compose";
import { currentAgentRuntime, filterPriorityIntent, protectionEnabled } from "@/lib/ai/agents/scope";
import { classifyPriorityIntent } from "@/lib/ai/priority-intents";
import { detectAbusiveInput } from "@/lib/ai/abuse-guard";
import { BOT_LOOP_MIN_MESSAGES, BOT_LOOP_WINDOW_SECONDS, detectBotLoop } from "@/lib/ai/loop-guard";
import { extractAiExitTag, stripAiExitTag } from "@/lib/ai/exit-tags";
import { effectivePromptVersion } from "@/lib/ai/attempt-telemetry";
import { isModelCompatibleWithProvider, resolveAiModel } from "@/lib/ai/models";
import { tallyToolResult, type ToolExecutionMeta, type ToolRoundTally } from "@/lib/ai/tool-recovery";
import { buildKnowledgeBaseContext } from "@/lib/ai/kb-context";
import { tryDecrypt } from "@/lib/whatsapp/encryption";
import { loadAccountSecrets, loadAccountSecretsFrom, withAccountSecretsScope } from "@/lib/ai/account-secrets";
import { sanitizeResponseBody } from "@/lib/ai-tools/tool-request";
import type { FlowEffects } from "../effects";
import { captureOutbound, simNote, type SimContext } from "./context";
import { effectiveSimToolMode } from "./types";

type HistoryRow = {
  id: string | null;
  content_text: string | null;
  content_type: string | null;
  media_url: string | null;
  created_at: string;
  sender_type: string;
};

const DEFAULT_TOOL_MOCK = (toolName: string) =>
  JSON.stringify({
    simulado: true,
    tool: toolName,
    mensagem: "Resposta simulada — defina a resposta desta tool no painel Testar fluxo.",
  });

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Nomes das ferramentas do turno que são do CATÁLOGO salvo (ligadas) e cuja definição HTTP é
 * idêntica à salva. Só estas podem fazer leitura real no simulador; definição inline ou alterada
 * no rascunho fica sempre em mock.
 */
export async function savedCatalogToolNames(
  db: SupabaseClient,
  accountId: string,
  tools: ReadonlyArray<{ name: string; http: unknown }> | undefined,
): Promise<Set<string>> {
  const out = new Set<string>();
  if (!tools?.length) return out;
  const { data } = await db.from("ai_tools").select("name, http, enabled").eq("account_id", accountId);
  const saved = new Map(((data ?? []) as Array<{ name: string; http: unknown; enabled: boolean }>).filter((r) => r.enabled).map((r) => [r.name, stableJson(r.http)]));
  for (const tool of tools) if (saved.get(tool.name) === stableJson(tool.http)) out.add(tool.name);
  return out;
}

/**
 * Executa a chamada HTTP de UMA tool no simulador. Real só para tools
 * somente-leitura liberadas no painel (effectiveSimToolMode); o resto —
 * inclusive efetiva_acordo e qualquer método que não seja GET — recebe a
 * resposta mockada e nunca sai do servidor.
 */
export function simulatedToolFetch(ctx: SimContext, nodeKey: string | null, savedCatalogTools: ReadonlySet<string> = new Set()) {
  return async (toolName: string, maskedUrl: string, init: RequestInit, real?: () => Promise<ToolRealRequest>): Promise<Response> => {
    let mode = effectiveSimToolMode(toolName, init.method, ctx.realReadOnlyTools);
    // Leitura real só para ferramenta do CATÁLOGO (versão salva), idêntica ao que está no rascunho:
    // uma definição inline/alterada no rascunho nunca recebe credencial.
    if (mode === "real_readonly" && !savedCatalogTools.has(toolName)) {
      simNote(ctx, `Tool ${toolName}: leitura real recusada — só ferramentas salvas no catálogo (Configurações → Ferramentas) podem consultar de verdade; usando resposta simulada`, nodeKey);
      mode = "mock";
    }
    if (mode === "real_readonly") {
      // maskedUrl/init chegam com "***" no lugar de {{cred}}/{{secret}}: o painel nunca vê
      // credencial. A resolução REAL só acontece aqui, para esta consulta GET liberada, e
      // segue a mesma regra da produção (host final permitido; senão a tool já falhou antes).
      simNote(ctx, `Tool ${toolName}: consulta REAL somente leitura`, nodeKey, { url: maskedUrl });
      const resolved = await real?.();
      if (!resolved) return new Response(ctx.toolMocks[toolName] ?? DEFAULT_TOOL_MOCK(toolName), { status: 200, headers: { "Content-Type": "application/json" } });
      if (resolved.missing?.length) {
        // Credencial da conta ausente (ou host não permitido): a chamada real NÃO acontece.
        simNote(ctx, `Tool ${toolName}: sem credencial da conta para a chamada real (${[...new Set(resolved.missing)].join(", ")}) — usando resposta simulada`, nodeKey);
        return new Response(ctx.toolMocks[toolName] ?? DEFAULT_TOOL_MOCK(toolName), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const res = await ctx.realFetch(resolved.url, resolved.init, {
        failOnCrossOriginRedirect: resolved.credentialInjected,
      });
      // A resposta volta ao modelo simulado e ao painel: nenhum eco de credencial.
      const text = sanitizeResponseBody(await res.text(), resolved.secretValues, Number.MAX_SAFE_INTEGER);
      return new Response(text, { status: res.status, headers: res.headers });
    }
    const body = ctx.toolMocks[toolName] ?? DEFAULT_TOOL_MOCK(toolName);
    simNote(ctx, `Tool ${toolName}: resposta simulada (nenhuma chamada real)`, nodeKey, { url: maskedUrl });
    return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
  };
}

/**
 * Versão do simulador de handleAiAutoResponse (responder.ts), com a mesma
 * assinatura: mesmo prompt (override do nó = rascunho do editor), mesmo
 * histórico, base de conhecimento, travas (prioridade, anti-abuso,
 * anti-loop), provedor e modelo REAIS, mesma detecção/remoção de tag e
 * #INSTABILIDADE forçada. Diferenças: tools via simulatedToolFetch, a
 * resposta é capturada em vez de enviada, nada é gravado fora do banco
 * em memória, e o orquestrador legado de CPF (só do prompt global, sem
 * override) não roda.
 */
export function createSimulatedAi(ctx: SimContext): FlowEffects["handleAiAutoResponse"] {
  return async (
    accountId,
    _contactId,
    conversationId,
    incomingText,
    systemPromptOverride,
    _skipDebounce,
    historyAfter,
    historyBefore,
    tools,
    onToolCall,
    onToolResult,
    nodeKey,
    _configId,
    flowExitTags,
    modelOverride,
  ): Promise<AiAutoResponseResult> => {
    const db = ctx.db;
    const node = nodeKey ?? null;
    const { data: aiConfig } = await db.from("ai_config").select("*").eq("account_id", accountId).maybeSingle();
    if (!aiConfig || !aiConfig.enabled) {
      return { outcome: "skipped", reason: "ai_config_disabled_or_missing", detectedTag: null, modelUsed: null };
    }
    if (modelOverride?.trim() && !isModelCompatibleWithProvider(modelOverride, aiConfig.api_provider)) {
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
      accountModel: typeof aiConfig.api_model === "string" ? aiConfig.api_model : null,
    });
    if (!resolvedModel) {
      return { outcome: "failed", reason: `unsupported_ai_provider:${aiConfig.api_provider}`, detectedTag: null, modelUsed: null };
    }
    const responseModel = resolvedModel.model;
    const hasOverride = !!systemPromptOverride && systemPromptOverride.trim() !== "";
    const promptVersion = effectivePromptVersion({ hasOverride, accountPrompt: aiConfig.system_prompt });

    let query = db
      .from("messages")
      .select("id, content_text, content_type, media_url, created_at, sender_type")
      .eq("conversation_id", conversationId);
    if (historyAfter) query = query.gt("received_at", historyAfter);
    if (historyBefore) query = query.lt("received_at", historyBefore);
    const { data: messages } = await query.order("created_at", { ascending: false }).limit(10);
    const history = ((messages ?? []) as HistoryRow[]).reverse();

    // Agente (perfil) do nó, quando houver: o motor abriu o escopo (withAgentRuntime) com a versão
    // PUBLICADA seedada no banco em memória. Mesmas travas/toggles da produção; opt-out sempre vale.
    const agentRuntime = currentAgentRuntime();
    if (agentRuntime) {
      const { data: agentRows } = await db.from("ai_agents").select("name").eq("id", agentRuntime.agentId).limit(1);
      const { data: versionRows } = await db.from("ai_agent_versions").select("version").eq("id", agentRuntime.versionId).limit(1);
      const agentName = (agentRows?.[0] as { name?: string } | undefined)?.name ?? "agente";
      const versionNumber = (versionRows?.[0] as { version?: number } | undefined)?.version;
      simNote(ctx, `Agente: ${agentName}${versionNumber ? ` v${versionNumber}` : ""} (versão publicada)`, node, {
        agent_id: agentRuntime.agentId,
        version_id: agentRuntime.versionId,
        composition: agentRuntime.composition,
      });
    }
    const priorityIntent = filterPriorityIntent(classifyPriorityIntent(incomingText), agentRuntime);
    if (priorityIntent?.kind === "opt_out" || priorityIntent?.kind === "wrong_person") {
      simNote(ctx, "O responder real gravaria o telefone na blacklist — não executado na simulação", node);
    }

    const abuse = priorityIntent || !protectionEnabled("anti_xingamento", agentRuntime) ? null : detectAbusiveInput(incomingText || "");
    if (abuse) {
      simNote(ctx, "Trava anti-abuso: iria para a fila humana da equipe (não executado)", node, abuse);
      return {
        outcome: "skipped",
        reason: "handoff_anti_scam",
        detectedTag: null,
        modelUsed: responseModel,
        guard: { subreason: abuse.kind === "jailbreak" ? "JAILBREAK" : "OFENSA", term: abuse.term, team_id: null, assigned_to: null },
      };
    }
    const antiLoopCfg = agentRuntime?.config.protections?.anti_loop;
    const loopWindowSeconds = antiLoopCfg?.window_seconds ?? BOT_LOOP_WINDOW_SECONDS;
    const loopMinMessages = antiLoopCfg?.min_messages ?? BOT_LOOP_MIN_MESSAGES;
    if (!priorityIntent && protectionEnabled("anti_loop", agentRuntime)) {
      const since = new Date(Date.now() - loopWindowSeconds * 1000).toISOString();
      const { data: botRows } = await db
        .from("messages")
        .select("received_at")
        .eq("conversation_id", conversationId)
        .eq("sender_type", "bot")
        .gte("received_at", since)
        .order("received_at", { ascending: false })
        .limit(loopMinMessages);
      const loop = detectBotLoop(
        ((botRows ?? []) as Array<{ received_at: string | null }>).map((r) => r.received_at),
        new Date(),
        { minMessages: loopMinMessages, windowSeconds: loopWindowSeconds, futureToleranceMs: antiLoopCfg?.future_tolerance_ms },
      );
      if (loop) {
        simNote(ctx, "Trava anti-loop: iria para a fila humana da equipe (não executado)", node, loop);
        return {
          outcome: "skipped",
          reason: "handoff_anti_loop",
          detectedTag: null,
          modelUsed: responseModel,
          guard: { subreason: "BOT_EM_LOOP", bot_messages: loop.botMessages, window_seconds: loop.windowSeconds, team_id: null, assigned_to: null },
        };
      }
    }

    const trimmedIncoming = (incomingText || "").trim();
    if (trimmedIncoming) {
      const lastCustomer = [...history].reverse().find((m) => m.sender_type === "customer");
      if (!lastCustomer || !(lastCustomer.content_text || "").includes(trimmedIncoming)) {
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

    const rawKey = typeof aiConfig.api_key === "string" ? aiConfig.api_key.trim() : "";
    const configKey = rawKey ? tryDecrypt(rawKey) : "";
    const masterKey =
      aiConfig.api_provider === "hermes"
        ? process.env.OPENROUTER_API_KEY
        : aiConfig.api_provider === "openai"
          ? process.env.OPENAI_API_KEY
          : aiConfig.api_provider === "claude"
            ? (process.env.CLAUDE_API_KEY ?? process.env.ANTHROPIC_API_KEY)
            : process.env.GEMINI_API_KEY;
    const activeKey = configKey || masterKey || "";
    if (!activeKey) {
      return { outcome: "failed", reason: "missing_provider_api_key", detectedTag: null, modelUsed: responseModel };
    }

    const { data: kbFiles } = await db.from("knowledge_base_files").select("id, name, content").eq("account_id", accountId);
    let systemPrompt = hasOverride
      ? systemPromptOverride!
      : (aiConfig.system_prompt as string | null) || "Você é um assistente virtual. Aguarde um momento.";
    if (agentRuntime) {
      // Mesmo caminho da produção (responder.ts): seleção de KB do perfil + compose.ts como fonte única.
      const all = (kbFiles ?? []) as Array<{ id?: string; name: string; content: string | null }>;
      const knowledge = agentRuntime.config.knowledge;
      const kbForPrompt =
        knowledge.selection_mode === "explicit" ? all.filter((f) => f.id !== undefined && new Set(knowledge.file_ids ?? []).has(f.id)) : all;
      let kbContext: string | undefined;
      if (kbForPrompt.length > 0) {
        const recentCustomerText = history
          .filter((m) => m.sender_type === "customer")
          .slice(-3)
          .map((m) => m.content_text || "")
          .join("\n");
        kbContext = buildKnowledgeBaseContext(kbForPrompt, recentCustomerText, knowledge.max_chars);
      }
      systemPrompt = composeAgentPromptDetailed(
        buildPromptVersion(aiConfig.system_prompt as string | null, systemPromptOverride ?? "", hasOverride, agentRuntime),
        {
          kb_files: kbForPrompt.length > 0 ? kbForPrompt.map((f) => ({ name: f.name, content: f.content ?? "" })) : undefined,
          kb_context: kbContext,
          rules: agentRuntime.composition === "sections_v1" ? agentRuntime.rules : undefined,
          ddm_data: null,
          found_cpf: null,
          today_utc: new Date().toISOString().split("T")[0],
          current_date: new Date().toLocaleDateString("pt-BR"),
          prompt_interpolated: true,
        },
      ).systemPrompt;
      if (agentRuntime.config.knowledge.rag_external.enabled) {
        simNote(ctx, "RAG externo do agente não é consultado na simulação", node);
      }
    } else if (kbFiles && kbFiles.length > 0) {
      // Mesma dieta de tokens da produção (kb-context.ts, #91).
      const recentCustomerText = history
        .filter((m) => m.sender_type === "customer")
        .slice(-3)
        .map((m) => m.content_text || "")
        .join("\n");
      const kbContext = buildKnowledgeBaseContext(
        kbFiles as Array<{ name: string; content: string }>,
        recentCustomerText,
      );
      systemPrompt = `${systemPrompt}

=== BASE DE CONHECIMENTO DISPONÍVEL ===
${kbContext}
=== FIM DA BASE DE CONHECIMENTO ===

Use as informações da base de conhecimento acima para responder às dúvidas do cliente com a maior precisão possível. Se a informação não estiver na base, aja de acordo com suas instruções normais.`;
    }
    if (!hasOverride && !agentRuntime) {
      simNote(ctx, "Nó sem prompt próprio: o orquestrador legado de CPF/API DDM do prompt global não é simulado", node);
    }

    // Ferramentas do catálogo SALVO (iguais ao rascunho): só elas podem ter leitura real liberada.
    const savedTools = await savedCatalogToolNames(db, accountId, tools);
    const toolTally = new Map<string, ToolRoundTally>();
    const trackedOnToolResult = async (toolName: string, result: string, durationMs: number, meta?: ToolExecutionMeta) => {
      tallyToolResult(toolTally, toolName, meta?.failureCode);
      if (onToolResult) await onToolResult(toolName, result, durationMs, meta);
    };
    // O escopo da conta vale também aqui: as ferramentas resolvem {{var}}/{{cred}} só para a conta
    // da simulação (e, no modo simulador, com "***" no lugar do valor — ver simulatedToolFetch).
    const callProvider = (): Promise<string> =>
      withAccountSecretsScope(accountId, () => callProviderInner(), {
        // Variáveis/nomes/hosts vêm do banco em memória (seed); credenciais SEM valor (viram ***).
        load: (id) => loadAccountSecretsFrom(db, id, { decryptCredentials: false }),
        // Valores reais só para a consulta GET liberada (leitura somente-leitura, mesma regra de host).
        loadReal: loadAccountSecrets,
      });
    const callProviderInner = (): Promise<string> => {
      if (aiConfig.api_provider === "openai") {
        return generateOpenAiResponse(
          activeKey,
          systemPrompt,
          history,
          tools,
          async (toolName, toolArgs) => {
            if (onToolCall) await onToolCall(toolName, toolArgs);
          },
          trackedOnToolResult,
          nodeKey,
          responseModel,
          undefined, // onWaiting (heartbeat do vigia): sem efeito no simulador
          simulatedToolFetch(ctx, node, savedTools),
        );
      }
      if (tools?.length) simNote(ctx, `Provedor ${aiConfig.api_provider} não usa tools (igual à produção)`, node);
      if (aiConfig.api_provider === "claude") return generateClaudeResponse(activeKey, systemPrompt, history, responseModel);
      if (aiConfig.api_provider === "hermes") return generateHermesResponse(activeKey, systemPrompt, history, responseModel);
      return generateGeminiResponse(activeKey, systemPrompt, history, responseModel);
    };

    let generatedText: string;
    if (priorityIntent) {
      generatedText = `${priorityIntent.reply} ${priorityIntent.tag}`;
    } else {
      generatedText = (await callProvider()).trim();
      if (!generatedText) generatedText = (await callProvider()).trim();
    }

    const forcedExit = decideForcedInstability(toolTally, generatedText, flowExitTags);
    if (forcedExit) generatedText = `${AI_INSTABILITY_TEXT} #INSTABILIDADE`;
    if (!generatedText) generatedText = AI_EMPTY_REPLY_FALLBACK_TEXT;

    const detectedTag = extractAiExitTag(generatedText, flowExitTags);
    const text = stripAiExitTag(generatedText, detectedTag, flowExitTags);
    if (!text) {
      return { outcome: "skipped", reason: "control_tag_only", detectedTag, modelUsed: responseModel, forcedExit, promptVersion };
    }

    const sent = captureOutbound(ctx, { kind: "text", text, source: "ia" });
    return {
      outcome: "sent",
      messageId: sent.id,
      providerMessageId: sent.whatsapp_message_id,
      content: text,
      detectedTag,
      modelUsed: responseModel,
      forcedExit,
      promptVersion,
    };
  };
}
