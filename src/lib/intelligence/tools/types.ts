// Contrato das ferramentas do Intelligence. O escopo (conta/equipes) é
// argumento separado de `run`, resolvido no servidor — nenhum inputSchema
// tem account_id/team ids de escopo, e `validate` rejeita campos
// desconhecidos (então um account_id vindo do modelo é recusado).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { IntelligenceScope } from "../scope";

export interface JsonSchemaObject {
  type: "object";
  description?: string;
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
}

export interface ToolRunContext {
  /** Cliente service role (padrão: supabaseAdmin()). */
  db: SupabaseClient;
  /** Relógio (testes). */
  nowMs: number;
}

export interface IntelligenceTool<I, O> {
  name: string;
  /** pt-BR, escrita para um LLM: o que responde e quando usar. */
  description: string;
  inputSchema: JsonSchemaObject;
  /** Valida o input cru; lança BadRequestError com mensagem clara. */
  validate(input: unknown): I;
  run(scope: IntelligenceScope, input: I, ctx: ToolRunContext): Promise<O>;
}

/** Ferramenta com tipos apagados, para o registro. */
export interface RegisteredTool {
  name: string;
  description: string;
  inputSchema: JsonSchemaObject;
  validate(input: unknown): unknown;
  run(scope: IntelligenceScope, input: unknown, ctx: ToolRunContext): Promise<unknown>;
}

export function defineTool<I, O>(tool: IntelligenceTool<I, O>): RegisteredTool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    validate: (input) => tool.validate(input),
    run: (scope, input, ctx) => tool.run(scope, input as I, ctx),
  };
}
