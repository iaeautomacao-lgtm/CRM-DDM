import type { AgentConfig, AgentComposition } from '@/lib/ai/agents/schema';

export interface AgentListItem {
  id: string;
  name: string;
  enabled: boolean;
  published_version: {
    id: string;
    version: number;
    created_at: string;
  } | null;
  used_in_flows: number;
  updated_at: string;
}

export interface AgentVersionSummary {
  id: string;
  version: number;
  created_at: string;
  created_by_name?: string | null;
}

export interface AgentUsageItem {
  flow_id: string;
  flow_name: string;
  node_key: string;
}

export interface AgentRuleItem {
  id?: string;
  rule_version_id?: string;
  content: string;
  enabled: boolean;
  position?: number;
}

export interface AgentToolItem {
  id: string;
  name: string;
  enabled: boolean;
  /** Ligada no catálogo de ferramentas (desligada lá = o agente não a usa). */
  catalog_enabled?: boolean;
}

export interface AgentKnowledgeItem {
  selection_mode: 'legacy_account_all' | 'explicit';
  file_ids?: string[];
}

export interface AgentPublishedData {
  version_id: string;
  version: number;
  config: AgentConfig;
  prompt_content: string;
  composition: AgentComposition;
  rules: AgentRuleItem[];
  tools: AgentToolItem[];
  knowledge: AgentKnowledgeItem;
}

export interface AgentDetailResponse {
  agent: {
    id: string;
    name: string;
    enabled: boolean;
  };
  published: AgentPublishedData | null;
  versions: AgentVersionSummary[];
  used_in: AgentUsageItem[];
}

export interface SaveAgentPayload {
  name?: string;
  config: AgentConfig;
  prompt_content: string;
  composition: AgentComposition;
  rules: Array<{ content: string; enabled: boolean }>;
  tool_ids: string[];
  knowledge: {
    selection_mode: 'legacy_account_all' | 'explicit';
    file_ids?: string[];
  };
}

export interface PreviewAgentPayload {
  config: AgentConfig;
  prompt_content: string;
  composition: AgentComposition;
  rules: Array<{ content: string; enabled: boolean }>;
  knowledge: {
    selection_mode: 'legacy_account_all' | 'explicit';
    file_ids?: string[];
  };
}

export interface ToolCatalogItem {
  id: string;
  name: string;
  display_name?: string;
  description: string;
  enabled: boolean;
  host?: string;
  http?: {
    url: string;
    method: string;
  };
}

export interface KnowledgeBaseFileItem {
  id: string;
  name: string;
  created_at: string;
}

export interface SecretItem {
  id: string;
  name: string;
  kind: 'variable' | 'credential';
  last4?: string;
  description?: string;
}

export interface AgentFormData {
  name: string;
  enabled: boolean;
  prompt_content: string;
  composition: AgentComposition;
  rules: Array<{ id: string; content: string; enabled: boolean }>;
  knowledge: {
    selection_mode: 'legacy_account_all' | 'explicit';
    file_ids: string[];
    rag_external: {
      enabled: boolean;
      url: string;
      credential: string;
      top_k: number;
      timeout_ms: number;
    };
  };
  tools: Array<{
    tool_id: string;
    enabled: boolean;
  }>;
  llm: {
    provider: 'openai' | 'gemini' | 'claude' | 'hermes';
    model: string;
    temperatureUseDefault: boolean;
    temperature: number;
    maxTokensUseDefault: boolean;
    max_tokens: number;
    topPUseDefault: boolean;
    top_p: number;
    frequencyPenaltyUseDefault: boolean;
    frequency_penalty: number;
    presencePenaltyUseDefault: boolean;
    presence_penalty: number;
    reasoningEffortUseDefault: boolean;
    reasoning_effort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
    responseFormatUseDefault: boolean;
    response_format: 'text' | 'json_object' | 'json_schema';
  };
  behavior: {
    mode: 'once' | 'loop' | 'takeover';
    max_turns: number;
    herdar_contexto: boolean;
    debounce_ms: number;
    stall_seconds: number;
  };
  recovery: {
    attempt_retries: number;
    empty_reply_text: string;
    integration_failure_text: string;
    integration_failure_tag: string;
  };
  protections: {
    anti_xingamento: boolean;
    anti_loop: boolean;
    pedido_humano_contestacao: boolean;
    pessoa_errada: boolean;
  };
  execution: {
    llm_timeout_ms: number;
  };
}
