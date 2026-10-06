import type { SupabaseClient } from "@supabase/supabase-js";
import {
  callLlmForAnalysis,
  fetchRecentHistoryText,
  resolveActiveApiKey,
  stripJsonFences,
} from "./llm-shared";

/**
 * Sugestão de tabulação (tag de encerramento) pela IA — usada pelo
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
 *     (ai_config guarda a chave criptografada — dado de servidor).
 *
 * O modelo é o da conta (provider + modelo + chave, como as demais
 * análises em llm-shared.ts) — antes era gpt-4o-mini fixo na OpenAI, o que
 * quebrava contas Claude/Gemini/Hermes.
 */

/** Quantas mensagens recentes entram no prompt. */
export const SUGGEST_HISTORY_LIMIT = 20;

/** Resposta do modelo quando nenhuma tabulação se encaixa com segurança. */
export const UNCERTAIN_CODE = "incerto";

export interface OutcomeTagOption {
  id: string;
  name: string;
  codigo_tabulacao: number | null;
}

export interface SuggestableConversation {
  id: string;
  account_id: string;
  team_id: string | null;
  status: string;
}

export interface ParsedOutcomeSuggestion {
  tag: OutcomeTagOption;
  confidence: number;
  reason: string;
}

export interface OutcomeSuggestionPayload {
  tag_id: string;
  tag_name: string;
  codigo_tabulacao: number | null;
  /** 0..1 */
  confidence: number;
  motivo: string;
}

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
    .select("id, account_id, team_id, status")
    .eq("id", conversationId)
    .eq("account_id", accountId)
    .maybeSingle();
  if (error || !data) return null;
  return data as SuggestableConversation;
}

/**
 * Tabulações disponíveis para a conversa: as tags de desfecho da conta;
 * se a equipe da conversa tem mapeamento em team_outcome_tags, só as
 * mapeadas (mesma regra para a sugestão e para o picker).
 */
export async function loadOutcomeTagsForConversation(
  userDb: SupabaseClient,
  accountId: string,
  teamId: string | null,
): Promise<OutcomeTagOption[]> {
  const { data, error } = await userDb
    .from("tags")
    .select("id, name, codigo_tabulacao")
    .eq("account_id", accountId)
    .eq("kind", "outcome")
    .order("name");
  if (error || !data) return [];
  const tags = (data as OutcomeTagOption[]).map((t) => ({
    id: t.id,
    name: t.name,
    codigo_tabulacao: t.codigo_tabulacao ?? null,
  }));

  if (!teamId) return tags;
  const { data: mapped, error: mapError } = await userDb
    .from("team_outcome_tags")
    .select("tag_id")
    .eq("team_id", teamId);
  if (mapError || !mapped || mapped.length === 0) return tags;
  const allowed = new Set((mapped as { tag_id: string }[]).map((m) => m.tag_id));
  return tags.filter((t) => allowed.has(t.id));
}

export interface SuggestOutcomeDeps {
  /** Client do usuário (RLS). Toda leitura de dado de atendimento sai daqui. */
  userDb: SupabaseClient;
  /** Service role — só para resolver a chave/modelo de IA da conta. */
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
    console.error("[suggest-tag] LLM call failed:", err);
    return { status: "ok", suggestion: null };
  }

  const parsed = parseOutcomeSuggestResponse(raw, tags);
  if (!parsed) return { status: "ok", suggestion: null };

  return {
    status: "ok",
    suggestion: {
      tag_id: parsed.tag.id,
      tag_name: parsed.tag.name,
      codigo_tabulacao: parsed.tag.codigo_tabulacao,
      confidence: parsed.confidence,
      motivo: parsed.reason,
    },
  };
}
