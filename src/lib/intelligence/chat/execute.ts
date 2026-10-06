// Execução das chamadas de ferramenta pedidas pelo modelo. Mesmo caminho
// da rota POST /api/intelligence/tools/[name]: getTool → executeTool com o
// escopo do servidor (nunca do modelo) → logToolCall, sob o mesmo limite
// por usuário (rate.ts). Erros viram resultado estruturado para o modelo
// em vez de exceção — o laço decide o que fazer com eles.

import type { SupabaseClient } from "@supabase/supabase-js";
import { ForbiddenError, UnauthorizedError } from "@/lib/auth/account";
import { logToolCall, type ToolCallLog } from "../audit";
import { BadRequestError, NotFoundError } from "../errors";
import { checkIntelligenceToolRate } from "../rate";
import type { IntelligenceScope } from "../scope";
import { executeTool, getTool } from "../tools";
import type { ToolErrorKind, ToolExecution, ToolExecutor } from "./types";

export interface ToolExecutorDeps {
  /** Cliente service role das ferramentas (padrão: supabaseAdmin()). */
  db?: SupabaseClient;
  /** Relógio (testes). */
  now?: () => number;
  /** Auditoria (padrão: logToolCall). */
  log?: (entry: ToolCallLog) => Promise<void>;
  /** Limite por usuário (padrão: o balde compartilhado de rate.ts). */
  allowCall?: (userId: string) => boolean;
}

function classify(err: unknown): { kind: ToolErrorKind; message: string } {
  if (err instanceof ForbiddenError || err instanceof UnauthorizedError) {
    return { kind: "forbidden", message: err.message };
  }
  if (err instanceof BadRequestError) return { kind: "bad_request", message: err.message };
  if (err instanceof NotFoundError) return { kind: "not_found", message: err.message };
  return { kind: "internal", message: err instanceof Error ? err.message : String(err) };
}

export function parseToolArguments(raw: string): { ok: true; value: unknown } | { ok: false } {
  if (!raw.trim()) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

export function createToolExecutor(scope: IntelligenceScope, deps: ToolExecutorDeps = {}): ToolExecutor {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((entry: ToolCallLog) => logToolCall(entry));
  const allowCall = deps.allowCall ?? ((userId: string) => checkIntelligenceToolRate(userId).success);

  return async (name, rawArguments): Promise<ToolExecution> => {
    const startedAt = now();
    const parsed = parseToolArguments(rawArguments);
    const args = parsed.ok ? parsed.value : { _raw: rawArguments };

    const fail = async (kind: ToolErrorKind, message: string): Promise<ToolExecution> => {
      const durationMs = now() - startedAt;
      await log({ scope, toolName: name, args, durationMs, success: false, resultSize: null, error: `${kind}: ${message}` });
      return { ok: false, kind, message, durationMs };
    };

    if (!allowCall(scope.userId)) {
      return fail("rate_limited", "Limite de consultas por minuto atingido");
    }
    const tool = getTool(name);
    if (!tool) return fail("unknown_tool", `Ferramenta desconhecida: ${name}`);
    if (!parsed.ok) return fail("bad_request", "Os argumentos da ferramenta devem ser um JSON válido");

    try {
      const result = await executeTool(tool, scope, args, {
        ...(deps.db ? { db: deps.db } : {}),
        nowMs: now(),
      });
      const durationMs = now() - startedAt;
      let resultSize: number | null = null;
      try {
        resultSize = JSON.stringify(result ?? null).length;
      } catch {
        resultSize = null;
      }
      await log({ scope, toolName: tool.name, args, durationMs, success: true, resultSize });
      return { ok: true, result, durationMs };
    } catch (err) {
      const { kind, message } = classify(err);
      if (kind === "internal") console.error(`[intelligence/chat] ferramenta ${name} falhou:`, err);
      return fail(kind, message);
    }
  };
}
