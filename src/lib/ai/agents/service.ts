import { createHash, randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { findLiteralCredential } from '@/lib/ai-tools/tool-input';
import { isModelCompatibleWithProvider } from '../models';
import { composeAgentPrompt } from './compose';
import { hashAgentVersion } from './convert';
import {
  LEGACY_AGENT_DEFAULTS,
  validateAgentConfig,
  type AgentConfig,
  type AgentConfigIssue,
  type AgentComposition,
} from './schema';

export class AgentServiceError extends Error {
  constructor(
    message: string,
    public status = 400,
    public issues?: AgentConfigIssue[]
  ) {
    super(message);
  }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Row = Record<string, unknown>;
type AgentRow = {
  id: string;
  name: string;
  enabled: boolean;
  published_version_id: string | null;
  updated_at: string;
};
type VersionRow = {
  id: string;
  agent_id: string;
  version: number;
  config: AgentConfig;
  prompt_content: string;
  composition: AgentComposition;
  created_at: string;
  created_by: string | null;
};
type FileRow = { id: string; name: string; content: string | null };
type RuleInput = { content: string; enabled: boolean };
type Knowledge = {
  selection_mode: 'legacy_account_all' | 'explicit';
  file_ids?: string[];
};
type Input = {
  name?: string;
  config: AgentConfig;
  prompt_content: string;
  composition: AgentComposition;
  rules: RuleInput[];
  tool_ids: string[];
  knowledge: Knowledge;
};
export const validAgentId = (id: string) => UUID.test(id);
function object(value: unknown): value is Row {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function fail(message: string): never {
  throw new AgentServiceError(message);
}
function ids(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 500 ||
    value.some((v) => typeof v !== 'string' || !UUID.test(v))
  )
    fail('Lista de IDs inválida.');
  const result = (value as string[]).map((v) => v.toLowerCase());
  if (new Set(result).size !== result.length) fail('IDs duplicados.');
  return result;
}
function name(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 200)
    fail('Nome obrigatório, com até 200 caracteres.');
  return value.trim();
}
function parseInput(body: unknown, creating: boolean, preview = false): Input {
  if (!object(body)) fail('Corpo da requisição inválido.');
  const allowed = new Set([
    'config',
    'prompt_content',
    'composition',
    'rules',
    'knowledge',
    ...(creating ? ['name'] : []),
    ...(preview ? [] : ['tool_ids']),
  ]);
  if (Object.keys(body).some((k) => !allowed.has(k)))
    fail('Campo desconhecido na requisição.');
  const result = validateAgentConfig(body.config);
  if (!result.success)
    throw new AgentServiceError('Configuração inválida.', 400, result.issues);
  if (
    result.data.llm.provider &&
    result.data.llm.model &&
    !isModelCompatibleWithProvider(
      result.data.llm.model,
      result.data.llm.provider
    )
  )
    fail('Modelo incompatível com o provedor.');
  if (body.composition !== 'sections_v1' && body.composition !== 'legacy_v1')
    fail('Composição inválida.');
  // legacy_v1 só existe como NOVA versão de um agente que já é legacy_v1 (conferido em publishAgent e na RPC).
  if (body.composition === 'legacy_v1' && creating)
    fail('A composição legacy_v1 só vale para nova versão de agente legacy_v1.');
  if (
    typeof body.prompt_content !== 'string' ||
    body.prompt_content.length > 200000
  )
    fail('Prompt inválido ou muito grande.');
  if (!Array.isArray(body.rules) || body.rules.length > 200)
    fail('Lista de regras inválida.');
  if (body.composition === 'legacy_v1' && body.rules.length)
    fail('legacy_v1 não aceita regras separadas; converta para prompt em seções.');
  const rules = body.rules.map((r) => {
    if (
      !object(r) ||
      Object.keys(r).some((k) => !['content', 'enabled'].includes(k)) ||
      typeof r.content !== 'string' ||
      !r.content.trim() ||
      r.content.length > 50000 ||
      typeof r.enabled !== 'boolean'
    )
      fail('Regra inválida.');
    return { content: r.content, enabled: r.enabled };
  });
  const k = body.knowledge;
  if (
    !object(k) ||
    Object.keys(k).some(
      (key) => !['selection_mode', 'file_ids'].includes(key)
    ) ||
    !['legacy_account_all', 'explicit'].includes(String(k.selection_mode))
  )
    fail('Seleção de conhecimento inválida.');
  const file_ids = k.file_ids === undefined ? [] : ids(k.file_ids);
  if (k.selection_mode === 'legacy_account_all' && file_ids.length)
    fail('Todos os arquivos não aceita seleção de IDs.');
  const platformKeys: Record<string, string[]> = {
    llm: [
      'OPENAI_API_KEY',
      'GEMINI_API_KEY',
      'OPENROUTER_API_KEY',
      'CLAUDE_API_KEY',
      'ANTHROPIC_API_KEY',
    ],
    stt: ['OPENAI_API_KEY'],
    tts: [],
    ddm: ['DDM_ACORDOS_API_TOKEN', 'DDM_TOKEN', 'DDM_API_KEY'],
  };
  for (const [slot, connection] of Object.entries(result.data.connections)) {
    if (!connection) continue;
    if (
      connection.platform_env?.some((key) => !platformKeys[slot].includes(key))
    )
      fail('Fallback de plataforma inválido para a conexão.');
    if (
      findLiteralCredential({
        url: connection.endpoint,
        headers: connection.headers,
      })
    )
      fail('Conexão contém credencial literal. Use {{cred.NOME}}.');
  }
  for (const tool of result.data.tools)
    if (tool.definition && findLiteralCredential(tool.definition.http))
      fail('Ferramenta contém credencial literal. Use {{cred.NOME}}.');
  if (findLiteralCredential({ url: result.data.knowledge.rag_external.url }))
    fail('RAG contém credencial literal na URL. Use o campo credencial.');
  return {
    ...(creating ? { name: name(body.name) } : {}),
    config: result.data,
    prompt_content: body.prompt_content,
    composition: body.composition,
    rules,
    tool_ids: preview ? [] : ids(body.tool_ids),
    knowledge: {
      selection_mode: k.selection_mode as Knowledge['selection_mode'],
      ...(k.selection_mode === 'explicit' ? { file_ids } : {}),
    },
  };
}
function dbError(error: { code?: string; message?: string } | null): void {
  if (!error) return;
  if (error.message?.includes('agent_used_in_runs'))
    throw new AgentServiceError(
      'Este agente já foi usado em conversas: desligue-o em vez de excluir.',
      409
    );
  if (error.code === '23505')
    throw new AgentServiceError('Já existe um agente com esse nome.', 409);
  if (error.code === 'P0002')
    throw new AgentServiceError('Agente ou versão não encontrado.', 404);
  if (error.code === '23503' || error.code === 'P0001')
    throw new AgentServiceError(
      'Referência inválida ou agente ainda em uso.',
      409
    );
  if (error.code === '22023' || error.code === '23514')
    throw new AgentServiceError(
      'Dados inválidos ou referência fora da conta.',
      400
    );
  throw new AgentServiceError('Não foi possível concluir a operação.', 500);
}
// Paginar também catálogos e versões: PostgREST limita resultados por requisição.
async function all<T>(
  table: string,
  columns: string,
  accountId: string,
  filters: Record<string, unknown> = {}
): Promise<T[]> {
  const result: T[] = [];
  for (let offset = 0; ; offset += 500) {
    const order =
      table === 'profiles'
        ? 'user_id'
        : table === 'ai_agent_knowledge'
          ? 'agent_version_id'
          : ['ai_agent_rules', 'ai_agent_tools'].includes(table)
            ? 'position'
            : 'id';
    let q = supabaseAdmin()
      .from(table)
      .select(columns)
      .eq('account_id', accountId)
      .order(order)
      .range(offset, offset + 499);
    for (const [key, value] of Object.entries(filters))
      q = Array.isArray(value) ? q.in(key, value) : q.eq(key, value);
    const { data, error } = await q;
    dbError(error);
    const page = (data ?? []) as T[];
    result.push(...page);
    if (page.length < 500) return result;
  }
}
async function own(accountId: string, id: string): Promise<AgentRow> {
  if (!validAgentId(id))
    throw new AgentServiceError('Agente não encontrado.', 404);
  const { data, error } = await supabaseAdmin()
    .from('ai_agents')
    .select('*')
    .eq('account_id', accountId)
    .eq('id', id)
    .limit(1);
  dbError(error);
  if (!data?.[0]) throw new AgentServiceError('Agente não encontrado.', 404);
  return data[0] as AgentRow;
}
export async function loadAgentUsage(accountId: string) {
  const flows = await all<{ id: string; name: string }>(
    'flows',
    'id,name',
    accountId
  );
  const usage = new Map<
    string,
    { flow_id: string; flow_name: string; node_key: string }[]
  >();
  for (let i = 0; i < flows.length; i += 100) {
    const chunk = flows.slice(i, i + 100);
    const names = new Map(chunk.map((f) => [f.id, f.name]));
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await supabaseAdmin()
        .from('flow_nodes')
        .select('flow_id,node_key,config')
        .eq('node_type', 'ai_agent')
        .in(
          'flow_id',
          chunk.map((f) => f.id)
        )
        .order('id')
        .range(offset, offset + 499);
      dbError(error);
      const nodes = (data ?? []) as {
        flow_id: string;
        node_key: string;
        config: { agent_id?: string } | null;
      }[];
      for (const n of nodes)
        if (typeof n.config?.agent_id === 'string') {
          const entries = usage.get(n.config.agent_id) ?? [];
          entries.push({
            flow_id: n.flow_id,
            flow_name: names.get(n.flow_id)!,
            node_key: n.node_key,
          });
          usage.set(n.config.agent_id, entries);
        }
      if (nodes.length < 500) break;
    }
  }
  return usage;
}
export async function listAgents(accountId: string) {
  const [agents, versions, usage] = await Promise.all([
    all<AgentRow>(
      'ai_agents',
      'id,name,enabled,published_version_id,updated_at',
      accountId
    ),
    all<Pick<VersionRow, 'id' | 'version' | 'created_at'>>(
      'ai_agent_versions',
      'id,version,created_at',
      accountId
    ),
    loadAgentUsage(accountId),
  ]);
  const byId = new Map(versions.map((v) => [v.id, v]));
  return {
    agents: agents
      .map(({ published_version_id, ...a }) => ({
        ...a,
        published_version: byId.get(published_version_id ?? '') ?? null,
        used_in_flows: new Set((usage.get(a.id) ?? []).map((u) => u.flow_id))
          .size,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}
async function bindings(accountId: string, versionId: string) {
  const [rules, tools, knowledge] = await Promise.all([
    all<{ rule_version_id: string; position: number; enabled: boolean }>(
      'ai_agent_rules',
      '*',
      accountId,
      { agent_version_id: versionId }
    ),
    all<{ tool_id: string; position: number; enabled: boolean }>(
      'ai_agent_tools',
      '*',
      accountId,
      { agent_version_id: versionId }
    ),
    all<Knowledge>('ai_agent_knowledge', 'selection_mode,file_ids', accountId, {
      agent_version_id: versionId,
    }),
  ]);
  const ruleVersions = await all<{ id: string; content: string }>(
    'ai_rule_versions',
    'id,content',
    accountId
  );
  const contents = new Map(ruleVersions.map((r) => [r.id, r.content]));
  const catalog = await all<{ id: string; name: string; enabled: boolean }>(
    'ai_tools',
    'id,name,enabled',
    accountId
  );
  const toolMap = new Map(catalog.map((t) => [t.id, t]));
  return {
    rules: rules
      .sort((a, b) => a.position - b.position)
      .map((r) => ({ ...r, content: contents.get(r.rule_version_id) ?? '' })),
    tools: tools
      .sort((a, b) => a.position - b.position)
      .map((t) => ({
        id: t.tool_id,
        name: toolMap.get(t.tool_id)?.name ?? '',
        enabled: t.enabled,
        catalog_enabled: toolMap.get(t.tool_id)?.enabled ?? false,
      })),
    knowledge: knowledge[0] ?? {
      selection_mode: 'legacy_account_all' as const,
    },
  };
}
export async function getAgent(accountId: string, id: string) {
  const agent = await own(accountId, id);
  const [versions, usage, authors] = await Promise.all([
    all<Pick<VersionRow, 'id' | 'version' | 'created_at' | 'created_by'>>(
      'ai_agent_versions',
      'id,version,created_at,created_by',
      accountId,
      { agent_id: id }
    ),
    loadAgentUsage(accountId),
    all<{ user_id: string; full_name: string | null }>(
      'profiles',
      'user_id,full_name',
      accountId
    ),
  ]);
  const names = new Map(authors.map((p) => [p.user_id, p.full_name]));
  const p = agent.published_version_id
    ? (
        await all<VersionRow>('ai_agent_versions', '*', accountId, {
          agent_id: id,
          id: agent.published_version_id,
        })
      )[0]
    : undefined;
  return {
    agent,
    published: p
      ? {
          version_id: p.id,
          version: p.version,
          config: p.config,
          prompt_content: p.prompt_content,
          composition: p.composition,
          ...(await bindings(accountId, p.id)),
        }
      : null,
    versions: versions
      .sort((a, b) => b.version - a.version)
      .map((v) => ({
        id: v.id,
        version: v.version,
        created_at: v.created_at,
        created_by_name: names.get(v.created_by ?? '') ?? null,
      })),
    used_in: usage.get(id) ?? [],
  };
}
async function filesFor(
  accountId: string,
  knowledge: Knowledge
): Promise<FileRow[]> {
  if (knowledge.selection_mode === 'legacy_account_all')
    return all<FileRow>('knowledge_base_files', 'id,name,content', accountId);
  const requested = knowledge.file_ids ?? [];
  const files: FileRow[] = [];
  for (let i = 0; i < requested.length; i += 100)
    files.push(
      ...(await all<FileRow>(
        'knowledge_base_files',
        'id,name,content',
        accountId,
        { id: requested.slice(i, i + 100) }
      ))
    );
  const byId = new Map(files.map((f) => [f.id, f]));
  return (knowledge.file_ids ?? []).map(
    (id) => byId.get(id) ?? fail('Arquivo inexistente ou fora da conta.')
  );
}
/**
 * Ferramentas da nova versão: as entradas inline (`definition`, vindas da conversão do fluxo) da
 * versão publicada anterior são PRESERVADAS — definição sempre a anterior (o cliente só controla o
 * `enabled`, casando por nome) e na mesma ordem relativa; só as entradas de catálogo (`tool_id`)
 * são substituídas por `tool_ids`. Inline desconhecida (não existia antes) é ignorada.
 */
function mergeTools(
  incoming: AgentConfig['tools'],
  catalog: AgentConfig['tools'],
  previous: AgentConfig['tools'] | undefined
): AgentConfig['tools'] {
  const inlineEnabled = new Map(
    incoming.filter((t) => t.definition).map((t) => [t.definition!.name, t.enabled])
  );
  const out: AgentConfig['tools'] = [];
  const pending = [...catalog];
  for (const entry of previous ?? []) {
    if (entry.definition)
      out.push({
        ...entry,
        enabled: inlineEnabled.get(entry.definition.name) ?? entry.enabled,
      });
    else if (pending.length) out.push(pending.shift()!);
  }
  return [...out, ...pending];
}
async function prepare(
  accountId: string,
  input: Input,
  previous?: VersionRow
) {
  const [files, catalog] = await Promise.all([
    filesFor(accountId, input.knowledge),
    all<{ id: string }>('ai_tools', 'id', accountId),
  ]);
  const allowed = new Set(catalog.map((t) => t.id));
  if (input.tool_ids.some((id) => !allowed.has(id)))
    fail('Ferramenta inexistente ou fora da conta.');
  const config = structuredClone(input.config);
  config.legacy.account_id = accountId;
  // Metadados de infraestrutura não ampliam SSRF nem removem as travas do engine.
  config.legacy.ssrf_allowed_hosts = (process.env.SSRF_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  config.legacy.immutable_limits = {
    ...LEGACY_AGENT_DEFAULTS.immutable_limits,
  };
  config.knowledge = {
    ...config.knowledge,
    ...input.knowledge,
    files: files.map((f) => ({
      id: f.id,
      name: f.name,
      content_hash: createHash('sha256')
        .update(JSON.stringify(f.content))
        .digest('hex'),
    })),
  };
  if (input.knowledge.selection_mode === 'legacy_account_all')
    delete config.knowledge.file_ids;
  const toggles = new Map(
    config.tools
      .filter((t) => t.tool_id)
      .map((t) => [t.tool_id!.toLowerCase(), t.enabled])
  );
  config.tools = mergeTools(
    input.config.tools,
    input.tool_ids.map((tool_id) => ({
      tool_id,
      enabled: toggles.get(tool_id) ?? true,
    })),
    previous?.config.tools
  );
  const rules = input.rules.map((r, position) => ({
    ...r,
    rule_id: randomUUID(),
    rule_version_id: randomUUID(),
    position,
  }));
  config.rules = rules.map((r) => ({
    rule_version_id: r.rule_version_id,
    position: r.position,
    enabled: r.enabled,
    content_hash: createHash('sha256').update(r.content).digest('hex'),
  }));
  return { config, rules };
}
export async function publishAgent(
  accountId: string,
  userId: string,
  body: unknown,
  agentId?: string
) {
  const agent = agentId ? await own(accountId, agentId) : null;
  const input = parseInput(body, !agentId);
  const previous = agent?.published_version_id
    ? (
        await all<VersionRow>('ai_agent_versions', '*', accountId, {
          agent_id: agent.id,
          id: agent.published_version_id,
        })
      )[0]
    : undefined;
  if (input.composition === 'legacy_v1' && previous?.composition !== 'legacy_v1')
    fail('A composição legacy_v1 só vale para nova versão de agente legacy_v1.');
  const { config, rules } = await prepare(accountId, input, previous);
  const { data, error } = await supabaseAdmin().rpc('publish_ai_agent', {
    p_account_id: accountId,
    p_created_by: userId,
    p_agent_id: agentId ?? null,
    p_name: input.name ?? null,
    p_payload: {
      config,
      prompt_content: input.prompt_content,
      composition: input.composition,
      rules,
      config_hash: hashAgentVersion({
        config,
        prompt_content: input.prompt_content,
        composition: input.composition,
      }),
    },
  });
  dbError(error);
  return data as { agent_id: string; version_id: string; version: number };
}
export async function rollbackAgent(
  accountId: string,
  userId: string,
  agentId: string,
  body: unknown
) {
  await own(accountId, agentId);
  if (
    !object(body) ||
    Object.keys(body).length !== 1 ||
    typeof body.version_id !== 'string' ||
    !UUID.test(body.version_id)
  )
    fail('Versão inválida.');
  const { data, error } = await supabaseAdmin().rpc('rollback_ai_agent', {
    p_account_id: accountId,
    p_created_by: userId,
    p_agent_id: agentId,
    p_version_id: body.version_id,
  });
  dbError(error);
  return data as { version_id: string; version: number };
}
export async function patchAgent(accountId: string, id: string, body: unknown) {
  await own(accountId, id);
  if (
    !object(body) ||
    !Object.keys(body).length ||
    Object.keys(body).some((k) => !['name', 'enabled'].includes(k))
  )
    fail('Campos inválidos.');
  const update: Row = { updated_at: new Date().toISOString() };
  if (body.name !== undefined) update.name = name(body.name);
  if (Object.hasOwn(body, 'enabled')) {
    if (typeof body.enabled !== 'boolean')
      fail('Habilitado deve ser booleano.');
    update.enabled = body.enabled;
  }
  const { data, error } = await supabaseAdmin()
    .from('ai_agents')
    .update(update)
    .eq('account_id', accountId)
    .eq('id', id)
    .select('*')
    .limit(1);
  dbError(error);
  if (!data?.length) throw new AgentServiceError('Agente não encontrado.', 404);
  return { agent: data[0] };
}
export async function deleteAgent(accountId: string, id: string) {
  await own(accountId, id);
  const { error } = await supabaseAdmin().rpc('delete_ai_agent', {
    p_account_id: accountId,
    p_agent_id: id,
  });
  dbError(error);
  return { ok: true };
}
export async function previewAgent(accountId: string, body: unknown) {
  const input = parseInput(body, false, true);
  const files = await filesFor(accountId, input.knowledge);
  return {
    system_prompt: composeAgentPrompt(input, {
      rules: input.rules.map((r, position) => ({ ...r, position })),
      kb_files: files,
    }),
  };
}
