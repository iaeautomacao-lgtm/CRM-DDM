// Carrega um agente (perfil) PUBLICADO para execução: versão fixada (ou a publicada
// agora), regras com texto, ferramentas efetivas (catálogo ligado + definições
// legadas) — tudo escopado pela conta. Servidor. Nunca resolve credenciais.
//
// Falha fechado: agente inexistente/de outra conta, sem versão publicada ou com
// config inválida volta como `ok: false` — quem chama trata como agente
// indisponível (saída de falha/handoff), nunca como "perfil padrão".

import type { SupabaseClient } from "@supabase/supabase-js";
import { toAiAgentTool, type ToolRow } from "@/lib/ai-tools/tool-input";
import type { AiAgentNodeConfig, AiAgentTool } from "@/lib/flows/types";
import { validateAgentConfig, type AgentComposition, type AgentConfig, type AgentRule } from "./schema";
import type { AgentRuntimeScope } from "./scope";

type Db = Pick<SupabaseClient, "from">;

export interface LoadedAgent {
  agent: { id: string; name: string; enabled: boolean };
  versionId: string;
  configHash: string;
  runtime: AgentRuntimeScope;
  /** Ferramentas efetivas (ligadas no perfil E no catálogo), na ordem do perfil. */
  tools: AiAgentTool[];
}

export type AgentLoadFailure = "not_found" | "no_version" | "invalid_config" | "load_failed";
export type AgentLoadResult = { ok: true; value: LoadedAgent } | { ok: false; reason: AgentLoadFailure; agentName?: string };

interface AgentRow {
  id: string;
  name: string;
  enabled: boolean;
  published_version_id: string | null;
}
interface VersionRow {
  id: string;
  config: unknown;
  prompt_content: string;
  composition: AgentComposition;
  config_hash: string;
}

/** Agentes da conta (id, nome, ligado) para o validador de fluxo. null = falha de leitura (não acusar). */
export async function listAccountAgents(db: Db, accountId: string): Promise<Array<{ id: string; name: string; enabled: boolean }> | null> {
  const { data, error } = await db.from("ai_agents").select("id, name, enabled").eq("account_id", accountId);
  if (error) return null;
  return (data ?? []) as Array<{ id: string; name: string; enabled: boolean }>;
}

export async function loadAgentForRun(
  db: Db,
  accountId: string,
  agentId: string,
  pinnedVersionId: string | null,
): Promise<AgentLoadResult> {
  const { data: agents, error: agentError } = await db
    .from("ai_agents")
    .select("id, name, enabled, published_version_id")
    .eq("account_id", accountId)
    .eq("id", agentId)
    .limit(1);
  if (agentError) {
    console.error("[agents] falha ao carregar o agente:", agentError.message);
    return { ok: false, reason: "load_failed" };
  }
  const agent = ((agents ?? []) as AgentRow[])[0];
  if (!agent) return { ok: false, reason: "not_found" };

  const versionId = pinnedVersionId ?? agent.published_version_id;
  if (!versionId) return { ok: false, reason: "no_version", agentName: agent.name };

  const { data: versions, error: versionError } = await db
    .from("ai_agent_versions")
    .select("id, config, prompt_content, composition, config_hash")
    .eq("account_id", accountId)
    .eq("agent_id", agentId)
    .eq("id", versionId)
    .limit(1);
  if (versionError) {
    console.error("[agents] falha ao carregar a versão do agente:", versionError.message);
    return { ok: false, reason: "load_failed", agentName: agent.name };
  }
  const version = ((versions ?? []) as VersionRow[])[0];
  if (!version) return { ok: false, reason: "no_version", agentName: agent.name };

  const parsed = validateAgentConfig(version.config);
  if (!parsed.success) {
    console.error("[agents] config inválida na versão", versionId, parsed.issues[0]?.path);
    return { ok: false, reason: "invalid_config", agentName: agent.name };
  }
  const config = parsed.data;

  const rules = await loadRules(db, accountId, config);
  const tools = await loadTools(db, accountId, config);
  if (rules === null || tools === null) return { ok: false, reason: "load_failed", agentName: agent.name };

  return {
    ok: true,
    value: {
      agent: { id: agent.id, name: agent.name, enabled: agent.enabled },
      versionId: version.id,
      configHash: version.config_hash,
      tools,
      runtime: {
        agentId: agent.id,
        versionId: version.id,
        config,
        promptContent: version.prompt_content,
        composition: version.composition,
        rules,
      },
    },
  };
}

/** Regras ligadas da versão, com o texto de ai_rule_versions. null = falha de leitura. */
async function loadRules(db: Db, accountId: string, config: AgentConfig): Promise<AgentRule[] | null> {
  const entries = config.rules;
  if (entries.length === 0) return [];
  const { data, error } = await db
    .from("ai_rule_versions")
    .select("id, content")
    .eq("account_id", accountId)
    .in("id", entries.map((r) => r.rule_version_id));
  if (error) {
    console.error("[agents] falha ao carregar as regras:", error.message);
    return null;
  }
  const byId = new Map(((data ?? []) as Array<{ id: string; content: string }>).map((r) => [r.id, r.content]));
  const rules: AgentRule[] = [];
  for (const entry of entries) {
    const content = byId.get(entry.rule_version_id);
    if (content === undefined) {
      console.error("[agents] regra da versão não encontrada:", entry.rule_version_id);
      continue;
    }
    rules.push({ content, position: entry.position, enabled: entry.enabled, version_id: entry.rule_version_id });
  }
  return rules;
}

/** Ferramentas efetivas na ordem do perfil; desligada (no perfil ou no catálogo) não entra. null = falha de leitura. */
async function loadTools(db: Db, accountId: string, config: AgentConfig): Promise<AiAgentTool[] | null> {
  const catalogIds = config.tools.filter((t) => t.enabled && t.tool_id).map((t) => t.tool_id as string);
  const catalog = new Map<string, ToolRow>();
  if (catalogIds.length > 0) {
    const { data, error } = await db
      .from("ai_tools")
      .select("id, name, description, parameters, http, timeout_ms, enabled")
      .eq("account_id", accountId)
      .in("id", catalogIds);
    if (error) {
      console.error("[agents] falha ao carregar o catálogo de ferramentas:", error.message);
      return null;
    }
    for (const row of (data ?? []) as ToolRow[]) catalog.set(row.id, row);
  }
  const out: AiAgentTool[] = [];
  const seen = new Set<string>();
  for (const entry of config.tools) {
    if (!entry.enabled) continue;
    let tool: AiAgentTool | null = null;
    if (entry.tool_id) {
      const row = catalog.get(entry.tool_id);
      if (row?.enabled) tool = toAiAgentTool(row);
    } else if (entry.definition) {
      tool = entry.definition as unknown as AiAgentTool;
    }
    if (!tool) continue;
    if (seen.has(tool.name)) {
      console.warn("[agents] nome de ferramenta duplicado no agente; usando a primeira:", tool.name);
      continue;
    }
    seen.add(tool.name);
    out.push(tool);
  }
  return out;
}

/**
 * Config efetiva do nó para um agente: o fio do fluxo (próximo nó, saída de falha…) continua no
 * nó; comportamento, prompt, modelo e ferramentas vêm do agente. Pura.
 */
export function buildBoundNodeConfig(raw: AiAgentNodeConfig, loaded: Pick<LoadedAgent, "runtime" | "tools">): AiAgentNodeConfig {
  const { config, composition, promptContent } = loaded.runtime;
  const override =
    composition === "sections_v1" ? promptContent : config.prompt.legacy_override_present ? promptContent : undefined;
  return {
    ...raw,
    mode: config.behavior.mode,
    max_turns: config.behavior.max_turns,
    herdar_contexto_anterior: config.behavior.herdar_contexto ?? false,
    model: config.llm.model ?? null,
    system_prompt_override: override,
    tools: loaded.tools,
    // O catálogo já foi resolvido pelo agente; não misturar tool_refs do nó.
    tool_refs: [],
  };
}
