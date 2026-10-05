// search_conversations e get_conversation_timeline — as únicas
// ferramentas que descem ao nível de conversa. search devolve só
// metadados; timeline devolve o texto das mensagens (truncado) de UMA
// conversa, depois de confirmar que ela está no escopo.

import type { SupabaseClient } from "@supabase/supabase-js";
import { firstResponseMinutes } from "../compute/conversations";
import { TAKEOVER_REASON } from "../compute/runs";
import {
  chunk,
  conversationsQuery,
  CONVERSATION_COLUMNS,
  loadAgentNames,
  loadClientNames,
  loadFlowNames,
  loadTeamNames,
  paginate,
} from "../data";
import { NotFoundError } from "../errors";
import { resolvePeriod, type PeriodInput } from "../period";
import { narrowScopeToTeam, type IntelligenceScope } from "../scope";
import { round } from "../stats";
import type { ConversationRow, ConversationStatus } from "../types";
import { periodHeader, schemaWithPeriod, TRUNCATED_NOTE, UUID_SCHEMA } from "./shared";
import { defineTool } from "./types";
import {
  asObject,
  CHANNEL_TYPES,
  CONVERSATION_STATUSES,
  optBool,
  optEnum,
  optInt,
  optUuid,
  periodField,
  reqUuid,
} from "./validate";

export const SEARCH_MAX_LIMIT = 50;
export const MESSAGE_TEXT_MAX = 500;
export const TIMELINE_MAX_MESSAGES = 500;

// ------------------------------------------------------------
// search_conversations
// ------------------------------------------------------------

export interface SearchInput {
  period: PeriodInput;
  status?: ConversationStatus;
  channel?: (typeof CHANNEL_TYPES)[number];
  team_id?: string;
  agent_id?: string;
  client_id?: string;
  has_handoff?: boolean;
  flow_id?: string;
  limit: number;
  offset: number;
}

interface RunLite {
  conversation_id: string;
  flow_id: string;
  status: string;
  end_reason: string | null;
}

/** Execuções (por conversa) para os filtros has_handoff/flow_id. */
async function runsByConversation(
  db: SupabaseClient,
  scope: IntelligenceScope,
  conversationIds: string[],
  flowId: string | undefined,
): Promise<Map<string, RunLite[]>> {
  const out = new Map<string, RunLite[]>();
  for (const part of chunk(conversationIds)) {
    const loaded = await paginate<RunLite>((a, b) => {
      let q = db
        .from("flow_runs")
        .select("id, conversation_id, flow_id, status, end_reason")
        .eq("account_id", scope.accountId)
        .in("conversation_id", part);
      if (flowId) q = q.eq("flow_id", flowId);
      return q.order("id").range(a, b);
    });
    for (const r of loaded.rows) {
      const list = out.get(r.conversation_id);
      if (list) list.push(r);
      else out.set(r.conversation_id, [r]);
    }
  }
  return out;
}

export const searchConversations = defineTool({
  name: "search_conversations",
  description:
    "Lista conversas criadas no período que batem com os filtros (status, canal, equipe, atendente, cliente, se houve transferência de fluxo para humano, fluxo). Devolve SÓ metadados (ids, status, canal, equipe, cliente, atendente, datas, minutos até a 1ª resposta) — nunca o conteúdo das mensagens; para ler uma conversa use get_conversation_timeline. Máximo 50 por chamada; pagine com offset.",
  inputSchema: schemaWithPeriod("Filtros da busca.", {
    status: { type: "string", enum: [...CONVERSATION_STATUSES] },
    channel: { type: "string", enum: [...CHANNEL_TYPES] },
    team_id: { ...UUID_SCHEMA, description: "Equipe (precisa estar no seu escopo)." },
    agent_id: { ...UUID_SCHEMA, description: "Atendente atual (user_id)." },
    client_id: { ...UUID_SCHEMA, description: "Cliente/instituição (wacrm.clients)." },
    has_handoff: {
      type: "boolean",
      description: "true = só conversas com execução de fluxo transferida para humano; false = só sem.",
    },
    flow_id: { ...UUID_SCHEMA, description: "Só conversas com execução deste fluxo." },
    limit: { type: "integer", minimum: 1, maximum: SEARCH_MAX_LIMIT, default: 20 },
    offset: { type: "integer", minimum: 0, maximum: 10_000, default: 0 },
  }),
  validate(input: unknown): SearchInput {
    const obj = asObject(input, [
      "period",
      "status",
      "channel",
      "team_id",
      "agent_id",
      "client_id",
      "has_handoff",
      "flow_id",
      "limit",
      "offset",
    ]);
    return {
      period: periodField(obj),
      status: optEnum(obj, "status", CONVERSATION_STATUSES),
      channel: optEnum(obj, "channel", CHANNEL_TYPES),
      team_id: optUuid(obj, "team_id"),
      agent_id: optUuid(obj, "agent_id"),
      client_id: optUuid(obj, "client_id"),
      has_handoff: optBool(obj, "has_handoff"),
      flow_id: optUuid(obj, "flow_id"),
      limit: optInt(obj, "limit", 1, SEARCH_MAX_LIMIT) ?? 20,
      offset: optInt(obj, "offset", 0, 10_000) ?? 0,
    };
  },
  async run(baseScope, input, ctx) {
    const scope = narrowScopeToTeam(baseScope, input.team_id);
    const period = resolvePeriod(input.period, ctx.nowMs);
    const db = ctx.db;

    const base = (withCount: boolean) => {
      let q = conversationsQuery(db, scope, CONVERSATION_COLUMNS, withCount ? { count: "exact" } : {})
        .gte("created_at", period.from)
        .lt("created_at", period.to);
      if (input.status) q = q.eq("status", input.status);
      if (input.channel) q = q.eq("channel_type", input.channel);
      if (input.agent_id) q = q.eq("assigned_agent_id", input.agent_id);
      if (input.client_id) q = q.eq("client_id", input.client_id);
      return q.order("created_at", { ascending: false }).order("id", { ascending: false });
    };

    let page: ConversationRow[];
    let total: number;
    let truncated = false;
    const runFilter = input.has_handoff !== undefined || input.flow_id !== undefined;

    if (!runFilter) {
      const { data, error, count } = await base(true).range(input.offset, input.offset + input.limit - 1);
      if (error) throw new Error(error.message);
      page = (data ?? []) as unknown as ConversationRow[];
      total = count ?? page.length;
    } else {
      const candidates = await paginate<ConversationRow>((a, b) => base(false).range(a, b));
      truncated = candidates.truncated;
      const runs = await runsByConversation(
        db,
        scope,
        candidates.rows.map((r) => r.id),
        input.flow_id,
      );
      const matches = candidates.rows.filter((r) => {
        const list = runs.get(r.id) ?? [];
        if (input.flow_id && list.length === 0) return false;
        if (input.has_handoff === undefined) return true;
        const handed = list.some((x) => x.status === "handed_off" && x.end_reason !== TAKEOVER_REASON);
        return handed === input.has_handoff;
      });
      total = matches.length;
      page = matches.slice(input.offset, input.offset + input.limit);
    }

    const [teams, clients, agents] = await Promise.all([
      loadTeamNames(db, scope, page.map((r) => r.team_id).filter((x): x is string => !!x)),
      loadClientNames(db, scope, page.map((r) => r.client_id).filter((x): x is string => !!x)),
      loadAgentNames(db, scope, page.map((r) => r.assigned_agent_id).filter((x): x is string => !!x)),
    ]);
    const mins = (r: ConversationRow) => {
      const m = firstResponseMinutes(r);
      return m === null ? null : round(m, 1);
    };

    return {
      period: periodHeader(period),
      total,
      offset: input.offset,
      limit: input.limit,
      conversations: page.map((r) => ({
        id: r.id,
        status: r.status,
        channel_type: r.channel_type ?? "whatsapp",
        team_id: r.team_id,
        team_name: r.team_id ? teams.get(r.team_id) ?? null : null,
        client_id: r.client_id,
        client_name: r.client_id ? clients.get(r.client_id) ?? null : null,
        assigned_agent_id: r.assigned_agent_id,
        agent_name: r.assigned_agent_id ? agents.get(r.assigned_agent_id) ?? null : null,
        created_at: r.created_at,
        first_response_at: r.first_response_at,
        first_response_min: mins(r),
        closed_at: r.closed_at,
      })),
      truncated,
      notes: truncated ? [TRUNCATED_NOTE] : [],
    };
  },
});

// ------------------------------------------------------------
// get_conversation_timeline
// ------------------------------------------------------------

export function truncateText(text: string | null, max = MESSAGE_TEXT_MAX): string | null {
  if (text === null || text === undefined) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

interface MessageRow {
  id: string;
  sender_type: string;
  sender_id: string | null;
  content_type: string;
  content_text: string | null;
  created_at: string;
}

interface AuditRow {
  created_at: string;
  action: string | null;
  summary: string | null;
  changes: Record<string, { before?: unknown; after?: unknown }> | null;
  user_name: string | null;
  actor_type: string | null;
}

export const getConversationTimeline = defineTool({
  name: "get_conversation_timeline",
  description:
    "Linha do tempo de UMA conversa (que precisa estar no seu escopo): mensagens em ordem (quem enviou — customer/agent/bot —, tipo e texto truncado em 500 caracteres), eventos dos fluxos (nó, ferramenta, transferência, erro), atribuições/transferências de atendente/equipe e mudanças de status. Use depois de search_conversations para entender um caso concreto.",
  inputSchema: {
    type: "object",
    description: "Conversa e limite de mensagens.",
    properties: {
      conversation_id: UUID_SCHEMA,
      message_limit: {
        type: "integer",
        minimum: 1,
        maximum: TIMELINE_MAX_MESSAGES,
        default: 200,
        description: "Quantas mensagens (as mais recentes).",
      },
    },
    required: ["conversation_id"],
    additionalProperties: false,
  },
  validate(input: unknown): { conversation_id: string; message_limit: number } {
    const obj = asObject(input, ["conversation_id", "message_limit"]);
    return {
      conversation_id: reqUuid(obj, "conversation_id"),
      message_limit: optInt(obj, "message_limit", 1, TIMELINE_MAX_MESSAGES) ?? 200,
    };
  },
  async run(scope, input, ctx) {
    const db = ctx.db;
    // 1. A conversa está no escopo? (conta + equipes do supervisor)
    const { data: convData, error: convErr } = await conversationsQuery(db, scope, `${CONVERSATION_COLUMNS}, contact_id, last_message_at`)
      .eq("id", input.conversation_id)
      .limit(1);
    if (convErr) throw new Error(convErr.message);
    const conv = (convData ?? [])[0] as unknown as (ConversationRow & { contact_id: string | null; last_message_at: string | null }) | undefined;
    if (!conv) throw new NotFoundError("Conversa não encontrada no seu escopo");

    // 2. Mensagens (as N mais recentes, devolvidas em ordem cronológica).
    const { data: msgData, error: msgErr } = await db
      .from("messages")
      .select("id, sender_type, sender_id, content_type, content_text, created_at")
      .eq("conversation_id", conv.id)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(0, input.message_limit - 1);
    if (msgErr) throw new Error(msgErr.message);
    const messages = ((msgData ?? []) as MessageRow[]).reverse();

    // 3. Execuções de fluxo da conversa e seus eventos (sem payload cru:
    //    args/resultados de API podem ter dado de cliente).
    const { data: runData, error: runErr } = await db
      .from("flow_runs")
      .select("id, flow_id, status, started_at, ended_at, end_reason")
      .eq("account_id", scope.accountId)
      .eq("conversation_id", conv.id)
      .order("started_at")
      .order("id")
      .range(0, 99);
    if (runErr) throw new Error(runErr.message);
    const runs = (runData ?? []) as Array<{
      id: string;
      flow_id: string;
      status: string;
      started_at: string;
      ended_at: string | null;
      end_reason: string | null;
    }>;
    const events =
      runs.length === 0
        ? []
        : (
            await paginate<Record<string, unknown>>(
              (a, b) =>
                db
                  .from("flow_run_events")
                  .select(
                    "id, flow_run_id, event_type, node_key, node_type, status, duration_ms, created_at, " +
                      "tool_name:payload->>tool_name, reason:payload->>reason, action:payload->>action",
                  )
                  .in(
                    "flow_run_id",
                    runs.map((r) => r.id),
                  )
                  .not("event_type", "in", "(message_sent,reply_received,node_completed)")
                  .order("id")
                  .range(a, b),
              2_000,
            )
          ).rows.sort((x, y) => String(x.created_at).localeCompare(String(y.created_at)));
    const flowNames = await loadFlowNames(db, scope, runs.map((r) => r.flow_id));

    // 4. Atribuições (migration 128).
    const { data: asgData, error: asgErr } = await db
      .from("conversation_assignments")
      .select("created_at, from_agent_id, to_agent_id, from_team_id, to_team_id, actor_id, reason")
      .eq("account_id", scope.accountId)
      .eq("conversation_id", conv.id)
      .order("created_at")
      .order("id")
      .range(0, 199);
    const assignments = asgErr ? null : (asgData ?? []);

    // 5. Mudanças de status (audit_logs v2, se disponível). Sem IP/user-agent.
    const { data: audData, error: audErr } = await db
      .from("audit_logs")
      .select("created_at, action, summary, changes, user_name, actor_type")
      .eq("account_id", scope.accountId)
      .eq("resource_type", "conversation")
      .eq("resource_id", conv.id)
      .order("created_at")
      .order("id")
      .range(0, 199);
    const statusChanges = audErr
      ? null
      : ((audData ?? []) as AuditRow[])
          .filter((a) => (a.changes && "status" in a.changes) || /status|closed|reopen/i.test(a.action ?? ""))
          .map((a) => ({
            at: a.created_at,
            from: a.changes?.status?.before ?? null,
            to: a.changes?.status?.after ?? null,
            action: a.action,
            summary: truncateText(a.summary, 200),
            by: a.user_name ?? a.actor_type ?? null,
          }));

    const ids = [
      ...messages.map((m) => m.sender_id),
      ...((assignments ?? []) as Array<Record<string, string | null>>).flatMap((a) => [
        a.from_agent_id,
        a.to_agent_id,
        a.actor_id,
      ]),
      conv.assigned_agent_id,
    ].filter((x): x is string => !!x);
    const agentNames = await loadAgentNames(db, scope, ids);

    return {
      conversation: {
        id: conv.id,
        status: conv.status,
        channel_type: conv.channel_type ?? "whatsapp",
        team_id: conv.team_id,
        client_id: conv.client_id,
        assigned_agent_id: conv.assigned_agent_id,
        agent_name: conv.assigned_agent_id ? agentNames.get(conv.assigned_agent_id) ?? null : null,
        created_at: conv.created_at,
        first_response_at: conv.first_response_at,
        closed_at: conv.closed_at,
        last_message_at: conv.last_message_at,
      },
      messages: messages.map((m) => ({
        at: m.created_at,
        sender: m.sender_type,
        sender_name: m.sender_type === "agent" && m.sender_id ? agentNames.get(m.sender_id) ?? null : null,
        type: m.content_type,
        text: truncateText(m.content_text),
      })),
      messages_limited_to: input.message_limit,
      flow_runs: runs.map((r) => ({ ...r, flow_name: flowNames.get(r.flow_id) ?? null })),
      flow_events: events,
      assignments,
      status_changes: statusChanges,
      notes: [
        ...(assignments === null ? ["Histórico de atribuição indisponível (migration 128)."] : []),
        ...(statusChanges === null ? ["Mudanças de status indisponíveis (audit_logs)."] : []),
      ],
    };
  },
});
