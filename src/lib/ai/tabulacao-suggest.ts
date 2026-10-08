import type { SupabaseClient } from "@supabase/supabase-js";
import type { OutcomeSuggestionSource } from "@/types";
import {
  callLlmForAnalysis,
  fetchRecentHistoryText,
  resolveActiveApiKey,
  stripJsonFences,
} from "./llm-shared";
import {
  loadOutcomeTagsForConversation,
  type OutcomeSuggestionView,
} from "@/lib/conversations/outcome-tags";

/**
 * Sugestão de tabulação (tag de encerramento) — usada pelo
 * OutcomeTagPicker via GET /api/conversations/[id]/suggest-tag.
 *
 * Regras de acesso (antes a rota lia tags/mensagens com service role e
 * SEM filtro de conta — vazava tabulações de outros tenants):
 *   - a conversa é lida com o client do USUÁRIO (RLS): se ele não a vê,
 *     a rota responde 404;
 *   - tags/mensagens também saem do client do usuário, filtradas pela
 *     conta da conversa; se a equipe da conversa tem tabulações mapeadas
 *     (team_outcome_tags, migration 107), só essas entram na lista;
 *   - service role só para resolver a chave/modelo de IA da conta
 *     (ai_config guarda a chave criptografada) e para gravar o cache da
 *     sugestão na conversa já verificada.
 *
 * Ordem (migration 157):
 *   1. sugestão vinda do fluxo (tag de saída da IA, source 'exit_tag') —
 *      devolvida sem chamar o LLM;
 *   2. cache: sugestão do LLM já calculada para a MESMA última mensagem
 *      (outcome_suggestion_key) — reabrir o picker não chama a IA de novo;
 *   3. LLM da conta (provider + modelo + chave, como as demais análises
 *      em llm-shared.ts), resposta JSON {codigo_tabulacao, confidence,
 *      reason} com opção "incerto"; o resultado (inclusive "incerto") é
 *      gravado como cache.
 */

/** Quantas mensagens recentes entram no prompt. */
export const SUGGEST_HISTORY_LIMIT = 20;

/** Resposta do modelo quando nenhuma tabulação se encaixa com segurança. */
export const UNCERTAIN_CODE = "incerto";

export interface OutcomeTagOption {
  id: string;
  name: string;
  codigo_tabulacao?: number | null;
}

export interface SuggestableConversation {
  id: string;
  account_id: string;
  team_id: string | null;
  status: string;
  suggested_outcome_tag_id: string | null;
  outcome_suggestion_source: OutcomeSuggestionSource | null;
  outcome_suggestion_confidence: number | string | null;
  outcome_suggestion_reason: string | null;
  outcome_suggestion_key: string | null;
}

export interface ParsedOutcomeSuggestion {
  tag: OutcomeTagOption;
  confidence: number;
  reason: string;
}

export type OutcomeSuggestionPayload = OutcomeSuggestionView;

export type LlmCaller = (
  provider: string,
  apiKey: string,
  prompt: string,
  model?: string,
) => Promise<string>;

/**
 * Chave com que cada opção aparece no prompt: o codigo_tabulacao quando
 * existe (é o identificador de negócio, estável entre contas), senão um
 * apelido curto "t<n>" para tags criadas sem código.
 */
export function optionKey(tag: OutcomeTagOption, index: number): string {
  return tag.codigo_tabulacao !== null && tag.codigo_tabulacao !== undefined
    ? String(tag.codigo_tabulacao)
    : `t${index + 1}`;
}

export function buildOutcomeSuggestPrompt(
  tags: OutcomeTagOption[],
  historyText: string,
): string {
  const options = tags
    .map((t, i) => `- ${optionKey(t, i)}: ${t.name}`)
    .join("\n");

  return `Você é um assistente de tabulação de atendimentos de cobrança.
Analise a conversa e escolha a tabulação (desfecho do atendimento) mais adequada dentre as opções abaixo.

Regras:
- Use SOMENTE um dos códigos listados.
- Se a conversa não deixa claro o desfecho, ou nenhuma opção se encaixa com segurança, responda "${UNCERTAIN_CODE}".
- "confidence" é a sua certeza entre 0 e 1.
- "reason" é uma frase curta em português explicando a escolha.

Opções (código: nome):
${options}

Responda apenas com um objeto JSON válido, sem texto antes ou depois e sem bloco de código:
{"codigo_tabulacao": "<código ou ${UNCERTAIN_CODE}>", "confidence": 0.0, "reason": "..."}

Histórico da conversa:
"""
${historyText}
"""`;
}

function normalizeConfidence(raw: unknown): number {
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return 0;
  // Alguns modelos devolvem porcentagem (ex.: 85).
  if (n > 1) return n <= 100 ? n / 100 : 0;
  return n;
}

/**
 * Interpreta a resposta do modelo. Devolve null (sem sugestão) para JSON
 * inválido, "incerto", código fora da lista ou confiança zero — nunca
 * chuta uma tag.
 */
export function parseOutcomeSuggestResponse(
  raw: string,
  tags: OutcomeTagOption[],
): ParsedOutcomeSuggestion | null {
  let data: Record<string, unknown>;
  try {
    const parsed = JSON.parse(stripJsonFences(raw));
    if (!parsed || typeof parsed !== "object") return null;
    data = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const code = String(data.codigo_tabulacao ?? "").trim();
  if (!code || code.toLowerCase() === UNCERTAIN_CODE) return null;

  const index = tags.findIndex((t, i) => optionKey(t, i) === code);
  if (index < 0) return null;

  const confidence = normalizeConfidence(data.confidence);
  if (confidence <= 0) return null;

  const reason = typeof data.reason === "string" ? data.reason.trim().slice(0, 300) : "";
  return { tag: tags[index], confidence, reason };
}

/** Conversa, só se o usuário a enxerga (client RLS) e for da conta dele. */
export async function loadVisibleConversation(
  userDb: SupabaseClient,
  accountId: string,
  conversationId: string,
): Promise<SuggestableConversation | null> {
  const { data, error } = await userDb
    .from("conversations")
    .select(
      "id, account_id, team_id, status, suggested_outcome_tag_id, outcome_suggestion_source, outcome_suggestion_confidence, outcome_suggestion_reason, outcome_suggestion_key",
    )
    .eq("id", conversationId)
    .eq("account_id", accountId)
    .maybeSingle();
  if (error || !data) return null;
  return data as SuggestableConversation;
}

/** Id da última mensagem — chave do cache da sugestão. */
export async function latestMessageKey(
  db: SupabaseClient,
  conversationId: string,
): Promise<string | null> {
  const { data, error } = await db
    .from("messages")
    .select("id, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(1);
  const row = (data as { id: string }[] | null)?.[0];
  if (error || !row) return null;
  return String(row.id);
}

/** Sugestão gravada na conversa → payload, se a tag ainda está na lista. */
function storedSuggestion(
  conv: SuggestableConversation,
  tags: OutcomeTagOption[],
): OutcomeSuggestionPayload | null {
  if (!conv.suggested_outcome_tag_id || !conv.outcome_suggestion_source) return null;
  const tag = tags.find((t) => t.id === conv.suggested_outcome_tag_id);
  if (!tag) return null;
  return {
    tag_id: tag.id,
    tag_name: tag.name,
    codigo_tabulacao: tag.codigo_tabulacao ?? null,
    confidence: normalizeConfidence(conv.outcome_suggestion_confidence),
    motivo: conv.outcome_suggestion_reason ?? "",
    source: conv.outcome_suggestion_source,
  };
}

export interface SuggestOutcomeDeps {
  /** Client do usuário (RLS). Toda leitura de dado de atendimento sai daqui. */
  userDb: SupabaseClient;
  /** Service role — chave/modelo de IA da conta e escrita do cache. */
  adminDb: SupabaseClient;
  accountId: string;
  conversationId: string;
  callLlm?: LlmCaller;
}

export type SuggestOutcomeResult =
  | { status: "not_found" }
  | { status: "ok"; suggestion: OutcomeSuggestionPayload | null };

export async function suggestOutcomeTag(
  deps: SuggestOutcomeDeps,
): Promise<SuggestOutcomeResult> {
  const conversation = await loadVisibleConversation(
    deps.userDb,
    deps.accountId,
    deps.conversationId,
  );
  if (!conversation) return { status: "not_found" };

  const tags = await loadOutcomeTagsForConversation(
    deps.userDb,
    conversation.account_id,
    conversation.team_id,
  );
  if (tags.length === 0) return { status: "ok", suggestion: null };

  // 1. Fluxo já decidiu (tag de saída da IA): sem LLM.
  if (conversation.outcome_suggestion_source === "exit_tag") {
    const fromFlow = storedSuggestion(conversation, tags);
    if (fromFlow) return { status: "ok", suggestion: fromFlow };
  }

  // 2. Cache por última mensagem.
  const key = await latestMessageKey(deps.userDb, conversation.id);
  if (!key) return { status: "ok", suggestion: null };
  if (
    conversation.outcome_suggestion_key === key &&
    (conversation.outcome_suggestion_source === "llm" ||
      conversation.outcome_suggestion_source === "rule")
  ) {
    return { status: "ok", suggestion: storedSuggestion(conversation, tags) };
  }

  // 3. LLM da conta.
  const historyText = await fetchRecentHistoryText(
    deps.userDb,
    conversation.id,
    SUGGEST_HISTORY_LIMIT,
  );
  if (!historyText) return { status: "ok", suggestion: null };

  const active = await resolveActiveApiKey(deps.adminDb, conversation.account_id);
  if (!active) return { status: "ok", suggestion: null };

  const callLlm = deps.callLlm ?? callLlmForAnalysis;
  let raw: string;
  try {
    raw = await callLlm(
      active.provider,
      active.apiKey,
      buildOutcomeSuggestPrompt(tags, historyText),
      active.model,
    );
  } catch (err) {
    // Falha não entra no cache: a próxima abertura tenta de novo.
    console.error("[suggest-tag] LLM call failed:", err);
    return { status: "ok", suggestion: null };
  }

  const parsed = parseOutcomeSuggestResponse(raw, tags);
  await cacheLlmSuggestion(deps.adminDb, conversation, key, parsed);
  if (!parsed) return { status: "ok", suggestion: null };

  return {
    status: "ok",
    suggestion: {
      tag_id: parsed.tag.id,
      tag_name: parsed.tag.name,
      codigo_tabulacao: parsed.tag.codigo_tabulacao ?? null,
      confidence: parsed.confidence,
      motivo: parsed.reason,
      source: "llm",
    },
  };
}

/**
 * Grava a sugestão do LLM (ou "incerto", tag nula) como cache na conversa.
 * Nunca sobrescreve a sugestão do fluxo ('exit_tag') nem mexe em conversa
 * fechada (lá a sugestão fica congelada para a métrica de aceite).
 * Best-effort: erro de escrita não derruba a resposta.
 */
async function cacheLlmSuggestion(
  adminDb: SupabaseClient,
  conversation: SuggestableConversation,
  key: string,
  parsed: ParsedOutcomeSuggestion | null,
): Promise<void> {
  try {
    const { error } = await adminDb
      .from("conversations")
      .update({
        suggested_outcome_tag_id: parsed?.tag.id ?? null,
        outcome_suggestion_source: "llm",
        outcome_suggestion_confidence: parsed?.confidence ?? null,
        outcome_suggestion_reason: parsed?.reason ?? null,
        outcome_suggested_at: new Date().toISOString(),
        outcome_suggestion_key: key,
      })
      .eq("id", conversation.id)
      .eq("account_id", conversation.account_id)
      .neq("status", "closed")
      .or("outcome_suggestion_source.is.null,outcome_suggestion_source.neq.exit_tag");
    if (error) console.error("[suggest-tag] cache write failed:", error.message);
  } catch (err) {
    console.error("[suggest-tag] cache write failed:", err);
  }
}
