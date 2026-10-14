// Cota diária de IA por conta (plano de segurança 13/10, Âncora item 2; migration 339). Transcrição de áudio (STT) e sugestão de
// tabulação gastam a chave de IA da conta: o teto evita que um laço ou uma enxurrada esvazie o saldo do cliente.
//   - padrão GENEROSO aqui; o teto de uma conta muda por linha em wacrm.ai_daily_quota_config (sem .env);
//   - a chamada negada não consome cota; a contagem é por dia de São Paulo (atômica na RPC consume_ai_quota);
//   - FAIL-OPEN: sem a migration (RPC ausente) ou com falha de leitura, a IA segue como antes. A cota é uma proteção de custo,
//     não pode derrubar o atendimento por falha da própria proteção.

export type AiQuotaKind = 'stt' | 'tag_suggest' | 'copilot'

/** Padrão por conta e por dia. Uso humano normal fica muito abaixo; é só o freio contra laço/abuso. */
export const DEFAULT_AI_DAILY_LIMITS: Readonly<Record<AiQuotaKind, number>> = {
  stt: 10_000,
  tag_suggest: 5_000,
  copilot: 3_000,
}

export interface AiQuotaResult {
  allowed: boolean
  used?: number
  limit?: number
}

type QuotaDb = { rpc?: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }> }

export async function consumeAiQuota(db: unknown, accountId: string, kind: AiQuotaKind): Promise<AiQuotaResult> {
  try {
    const rpc = (db as QuotaDb | null)?.rpc
    if (typeof rpc !== 'function') return { allowed: true }
    const { data, error } = await (db as { rpc: NonNullable<QuotaDb['rpc']> }).rpc('consume_ai_quota', {
      p_account: accountId,
      p_kind: kind,
      p_default_limit: DEFAULT_AI_DAILY_LIMITS[kind],
    })
    if (error) {
      // 42883/PGRST202: migration 339 ausente → sem cota (silêncio); outro erro só vai para o log.
      if (error.code !== '42883' && error.code !== 'PGRST202') console.error('[ai-quota] falha ao consumir a cota:', error.message)
      return { allowed: true }
    }
    const row = (data ?? null) as { allowed?: unknown; used?: unknown; limit?: unknown } | null
    if (!row || typeof row.allowed !== 'boolean') return { allowed: true }
    return { allowed: row.allowed, used: Number(row.used ?? 0), limit: Number(row.limit ?? 0) }
  } catch (err) {
    console.error('[ai-quota] falha inesperada:', err instanceof Error ? err.message : String(err))
    return { allowed: true }
  }
}
