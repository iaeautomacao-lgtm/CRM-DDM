import { randomUUID } from "node:crypto";
import { safeFetch } from "@/lib/security/ssrf-guard";
import { dispatchInboundToFlows } from "../engine";
import { runWithFlowEffects } from "../effects";
import type { FlowRunRow, ParsedInbound } from "../types";
import { createMemoryDb, simNow, type SimClock, type SimRow, type SimTables } from "./memory-db";
import type { SimContext } from "./context";
import { createSimulationEffects } from "./effects";
import {
  SIM_STATE_TABLES,
  type SimRunSnapshot,
  type SimState,
  type SimTimelineEvent,
  type SimulateRequest,
  type SimulateResponse,
} from "./types";

/** Ids fixos dentro do banco em memória — nunca se confundem com linhas reais. */
export const SIM_IDS = {
  contactId: "00000000-0000-4000-8000-00000000c0a1",
  conversationId: "00000000-0000-4000-8000-00000000c0a2",
  configId: "00000000-0000-4000-8000-00000000c0a3",
} as const;

/** Dados reais lidos (só SELECT) pela rota antes de simular. */
export interface SimulationSeed {
  accountId: string;
  userId: string;
  flowId: string;
  flowName: string;
  /** Linha de ai_config da conta (fica só no servidor, nunca volta ao cliente). */
  aiConfig: Record<string, unknown> | null;
  knowledgeBase: Array<{ id?: string; name: string; content: string }>;
  teams: Array<{ id: string; name: string }>;
  /**
   * Operadores fictícios da simulação (menu "escolha seu atendente" e handoff de equipe): `online` = visto agora; `max` = teto de
   * conversas simultâneas. Só vivem no banco em memória — nada é gravado de verdade.
   */
  operators?: Array<{ user_id: string; name: string; team_id?: string | null; online?: boolean; away?: boolean; max?: number | null }>;
  /** Catálogo de ferramentas da conta (somente SELECT; sem credenciais — a tabela guarda só marcadores). */
  aiTools?: Array<Record<string, unknown>>;
  /** Variáveis (valor) e credenciais (SÓ nome e hosts — nunca value_encrypted) da conta. */
  accountSecrets?: Array<{ name: string; kind: string; value_plain: string | null; allowed_hosts: string[] | null }>;
  /**
   * Agentes (perfis) usados pelos nós do rascunho: o agente, a versão PUBLICADA agora (o simulador
   * nunca fixa versão — não há run real) e as versões de regra dessa versão. Só marcadores de
   * credencial ({{cred.X}}) — nenhum valor.
   */
  agents?: {
    agents: Array<Record<string, unknown>>;
    versions: Array<Record<string, unknown>>;
    ruleVersions: Array<Record<string, unknown>>;
  };
}

export interface SimulateDeps {
  /** fetch real para tools somente-leitura liberadas. Padrão: globalThis.fetch. */
  realFetch?: SimContext["realFetch"];
}

function emptyState(): SimState {
  return { version: 1, tables: {}, clock: 0, seq: 0 };
}

/** Monta o banco em memória: estado do cliente + rascunho + dados da conta. */
function buildTables(req: SimulateRequest, seed: SimulationSeed, state: SimState, clock: SimClock): SimTables {
  const tables: SimTables = {};
  for (const name of SIM_STATE_TABLES) {
    const rows = state.tables[name];
    tables[name] = Array.isArray(rows) ? (JSON.parse(JSON.stringify(rows)) as SimRow[]) : [];
  }
  const now = simNow(clock);
  // Rascunho do editor, sempre o mais recente (editar entre mensagens vale).
  tables.flows = [
    {
      id: seed.flowId,
      account_id: seed.accountId,
      user_id: seed.userId,
      name: seed.flowName,
      status: "active",
      trigger_type: req.draft.trigger_type,
      trigger_config: req.draft.trigger_config ?? {},
      entry_node_id: req.draft.entry_node_id,
      fallback_policy: req.draft.fallback_policy ?? {},
      created_at: now,
    },
  ];
  tables.flow_nodes = req.draft.nodes.map((n) => ({
    id: randomUUID(),
    flow_id: seed.flowId,
    node_key: n.node_key,
    node_type: n.node_type,
    config: n.config ?? {},
    created_at: now,
  }));
  tables.whatsapp_config = [
    {
      id: SIM_IDS.configId,
      account_id: seed.accountId,
      provider: req.provider,
      // Vínculo da linha ao fluxo = "começa em qualquer mensagem" (findEntryFlow).
      flow_id: req.ignoreTrigger ? seed.flowId : null,
    },
  ];
  tables.ai_config = seed.aiConfig ? [JSON.parse(JSON.stringify(seed.aiConfig)) as SimRow] : [];
  tables.knowledge_base_files = seed.knowledgeBase.map((f) => ({ ...f, account_id: seed.accountId }));
  tables.teams = seed.teams.map((t) => ({ ...t, account_id: seed.accountId }));
  const operators = seed.operators ?? [];
  tables.profiles = operators.map((o) => ({ user_id: o.user_id, account_id: seed.accountId, account_role: "agent", full_name: o.name, max_simultaneous_chats: o.max ?? null }));
  tables.team_members = operators.filter((o) => o.team_id).map((o) => ({ user_id: o.user_id, team_id: o.team_id, created_at: new Date(0).toISOString() }));
  tables.member_presence = operators
    .filter((o) => o.online || o.away)
    .map((o) => ({ user_id: o.user_id, account_id: seed.accountId, status: o.online ? "online" : "away", last_seen_at: new Date().toISOString() }));
  tables.ai_tools = (seed.aiTools ?? []).map((t) => ({ ...(JSON.parse(JSON.stringify(t)) as SimRow), account_id: seed.accountId }));
  const withAccount = (r: Record<string, unknown>) => ({
    ...(JSON.parse(JSON.stringify(r)) as SimRow),
    account_id: seed.accountId,
  });
  tables.ai_agents = (seed.agents?.agents ?? []).map(withAccount);
  tables.ai_agent_versions = (seed.agents?.versions ?? []).map(withAccount);
  tables.ai_rule_versions = (seed.agents?.ruleVersions ?? []).map(withAccount);
  // Vínculos por run: sempre vazios (stateless) — o motor fixa a publicada na própria simulação.
  tables.flow_run_agent_bindings = [];
  tables.account_secrets = (seed.accountSecrets ?? []).map((r) => ({
    name: r.name,
    kind: r.kind,
    value_plain: r.kind === "variable" ? r.value_plain : null,
    value_encrypted: null,
    allowed_hosts: r.allowed_hosts,
    account_id: seed.accountId,
  }));
  if (!tables.contacts.some((c) => c.id === SIM_IDS.contactId)) {
    tables.contacts.push({
      id: SIM_IDS.contactId,
      account_id: seed.accountId,
      name: req.contact.name,
      phone: req.contact.phone,
      created_at: now,
    });
  }
  if (!tables.conversations.some((c) => c.id === SIM_IDS.conversationId)) {
    tables.conversations.push({
      id: SIM_IDS.conversationId,
      account_id: seed.accountId,
      contact_id: SIM_IDS.contactId,
      status: "open",
      channel_type: "whatsapp",
      assigned_agent_id: null,
      team_id: null,
      created_at: now,
    });
  }
  return tables;
}

function toParsedInbound(req: SimulateRequest, id: string): ParsedInbound {
  if (req.message.kind === "interactive_reply") {
    return {
      kind: "interactive_reply",
      reply_id: req.message.reply_id,
      reply_title: req.message.reply_title,
      meta_message_id: id,
      message_id: id,
    };
  }
  return { kind: "text", text: req.message.text, meta_message_id: id, message_id: id };
}

function teamLabel(teams: SimulationSeed["teams"], teamId: unknown): string | null {
  if (typeof teamId !== "string" || !teamId) return null;
  return teams.find((t) => t.id === teamId)?.name ?? teamId;
}

/**
 * Linha do tempo desta mensagem a partir do que o motor gravou no banco
 * em memória (flow_run_events / ai_decisions) + as notas do simulador.
 */
export function buildTimeline(
  newEvents: SimRow[],
  newDecisions: SimRow[],
  notes: SimTimelineEvent[],
  teams: SimulationSeed["teams"],
  /** Resultados brutos do turno (flow_run_tool_results): o evento tool_result só carrega o resumo. */
  newToolResults: SimRow[] = [],
): { timeline: SimTimelineEvent[]; path: string[] } {
  const timeline: SimTimelineEvent[] = [...notes];
  const rawResults = [...newToolResults];
  const path: string[] = [];
  for (const ev of newEvents) {
    const at = String(ev.created_at ?? "");
    const nodeKey = (ev.node_key as string | null) ?? null;
    const payload = (ev.payload ?? {}) as Record<string, unknown>;
    const output = (payload.output ?? {}) as Record<string, unknown>;
    switch (ev.event_type) {
      case "node_completed": {
        if (nodeKey && path[path.length - 1] !== nodeKey) path.push(nodeKey);
        timeline.push({ at, type: "node", node_key: nodeKey, label: `${ev.node_type ?? "nó"} · ${nodeKey}`, detail: output });
        if (typeof output.chosen_branch === "string") {
          timeline.push({
            at,
            type: "branch",
            node_key: nodeKey,
            label: `Ramo: ${output.chosen_branch === "fallback" ? "padrão (nenhum ramo casou)" : output.chosen_branch} → ${output.advancing_to ?? "—"}`,
            detail: output.conditions_evaluated,
          });
        }
        if (typeof output.branch_chosen === "string" && ev.node_type === "condition") {
          timeline.push({ at, type: "branch", node_key: nodeKey, label: `Condição: ${output.branch_chosen} → ${output.advancing_to ?? "—"}` });
        }
        if (typeof output.ai_exit_code === "string" && output.ai_exit_code) {
          timeline.push({ at, type: "tag", node_key: nodeKey, label: `Tag da IA: ${output.ai_exit_code}`, detail: { exit_reason: output.exit_reason } });
        }
        break;
      }
      case "tool_called":
        timeline.push({ at, type: "tool_call", node_key: nodeKey, label: `Tool chamada: ${payload.tool_name}`, detail: payload.args });
        break;
      case "tool_result":
        timeline.push({
          at,
          type: "tool_result",
          node_key: nodeKey,
          label: `Resultado de ${payload.tool_name}${ev.status === "error" ? " (erro)" : ""}`,
          // Eventos novos não trazem o corpo: o simulador mostra o bruto (dados fictícios) da tabela fechada.
          detail:
            payload.result ??
            (() => {
              const i = rawResults.findIndex((r) => r.tool_name === payload.tool_name);
              return i >= 0 ? rawResults.splice(i, 1)[0].result : undefined;
            })(),
        });
        break;
      case "node_error":
        timeline.push({ at, type: "error", node_key: nodeKey, label: `Erro: ${ev.error_message ?? "falha no nó"}`, detail: payload });
        break;
      case "run_completed":
      case "run_error":
        timeline.push({
          at,
          type: "run_end",
          node_key: nodeKey,
          label: `Execução encerrada: ${payload.run_status ?? ""} (${payload.end_reason ?? ""})`,
        });
        break;
      default:
        break;
    }
  }
  for (const d of newDecisions) {
    if (d.decision_type !== "handoff") continue;
    const decision = (d.decision ?? {}) as Record<string, unknown>;
    const team = teamLabel(teams, decision.team_id);
    timeline.push({
      at: String(d.created_at ?? ""),
      type: "handoff",
      node_key: (d.node_key as string | null) ?? null,
      label: `Iria para ${team ? `a equipe ${team}` : "atendimento humano"} — motivo ${d.handoff_reason ?? "?"}${d.handoff_subreason ? ` / ${d.handoff_subreason}` : ""}`,
      detail: decision,
    });
  }
  timeline.sort((a, b) => a.at.localeCompare(b.at));
  return { timeline, path };
}

/**
 * Processa UMA mensagem do "cliente" no motor real (dispatchInboundToFlows)
 * com os efeitos de simulação. Stateless: entra o estado do cliente, sai o
 * estado novo.
 */
export async function simulateTurn(
  req: SimulateRequest,
  seed: SimulationSeed,
  deps: SimulateDeps = {},
): Promise<Omit<SimulateResponse, "remaining">> {
  const state = req.state ?? emptyState();
  const clock: SimClock = { last: Number.isFinite(state.clock) ? state.clock : 0 };
  const tables = buildTables(req, seed, state, clock);
  const before = {
    events: tables.flow_run_events.length,
    decisions: tables.ai_decisions.length,
    toolResults: tables.flow_run_tool_results.length,
  };

  const initialVars = { ...req.contact.vars };
  const db = createMemoryDb({
    tables,
    clock,
    defaults: {
      flow_runs: (c) => {
        const now = simNow(c);
        return {
          vars: initialVars,
          reprompt_count: 0,
          hops_count: 0,
          started_at: now,
          last_advanced_at: now,
          ended_at: null,
          end_reason: null,
          last_prompt_message_id: null,
          wake_at: null,
          debounce_until: null,
        };
      },
      messages: (c) => ({ received_at: simNow(c) }),
    },
    rpc: {
      // Debounce do ai_agent: o simulador não espera (sleep é no-op) e
      // a mesma chamada relê o valor que gravou → prossegue.
      bump_ai_agent_debounce: (args, t, c) => {
        const run = (t.flow_runs ?? []).find((r) => r.id === args.p_run_id);
        const deadline = simNow(c);
        if (run) run.debounce_until = deadline;
        return deadline;
      },
      increment_flow_execution_count: () => null,
      claim_ai_reply: () => true,
      release_ai_reply: () => true,
    },
  });

  const seq = { value: Number.isFinite(state.seq) ? state.seq : 0 };
  const ctx: SimContext = {
    accountId: seed.accountId,
    conversationId: SIM_IDS.conversationId,
    provider: req.provider,
    db,
    tables,
    clock,
    outbound: [],
    notes: [],
    toolMocks: req.toolMocks ?? {},
    realReadOnlyTools: req.realReadOnlyTools ?? [],
    httpMocks: req.httpMocks ?? {},
    realFetch:
      deps.realFetch ??
      // Leitura real das tools liberadas também passa pelo guard anti-SSRF (#98).
      ((input, init, options) =>
        safeFetch(
          String(input),
          {
            method: init?.method,
            headers: init?.headers,
            body: typeof init?.body === "string" ? init.body : undefined,
          },
          { timeoutMs: 30_000, maxBytes: 1024 * 1024, failOnCrossOriginRedirect: options?.failOnCrossOriginRedirect },
        )),
    seq,
  };

  // A mensagem do cliente entra na conversa como o webhook faria.
  seq.value += 1;
  const inboundId = `sim-in-${seq.value}`;
  const isFirstInboundMessage = !tables.messages.some((m) => m.sender_type === "customer");
  const text = req.message.kind === "text" ? req.message.text : req.message.reply_title;
  const at = simNow(clock);
  tables.messages.push({
    id: `sim-msg-in-${seq.value}`,
    conversation_id: SIM_IDS.conversationId,
    account_id: seed.accountId,
    sender_type: "customer",
    content_type: req.message.kind === "text" ? "text" : "interactive",
    content_text: text,
    message_id: inboundId,
    created_at: at,
    received_at: at,
  });

  const effects = createSimulationEffects(ctx);
  const dispatch = await runWithFlowEffects(effects, () =>
    dispatchInboundToFlows({
      accountId: seed.accountId,
      userId: seed.userId,
      contactId: SIM_IDS.contactId,
      conversationId: SIM_IDS.conversationId,
      configId: SIM_IDS.configId,
      message: toParsedInbound(req, inboundId),
      isFirstInboundMessage,
    }),
  );

  const { timeline, path } = buildTimeline(
    tables.flow_run_events.slice(before.events),
    tables.ai_decisions.slice(before.decisions),
    ctx.notes,
    seed.teams,
    tables.flow_run_tool_results.slice(before.toolResults),
  );
  if (!dispatch.consumed) {
    timeline.push({
      at: simNow(clock),
      type: "note",
      node_key: null,
      label:
        dispatch.outcome === "no_match"
          ? "Nenhum fluxo assumiu a mensagem (gatilho não casou, execução encerrada ou conversa com humano)"
          : `Mensagem não consumida pelo fluxo (${dispatch.outcome})`,
    });
  }

  const runs = (tables.flow_runs as unknown as FlowRunRow[]).filter((r) => r.contact_id === SIM_IDS.contactId);
  const latest = runs[runs.length - 1] ?? null;
  const run: SimRunSnapshot | null = latest
    ? {
        id: latest.id,
        status: latest.status,
        current_node_key: latest.current_node_key,
        vars: latest.vars ?? {},
        end_reason: latest.end_reason,
      }
    : null;

  const nextState: SimState = { version: 1, tables: {}, clock: clock.last, seq: seq.value };
  for (const name of SIM_STATE_TABLES) nextState.tables[name] = tables[name] ?? [];

  return {
    state: nextState,
    outbound: ctx.outbound,
    timeline,
    run,
    path,
    dispatch: { consumed: dispatch.consumed, outcome: dispatch.outcome ?? "no_match" },
  };
}
