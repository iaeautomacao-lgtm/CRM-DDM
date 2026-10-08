// Movimentação em LOTES dos itens da fila após pausar / encerrar / retomar uma campanha (migration 184).
//
// A RPC stop/resume só troca campaigns.status (instantâneo; o claim exige campanha `em_execucao`). Os itens
// (agendado → pausado, → cancelado, pausado → agendado) são movidos por process_dispatch_campaign_moves,
// em chamadas curtas de até `batch` itens — pela rota (limitada por orçamento de tempo) e pelo cron (manutenção).
// Sem a migration 184 a RPC não existe: devolve { ok: false } e o comportamento antigo (tudo dentro do stop/resume) segue valendo.

import type { SupabaseClient } from "@supabase/supabase-js";

export const MOVES_BATCH = 5000;

export interface DrainResult {
  ok: boolean;
  moved: number;
  /** true quando parou por orçamento/limite de rodadas (ainda pode haver itens; o cron termina). */
  partial: boolean;
}

type Db = Pick<SupabaseClient, "rpc">;

/**
 * Chama a RPC repetidamente até acabar (retorno 0) ou estourar o orçamento. Nunca lança.
 * `campaignId` null = qualquer campanha com job pendente (manutenção do cron).
 */
export async function drainDispatchMoves(
  db: Db,
  campaignId: string | null,
  options: { budgetMs?: number; batch?: number; maxRounds?: number; now?: () => number } = {},
): Promise<DrainResult> {
  const budgetMs = options.budgetMs ?? 15_000;
  const batch = options.batch ?? MOVES_BATCH;
  const maxRounds = options.maxRounds ?? 200;
  const now = options.now ?? Date.now;
  const deadline = now() + budgetMs;
  let moved = 0;
  for (let round = 0; round < maxRounds; round++) {
    const { data, error } = await db.rpc("process_dispatch_campaign_moves", {
      p_campaign_id: campaignId,
      p_limit: batch,
      p_max_jobs: 10,
    });
    if (error) {
      // 184 não aplicada (função inexistente) ou falha transitória: o stop/resume já valeu; o cron tenta de novo.
      return { ok: false, moved, partial: moved > 0 };
    }
    const count = Number(data) || 0;
    moved += count;
    if (count === 0) return { ok: true, moved, partial: false };
    if (now() >= deadline) return { ok: true, moved, partial: true };
  }
  return { ok: true, moved, partial: true };
}
