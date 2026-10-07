import { apiFetch } from '@/lib/api-fetch';
import { createClient } from '@/lib/supabase/client';
import type {
  AgentDetailResponse,
  AgentListItem,
  KnowledgeBaseFileItem,
  PreviewAgentPayload,
  SaveAgentPayload,
  SecretItem,
  ToolCatalogItem,
} from './types';

export class AgentApiError extends Error {
  status: number;
  issues?: Array<{ path: string; message: string }>;

  constructor(
    message: string,
    status = 500,
    issues?: Array<{ path: string; message: string }>,
  ) {
    super(message);
    this.name = 'AgentApiError';
    this.status = status;
    this.issues = issues;
  }
}

async function handleResponse<T>(res: Response, defaultErrorMessage: string): Promise<T> {
  const data = await res.json().catch(() => null);

  if (!res.ok) {
    if (res.status === 404) {
      throw new AgentApiError('Agente não encontrado.', 404);
    }
    if (res.status === 409) {
      const msg = data?.error || 'Este agente está em uso em fluxos e não pode ser excluído.';
      throw new AgentApiError(msg, 409);
    }
    const message = data?.error || defaultErrorMessage;
    throw new AgentApiError(message, res.status, data?.issues);
  }

  return data as T;
}

export async function fetchAgents(): Promise<AgentListItem[]> {
  try {
    const res = await apiFetch('/api/settings/agents', { cache: 'no-store' });
    const data = await handleResponse<{ agents: AgentListItem[] }>(
      res,
      'Não foi possível carregar a lista de agentes.',
    );
    return data.agents ?? [];
  } catch (err) {
    if (err instanceof AgentApiError) throw err;
    throw new AgentApiError(
      'Não foi possível conectar ao servidor para carregar os agentes.',
      0,
    );
  }
}

export async function fetchAgent(id: string): Promise<AgentDetailResponse> {
  try {
    const res = await apiFetch(`/api/settings/agents/${encodeURIComponent(id)}`, {
      cache: 'no-store',
    });
    return await handleResponse<AgentDetailResponse>(
      res,
      'Não foi possível carregar os detalhes do agente.',
    );
  } catch (err) {
    if (err instanceof AgentApiError) throw err;
    throw new AgentApiError(
      'Não foi possível conectar ao servidor para carregar o agente.',
      0,
    );
  }
}

export async function createAgent(
  payload: SaveAgentPayload,
): Promise<{ agent_id: string; version_id: string }> {
  try {
    const res = await apiFetch('/api/settings/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return await handleResponse<{ agent_id: string; version_id: string }>(
      res,
      'Não foi possível criar o agente.',
    );
  } catch (err) {
    if (err instanceof AgentApiError) throw err;
    throw new AgentApiError(
      'Não foi possível conectar ao servidor para criar o agente.',
      0,
    );
  }
}

export async function createAgentVersion(
  id: string,
  payload: Omit<SaveAgentPayload, 'name'>,
): Promise<{ version_id: string; version: number }> {
  try {
    const res = await apiFetch(`/api/settings/agents/${encodeURIComponent(id)}/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return await handleResponse<{ version_id: string; version: number }>(
      res,
      'Não foi possível publicar a nova versão do agente.',
    );
  } catch (err) {
    if (err instanceof AgentApiError) throw err;
    throw new AgentApiError(
      'Não foi possível conectar ao servidor para publicar a versão.',
      0,
    );
  }
}

export async function rollbackAgentVersion(
  id: string,
  version_id: string,
): Promise<{ version_id: string; version: number }> {
  try {
    const res = await apiFetch(`/api/settings/agents/${encodeURIComponent(id)}/rollback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version_id }),
    });
    return await handleResponse<{ version_id: string; version: number }>(
      res,
      'Não foi possível restaurar a versão do agente.',
    );
  } catch (err) {
    if (err instanceof AgentApiError) throw err;
    throw new AgentApiError(
      'Não foi possível conectar ao servidor para restaurar a versão.',
      0,
    );
  }
}

export async function patchAgent(
  id: string,
  patch: { name?: string; enabled?: boolean },
): Promise<void> {
  try {
    const res = await apiFetch(`/api/settings/agents/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    await handleResponse<{ ok?: boolean }>(res, 'Não foi possível atualizar o agente.');
  } catch (err) {
    if (err instanceof AgentApiError) throw err;
    throw new AgentApiError(
      'Não foi possível conectar ao servidor para atualizar o agente.',
      0,
    );
  }
}

export async function deleteAgent(id: string): Promise<void> {
  try {
    const res = await apiFetch(`/api/settings/agents/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    await handleResponse<{ ok?: boolean }>(res, 'Não foi possível excluir o agente.');
  } catch (err) {
    if (err instanceof AgentApiError) throw err;
    throw new AgentApiError(
      'Não foi possível conectar ao servidor para excluir o agente.',
      0,
    );
  }
}

export async function previewAgentPrompt(
  payload: PreviewAgentPayload,
): Promise<{ system_prompt: string }> {
  try {
    const res = await apiFetch('/api/settings/agents/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return await handleResponse<{ system_prompt: string }>(
      res,
      'Não foi possível gerar a prévia do prompt.',
    );
  } catch (err) {
    if (err instanceof AgentApiError) throw err;
    throw new AgentApiError(
      'Não foi possível conectar ao servidor para gerar a prévia.',
      0,
    );
  }
}

export async function fetchToolsCatalog(): Promise<ToolCatalogItem[]> {
  try {
    const res = await apiFetch('/api/settings/tools', { cache: 'no-store' });
    const data = await handleResponse<{ tools: ToolCatalogItem[] }>(
      res,
      'Não foi possível carregar as ferramentas.',
    );
    return data.tools ?? [];
  } catch (err) {
    if (err instanceof AgentApiError) throw err;
    throw new AgentApiError(
      'Não foi possível conectar ao servidor para carregar as ferramentas.',
      0,
    );
  }
}

export async function fetchAccountSecrets(): Promise<SecretItem[]> {
  try {
    const res = await apiFetch('/api/settings/secrets', { cache: 'no-store' });
    const data = await handleResponse<{ secrets: SecretItem[] }>(
      res,
      'Não foi possível carregar as credenciais.',
    );
    return data.secrets ?? [];
  } catch (err) {
    if (err instanceof AgentApiError) throw err;
    throw new AgentApiError(
      'Não foi possível conectar ao servidor para carregar as credenciais.',
      0,
    );
  }
}

export async function fetchKnowledgeBaseFiles(accountId?: string | null): Promise<KnowledgeBaseFileItem[]> {
  try {
    const supabase = createClient();
    let query = supabase
      .from('knowledge_base_files')
      .select('id, name, created_at')
      .order('created_at', { ascending: false });

    if (accountId) {
      query = query.eq('account_id', accountId);
    }

    const { data, error } = await query;
    if (error) {
      console.warn('Falha ao listar arquivos da base de conhecimento via Supabase:', error.message);
      return [];
    }
    return (data as KnowledgeBaseFileItem[]) ?? [];
  } catch (err) {
    console.warn('Erro ao conectar à base de conhecimento:', err);
    return [];
  }
}
