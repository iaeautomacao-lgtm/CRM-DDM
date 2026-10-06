/**
 * Registry central de modelos de IA suportados pelo CRM.
 *
 * Uma única fonte para:
 * - opções do Flow Builder;
 * - validação de compatibilidade provider/model;
 * - resolução do modelo efetivo no runtime;
 * - observabilidade do modelo realmente chamado.
 *
 * O override do nó fica restrito ao provider configurado na conta.
 */
export const AI_PROVIDERS = ["openai", "gemini", "claude", "hermes"] as const;

export type AiProvider = (typeof AI_PROVIDERS)[number];

export interface AiModelDefinition {
  id: string;
  label: string;
  description?: string;
  /**
   * Opções específicas do Chat Completions da OpenAI. Mantidas no
   * registry para o runtime não espalhar exceções por model id.
   */
  openai_chat?: {
    reasoning_effort?: "none";
  };
}

export const AI_MODELS: Record<AiProvider, readonly AiModelDefinition[]> = {
  openai: [
    {
      id: "gpt-6-astra",
      label: "GPT-6 Astra",
      description: "Modelo de maior capacidade para tarefas complexas.",
      openai_chat: { reasoning_effort: "none" },
    },
    {
      id: "gpt-6-sol",
      label: "GPT-6 Sol",
      description: "Modelo de alta capacidade com equilíbrio entre custo e desempenho.",
      openai_chat: { reasoning_effort: "none" },
    },
    {
      id: "gpt-6-luna",
      label: "GPT-6 Luna",
      description: "Modelo eficiente para alto volume.",
      // No Chat Completions, function calling do GPT-6 Luna requer
      // reasoning_effort=none.
      openai_chat: { reasoning_effort: "none" },
    },
    {
      id: "gpt-4.1",
      label: "GPT-4.1",
      description: "Modelo geral com boa capacidade de instrução e ferramentas.",
    },
    {
      id: "gpt-4.1-mini",
      label: "GPT-4.1 mini",
      description: "Opção intermediária de custo e desempenho.",
    },
    {
      id: "gpt-4o-mini",
      label: "GPT-4o mini",
      description: "Modelo padrão legado do CRM.",
    },
  ],
  gemini: [
    {
      id: "gemini-2.5-flash",
      label: "Gemini 2.5 Flash",
      description: "Modelo Flash para alto volume.",
    },
    {
      id: "gemini-1.5-flash",
      label: "Gemini 1.5 Flash",
      description: "Modelo padrão legado do CRM.",
    },
  ],
  claude: [
    {
      id: "claude-3-5-sonnet-20241022",
      label: "Claude 3.5 Sonnet",
      description: "Modelo padrão legado do CRM.",
    },
  ],
  hermes: [
    {
      id: "nousresearch/hermes-3-llama-3.1-405b",
      label: "Hermes 3 Llama 3.1 405B",
      description: "Modelo Hermes via OpenRouter.",
    },
  ],
};

/**
 * Defaults do provider quando nem o nó nem a conta definem modelo.
 *
 * Mantemos os mesmos defaults que o runtime usava antes desta feature
 * para que adicionar o seletor não altere silenciosamente a produção.
 */
export const DEFAULT_MODEL_BY_PROVIDER: Record<AiProvider, string> = {
  openai: "gpt-4o-mini",
  gemini: "gemini-1.5-flash",
  claude: "claude-3-5-sonnet-20241022",
  hermes: "nousresearch/hermes-3-llama-3.1-405b",
};

export function isAiProvider(value: unknown): value is AiProvider {
  return typeof value === "string" && (AI_PROVIDERS as readonly string[]).includes(value);
}

export function getAiModelsForProvider(
  provider: string | null | undefined,
): readonly AiModelDefinition[] {
  return isAiProvider(provider) ? AI_MODELS[provider] : [];
}

export function getAiModelDefinition(
  provider: string | null | undefined,
  model: string | null | undefined,
): AiModelDefinition | null {
  if (!isAiProvider(provider) || !model?.trim()) return null;
  return AI_MODELS[provider].find((candidate) => candidate.id === model.trim()) ?? null;
}

export function getProviderForModel(
  model: string | null | undefined,
): AiProvider | null {
  const normalized = model?.trim();
  if (!normalized) return null;
  for (const provider of AI_PROVIDERS) {
    if (AI_MODELS[provider].some((candidate) => candidate.id === normalized)) {
      return provider;
    }
  }
  return null;
}

export function isModelCompatibleWithProvider(
  model: string | null | undefined,
  provider: string | null | undefined,
): boolean {
  if (!model?.trim() || !isAiProvider(provider)) return false;
  return AI_MODELS[provider].some((candidate) => candidate.id === model.trim());
}

export interface ResolveAiModelInput {
  provider: string;
  nodeModel?: string | null;
  accountModel?: string | null;
}

export interface ResolvedAiModel {
  model: string;
  source: "node" | "account" | "provider_default";
}

/**
 * Prioridade:
 *   modelo do nó -> modelo da conta -> default do provider.
 *
 * O caller deve rejeitar explicitamente um nodeModel incompatível antes
 * de chamar esta função. accountModel inválido é ignorado com fallback
 * seguro porque configurações antigas não podem derrubar todos os fluxos.
 */
export function resolveAiModel({
  provider,
  nodeModel,
  accountModel,
}: ResolveAiModelInput): ResolvedAiModel | null {
  if (!isAiProvider(provider)) return null;

  const normalizedNode = nodeModel?.trim();
  if (normalizedNode && isModelCompatibleWithProvider(normalizedNode, provider)) {
    return { model: normalizedNode, source: "node" };
  }

  const normalizedAccount = accountModel?.trim();
  if (normalizedAccount && isModelCompatibleWithProvider(normalizedAccount, provider)) {
    return { model: normalizedAccount, source: "account" };
  }

  return {
    model: DEFAULT_MODEL_BY_PROVIDER[provider],
    source: "provider_default",
  };
}

export function aiProviderLabel(provider: string | null | undefined): string {
  switch (provider) {
    case "openai":
      return "OpenAI";
    case "gemini":
      return "Google Gemini";
    case "claude":
      return "Anthropic Claude";
    case "hermes":
      return "OpenRouter / Hermes";
    default:
      return "Provider não configurado";
  }
}
