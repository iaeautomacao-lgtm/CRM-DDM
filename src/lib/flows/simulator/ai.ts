import {
  AI_EMPTY_REPLY_FALLBACK_TEXT,
  AI_INSTABILITY_TEXT,
  decideForcedInstability,
  generateClaudeResponse,
  generateGeminiResponse,
  generateHermesResponse,
  generateOpenAiResponse,
  type AiAutoResponseResult,
} from "@/lib/ai/responder";
import { classifyPriorityIntent } from "@/lib/ai/priority-intents";
import { detectAbusiveInput } from "@/lib/ai/abuse-guard";
import { BOT_LOOP_MIN_MESSAGES, BOT_LOOP_WINDOW_SECONDS, detectBotLoop } from "@/lib/ai/loop-guard";
import { extractAiExitTag, stripAiExitTag } from "@/lib/ai/exit-tags";
import { effectivePromptVersion } from "@/lib/ai/attempt-telemetry";
import { isModelCompatibleWithProvider, resolveAiModel } from "@/lib/ai/models";
import { tallyToolResult, type ToolExecutionMeta, type ToolRoundTally } from "@/lib/ai/tool-recovery";
import { tryDecrypt } from "@/lib/whatsapp/encryption";
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

/**
 * Executa a chamada HTTP de UMA tool no simulador. Real só para tools
 * somente-leitura liberadas no painel (effectiveSimToolMode); o resto —
 * inclusive efetiva_acordo e qualquer método que não seja GET — recebe a
 * resposta mockada e nunca sai do servidor.
 */
export function simulatedToolFetch(ctx: SimContext, nodeKey: string | null) {
  return async (toolName: string, _url: string, init: RequestInit): Promise<Response> => {
    const mode = effectiveSimToolMode(toolName, init.method, ctx.realReadOnlyTools);
    if (mode === "real_readonly") {
      // A URL pode ter segredo ({{secret.X}}) já resolvido — não vai para o painel.
      simNote(ctx, `Tool ${toolName}: consulta REAL somente leitura`, nodeKey);
      return ctx.realFetch(_url, init);
    }
    const body = ctx.toolMocks[toolName] ?? DEFAULT_TOOL_MOCK(toolName);
    simNote(ctx, `Tool ${toolName}: resposta simulada (nenhuma chamada real)`, nodeKey);
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

    const priorityIntent = classifyPriorityIntent(incomingText);
    if (priorityIntent?.kind === "opt_out" || priorityIntent?.kind === "wrong_person") {
      simNote(ctx, "O responder real gravaria o telefone na blacklist — não executado na simulação", node);
    }

    const abuse = priorityIntent ? null : detectAbusiveInput(incomingText || "");
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
    if (!priorityIntent) {
      const since = new Date(Date.now() - BOT_LOOP_WINDOW_SECONDS * 1000).toISOString();
      const { data: botRows } = await db
        .from("messages")
        .select("received_at")
        .eq("conversation_id", conversationId)
        .eq("sender_type", "bot")
        .gte("received_at", since)
        .order("received_at", { ascending: false })
        .limit(BOT_LOOP_MIN_MESSAGES);
      const loop = detectBotLoop(((botRows ?? []) as Array<{ received_at: string | null }>).map((r) => r.received_at));
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

    const { data: kbFiles } = await db.from("knowledge_base_files").select("name, content").eq("account_id", accountId);
    let systemPrompt = hasOverride
      ? systemPromptOverride!
      : (aiConfig.system_prompt as string | null) || "Você é um assistente virtual. Aguarde um momento.";
    if (kbFiles && kbFiles.length > 0) {
      const kbContext = (kbFiles as Array<{ name: string; content: string }>)
        .map((file) => `[ARQUIVO: ${file.name}]\n${file.content}\n---`)
        .join("\n\n");
      systemPrompt = `${systemPrompt}

=== BASE DE CONHECIMENTO DISPONÍVEL ===
${kbContext}
=== FIM DA BASE DE CONHECIMENTO ===

Use as informações da base de conhecimento acima para responder às dúvidas do cliente com a maior precisão possível. Se a informação não estiver na base, aja de acordo com suas instruções normais.`;
    }
    if (!hasOverride) {
      simNote(ctx, "Nó sem prompt próprio: o orquestrador legado de CPF/API DDM do prompt global não é simulado", node);
    }

    const toolTally = new Map<string, ToolRoundTally>();
    const trackedOnToolResult = async (toolName: string, result: string, durationMs: number, meta?: ToolExecutionMeta) => {
      tallyToolResult(toolTally, toolName, meta?.failureCode);
      if (onToolResult) await onToolResult(toolName, result, durationMs, meta);
    };
    const callProvider = (): Promise<string> => {
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
          simulatedToolFetch(ctx, node),
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
