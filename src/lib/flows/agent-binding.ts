// Binding nó de IA → agente (perfil) + snapshot por run (Fase 4).
//
//  - snapshotRunAgentBindings: ao iniciar um run, fixa a versão publicada de TODOS os
//    nós ai_agent do fluxo que têm `agent_id` (tabela flow_run_agent_bindings, migration 179).
//  - resolveBoundAiNode: devolve a config efetiva do nó. Sem `agent_id`: o nó como está
//    (comportamento atual intacto, zero consulta). Com `agent_id`: a versão FIXADA no run
//    (ou, se o run não tem snapshot — webchat/runs antigos —, a publicada agora, fixada
//    nesse momento). Agente desligado/inexistente/sem versão válida ⇒ `disabled`: quem
//    chama segue pela saída de falha/handoff, nunca trava o run.
//
// Não toca truncagem nem hasRunLeftNodeSnapshot do engine.

import type { SupabaseClient } from "@supabase/supabase-js";
import { buildBoundNodeConfig, loadAgentForRun, type LoadedAgent } from "@/lib/ai/agents/runtime";
import type { AgentRuntimeScope } from "@/lib/ai/agents/scope";
import type { AiAgentNodeConfig, FlowNodeRow, FlowRunRow } from "./types";

type Db = Pick<SupabaseClient, "from">;

export type AgentDisabledReason = "agent_disabled" | "agent_not_found" | "agent_unavailable";

export interface ResolvedAiNode {
  cfg: AiAgentNodeConfig;
  /** Escopo do agente para o responder (null = nó inline/legado). */
  runtime: AgentRuntimeScope | null;
  /** Preenchido quando o agente não pode responder: seguir pela saída de falha/handoff. */
  disabled: { reason: AgentDisabledReason; agentName?: string } | null;
  agentId: string | null;
  agentVersionId: string | null;
}

const TABLE_MISSING = /flow_run_agent_bindings|42P01|does not exist/i;

function boundAgentId(config: unknown): string | null {
  const id = (config as { agent_id?: unknown } | null)?.agent_id;
  return typeof id === "string" && id ? id : null;
}

/** Fixa a versão publicada de cada nó vinculado do fluxo neste run. Nunca lança. */
export async function snapshotRunAgentBindings(
  db: Db,
  run: Pick<FlowRunRow, "id" | "flow_id" | "account_id">,
  nodes: Iterable<Pick<FlowNodeRow, "node_key" | "node_type" | "config">>,
): Promise<{ pinned: number; skipped: number }> {
  let pinned = 0;
  let skipped = 0;
  try {
    const bound: Array<{ node_key: string; agent_id: string }> = [];
    for (const node of nodes) {
      const agentId = node.node_type === "ai_agent" ? boundAgentId(node.config) : null;
      if (agentId) bound.push({ node_key: node.node_key, agent_id: agentId });
    }
    for (const item of bound) {
      const ok = await pinPublishedVersion(db, run, item.node_key, item.agent_id);
      if (ok) pinned += 1;
      else skipped += 1;
    }
  } catch (err) {
    console.error("[agents] falha ao fixar a versão dos agentes do run:", err instanceof Error ? err.message : err);
  }
  return { pinned, skipped };
}

/** Insere o vínculo com a versão publicada AGORA (idempotente). true = vínculo existe/foi criado. */
async function pinPublishedVersion(
  db: Db,
  run: Pick<FlowRunRow, "id" | "flow_id" | "account_id">,
  nodeKey: string,
  agentId: string,
): Promise<boolean> {
  const loaded = await loadAgentForRun(db, run.account_id, agentId, null);
  if (!loaded.ok) return false;
  const { error } = await db.from("flow_run_agent_bindings").upsert(
    {
      run_id: run.id,
      account_id: run.account_id,
      flow_id: run.flow_id,
      node_key: nodeKey,
      agent_id: agentId,
      agent_version_id: loaded.value.versionId,
      config_hash: loaded.value.configHash,
    },
    // Já fixado: o existente vence (snapshot nunca muda).
    { onConflict: "run_id,node_key", ignoreDuplicates: true },
  );
  if (error) {
    if (!TABLE_MISSING.test(error.message)) console.error("[agents] falha ao gravar o vínculo do run:", error.message);
    return false;
  }
  return true;
}

async function readPinnedVersion(db: Db, runId: string, nodeKey: string, agentId: string): Promise<string | null> {
  const { data, error } = await db
    .from("flow_run_agent_bindings")
    .select("agent_id, agent_version_id")
    .eq("run_id", runId)
    .eq("node_key", nodeKey)
    .limit(1);
  if (error) return null;
  const row = ((data ?? []) as Array<{ agent_id: string; agent_version_id: string }>)[0];
  // Se o nó passou a apontar para OUTRO agente depois do snapshot, o vínculo antigo não vale.
  return row && row.agent_id === agentId ? row.agent_version_id : null;
}

export async function resolveBoundAiNode(
  db: Db,
  run: Pick<FlowRunRow, "id" | "flow_id" | "account_id">,
  node: Pick<FlowNodeRow, "node_key" | "config">,
): Promise<ResolvedAiNode> {
  const raw = node.config as unknown as AiAgentNodeConfig;
  const agentId = boundAgentId(node.config);
  if (!agentId) return { cfg: raw, runtime: null, disabled: null, agentId: null, agentVersionId: null };

  let versionId = await readPinnedVersion(db, run.id, node.node_key, agentId);
  if (!versionId) {
    // Run sem snapshot (webchat, run antigo, tabela ainda não migrada): fixa a publicada agora.
    await pinPublishedVersion(db, run, node.node_key, agentId);
    versionId = await readPinnedVersion(db, run.id, node.node_key, agentId);
  }

  const loaded = await loadAgentForRun(db, run.account_id, agentId, versionId);
  if (!loaded.ok) {
    const reason: AgentDisabledReason = loaded.reason === "not_found" ? "agent_not_found" : "agent_unavailable";
    return { cfg: raw, runtime: null, disabled: { reason, agentName: loaded.agentName }, agentId, agentVersionId: versionId };
  }
  return bound(raw, loaded.value);
}

function bound(raw: AiAgentNodeConfig, loaded: LoadedAgent): ResolvedAiNode {
  const base = { cfg: buildBoundNodeConfig(raw, loaded), runtime: loaded.runtime, agentId: loaded.agent.id, agentVersionId: loaded.versionId };
  // Desligado: não responde (liga/desliga é do agente, vale na hora — também para runs em andamento).
  if (!loaded.agent.enabled) return { ...base, disabled: { reason: "agent_disabled", agentName: loaded.agent.name } };
  return { ...base, disabled: null };
}
