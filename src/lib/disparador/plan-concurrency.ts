// Planejamento do tick com concorrência LIMITADA (AUDIT-DISPARADOR D-08).
//
// Antes o cron planejava as campanhas ativas UMA POR VEZ (auto-pausa, reserva de cadência, contagem de itens vencidos, amostra,
// reflow), ~4 idas ao banco cada: com dezenas de campanhas ativas isso gasta segundos do orçamento antes do primeiro envio. Agora até N
// campanhas são planejadas ao mesmo tempo, mas o RESULTADO sai sempre na ordem original da lista (a lista vem ordenada por
// next_batch_at, a mais atrasada primeiro): a justiça (fairness) do agendador por número não muda.
//
// N = DISPARADOR_PLAN_CONCURRENCY (padrão 4, 1..8; 1 = o comportamento serial de antes). É só leitura/escrita de planejamento no banco;
// não mexe em ritmo, limites nem concorrência de ENVIO.

export const DEFAULT_PLAN_CONCURRENCY = 4;
export const MAX_PLAN_CONCURRENCY = 8;

export function resolvePlanConcurrency(env: Record<string, string | undefined> = process.env): number {
  const raw = Number.parseInt(env.DISPARADOR_PLAN_CONCURRENCY ?? "", 10);
  if (!Number.isFinite(raw)) return DEFAULT_PLAN_CONCURRENCY;
  return Math.min(MAX_PLAN_CONCURRENCY, Math.max(1, raw));
}

/**
 * map com no máximo `limit` tarefas em voo e resultado na ORDEM de entrada. A 1ª falha para de iniciar tarefas novas e rejeita com
 * esse erro (igual ao laço serial, que parava na primeira exceção); as já iniciadas terminam sem que o resultado seja usado.
 */
export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: { error: unknown } | null = null;
  const worker = async () => {
    while (!failure) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        failure ??= { error };
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  if (failure) throw (failure as { error: unknown }).error;
  return results;
}
