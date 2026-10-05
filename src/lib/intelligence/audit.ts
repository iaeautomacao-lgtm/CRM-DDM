// Auditoria das chamadas de ferramenta (wacrm.intelligence_tool_calls,
// migration 136). Best-effort: falha ao gravar nunca derruba a resposta.

import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import type { IntelligenceScope } from "./scope";

const MAX_ARGS_CHARS = 4_000;
const MAX_ERROR_CHARS = 500;

export interface ToolCallLog {
  scope: Pick<IntelligenceScope, "accountId" | "userId">;
  toolName: string;
  args: unknown;
  durationMs: number;
  success: boolean;
  /** Tamanho do JSON do resultado, em caracteres. */
  resultSize: number | null;
  error?: string | null;
}

function safeArgs(args: unknown): unknown {
  try {
    const json = JSON.stringify(args ?? {});
    if (json.length <= MAX_ARGS_CHARS) return JSON.parse(json);
    return { _truncated: true, preview: json.slice(0, MAX_ARGS_CHARS) };
  } catch {
    return { _unserializable: true };
  }
}

export async function logToolCall(entry: ToolCallLog, db?: SupabaseClient): Promise<void> {
  try {
    const client = db ?? supabaseAdmin();
    const { error } = await client.from("intelligence_tool_calls").insert({
      account_id: entry.scope.accountId,
      user_id: entry.scope.userId,
      tool_name: entry.toolName,
      arguments: safeArgs(entry.args),
      duration_ms: Math.max(0, Math.round(entry.durationMs)),
      success: entry.success,
      result_size: entry.resultSize,
      error: entry.error ? entry.error.slice(0, MAX_ERROR_CHARS) : null,
    });
    if (error) console.error("[intelligence] logToolCall:", error.message);
  } catch (err) {
    console.error("[intelligence] logToolCall:", err instanceof Error ? err.message : err);
  }
}
