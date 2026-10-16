"use client"

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { useApiSWR, useScopedSWR } from '@/lib/swr'
import { usePermission } from '@/hooks/use-permission'
import { useAuth } from '@/hooks/use-auth'
import {
  loadActivity,
  loadConversationsSeries,
  loadMetrics,
  loadConversationsStatusDonut,
  loadResponseTime,
  loadAiAnalytics,
} from '@/lib/dashboard/queries'
import type {
  ConversationsSeriesPoint,
} from '@/lib/dashboard/types'
import { updatedLabel } from '@/lib/dashboard/view'

import { MetricCard as MetricCardBase } from '@/components/dashboard/metric-card'
import { QuickActions as QuickActionsBase } from '@/components/dashboard/quick-actions'
import { ConversationsChart as ConversationsChartBase, type RangeDays } from '@/components/dashboard/conversations-chart'
import { StatusPanel as StatusPanelBase, type QueueNow } from '@/components/dashboard/status-panel'
import { ResponseTimeChart as ResponseTimeChartBase } from '@/components/dashboard/response-time-chart'
import { ActivityFeed as ActivityFeedBase } from '@/components/dashboard/activity-feed'
import { AiPerformance as AiPerformanceBase } from '@/components/dashboard/ai-performance'
import { FinancialPerformance as FinancialPerformanceBase } from '@/components/dashboard/financial-performance'
import { ErrorState } from '@/components/dashboard/error-state'
import { cn } from '@/lib/utils'
import { PageBody } from '@/components/ddm/page-toolbar'

// O relógio da página ("Atualizado há…") re-renderiza a cada 15 s: os cartões só redesenham quando os próprios dados mudam.
const MetricCard = memo(MetricCardBase)
const QuickActions = memo(QuickActionsBase)
const StatusPanel = memo(StatusPanelBase)
const ResponseTimeChart = memo(ResponseTimeChartBase)
const ActivityFeed = memo(ActivityFeedBase)
const AiPerformance = memo(AiPerformanceBase)
const FinancialPerformance = memo(FinancialPerformanceBase)
const ConversationsChart = memo(ConversationsChartBase)

// Seções carregadas por loadAll — usadas para rastrear quais falharam
// e oferecer "Tentar novamente" em vez de skeletons eternos.
type DashboardSection = 'metrics' | 'series' | 'status' | 'responseTime' | 'activity' | 'ai'

const EMPTY_SERIES: Record<RangeDays, ConversationsSeriesPoint[] | null> = { 7: null, 30: null, 90: null }

export default function DashboardPage() {
  const [range, setRange] = useState<RangeDays>(30)
  const [updatedAt, setUpdatedAt] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())
  const [spin, setSpin] = useState(0)
  const [refreshing, setRefreshing] = useState(false)

  const canSeeQueue = usePermission('monitoring.view_team')
  // Conta atual só para o feed de atividade usar o índice por conta.
  const { accountId } = useAuth()

  // Cache entre navegações (SWR em memória, chave por conta+usuário — ver src/lib/swr).
  // Voltar ao Painel mostra o último resultado na hora e revalida em segundo plano.
  const errorCount = useRef(0)
  const swrOptions = {
    onSuccess: () => setUpdatedAt(Date.now()),
    onError: (err: unknown) => {
      errorCount.current += 1
      console.error('[dashboard] falha ao carregar seção:', err)
    },
  }
  const metricsQ = useScopedSWR('dashboard.metrics', [], () => loadMetrics(createClient()), swrOptions)
  const seriesQ = useScopedSWR('dashboard.series', [range], () => loadConversationsSeries(createClient(), range), swrOptions)
  const statusQ = useScopedSWR('dashboard.status', [], () => loadConversationsStatusDonut(createClient()), swrOptions)
  const responseTimeQ = useScopedSWR('dashboard.response-time', [], () => loadResponseTime(createClient()), swrOptions)
  const activityQ = useScopedSWR('dashboard.activity', [], () => loadActivity(createClient(), 50, accountId), swrOptions)
  const aiQ = useScopedSWR('dashboard.ai', [], () => loadAiAnalytics(createClient()), swrOptions)
  // Fila sem atendente (mesma fonte do Monitoramento). Só para quem tem
  // monitoring.view_team; sem a permissão o aviso some do layout.
  const queueQ = useApiSWR<{ total?: { queued?: number; longestWaitMin?: number | null } }>(
    '/api/monitoramento/sla?days=1',
    { enabled: canSeeQueue },
  )

  const metrics = metricsQ.data ?? null
  const series = useMemo<Record<RangeDays, ConversationsSeriesPoint[] | null>>(
    () => ({ ...EMPTY_SERIES, [range]: seriesQ.data ?? null }),
    [range, seriesQ.data],
  )
  const statusData = statusQ.data ?? null
  const responseTime = responseTimeQ.data ?? null
  const activity = activityQ.data ?? null
  const ai = aiQ.data ?? null
  const queue = useMemo<QueueNow | null>(
    () =>
      queueQ.data
        ? { queued: queueQ.data.total?.queued ?? 0, longestWaitMin: queueQ.data.total?.longestWaitMin ?? null }
        : null,
    [queueQ.data],
  )

  const sections: Record<DashboardSection, { isLoading: boolean; error?: Error; data: unknown }> = {
    metrics: metricsQ,
    series: seriesQ,
    status: statusQ,
    responseTime: responseTimeQ,
    activity: activityQ,
    ai: aiQ,
  }
  // Só vira erro de tela se não há nem dado antigo para mostrar.
  const failed = (s: DashboardSection) => sections[s].error !== undefined && sections[s].data === undefined
  const loading = (s: DashboardSection) => sections[s].isLoading

  // Relógio para "Atualizado há N min" e o tempo relativo do feed.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(id)
  }, [])

  const reloadAll = useCallback(async () => {
    const before = errorCount.current
    await Promise.all([
      metricsQ.mutate(),
      seriesQ.mutate(),
      statusQ.mutate(),
      responseTimeQ.mutate(),
      activityQ.mutate(),
      aiQ.mutate(),
      queueQ.mutate(),
    ])
    return errorCount.current === before
  }, [metricsQ, seriesQ, statusQ, responseTimeQ, activityQ, aiQ, queueQ])

  const refresh = useCallback(() => {
    setSpin((s) => s + 360)
    setRefreshing(true)
    void reloadAll()
      .then((ok) => {
        setNow(Date.now())
        if (ok) toast.success('Dados atualizados')
      })
      .finally(() => setRefreshing(false))
  }, [reloadAll])

  const handleRangeChange = useCallback((r: RangeDays) => setRange(r), [])

  const retry = () => void reloadAll()

  return (
    <PageBody className="gap-5">
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
            disabled={refreshing || Object.keys(sections).some((s) => loading(s as DashboardSection))}
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

      {failed('metrics') ? (
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
        {failed('series') ? (
          <Failed className="flex-[2_1_560px]" title="Não foi possível carregar o movimento de conversas" onRetry={retry} />
        ) : (
          <ConversationsChart
            series={series}
            loading={loading('series')}
            range={range}
            onRangeChange={handleRangeChange}
          />
        )}
        {failed('status') ? (
          <Failed className="flex-[1_1_300px]" title="Não foi possível carregar a situação atual" onRetry={retry} />
        ) : (
          <StatusPanel data={statusData} loading={loading('status')} queue={canSeeQueue ? queue : null} />
        )}
      </Row>

      <Row>
        {failed('ai') ? (
          <Failed className="flex-[2_1_560px]" title="Não foi possível carregar a recuperação financeira" onRetry={retry} />
        ) : (
          <FinancialPerformance data={ai} loading={loading('ai')} />
        )}
        {failed('responseTime') ? (
          <Failed className="flex-[1_1_300px]" title="Não foi possível carregar o tempo de resposta" onRetry={retry} />
        ) : (
          <ResponseTimeChart data={responseTime} loading={loading('responseTime')} />
        )}
      </Row>

      <Row>
        {failed('ai') ? (
          <Failed className="flex-[1_1_300px]" title="Não foi possível carregar o desempenho da IA" onRetry={retry} />
        ) : (
          <AiPerformance data={ai} loading={loading('ai')} />
        )}
        {failed('activity') ? (
          <Failed className="flex-[2_1_560px]" title="Não foi possível carregar a atividade recente" onRetry={retry} />
        ) : (
          <ActivityFeed items={activity} loading={loading('activity')} nowMs={now} />
        )}
      </Row>
    </PageBody>
  )
}

function Row({ children }: { children: ReactNode }) {
  return <div className="ddm-stagger-blocks flex flex-wrap gap-3">{children}</div>
}

function Failed({ title, onRetry, className }: { title: string; onRetry: () => void; className?: string }) {
  return <ErrorState className={cn('min-w-0 rounded-field', className)} title={title} onRetry={onRetry} />
}
