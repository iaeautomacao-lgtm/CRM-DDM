export type AiProvider = "openai" | "gemini" | "claude" | "hermes";

export interface AiModelOption {
  id: string;
  label: string;
  description: string;
}

export const DEFAULT_AI_MODEL_BY_PROVIDER: Record<AiProvider, string> = {
  openai: "gpt-4o-mini",
  gemini: "gemini-3.8-flash",
  claude: "claude-sonnet-5",
  hermes: "nousresearch/hermes-3-llama-3.1-405b",
};

export const AI_MODELS_BY_PROVIDER: Record<AiProvider, AiModelOption[]> = {
  openai: [
    { id: "gpt-5.1", label: "GPT-5.1", description: "Mais capacidade para raciocínio e tarefas complexas." },
    { id: "gpt-5-mini", label: "GPT-5 mini", description: "Equilíbrio entre qualidade, velocidade e custo." },
    { id: "gpt-4.1", label: "GPT-4.1", description: "Modelo forte para instruções, ferramentas e contexto longo." },
    { id: "gpt-4.1-mini", label: "GPT-4.1 mini", description: "Mais rápido e econômico para atendimento." },
    { id: "gpt-4o-mini", label: "GPT-4o mini", description: "Modelo legado atual do CRM, rápido e econômico." },
  ],
  gemini: [
    { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", description: "Modelo Flash atual para baixa latência e alto volume." },
    { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite", description: "Foco em custo e velocidade." },
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", description: "Mais capacidade para tarefas complexas." },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", description: "Equilíbrio entre velocidade e qualidade." },
  ],
  claude: [
    { id: "claude-sonnet-5", label: "Claude Sonnet 5", description: "Modelo Sonnet atual para tarefas gerais complexas." },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", description: "Alta qualidade e boa estabilidade." },
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", description: "Mais rápido e econômico." },
    { id: "claude-opus-4-8", label: "Claude Opus 4.8", description: "Maior capacidade para tarefas difíceis." },
  ],
  hermes: [
    {
      id: "nousresearch/hermes-3-llama-3.1-405b",
      label: "Hermes 3 Llama 3.1 405B",
      description: "Modelo Hermes atual via OpenRouter.",
    },
  ],
};

export function isAiProvider(value: unknown): value is AiProvider {
  return value === "openai" || value === "gemini" || value === "claude" || value === "hermes";
}

export function getAiModelsForProvider(provider: AiProvider): AiModelOption[] {
  return AI_MODELS_BY_PROVIDER[provider];
}

export function getDefaultAiModel(provider: AiProvider): string {
  return DEFAULT_AI_MODEL_BY_PROVIDER[provider];
}

export function isAiModelAllowedForProvider(provider: AiProvider, model: string): boolean {
  return AI_MODELS_BY_PROVIDER[provider].some((item) => item.id === model);
}

/**
 * Node override is intentionally allow-listed. The account-level model is
 * accepted as-is for backwards compatibility, while the node UI only stores
 * model ids from the registry above.
 */
export function resolveEffectiveAiModel(input: {
  provider: AiProvider;
  nodeModel?: string | null;
  accountModel?: string | null;
}): string {
  const nodeModel = input.nodeModel?.trim();
  if (nodeModel && isAiModelAllowedForProvider(input.provider, nodeModel)) {
    return nodeModel;
  }

  const accountModel = input.accountModel?.trim();
  if (accountModel) return accountModel;

  return getDefaultAiModel(input.provider);
}
