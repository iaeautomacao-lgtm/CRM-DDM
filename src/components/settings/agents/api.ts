import { apiFetch } from '@/lib/api-fetch';
import type { SimOutbound, SimState, SimTimelineEvent } from '@/lib/flows/simulator/types';
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

export async function fetchKnowledgeBaseFiles(): Promise<KnowledgeBaseFileItem[]> {
  try {
    const res = await apiFetch('/api/settings/agents/knowledge', { cache: 'no-store' });
    const data = await handleResponse<{ files: KnowledgeBaseFileItem[] }>(
      res,
      'Não foi possível carregar os arquivos de conhecimento.',
    );
    return data.files ?? [];
  } catch (err) {
    if (err instanceof AgentApiError) throw err;
    throw new AgentApiError(
      'Não foi possível conectar ao servidor para carregar os arquivos de conhecimento.',
      0,
    );
  }
}

/** Envia um arquivo de conhecimento (o texto é extraído no servidor). */
export async function uploadKnowledgeFile(file: File): Promise<KnowledgeBaseFileItem> {
  const body = new FormData();
  body.append('file', file);
  let res: Response;
  try {
    res = await apiFetch('/api/settings/agents/knowledge', { method: 'POST', body });
  } catch {
    throw new AgentApiError('Não foi possível conectar ao servidor para enviar o arquivo.', 0);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new AgentApiError(data?.error || 'Não foi possível enviar o arquivo.', res.status);
  return (data as { file: KnowledgeBaseFileItem }).file;
}

/** Remove um arquivo de conhecimento (409 se algum agente o usa). */
export async function removeKnowledgeFile(id: string): Promise<void> {
  let res: Response;
  try {
    res = await apiFetch(`/api/settings/agents/knowledge/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch {
    throw new AgentApiError('Não foi possível conectar ao servidor para remover o arquivo.', 0);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new AgentApiError(data?.error || 'Não foi possível remover o arquivo.', res.status);
}

export interface AgentSimulateResponse {
  state: SimState;
  outbound: SimOutbound[];
  timeline: SimTimelineEvent[];
  remaining: number;
  agent: { name: string; version: number; disabled: boolean };
  real_read_denied?: boolean;
}

/** Uma mensagem do "cliente" para o rascunho do agente (null = agente ainda não criado). Nada é salvo nem enviado. */
export async function simulateAgent(
  agentId: string | null,
  body: {
    agent: Record<string, unknown>;
    message: { kind: 'text'; text: string };
    state: SimState | null;
    toolMocks: Record<string, string>;
    realReadOnlyTools: string[];
  },
): Promise<AgentSimulateResponse> {
  let res: Response;
  try {
    res = await apiFetch(`/api/settings/agents/${agentId ? encodeURIComponent(agentId) : 'new'}/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AgentApiError('Não foi possível conectar ao servidor para testar o agente.', 0);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.state) {
    const first = data?.issues?.[0];
    const message = data?.error || 'Não foi possível testar o agente.';
    throw new AgentApiError(first ? `${message} (${first.path}: ${first.message})` : message, res.status, data?.issues);
  }
  return data as AgentSimulateResponse;
}
