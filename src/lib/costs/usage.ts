// Telemetria de uso de IA (migration 378). Grava SÓ contagens e metadados (conta, provedor, modelo, funcionalidade, request_id e tokens):
// nunca prompt, mensagem, resposta, nome, telefone nem chave (LGPD). Best-effort: NUNCA lança e quem chama NÃO deve esperar (void) —
// falha de custo não derruba a resposta ao cliente. Uso desconhecido NÃO é gravado como zero; sem a migration é no-op.
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** Extrai as contagens da resposta CRUA do provedor (openai/hermes, claude, gemini). null = a resposta não informou uso. */
export function tokensFromProviderResponse(provider: string, response: unknown): TokenUsage | null {
  const root = object(response)
  if (!root) return null
  const usage = object(root.usage)
  if (provider === 'gemini') {
    const metadata = object(root.usageMetadata)
    if (!metadata) return null
    const inputTokens = count(metadata.promptTokenCount)
    return {
      inputTokens,
      outputTokens: count(metadata.candidatesTokenCount) + count(metadata.thoughtsTokenCount),
      cachedInputTokens: Math.min(inputTokens, count(metadata.cachedContentTokenCount)),
    }
  }
  if (provider === 'claude') {
    if (!usage) return null
    const cached = count(usage.cache_read_input_tokens)
    // A Anthropic separa input_tokens de leitura/criação de cache.
    const inputTokens = count(usage.input_tokens) + cached + count(usage.cache_creation_input_tokens)
    return { inputTokens, outputTokens: count(usage.output_tokens), cachedInputTokens: cached }
  }
  if (!usage) return null
  const details = object(usage.prompt_tokens_details) ?? object(usage.input_tokens_details)
  const inputTokens = count(usage.prompt_tokens ?? usage.input_tokens)
  return {
    inputTokens,
    outputTokens: count(usage.completion_tokens ?? usage.output_tokens),
    cachedInputTokens: Math.min(inputTokens, count(details?.cached_tokens)),
  }
}

const isMissingTable = (e: { code?: string } | null | undefined) => e?.code === '42P01' || e?.code === 'PGRST205'

export interface RecordAiUsageInput {
  accountId?: string | null
  provider: string
  model: string
  feature: string
  /** Resposta crua do provedor (só o campo de uso é lido). */
  response: unknown
  requestId?: string
}

async function defaultDb(): Promise<Pick<SupabaseClient, 'from'>> {
  const { supabaseAdmin } = await import('@/lib/flows/admin-client')
  return supabaseAdmin()
}

export async function recordAiTokenUsage(input: RecordAiUsageInput, db?: Pick<SupabaseClient, 'from'>): Promise<void> {
  try {
    if (!input.accountId) return // sem conta (teste, simulador): nada a atribuir
    const usage = tokensFromProviderResponse(input.provider, input.response)
    if (!usage) return
    const root = object(input.response)
    const requestId = input.requestId ?? (typeof root?.id === 'string' && root.id ? root.id : randomUUID())
    const client = db ?? (await defaultDb())
    const { error } = await client.from('ai_token_usage').upsert(
      {
        account_id: input.accountId,
        request_id: requestId.slice(0, 200),
        provider: input.provider,
        model: input.model.slice(0, 128),
        feature: input.feature.slice(0, 80),
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        cached_input_tokens: usage.cachedInputTokens,
      },
      { onConflict: 'account_id,provider,request_id', ignoreDuplicates: true },
    )
    if (error && !isMissingTable(error)) console.error('[costs] não foi possível gravar o uso de IA:', error.code ?? 'db_error')
  } catch {
    console.error('[costs] não foi possível gravar o uso de IA')
  }
}
