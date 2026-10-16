// Best-effort provider-usage telemetry. Only token counts/metadata are stored:
// never prompts, messages, recipient identifiers, API keys or completions.
import { randomUUID } from 'node:crypto'
import { supabaseAdmin } from '@/lib/flows/admin-client'

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
}
function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}
export function tokensFromProviderResponse(provider: string, response: unknown): TokenUsage | null {
  const root = object(response)
  if (!root) return null
  const usage = object(root.usage)
  const metadata = object(root.usageMetadata)
  if (provider === 'gemini') {
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
    // Anthropic separates input_tokens from cache-read and cache-creation usage.
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

export async function recordAiTokenUsage(input: {
  accountId?: string | null
  provider: string
  model: string
  feature: string
  response: unknown
  requestId?: string
}): Promise<void> {
  if (!input.accountId) return // Unit tests / standalone calls have no tenant.
  const usage = tokensFromProviderResponse(input.provider, input.response)
  if (!usage) return // Unknown usage is NOT recorded as zero consumption.
  const root = object(input.response)
  const requestId = input.requestId ?? (typeof root?.id === 'string' && root.id ? root.id : randomUUID())
  try {
    const { error } = await supabaseAdmin().from('ai_token_usage').upsert({
      account_id: input.accountId,
      request_id: requestId.slice(0, 200),
      provider: input.provider,
      model: input.model.slice(0, 128),
      feature: input.feature.slice(0, 80),
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cached_input_tokens: usage.cachedInputTokens,
    }, { onConflict: 'account_id,provider,request_id', ignoreDuplicates: true })
    if (error) console.error('[costs] Cannot record AI usage:', error.code ?? 'db_error')
  } catch {
    // Billing telemetry failure must not block customer service or campaign sends.
    console.error('[costs] Cannot record AI usage')
  }
}
