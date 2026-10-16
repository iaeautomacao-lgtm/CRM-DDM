// Reserva do @operador expira para a fila (decisão do dono, 16/10): uma conversa reservada (conversations.requested_agent_id, migration 376) volta
// para a distribuição normal (dono do contato > rodízio) quando o operador reservado fica EM PAUSA ou OFFLINE por tempo demais. Roda no cron stateless
// de retry-assignment (nada em memória de processo). 30 min é constante única; não é configuração.
//
// REGRA EXATA — a reserva expira quando as DUAS condições valem AGORA:
//   (A) a reserva tem pelo menos 30 min (conversations.requested_at, migration 384; sem a coluna ou sem a data = nunca expira);
//   (B) o operador reservado está indisponível há pelo menos 30 min, por QUALQUER um dos motivos:
//       • PAUSA: tem pausa aberta (agent_pauses.ended_at IS NULL, o mesmo critério de src/lib/pausas/availability.ts) iniciada há ≥ 30 min;
//       • OFFLINE: não está presente pela régua de presença dos seletores (member_presence com status online OU away e last_seen_at nos últimos
//         75 s; 'away' conta como presente, igual ao fallback dos seletores) E o último sinal dele (last_seen_at) foi há ≥ 30 min. Sem nenhuma linha de
//         presença, ele conta como offline desde o começo da reserva.
//   Estado vivo, sem memória: quem volta antes dos 30 min (a pausa termina, ou o batimento volta) deixa de cumprir (B) e MANTÉM a reserva; a pausa só
//   conta o tempo da pausa ATUAL, e o offline só o tempo desde o último batimento.
// Quem decide e grava é este arquivo; o banco só guarda a hora de início (requested_at) e zera sozinho quando a reserva acaba.
//
// SEGURANÇA / CORRIDAS: leituras que falham (pausas, presença, conversas) = "não sei": não expira nada (nunca age no escuro). A liberação é um UPDATE com
// compare-and-set (mesmo operador reservado, ainda sem atendente, não fechada, ainda ≥ 30 min): se o operador assumiu, ou se a conversa foi re-reservada
// para outra pessoa, entre a leitura e a gravação, o UPDATE não pega nenhuma linha e nada acontece. LGPD: auditoria e log só com ids, nunca nome, telefone ou texto.
import type { SupabaseClient } from "@supabase/supabase-js";
import { openPauseStarts } from "@/lib/pausas/availability";
import { isMissingReservationColumn } from "@/lib/inbox/reservation-guard";

type Db = Pick<SupabaseClient, "from">;

/** Tempo de reserva, e de indisponibilidade do operador, antes de a reserva voltar para a fila. Constante única (não é configuração). */
export const RESERVATION_EXPIRY_MS = 30 * 60_000;
/** Mesma régua de presença dos seletores (selectAgentForTeam / owner-preference). */
export const PRESENCE_WINDOW_MS = 75_000;
/** Teto por rodada do cron (backpressure). */
const BATCH = 100;

export type ExpiryReason = "pause" | "offline";

export interface ExpiryFacts {
  now: number;
  requestedAt: string | null;
  /** started_at da pausa aberta do operador, se houver. */
  pauseStartedAt: string | null;
  /** Linha de member_presence do operador, se houver. */
  presence: { status: string | null; lastSeenAt: string | null } | null;
}

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/** Função pura da regra (ver o cabeçalho). Devolve o motivo da expiração ou null (mantém a reserva). */
export function reservationExpiryReason(f: ExpiryFacts): ExpiryReason | null {
  const requestedAt = ms(f.requestedAt);
  if (requestedAt === null) return null; // sem data de início = reserva antiga ou sem a 384: nunca expira
  if (f.now - requestedAt < RESERVATION_EXPIRY_MS) return null; // (A)

  const pauseStart = ms(f.pauseStartedAt);
  if (pauseStart !== null && f.now - pauseStart >= RESERVATION_EXPIRY_MS) return "pause"; // (B) pausa

  const lastSeen = ms(f.presence?.lastSeenAt);
  const present =
    !!f.presence && (f.presence.status === "online" || f.presence.status === "away") && lastSeen !== null && lastSeen >= f.now - PRESENCE_WINDOW_MS;
  if (present) return null;
  const offlineSince = lastSeen ?? requestedAt; // sem batimento registrado: offline desde o começo da reserva
  if (f.now - offlineSince >= RESERVATION_EXPIRY_MS) return "offline"; // (B) offline
  return null;
}

export interface ReleasedConversation {
  id: string;
  team_id: string | null;
  account_id: string;
  contact_id: string | null;
}

interface ReservedRow {
  id: string;
  team_id: string | null;
  account_id: string;
  contact_id: string | null;
  requested_agent_id: string | null;
  requested_at: string | null;
}

/**
 * Libera (requested_agent_id = NULL) as reservas que cumprem a regra e devolve as conversas liberadas, para o cron distribuí-las no MESMO tick
 * (dono do contato > rodízio). Nunca lança: qualquer falha de leitura/gravação vira "não expirou".
 */
export async function expireStaleReservations(db: Db, now: number = Date.now()): Promise<ReleasedConversation[]> {
  const cutoff = new Date(now - RESERVATION_EXPIRY_MS).toISOString();
  try {
    const { data, error } = await db
      .from("conversations")
      .select("id, team_id, account_id, contact_id, requested_agent_id, requested_at")
      .is("assigned_agent_id", null)
      .neq("status", "closed")
      .lte("requested_at", cutoff)
      .order("requested_at", { ascending: true })
      .limit(BATCH);
    if (error) {
      // 42703 / PGRST204: sem a 376/384 não há o que expirar.
      if (!isMissingReservationColumn(error)) console.error("[reserva] falha ao ler as reservas:", error.code ?? "erro");
      return [];
    }
    const rows = ((data ?? []) as unknown as ReservedRow[]).filter((r) => r.requested_agent_id && r.requested_at);
    if (rows.length === 0) return [];

    const agentIds = [...new Set(rows.map((r) => r.requested_agent_id as string))];
    const pauses = await openPauseStarts(db, agentIds);
    if (pauses === null) {
      console.error("[reserva] falha ao ler as pausas; nenhuma reserva expira nesta rodada");
      return [];
    }
    const { data: presenceRows, error: presenceError } = await db
      .from("member_presence")
      .select("user_id, status, last_seen_at")
      .in("user_id", agentIds);
    if (presenceError) {
      console.error("[reserva] falha ao ler a presença; nenhuma reserva expira nesta rodada:", presenceError.code ?? "erro");
      return [];
    }
    const presence = new Map(
      ((presenceRows ?? []) as unknown as Array<{ user_id: string; status: string | null; last_seen_at: string | null }>).map((p) => [
        p.user_id,
        { status: p.status, lastSeenAt: p.last_seen_at },
      ]),
    );

    const released: ReleasedConversation[] = [];
    for (const row of rows) {
      const agentId = row.requested_agent_id as string;
      const reason = reservationExpiryReason({
        now,
        requestedAt: row.requested_at,
        pauseStartedAt: pauses.get(agentId) ?? null,
        presence: presence.get(agentId) ?? null,
      });
      if (!reason) continue;

      // compare-and-set: só libera se NADA mudou desde a leitura (mesmo operador, sem atendente, aberta, reserva ainda velha)
      const { data: updated, error: updateError } = await db
        .from("conversations")
        .update({ requested_agent_id: null })
        .eq("id", row.id)
        .eq("requested_agent_id", agentId)
        .is("assigned_agent_id", null)
        .neq("status", "closed")
        .lte("requested_at", cutoff)
        .select("id");
      if (updateError) {
        console.error("[reserva] falha ao liberar a reserva:", updateError.code ?? "erro");
        continue;
      }
      if (!updated || updated.length === 0) continue; // o operador assumiu / fechou / foi re-reservada: nada a fazer

      console.log(`[reserva] expirada conversa=${row.id} motivo=${reason}`);
      await auditExpired(row.account_id, row.id, agentId, reason);
      released.push({ id: row.id, team_id: row.team_id, account_id: row.account_id, contact_id: row.contact_id });
    }
    return released;
  } catch (err) {
    console.error("[reserva] falha inesperada na expiração:", err instanceof Error ? err.name : "erro");
    return [];
  }
}

async function auditExpired(accountId: string, conversationId: string, agentId: string, reason: ExpiryReason): Promise<void> {
  try {
    const { logAuditEvent } = await import("@/lib/audit/log-event"); // import dinâmico: o módulo é server-only e nunca derruba o cron
    await logAuditEvent({
      accountId,
      eventType: "action",
      resourceType: "conversation",
      resourceId: conversationId,
      action: "conversation.reservation_expired",
      summary: "A reserva do @operador expirou e a conversa voltou para a fila",
      metadata: { agent_id: agentId, reason, after_minutes: RESERVATION_EXPIRY_MS / 60_000 },
    });
  } catch {
    console.error("[reserva] falha ao auditar a expiração");
  }
}
