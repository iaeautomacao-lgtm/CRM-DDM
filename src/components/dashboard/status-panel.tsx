import Link from 'next/link'
import { Clock } from 'lucide-react'
import type { ConversationsStatusData } from '@/lib/dashboard/types'
import { formatMinutes, pct } from '@/lib/dashboard/view'
import { Skeleton } from '@/components/ui/skeleton'
import { DashCard, Swatch } from './dash-card'

const STATUS_COLOR: Record<string, string> = {
  open: 'bg-success',
  pending: 'bg-warning',
}

export interface QueueNow {
  /** Conversas abertas/pendentes sem atendente (GET /api/monitoramento/sla). */
  queued: number
  longestWaitMin: number | null
}

/**
 * "Situação atual": barra empilhada das conversas em operação, linhas
 * clicáveis para o inbox e, para quem monitora a equipe, o aviso da fila
 * sem atendente com a maior espera.
 */
export function StatusPanel({
  data,
  loading,
  queue,
}: {
  data: ConversationsStatusData | null
  loading: boolean
  queue: QueueNow | null
}) {
  const total = data?.totalCount ?? 0
  return (
    <DashCard
      title="Situação atual"
      className="flex-[1_1_300px]"
      subtitle={
        loading || !data
          ? 'Carregando…'
          : `${total.toLocaleString('pt-BR')} conversa${total === 1 ? '' : 's'} em operação`
      }
    >
      {loading || !data ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-2.5 w-full rounded-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : (
        <>
          <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-surface-3">
            {total > 0 &&
              data.slices.map((s) => (
                <span
                  key={s.status}
                  title={s.label}
                  className={`${STATUS_COLOR[s.status] ?? 'bg-muted-foreground'} origin-left animate-ddm-bar transition-[width] duration-500`}
                  style={{ width: `${(s.count / total) * 100}%` }}
                />
              ))}
          </div>
          <div className="flex flex-col">
            {data.slices.map((s) => (
              <Link
                key={s.status}
                href="/inbox"
                className="-mx-2 flex items-center gap-2.5 rounded-[6px] px-2 py-2.5 text-foreground transition-colors hover:bg-surface-hover"
              >
                <Swatch className={STATUS_COLOR[s.status] ?? 'bg-muted-foreground'} />
                <span className="flex-1 text-[13px]">{s.label}</span>
                <span className="text-[13px] font-semibold tabular-nums">{s.count.toLocaleString('pt-BR')}</span>
                <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">
                  {pct(s.count, total)}%
                </span>
              </Link>
            ))}
          </div>
        </>
      )}
      {queue && queue.queued > 0 ? (
        <div className="mt-auto flex animate-ddm-fade items-center gap-2.5 rounded-lg bg-warning-soft px-3 py-2.5">
          <Clock className="size-3.5 shrink-0 text-warning" aria-hidden="true" />
          <p className="m-0 flex-1 text-[12.5px] text-foreground">
            <span className="font-semibold">
              {queue.queued.toLocaleString('pt-BR')} na fila sem atendente.
            </span>
            {queue.longestWaitMin != null ? ` Maior espera: ${formatMinutes(queue.longestWaitMin)}.` : null}
          </p>
          <Link href="/monitoramento" className="whitespace-nowrap text-[12.5px] font-semibold text-primary-text hover:underline">
            Abrir fila
          </Link>
        </div>
      ) : null}
    </DashCard>
  )
}
