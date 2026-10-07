// Converte nós ai_agent legados (configuração inline) em agentes de Configurações → Agentes.
//
//   npx tsx scripts/convert-ai-nodes-to-agents.mjs            # dry-run (padrão): só relata
//   npx tsx scripts/convert-ai-nodes-to-agents.mjs --apply    # grava agentes/versões e preenche agent_id
//   opções: --account <uuid>  limita a uma conta
//
// - Usa src/lib/ai/agents/convert.ts (por isso roda via tsx) e deduplica por hash dentro da conta;
//   uma versão já existente com o mesmo config_hash é reaproveitada (script idempotente).
// - Só preenche `agent_id` em fluxos SEM runs ativos (active/paused_by_agent); os demais são listados
//   como pulados — rode de novo quando esvaziarem.
// - Nós com credencial literal/ferramenta com segredo não são convertidos (migrar para o cofre antes).
// - Nunca imprime segredo: só ids, nomes de fluxo/nó e a mensagem de erro do conversor.

import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync } from "node:fs";

for (const file of [".env.local", ".env.production.local", ".env.production", ".env"]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[m[1]] = value;
  }
}

const PAGE = 1000;
const ACTIVE_RUN_STATUSES = ["active", "paused_by_agent"];

async function fetchAll(build) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

/**
 * Planeja a conversão. Pura em relação ao banco (recebe linhas já lidas) — usada pelo teste.
 * rows: { accounts: Map<accountId, aiConfig>, flows, nodes, activeFlowIds:Set, kb: Map<accountId, files[]> }
 */
export function planConversion(rows, convert, envSnapshot = {}) {
  const { convertAiAgentNode, deduplicateAgents } = convert;
  const flowsById = new Map(rows.flows.map((f) => [f.id, f]));
  const plan = { items: [], skipped: [], errors: [] };
  const byAccount = new Map();
  for (const node of rows.nodes) {
    const flow = flowsById.get(node.flow_id);
    if (!flow) continue;
    if (node.config?.agent_id) continue; // já vinculado
    const label = `${flow.name ?? flow.id} / ${node.node_key}`;
    if (rows.activeFlowIds.has(flow.id)) {
      plan.skipped.push({ flow_id: flow.id, node_key: node.node_key, label, reason: "fluxo com runs ativos" });
      continue;
    }
    const account = rows.accounts.get(flow.account_id);
    if (!account) {
      plan.errors.push({ flow_id: flow.id, node_key: node.node_key, label, reason: "conta sem ai_config" });
      continue;
    }
    try {
      const converted = convertAiAgentNode(node.config ?? {}, account, {
        node_key: node.node_key,
        kb_files: rows.kb.get(flow.account_id) ?? [],
        env: envSnapshot,
      });
      const list = byAccount.get(flow.account_id) ?? [];
      list.push({ flow, node, label, converted });
      byAccount.set(flow.account_id, list);
    } catch (err) {
      plan.errors.push({
        flow_id: flow.id,
        node_key: node.node_key,
        label,
        reason: err instanceof Error ? err.message : "erro de conversão",
      });
    }
  }
  for (const [accountId, list] of byAccount) {
    const { profiles, profile_indexes } = deduplicateAgents(list.map((i) => i.converted));
    const profileItems = profiles.map((profile, index) => ({
      account_id: accountId,
      hash: profile.hash,
      profile,
      name: `Agente migrado ${index + 1} (${profile.hash.slice(0, 8)})`,
      nodes: [],
    }));
    list.forEach((item, i) => {
      profileItems[profile_indexes[i]].nodes.push({ flow_id: item.flow.id, node_key: item.node.node_key, label: item.label });
    });
    plan.items.push(...profileItems);
  }
  return plan;
}

function summarize(plan, apply) {
  const lines = [];
  lines.push(`Modo: ${apply ? "APPLY" : "DRY-RUN (nada será gravado)"}`);
  const nodeCount = plan.items.reduce((n, i) => n + i.nodes.length, 0);
  lines.push(`Agentes a criar/reaproveitar (após dedupe por hash): ${plan.items.length} para ${nodeCount} nó(s).`);
  for (const item of plan.items) {
    lines.push(`  - ${item.name} [conta ${item.account_id}] hash=${item.hash.slice(0, 12)} ← ${item.nodes.map((n) => n.label).join("; ")}`);
  }
  lines.push(`Pulados (runs ativos): ${plan.skipped.length}`);
  for (const s of plan.skipped) lines.push(`  - ${s.label}: ${s.reason}`);
  lines.push(`Não convertidos: ${plan.errors.length}`);
  for (const e of plan.errors) lines.push(`  - ${e.label}: ${e.reason}`);
  return lines.join("\n");
}

async function applyPlan(db, plan) {
  let created = 0;
  let reused = 0;
  let linked = 0;
  for (const item of plan.items) {
    const { data: existing, error: existingError } = await db
      .from("ai_agent_versions")
      .select("id, agent_id")
      .eq("account_id", item.account_id)
      .eq("config_hash", item.hash)
      .limit(1);
    if (existingError) throw new Error(existingError.message);
    let agentId = existing?.[0]?.agent_id;
    if (agentId) {
      reused += 1;
    } else {
      const { data: agentRows, error: agentError } = await db
        .from("ai_agents")
        .insert({ account_id: item.account_id, name: item.name, enabled: item.profile.enabled })
        .select("id")
        .limit(1);
      if (agentError || !agentRows?.[0]) throw new Error(agentError?.message ?? "falha ao criar agente");
      agentId = agentRows[0].id;
      const { data: versionRows, error: versionError } = await db
        .from("ai_agent_versions")
        .insert({
          account_id: item.account_id,
          agent_id: agentId,
          version: 1,
          config: item.profile.config,
          prompt_content: item.profile.prompt_content,
          composition: item.profile.composition,
          config_hash: item.hash,
        })
        .select("id")
        .limit(1);
      if (versionError || !versionRows?.[0]) throw new Error(versionError?.message ?? "falha ao criar versão");
      const versionId = versionRows[0].id;
      const { error: kbError } = await db
        .from("ai_agent_knowledge")
        .insert({ account_id: item.account_id, agent_version_id: versionId, selection_mode: "legacy_account_all", file_ids: null });
      if (kbError) throw new Error(kbError.message);
      const { error: publishError } = await db
        .from("ai_agents")
        .update({ published_version_id: versionId })
        .eq("account_id", item.account_id)
        .eq("id", agentId);
      if (publishError) throw new Error(publishError.message);
      created += 1;
    }
    for (const n of item.nodes) {
      const { data: nodeRows, error: nodeError } = await db
        .from("flow_nodes")
        .select("id, config")
        .eq("flow_id", n.flow_id)
        .eq("node_key", n.node_key)
        .limit(1);
      if (nodeError || !nodeRows?.[0]) throw new Error(nodeError?.message ?? "nó não encontrado");
      const { error: updateError } = await db
        .from("flow_nodes")
        .update({ config: { ...nodeRows[0].config, agent_id: agentId } })
        .eq("id", nodeRows[0].id);
      if (updateError) throw new Error(updateError.message);
      linked += 1;
    }
  }
  return { created, reused, linked };
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  if (apply && args.includes("--dry-run")) throw new Error("Use --dry-run OU --apply, não os dois.");
  const accIdx = args.indexOf("--account");
  const onlyAccount = accIdx >= 0 ? args[accIdx + 1] : undefined;
  if (accIdx >= 0 && !onlyAccount) throw new Error("--account exige um uuid.");

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios.");
  const db = createClient(url, key, { auth: { persistSession: false }, db: { schema: "wacrm" } });
  const convert = await import("../src/lib/ai/agents/convert.ts");

  const flows = await fetchAll(() => {
    const q = db.from("flows").select("id, name, account_id").order("id");
    return onlyAccount ? q.eq("account_id", onlyAccount) : q;
  });
  const flowIds = flows.map((f) => f.id);
  const nodes = [];
  for (let i = 0; i < flowIds.length; i += 100) {
    const chunk = flowIds.slice(i, i + 100);
    nodes.push(...(await fetchAll(() => db.from("flow_nodes").select("id, flow_id, node_key, config").eq("node_type", "ai_agent").in("flow_id", chunk).order("id"))));
  }
  const activeFlowIds = new Set();
  for (let i = 0; i < flowIds.length; i += 100) {
    const chunk = flowIds.slice(i, i + 100);
    const runs = await fetchAll(() => db.from("flow_runs").select("id, flow_id").in("flow_id", chunk).in("status", ACTIVE_RUN_STATUSES).order("id"));
    for (const r of runs) activeFlowIds.add(r.flow_id);
  }
  const accountIds = [...new Set(flows.map((f) => f.account_id))];
  const accounts = new Map();
  const kb = new Map();
  for (const accountId of accountIds) {
    const { data: cfg, error } = await db.from("ai_config").select("*").eq("account_id", accountId).limit(1);
    if (error) throw new Error(error.message);
    if (cfg?.[0]) accounts.set(accountId, { ...cfg[0], account_id: accountId });
    const files = await fetchAll(() => db.from("knowledge_base_files").select("id, name, content").eq("account_id", accountId).order("id"));
    kb.set(accountId, files);
  }

  const plan = planConversion({ accounts, flows, nodes, activeFlowIds, kb }, convert, process.env);
  console.log(summarize(plan, apply));
  if (!apply) {
    console.log("\nDry-run concluído. Rode com --apply para gravar.");
    return;
  }
  const result = await applyPlan(db, plan);
  console.log(`\nAplicado: ${result.created} agente(s) criado(s), ${result.reused} reaproveitado(s), ${result.linked} nó(s) vinculado(s).`);
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (isMain) {
  main().catch((err) => {
    console.error("Falha:", err instanceof Error ? err.message : "erro desconhecido");
    process.exit(1);
  });
}
