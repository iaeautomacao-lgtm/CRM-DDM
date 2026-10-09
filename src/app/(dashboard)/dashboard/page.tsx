"use client"

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { apiFetch } from '@/lib/api-fetch'
import { usePermission } from '@/hooks/use-permission'
import {
  loadActivity,
  loadConversationsSeries,
  loadMetrics,
  loadConversationsStatusDonut,
  loadResponseTime,
  loadAiAnalytics,
} from '@/lib/dashboard/queries'
import type {
  ActivityItem,
  ConversationsSeriesPoint,
  MetricsBundle,
  ConversationsStatusData,
  ResponseTimeSummary,
  AiAnalyticsData,
} from '@/lib/dashboard/types'
import { updatedLabel } from '@/lib/dashboard/view'

import { MetricCard } from '@/components/dashboard/metric-card'
import { QuickActions } from '@/components/dashboard/quick-actions'
import { ConversationsChart, type RangeDays } from '@/components/dashboard/conversations-chart'
import { StatusPanel, type QueueNow } from '@/components/dashboard/status-panel'
import { ResponseTimeChart } from '@/components/dashboard/response-time-chart'
import { ActivityFeed } from '@/components/dashboard/activity-feed'
import { AiPerformance } from '@/components/dashboard/ai-performance'
import { FinancialPerformance } from '@/components/dashboard/financial-performance'
import { ErrorState } from '@/components/dashboard/error-state'
import { cn } from '@/lib/utils'

// Seções carregadas por loadAll — usadas para rastrear quais falharam
// e oferecer "Tentar novamente" em vez de skeletons eternos.
type DashboardSection = 'metrics' | 'series' | 'status' | 'responseTime' | 'activity' | 'ai'

const EMPTY_SERIES: Record<RangeDays, ConversationsSeriesPoint[] | null> = { 7: null, 30: null, 90: null }

export default function DashboardPage() {
  const [metrics, setMetrics] = useState<MetricsBundle | null>(null)
  const [range, setRange] = useState<RangeDays>(30)
  const [series, setSeries] = useState(EMPTY_SERIES)
  const [statusData, setStatusData] = useState<ConversationsStatusData | null>(null)
  const [responseTime, setResponseTime] = useState<ResponseTimeSummary | null>(null)
  const [activity, setActivity] = useState<ActivityItem[] | null>(null)
  const [ai, setAi] = useState<AiAnalyticsData | null>(null)
  const [queue, setQueue] = useState<QueueNow | null>(null)

  const [pending, setPending] = useState<Set<DashboardSection>>(
    () => new Set(['metrics', 'series', 'status', 'responseTime', 'activity', 'ai']),
  )
  const [failed, setFailed] = useState<Set<DashboardSection>>(() => new Set())
  const [updatedAt, setUpdatedAt] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())
  const [spin, setSpin] = useState(0)
  // Geração da carga: respostas de uma carga antiga (Atualizar clicado no
  // meio) não sobrescrevem a nova.
  const gen = useRef(0)

  const canSeeQueue = usePermission('monitoring.view_team')

  const track = useCallback(
    <T,>(section: DashboardSection, p: Promise<T>, set: (v: T) => void, g: number): Promise<boolean> =>
      p
        .then((v) => {
          if (gen.current === g) set(v)
          return true
        })
        .catch((err) => {
          console.error(`[dashboard] ${section} failed:`, err)
          if (gen.current === g) setFailed((prev) => new Set(prev).add(section))
          return false
        })
        .finally(() => {
          if (gen.current !== g) return
          setPending((prev) => {
            const next = new Set(prev)
            next.delete(section)
            return next
          })
        }),
    [],
  )

  // Só dispara as buscas (os setState acontecem nas respostas). Quem
  // recarrega zera o estado antes, num handler: ver reloadAll.
  const loadAll = useCallback(
    (r: RangeDays) => {
      const g = ++gen.current
      const db = createClient()
      return Promise.all([
        track('metrics', loadMetrics(db), setMetrics, g),
        track('series', loadConversationsSeries(db, r), (s) => setSeries((prev) => ({ ...prev, [r]: s })), g),
        track('status', loadConversationsStatusDonut(db), setStatusData, g),
        track('responseTime', loadResponseTime(db), setResponseTime, g),
        track('activity', loadActivity(db, 50), setActivity, g),
        track('ai', loadAiAnalytics(db), setAi, g),
      ]).then((results) => {
        if (gen.current === g) setUpdatedAt(Date.now())
        return results.every(Boolean)
      })
    },
    [track],
  )

  useEffect(() => {
    void loadAll(30)
  }, [loadAll])

  // Fila sem atendente (mesma fonte do Monitoramento). Só para quem tem
  // monitoring.view_team; sem a permissão o aviso some do layout.
  const loadQueue = useCallback(() => {
    if (!canSeeQueue) return
    apiFetch('/api/monitoramento/sla?days=1')
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = (await res.json()) as { total?: { queued?: number; longestWaitMin?: number | null } }
        setQueue({ queued: body.total?.queued ?? 0, longestWaitMin: body.total?.longestWaitMin ?? null })
      })
      .catch(() => setQueue(null))
  }, [canSeeQueue])

  useEffect(() => {
    loadQueue()
  }, [loadQueue])

  // Relógio para "Atualizado há N min" e o tempo relativo do feed.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(id)
  }, [])

  const reloadAll = useCallback(
    (r: RangeDays) => {
      setFailed(new Set())
      setPending(new Set(['metrics', 'series', 'status', 'responseTime', 'activity', 'ai']))
      setSeries(EMPTY_SERIES)
      return loadAll(r)
    },
    [loadAll],
  )

  const refresh = useCallback(() => {
    setSpin((s) => s + 360)
    loadQueue()
    void reloadAll(range).then((ok) => {
      setNow(Date.now())
      if (ok) toast.success('Dados atualizados')
    })
  }, [reloadAll, loadQueue, range])

  const handleRangeChange = useCallback(
    (r: RangeDays) => {
      setRange(r)
      if (series[r] !== null) return
      const g = gen.current
      setPending((prev) => new Set(prev).add('series'))
      setFailed((prev) => {
        const next = new Set(prev)
        next.delete('series')
        return next
      })
      void track(
        'series',
        loadConversationsSeries(createClient(), r),
        (s) => setSeries((prev) => ({ ...prev, [r]: s })),
        g,
      )
    },
    [series, track],
  )

  const loading = (s: DashboardSection) => pending.has(s)
  const retry = () => void reloadAll(range)

  return (
    <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-5 pb-12">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="m-0 text-[15px] font-semibold text-foreground">Operação agora</h2>
          <p suppressHydrationWarning className="m-0 text-[12.5px] text-muted-foreground">
            Atualizado {updatedLabel(updatedAt, now)} · comparação com ontem
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={refresh}
            disabled={pending.size > 0}
            title="Atualizar dados"
            className="inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[6px] border border-border bg-card px-2.5 text-[12.5px] font-medium text-foreground-2 transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-60"
          >
            <span
              className="flex transition-transform duration-[600ms] ease-out motion-reduce:transition-none"
              style={{ transform: `rotate(${spin}deg)` }}
            >
              <RefreshCw className="size-3.5" aria-hidden="true" />
            </span>
            Atualizar
          </button>
          <QuickActions />
        </div>
      </div>

      {failed.has('metrics') ? (
        <ErrorState className="min-h-0" title="Não foi possível carregar os indicadores" onRetry={retry} />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(230px,1fr))] gap-3">
          <MetricCard
            title="Conversas ativas"
            href="/inbox"
            loading={loading('metrics') || !metrics}
            value={metrics?.activeConversations.current ?? 0}
            delta={metrics?.activeConversations.previous ?? 0}
            higherIsBetter
            note="novas hoje vs ontem"
          />
          <MetricCard
            title="Conversas pendentes"
            href="/inbox"
            loading={loading('metrics') || !metrics}
            value={metrics?.pendingConversations.current ?? 0}
            delta={metrics?.pendingConversations.previous ?? 0}
            higherIsBetter={false}
            note="novas hoje vs ontem"
          />
          <MetricCard
            title="Resolvidas hoje"
            href="/inbox"
            loading={loading('metrics') || !metrics}
            value={metrics?.resolvedConversationsToday.current ?? 0}
            delta={
              (metrics?.resolvedConversationsToday.current ?? 0) -
              (metrics?.resolvedConversationsToday.previous ?? 0)
            }
            higherIsBetter
            note="vs ontem"
          />
          <MetricCard
            title="Mensagens enviadas hoje"
            href="/inbox"
            loading={loading('metrics') || !metrics}
            value={metrics?.messagesSentToday.current ?? 0}
            delta={(metrics?.messagesSentToday.current ?? 0) - (metrics?.messagesSentToday.previous ?? 0)}
            higherIsBetter
            note="vs ontem"
          />
        </div>
      )}

      <Row>
        {failed.has('series') ? (
          <Failed className="flex-[2_1_560px]" title="Não foi possível carregar o movimento de conversas" onRetry={retry} />
        ) : (
          <ConversationsChart
            series={series}
            loading={loading('series')}
            range={range}
            onRangeChange={handleRangeChange}
          />
        )}
        {failed.has('status') ? (
          <Failed className="flex-[1_1_300px]" title="Não foi possível carregar a situação atual" onRetry={retry} />
        ) : (
          <StatusPanel data={statusData} loading={loading('status')} queue={canSeeQueue ? queue : null} />
        )}
      </Row>

      <Row>
        {failed.has('ai') ? (
          <Failed className="flex-[2_1_560px]" title="Não foi possível carregar a recuperação financeira" onRetry={retry} />
        ) : (
          <FinancialPerformance data={ai} loading={loading('ai')} />
        )}
        {failed.has('responseTime') ? (
          <Failed className="flex-[1_1_300px]" title="Não foi possível carregar o tempo de resposta" onRetry={retry} />
        ) : (
          <ResponseTimeChart data={responseTime} loading={loading('responseTime')} />
        )}
      </Row>

      <Row>
        {failed.has('ai') ? (
          <Failed className="flex-[1_1_300px]" title="Não foi possível carregar o desempenho da IA" onRetry={retry} />
        ) : (
          <AiPerformance data={ai} loading={loading('ai')} />
        )}
        {failed.has('activity') ? (
          <Failed className="flex-[2_1_560px]" title="Não foi possível carregar a atividade recente" onRetry={retry} />
        ) : (
          <ActivityFeed items={activity} loading={loading('activity')} nowMs={now} />
        )}
      </Row>
    </div>
  )
}

function Row({ children }: { children: ReactNode }) {
  return <div className="ddm-stagger-blocks flex flex-wrap gap-3">{children}</div>
}

function Failed({ title, onRetry, className }: { title: string; onRetry: () => void; className?: string }) {
  return <ErrorState className={cn('min-w-0 rounded-[10px]', className)} title={title} onRetry={onRetry} />
}
