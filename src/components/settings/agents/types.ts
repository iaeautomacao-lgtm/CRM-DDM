import type { AgentConfig, AgentComposition } from '@/lib/ai/agents/schema';
import type { AiAgentTool } from '@/lib/flows/types';

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
  /** Esquema dos argumentos (usado pelo "Testar" da aba Ferramentas). */
  parameters?: AiAgentTool['parameters'];
}

export interface KnowledgeBaseFileItem {
  id: string;
  name: string;
  created_at: string;
  mime_type?: string | null;
  size_bytes?: number | null;
  /** Caracteres do texto extraído (conta para o teto da base do agente). */
  char_count?: number | null;
  /** Índice da busca por trechos (RAG vetorial): indexed, no_key, failed, too_large, pending; null = sem índice. */
  embedding_status?: string | null;
  embedding_chunks?: number | null;
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
    /** Busca por trechos (RAG vetorial, TASK1-D). Desligada = modo atual (teto de caracteres). */
    vector: {
      enabled: boolean;
      top_k: number;
      min_similarity: number;
    };
  };
  tools: Array<{
    tool_id: string;
    enabled: boolean;
  }>;
  /** Ferramentas inline (legado, vindas do fluxo): só leitura; o servidor as preserva. Só o liga/desliga é editável. */
  legacyTools: Array<{
    name: string;
    description: string;
    method: string;
    url: string;
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
