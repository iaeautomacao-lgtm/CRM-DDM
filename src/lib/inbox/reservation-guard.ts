// Atribuição automática × reserva do @operador (migration 376): todo UPDATE automático de atribuição (retry-assignment, nó handoff_team do
// fluxo, travas da IA) leva .is("requested_agent_id", null). Sem isso, uma menção que chega entre a leitura e a gravação perde a reserva:
// o UPDATE só conferia assigned_agent_id IS NULL, passava, e o trigger da 376 zerava a reserva ao ver o atendente.
// Tolerante à coluna ausente (42703 / PGRST204 = a 376 ainda não foi aplicada): refaz sem o guarda, porque sem a 376 não existe reserva.

export interface GuardedResult<T> {
  data: T | null;
  error: { code?: string; message?: string } | null;
}

export const isMissingReservationColumn = (e: { code?: string } | null | undefined): boolean =>
  e?.code === "42703" || e?.code === "PGRST204";

/**
 * Roda `run(true)` (com o guarda de reserva) e, se a coluna não existir, `run(false)` (sem ele).
 * `run` monta e executa o UPDATE; quando `guard` é true, deve acrescentar `.is("requested_agent_id", null)`.
 */
export async function runUnlessReserved<T>(run: (guard: boolean) => PromiseLike<GuardedResult<T>>): Promise<GuardedResult<T>> {
  const first = await run(true);
  if (first.error && isMissingReservationColumn(first.error)) return run(false);
  return first;
}

/** O UPDATE guardado terminou sem erro e não tocou nenhuma linha: a conversa passou a ter reserva (ou sumiu) entre a leitura e a gravação. */
export function lostToReservation(result: GuardedResult<unknown[]>): boolean {
  return !result.error && (result.data ?? []).length === 0;
}
