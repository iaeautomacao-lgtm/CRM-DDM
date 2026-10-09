import type { AiAnalyticsData } from '@/lib/dashboard/types'
import { pct } from '@/lib/dashboard/view'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { DashCard, Swatch } from './dash-card'

const fmt = (n: number) => n.toLocaleString('pt-BR')

/**
 * "IA e conversão": sentimento das conversas, mensagens por autor (IA ×
 * humano) e o resultado dos negócios (ganhos, perdidos, em aberto).
 * Os dados cobrem todo o histórico da conta (loadAiAnalytics não filtra
 * período), por isso o subtítulo não fala em "últimos N dias".
 */
export function AiPerformance({ data, loading }: { data: AiAnalyticsData | null; loading: boolean }) {
  return (
    <DashCard title="IA e conversão" subtitle="Todo o histórico da organização" className="flex-[1_1_300px] gap-[18px]">
      {loading || !data ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : (
        <Body data={data} />
      )}
    </DashCard>
  )
}

function Body({ data }: { data: AiAnalyticsData }) {
  const { sentiment, messagesRatio, conversion } = data
  const sentimentRows = [
    { label: 'Positivo', value: sentiment.positive, color: 'bg-success' },
    { label: 'Neutro', value: sentiment.neutral, color: 'bg-muted-foreground' },
    { label: 'Negativo', value: sentiment.negative, color: 'bg-danger' },
    { label: 'Misto', value: sentiment.mixed, color: 'bg-warning' },
  ]
  const botPct = pct(messagesRatio.bot, messagesRatio.total)
  const humanPct = messagesRatio.total > 0 ? 100 - botPct : 0

  return (
    <>
      <div className="flex flex-col gap-2">
        <p className="m-0 text-[12.5px] font-semibold text-foreground-2">Sentimento dos clientes</p>
        {sentiment.total === 0 ? (
          <p className="m-0 text-[12.5px] text-muted-foreground">Nenhuma conversa com sentimento analisado.</p>
        ) : (
          sentimentRows.map((s) => {
            const p = pct(s.value, sentiment.total)
            return (
              <div key={s.label} className="grid grid-cols-[72px_minmax(0,1fr)_84px] items-center gap-2.5">
                <span className="text-[12.5px] text-foreground">{s.label}</span>
                <span className="h-1.5 overflow-hidden rounded-full bg-surface-3">
                  <span
                    className={cn('block h-full origin-left animate-ddm-bar rounded-full', s.color)}
                    style={{ width: `${p}%` }}
                  />
                </span>
                <span className="text-right text-[12.5px] tabular-nums text-foreground-2">
                  {fmt(s.value)} · {p}%
                </span>
              </div>
            )
          })
        )}
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex justify-between text-[12.5px]">
          <span className="font-semibold text-foreground-2">Mensagens por autor</span>
          <span className="tabular-nums text-muted-foreground">{fmt(messagesRatio.total)}</span>
        </div>
        <div className="flex h-2 gap-0.5 overflow-hidden rounded-full bg-surface-3">
          {messagesRatio.total > 0 && (
            <>
              <span className="origin-left animate-ddm-bar bg-foreground-2" style={{ width: `${botPct}%` }} />
              <span className="origin-left animate-ddm-bar bg-primary" style={{ width: `${humanPct}%` }} />
            </>
          )}
        </div>
        <div className="flex flex-wrap justify-between gap-2 text-xs tabular-nums text-foreground-2">
          <span className="inline-flex items-center gap-1.5">
            <Swatch className="bg-foreground-2" />
            IA · {fmt(messagesRatio.bot)} ({botPct}%)
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Swatch className="bg-primary" />
            Humano · {fmt(messagesRatio.human)} ({humanPct}%)
          </span>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {[
          { label: 'Ganhos', value: conversion.won, color: 'text-success' },
          { label: 'Perdidos', value: conversion.lost, color: 'text-danger' },
          { label: 'Em aberto', value: conversion.open, color: 'text-foreground' },
        ].map((c) => (
          <div key={c.label} className="flex flex-col gap-1 rounded-lg bg-surface-3 px-3 py-2.5">
            <span className="text-xs text-foreground-2">{c.label}</span>
            <span className={cn('text-lg font-semibold tabular-nums', c.color)}>{fmt(c.value)}</span>
          </div>
        ))}
      </div>
      <p className="m-0 -mt-2 text-xs text-muted-foreground">
        Taxa de fechamento: <span className="font-semibold tabular-nums text-foreground">{conversion.rate}%</span> dos negócios encerrados
      </p>
    </>
  )
}
