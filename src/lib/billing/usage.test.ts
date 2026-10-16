import { describe, expect, it } from 'vitest'
import { tokensFromProviderResponse } from './usage'

describe('tokensFromProviderResponse', () => {
  it('captures OpenAI prompt, completion and cached usage', () => {
    expect(tokensFromProviderResponse('openai', { usage: { prompt_tokens: 80, completion_tokens: 15, prompt_tokens_details: { cached_tokens: 20 } } }))
      .toEqual({ inputTokens: 80, outputTokens: 15, cachedInputTokens: 20 })
  })
  it('captures Gemini input, cached and thought tokens', () => {
    expect(tokensFromProviderResponse('gemini', { usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 30, thoughtsTokenCount: 8, cachedContentTokenCount: 20 } }))
      .toEqual({ inputTokens: 100, outputTokens: 38, cachedInputTokens: 20 })
  })
  it('captures Claude cached tokens without double counting them', () => {
    expect(tokensFromProviderResponse('claude', { usage: { input_tokens: 70, cache_read_input_tokens: 20, output_tokens: 7 } }))
      .toEqual({ inputTokens: 90, outputTokens: 7, cachedInputTokens: 20 })
  })
  it('never guesses tokens when usage is missing', () => {
    expect(tokensFromProviderResponse('openai', {choices:[{message:{content:'hello'}}]})).toBeNull()
  })
  it('never lets cached tokens exceed input tokens', () => {
    expect(tokensFromProviderResponse('hermes',{usage:{prompt_tokens:5,completion_tokens:3,prompt_tokens_details:{cached_tokens:99}}}))
      .toEqual({inputTokens:5,outputTokens:3,cachedInputTokens:5})
  })
})
