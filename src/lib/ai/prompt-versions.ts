import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

// ============================================================
// Histórico de versões do prompt da IA (PRD 02, Fase A — migration 148).
//
// Cada texto distinto do prompt da conta (ai_config.system_prompt) ou das
// "Instruções da IA para este nó" (flow_nodes.config.system_prompt_override)
// vira uma linha em wacrm.ai_prompt_versions. A versão é o sha256 do texto
// exatamente como gravado; os 12 primeiros caracteres são o que aparece na
// tela (e o que deve ir em ai_decisions.prompt_version).
//
// Gravar versão é best-effort: nunca lança, nunca bloqueia o salvar.
// Server-only (node:crypto + service role).
// ============================================================

export type PromptVersionScope = "account" | "flow_node";
export type PromptVersionSource = "ui" | "migration" | "restore" | "backfill";

export type PromptVersionTarget =
  | { scope: "account" }
  | { scope: "flow_node"; flowId: string; nodeKey: string };

export interface PromptVersionRow {
  id: string;
  scope: PromptVersionScope;
  flow_id: string | null;
  node_key: string | null;
  content: string;
  content_hash: string;
  source: PromptVersionSource;
  created_by: string | null;
  created_at: string;
  last_saved_by: string | null;
  last_saved_at: string;
}

export const SHORT_PROMPT_VERSION_LENGTH = 12;

/** sha256 (hex) do texto exatamente como fica no banco. */
export function hashPromptContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** "Versão" curta (hash truncado) mostrada na tela. */
export function shortPromptVersion(hash: string): string {
  return hash.slice(0, SHORT_PROMPT_VERSION_LENGTH);
}

/** Versão curta de um texto — o valor para ai_decisions.prompt_version. */
export function promptVersionOf(content: string | null | undefined): string | null {
  if (!content || !content.trim()) return null;
  return shortPromptVersion(hashPromptContent(content));
}

interface NodeLike {
  node_key?: unknown;
  node_type?: unknown;
  config?: unknown;
}

/** node_key → instruções do nó, só nós ai_agent com texto não vazio. */
export function collectAiNodePrompts(nodes: readonly NodeLike[] | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of nodes ?? []) {
    if (!n || n.node_type !== "ai_agent" || typeof n.node_key !== "string") continue;
    const cfg = n.config;
    if (!cfg || typeof cfg !== "object") continue;
    const prompt = (cfg as Record<string, unknown>).system_prompt_override;
    if (typeof prompt !== "string" || !prompt.trim()) continue;
    out.set(n.node_key, prompt);
  }
  return out;
}

/**
 * Instruções de nós ai_agent que mudaram entre a versão anterior do fluxo
 * e a nova (inclui nó novo ou renomeado). Nó que ficou sem instruções não
 * gera versão — vazio significa "usar o prompt da conta".
 */
export function changedAiNodePrompts(
  previous: readonly NodeLike[] | null | undefined,
  next: readonly NodeLike[] | null | undefined,
): Array<{ nodeKey: string; content: string }> {
  const before = collectAiNodePrompts(previous);
  const changed: Array<{ nodeKey: string; content: string }> = [];
  for (const [nodeKey, content] of collectAiNodePrompts(next)) {
    if (before.get(nodeKey) !== content) changed.push({ nodeKey, content });
  }
  return changed;
}

/** Tabela ainda não criada (migration 148 não aplicada). */
export function isMissingTableError(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  return /ai_prompt_versions/.test(error.message ?? "") && /does not exist|schema cache/i.test(error.message ?? "");
}

export type RecordOutcome = "created" | "existing" | "skipped" | "failed";

/**
 * Grava (ou "re-salva") uma versão. Mesmo texto no mesmo alvo não cria
 * linha nova — só atualiza last_saved_at/last_saved_by, para a lista
 * mostrar qual versão está valendo agora. Nunca lança.
 */
export async function recordPromptVersion(
  db: SupabaseClient,
  input: {
    accountId: string;
    target: PromptVersionTarget;
    content: string | null | undefined;
    userId?: string | null;
    source?: PromptVersionSource;
  },
): Promise<RecordOutcome> {
  try {
    const content = input.content ?? "";
    if (!content.trim()) return "skipped";
    const hash = hashPromptContent(content);
    const now = new Date().toISOString();
    const flowId = input.target.scope === "flow_node" ? input.target.flowId : null;
    const nodeKey = input.target.scope === "flow_node" ? input.target.nodeKey : null;

    const { error } = await db.from("ai_prompt_versions").insert({
      account_id: input.accountId,
      scope: input.target.scope,
      flow_id: flowId,
      node_key: nodeKey,
      content,
      content_hash: hash,
      source: input.source ?? "ui",
      created_by: input.userId ?? null,
      last_saved_by: input.userId ?? null,
      last_saved_at: now,
    });
    if (!error) return "created";
    if (error.code !== "23505") {
      console.error("[prompt-versions] falha ao gravar versão:", error.message);
      return "failed";
    }

    let update = db
      .from("ai_prompt_versions")
      .update({ last_saved_at: now, last_saved_by: input.userId ?? null })
      .eq("account_id", input.accountId)
      .eq("scope", input.target.scope)
      .eq("content_hash", hash);
    update = flowId ? update.eq("flow_id", flowId) : update.is("flow_id", null);
    update = nodeKey ? update.eq("node_key", nodeKey) : update.is("node_key", null);
    const { error: updErr } = await update;
    if (updErr) {
      console.error("[prompt-versions] falha ao atualizar versão existente:", updErr.message);
      return "failed";
    }
    return "existing";
  } catch (err) {
    console.error("[prompt-versions] erro inesperado:", err instanceof Error ? err.message : err);
    return "failed";
  }
}

/**
 * Versões dos nós ai_agent de um fluxo publicado. `onlyChangedFrom`:
 * nós da versão anterior — grava só o que mudou (publicar sem mexer no
 * prompt não "re-salva"). Sem ele (ativação), grava/re-salva todos.
 */
export async function recordFlowNodePromptVersions(
  db: SupabaseClient,
  input: {
    accountId: string;
    flowId: string;
    nodes: readonly NodeLike[] | null | undefined;
    onlyChangedFrom?: readonly NodeLike[] | null;
    userId?: string | null;
  },
): Promise<void> {
  try {
    const items =
      input.onlyChangedFrom !== undefined
        ? changedAiNodePrompts(input.onlyChangedFrom, input.nodes)
        : [...collectAiNodePrompts(input.nodes)].map(([nodeKey, content]) => ({ nodeKey, content }));
    for (const item of items) {
      await recordPromptVersion(db, {
        accountId: input.accountId,
        target: { scope: "flow_node", flowId: input.flowId, nodeKey: item.nodeKey },
        content: item.content,
        userId: input.userId,
        source: "ui",
      });
    }
  } catch (err) {
    console.error("[prompt-versions] erro ao gravar versões do fluxo:", err instanceof Error ? err.message : err);
  }
}

/**
 * Lista as versões de um alvo, mais recentes (last_saved_at) primeiro.
 * Tabela ausente (148 não aplicada) → lista vazia, sem erro.
 */
export async function listPromptVersions(
  db: SupabaseClient,
  accountId: string,
  target: PromptVersionTarget,
  limit = 50,
): Promise<{ rows: PromptVersionRow[]; error: string | null }> {
  let query = db
    .from("ai_prompt_versions")
    .select(
      "id, scope, flow_id, node_key, content, content_hash, source, created_by, created_at, last_saved_by, last_saved_at",
    )
    .eq("account_id", accountId)
    .eq("scope", target.scope);
  query =
    target.scope === "flow_node"
      ? query.eq("flow_id", target.flowId).eq("node_key", target.nodeKey)
      : query.is("flow_id", null);
  const { data, error } = await query
    .order("last_saved_at", { ascending: false })
    .range(0, Math.max(0, limit - 1));
  if (error) {
    if (isMissingTableError(error)) return { rows: [], error: null };
    return { rows: [], error: error.message };
  }
  return { rows: (data ?? []) as PromptVersionRow[], error: null };
}
