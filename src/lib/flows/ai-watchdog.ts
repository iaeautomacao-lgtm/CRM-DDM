/* eslint-disable @typescript-eslint/no-explicit-any -- cliente admin com schema wacrm */
// Vigia de IA travada (chamado pelo cron de fluxos).
//
// Conversa com fluxo/IA ativo em que o CLIENTE foi o último a falar e
// ninguém respondeu há mais de AI_STALL_SECONDS (padrão 180 s): a IA travou
// (falha antes/depois do modelo, integração, envio, processo reiniciado
// depois da reserva da mensagem…). Antes isso só era limpo pelo timeout de
// 24 h do fluxo — o cliente ficava sem resposta.
//
// Ação: a conversa vai para a fila humana (status "pending", mantendo a
// equipe), a execução termina como handed_off/ai_response_stalled e o
// motivo fica no histórico da execução e nos logs. Só olha conversas cuja
// última mensagem do cliente tem menos de AI_STALL_MAX_MINUTES (padrão 30)
// — o acúmulo antigo não é despejado de uma vez na fila.
//
// Não é "travada" (PRD 01, C4):
//   - IA ainda trabalhando: conversations.ai_in_progress_at (heartbeat
//     gravado pelo responder, migration 152) com menos de 2 min — o pior
//     caso legítimo (debounce + várias rodadas do modelo + tools com retry)
//     passava dos 90 s antigos e a IA respondia DEPOIS do handoff;
//   - run parado em nó que não é ai_agent (botões, lista, coleta…): ali o
//     fluxo espera o cliente responder ao menu, não a IA.

import type { SupabaseClient } from "@supabase/supabase-js";
import { writeLog } from "@/lib/logger";
import { AI_HEARTBEAT_FRESH_MS, isAiHeartbeatFresh } from "@/lib/ai/heartbeat";

type Db = SupabaseClient<any, any, any>;

export const AI_STALL_REASON = "ai_response_stalled";
/** handoff_reason gravado em ai_decisions para a transferência do vigia. */
export const AI_STALL_HANDOFF_REASON = "IA_TRAVADA";

function envInt(name: string, fallback: number): number {
  const v = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export interface StallWindow {
  /** Mensagens do cliente mais NOVAS que isto ainda estão no prazo. */
  stalledBefore: string;
  /** Mensagens mais ANTIGAS que isto não são tratadas aqui. */
  notOlderThan: string;
}

export function stallWindow(now: Date = new Date()): StallWindow {
  const stallMs = envInt("AI_STALL_SECONDS", 180) * 1000;
  const maxMs = envInt("AI_STALL_MAX_MINUTES", 30) * 60_000;
  return {
    stalledBefore: new Date(now.getTime() - stallMs).toISOString(),
    notOlderThan: new Date(now.getTime() - maxMs).toISOString(),
  };
}

interface CandidateConversation {
  id: string;
  account_id: string;
  last_customer_message_at: string;
  /** Heartbeat "IA trabalhando" (ausente antes da migration 152). */
  ai_in_progress_at?: string | null;
}

const CANDIDATE_COLUMNS = "id, account_id, last_customer_message_at";

async function loadCandidates(db: Db, win: StallWindow) {
  const query = (columns: string) =>
    db
      .from("conversations")
      .select(columns)
      .eq("status", "open")
      .is("assigned_agent_id", null)
      .lt("last_customer_message_at", win.stalledBefore)
      .gt("last_customer_message_at", win.notOlderThan)
      .order("last_customer_message_at", { ascending: true })
      .limit(STALL_SCAN_LIMIT);
  const withHeartbeat = await query(`${CANDIDATE_COLUMNS}, ai_in_progress_at`);
  // Migration 152 ainda não aplicada: segue sem o heartbeat (comportamento
  // anterior) em vez de parar o vigia.
  if (withHeartbeat.error && /ai_in_progress_at/.test(withHeartbeat.error.message)) {
    return query(CANDIDATE_COLUMNS);
  }
  return withHeartbeat;
}

interface ActiveRun {
  id: string;
  flow_id: string;
  current_node_key: string | null;
}

const STALL_SCAN_LIMIT = 50;

interface StalledRow {
  conversation_id: string;
  account_id: string;
  last_customer_message_at: string;
  ai_in_progress_at: string | null;
  run_id: string;
  flow_id: string;
  current_node_key: string | null;
}

function isMissingFunction(error: { code?: string; message?: string } | null | undefined): boolean {
  return error?.code === "PGRST202" || error?.code === "42883" || /could not find the function|does not exist/i.test(error?.message ?? "");
}

/**
 * Migration 211: o banco já devolve SÓ as conversas que o vigia trata (heartbeat, resposta, run ativo e nó de IA
 * resolvidos num JOIN), ordenadas e limitadas DEPOIS dos filtros. `null` = função ausente (usa o caminho antigo).
 */
async function loadStalledViaRpc(db: Db, win: StallWindow, now: Date): Promise<StalledRow[] | null> {
  if (typeof (db as { rpc?: unknown }).rpc !== "function") return null;
  const { data, error } = await db.rpc("stalled_ai_conversations", {
    p_stalled_before: win.stalledBefore,
    p_not_older_than: win.notOlderThan,
    p_heartbeat_after: new Date(now.getTime() - AI_HEARTBEAT_FRESH_MS).toISOString(),
    p_limit: STALL_SCAN_LIMIT,
  });
  if (error) {
    if (isMissingFunction(error)) return null;
    throw new Error(`stalled_ai_conversations: ${error.message}`);
  }
  return (data ?? []) as StalledRow[];
}

/** Encerra a execução presa e leva a conversa para a fila humana. `true` se transferiu. */
async function handOff(db: Db, conv: CandidateConversation, run: ActiveRun, now: Date): Promise<boolean> {
  // Encerra a execução primeiro (guardado por status='active'): se o
  // fluxo avançou nesse meio-tempo, não mexe na conversa.
  const endedAt = new Date().toISOString();
  const { data: ended, error: endErr } = await db
    .from("flow_runs")
    .update({ status: "handed_off", ended_at: endedAt, end_reason: AI_STALL_REASON })
    .eq("id", run.id)
    .eq("status", "active")
    .select("id");
  if (endErr || !ended?.length) return false;

  await db
    .from("conversations")
    .update({ status: "pending", updated_at: endedAt })
    .eq("id", conv.id)
    .eq("status", "open");

  const waitedSeconds = Math.round(
    (now.getTime() - new Date(conv.last_customer_message_at).getTime()) / 1000,
  );
  await db.from("flow_run_events").insert({
    flow_run_id: run.id,
    event_type: "handoff",
    node_key: run.current_node_key,
    payload: { reason: AI_STALL_REASON, waited_seconds: waitedSeconds },
  });
  // Telemetria do handoff (uma linha por transferência). Best-effort:
  // falha aqui não desfaz a transferência.
  try {
    const { error: decisionErr } = await db.from("ai_decisions").insert({
      account_id: conv.account_id,
      conversation_id: conv.id,
      flow_run_id: run.id,
      flow_id: run.flow_id,
      node_key: run.current_node_key,
      decision_type: "handoff",
      decision: { waited_seconds: waitedSeconds, end_reason: AI_STALL_REASON },
      reason: AI_STALL_REASON,
      needs_human: true,
      handoff_reason: AI_STALL_HANDOFF_REASON,
      handoff_subreason: "WATCHDOG_SEM_RESPOSTA",
      ai_node: run.current_node_key,
    });
    if (decisionErr) {
      console.error("[ai-watchdog] falha ao gravar ai_decisions:", decisionErr.message);
    }
  } catch (err) {
    console.error("[ai-watchdog] falha ao gravar ai_decisions:", err);
  }
  void writeLog({
    account_id: conv.account_id,
    level: "warn",
    source: "flows",
    event: AI_STALL_REASON,
    message: "IA sem resposta ao cliente — conversa enviada para a fila humana",
    payload: {
      conversation_id: conv.id,
      flow_run_id: run.id,
      flow_id: run.flow_id,
      node_key: run.current_node_key,
      waited_seconds: waitedSeconds,
    },
  });
  return true;
}

/** Varre e transfere para humano as conversas com IA travada. Nunca lança. */
export async function sweepStalledAiConversations(db: Db, now: Date = new Date()): Promise<number> {
  const win = stallWindow(now);
  let handed = 0;
  try {
    // Caminho novo (migration 211): filtros no banco, uma consulta.
    const stalled = await loadStalledViaRpc(db, win, now);
    if (stalled) {
      for (const row of stalled) {
        const conv: CandidateConversation = {
          id: row.conversation_id,
          account_id: row.account_id,
          last_customer_message_at: row.last_customer_message_at,
          ai_in_progress_at: row.ai_in_progress_at,
        };
        // Mesma checagem de antes (defesa: o heartbeat pode ter sido renovado entre a consulta e agora).
        if (isAiHeartbeatFresh(conv.ai_in_progress_at, now)) continue;
        const run: ActiveRun = { id: row.run_id, flow_id: row.flow_id, current_node_key: row.current_node_key };
        if (await handOff(db, conv, run, now)) handed += 1;
      }
      return handed;
    }

    // Caminho antigo (sem a função): limit(50) das mais antigas e filtros em código.
    const { data: convs, error } = await loadCandidates(db, win);
    if (error) {
      console.error("[ai-watchdog] busca de conversas falhou:", error.message);
      return 0;
    }

    for (const conv of (convs ?? []) as unknown as CandidateConversation[]) {
      // IA ainda gerando a resposta (heartbeat recente): não é travada.
      if (isAiHeartbeatFresh(conv.ai_in_progress_at, now)) continue;

      // Alguém (IA, fluxo, atendente) já respondeu depois do cliente?
      const { data: replies } = await db
        .from("messages")
        .select("id")
        .eq("conversation_id", conv.id)
        .neq("sender_type", "customer")
        .gt("created_at", conv.last_customer_message_at)
        .limit(1);
      if (replies && replies.length > 0) continue;

      // Só conversas que o fluxo/IA é dono agora.
      const { data: runs } = await db
        .from("flow_runs")
        .select("id, flow_id, current_node_key")
        .eq("conversation_id", conv.id)
        .eq("status", "active")
        .limit(1);
      const run = (runs?.[0] ?? null) as ActiveRun | null;
      if (!run || !run.current_node_key) continue;

      // Só runs parados em nó de IA: em botões/lista/coleta o fluxo está
      // esperando o CLIENTE, não a IA.
      const { data: nodeRows } = await db
        .from("flow_nodes")
        .select("node_type")
        .eq("flow_id", run.flow_id)
        .eq("node_key", run.current_node_key)
        .limit(1);
      const nodeType = (nodeRows?.[0] as { node_type?: string } | undefined)?.node_type ?? null;
      if (nodeType !== "ai_agent") continue;

      if (await handOff(db, conv, run, now)) handed += 1;
    }
  } catch (err) {
    console.error("[ai-watchdog] varredura falhou:", err);
  }
  return handed;
}
