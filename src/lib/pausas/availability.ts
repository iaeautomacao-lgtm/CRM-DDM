// Disponibilidade para a distribuição AUTOMÁTICA (decisão do dono 15/10): quem está em pausa NÃO recebe conversa nova. É regra do núcleo da
// distribuição — vale para todas as contas, sem chave e sem fluxo — e este é o ÚNICO critério de pausa usado por toda auto-atribuição:
// selectAgentForTeam / selectAnyAgentForAccount (fila e retry-assignment, round-robin de equipe, handoff_team do motor, transbordo, handoff da IA),
// o menu "escolha seu atendente" (listOnlineAgents), o handoff para atendente fixo/escolhido e o handoff da IA para o dono da linha.
// O espelho no banco é wacrm.is_agent_available (migration 371: online E sem pausa aberta). Aqui entra só a metade "sem pausa": a metade
// "online" continua sendo a régua de presença que cada ponto já aplica.
//
// Fail-closed: sem conseguir ler as pausas (erro que não seja "a migration 370 ainda não existe"), TODOS os candidatos contam como pausados —
// a conversa fica na fila e o retry tenta de novo em minutos; nunca se entrega a quem pode estar em pausa. Sem a 370 não há pausa nenhuma.
import type { SupabaseClient } from "@supabase/supabase-js";

type Db = Pick<SupabaseClient, "from">;

const isMissingTable = (e: { code?: string } | null | undefined) => e?.code === "42P01" || e?.code === "PGRST205";

/** Quais dos usuários têm uma pausa aberta agora. */
export async function pausedAgentIds(db: Db, userIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Set();
  try {
    const { data, error } = await db.from("agent_pauses").select("user_id").in("user_id", ids).is("ended_at", null);
    if (error) {
      if (isMissingTable(error)) return new Set();
      console.error("[pausas] falha ao ler as pausas; ninguém será atribuído nesta rodada:", error.message ?? "erro");
      return new Set(ids);
    }
    return new Set(((data ?? []) as Array<{ user_id: string }>).map((r) => r.user_id));
  } catch (err) {
    console.error("[pausas] falha ao ler as pausas; ninguém será atribuído nesta rodada:", err instanceof Error ? err.message : "erro");
    return new Set(ids);
  }
}

/** Candidatos SEM os pausados, na mesma ordem. */
export async function filterAvailableAgents<T extends string>(db: Db, userIds: readonly T[]): Promise<T[]> {
  if (userIds.length === 0) return [];
  const paused = await pausedAgentIds(db, userIds);
  return userIds.filter((id) => !paused.has(id));
}

export async function isAgentPaused(db: Db, userId: string): Promise<boolean> {
  return (await pausedAgentIds(db, [userId])).has(userId);
}

/**
 * Início da pausa ABERTA de cada um (mesmo critério de "em pausa": ended_at IS NULL, uma por atendente — índice único parcial da 370).
 * Diferente de pausedAgentIds, NÃO é fail-closed: quem usa isto para ENCERRAR algo (expiração da reserva do @operador) não pode agir no escuro, então
 * erro de leitura devolve null ("não sei") e o chamador não faz nada. Sem a migration 370 não há pausa nenhuma (mapa vazio).
 */
export async function openPauseStarts(db: Db, userIds: readonly string[]): Promise<Map<string, string> | null> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Map();
  try {
    const { data, error } = await db.from("agent_pauses").select("user_id, started_at").in("user_id", ids).is("ended_at", null);
    if (error) return isMissingTable(error) ? new Map() : null;
    return new Map(((data ?? []) as Array<{ user_id: string; started_at: string }>).map((r) => [r.user_id, r.started_at]));
  } catch {
    return null;
  }
}
