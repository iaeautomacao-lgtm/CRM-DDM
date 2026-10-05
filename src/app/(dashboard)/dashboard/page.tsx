"use client"

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useAuth } from '@/hooks/use-auth'
import {
  MessageSquare,
  UserPlus,
  CheckCircle,
  Send,
} from 'lucide-react'

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

import { MetricCard } from '@/components/dashboard/metric-card'
import { SkeletonCard } from '@/components/dashboard/skeleton'
import { QuickActions } from '@/components/dashboard/quick-actions'
import { ConversationsChart } from '@/components/dashboard/conversations-chart'
import { ConversationsStatusDonut } from '@/components/dashboard/conversations-status-donut'
import { ResponseTimeChart } from '@/components/dashboard/response-time-chart'
import { ActivityFeed } from '@/components/dashboard/activity-feed'
import { AiPerformance } from '@/components/dashboard/ai-performance'
import { FinancialPerformance } from '@/components/dashboard/financial-performance'
import { ErrorState } from '@/components/dashboard/error-state'

type RangeDays = 7 | 30 | 90

// Seções carregadas por loadAll — usadas para rastrear quais falharam
// e oferecer "Tentar novamente" em vez de skeletons eternos.
type DashboardSection = 'metrics' | 'series' | 'status' | 'responseTime' | 'activity' | 'ai'

export default function DashboardPage() {
  const [metrics, setMetrics] = useState<MetricsBundle | null>(null)
  const [metricsLoading, setMetricsLoading] = useState(true)

  const [range, setRange] = useState<RangeDays>(30)
  const [series, setSeries] = useState<Record<RangeDays, ConversationsSeriesPoint[] | null>>({
    7: null,
    30: null,
    90: null,
  })
  const [seriesLoading, setSeriesLoading] = useState(true)

  const [statusData, setStatusData] = useState<ConversationsStatusData | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)

  const [responseTime, setResponseTime] = useState<ResponseTimeSummary | null>(null)
  const [responseTimeLoading, setResponseTimeLoading] = useState(true)

  const [activity, setActivity] = useState<ActivityItem[] | null>(null)
  const [activityLoading, setActivityLoading] = useState(true)

  const [aiPerformance, setAiPerformance] = useState<AiAnalyticsData | null>(null)
  const [aiPerformanceLoading, setAiPerformanceLoading] = useState(true)

  const [failed, setFailed] = useState<Set<DashboardSection>>(() => new Set())
  const markFailed = useCallback((section: DashboardSection) => {
    setFailed((prev) => new Set(prev).add(section))
  }, [])

  const loadAll = useCallback(() => {
    const db = createClient()

    void loadMetrics(db)
      .then((m) => setMetrics(m))
      .catch((err) => {
        console.error('[dashboard] metrics failed:', err)
        markFailed('metrics')
      })
      .finally(() => setMetricsLoading(false))

    void loadConversationsSeries(db, 30)
      .then((s) => setSeries((prev) => ({ ...prev, 30: s })))
      .catch((err) => {
        console.error('[dashboard] series failed:', err)
        markFailed('series')
      })
      .finally(() => setSeriesLoading(false))

    void loadConversationsStatusDonut(db)
      .then((p) => setStatusData(p))
      .catch((err) => {
        console.error('[dashboard] status donut failed:', err)
        markFailed('status')
      })
      .finally(() => setStatusLoading(false))

    void loadResponseTime(db)
      .then((r) => setResponseTime(r))
      .catch((err) => {
        console.error('[dashboard] response time failed:', err)
        markFailed('responseTime')
      })
      .finally(() => setResponseTimeLoading(false))

    void loadActivity(db, 50)
      .then((a) => setActivity(a))
      .catch((err) => {
        console.error('[dashboard] activity failed:', err)
        markFailed('activity')
      })
      .finally(() => setActivityLoading(false))

    void loadAiAnalytics(db)
      .then((a) => setAiPerformance(a))
      .catch((err) => {
        console.error('[dashboard] ai performance failed:', err)
        markFailed('ai')
      })
      .finally(() => setAiPerformanceLoading(false))
  }, [markFailed])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  // "Tentar novamente": reinicia os estados (volta a mostrar os
  // skeletons) e recarrega tudo.
  const retryAll = useCallback(() => {
    setFailed(new Set())
    setMetricsLoading(true)
    setSeriesLoading(true)
    setStatusLoading(true)
    setResponseTimeLoading(true)
    setActivityLoading(true)
    setAiPerformanceLoading(true)
    loadAll()
    // loadAll só traz a série de 30 dias; o período escolhido (7/90) que
    // falhou precisa ser buscado de novo, senão o gráfico fica no skeleton.
    if (range !== 30) {
      loadConversationsSeries(createClient(), range)
        .then((s) => setSeries((prev) => ({ ...prev, [range]: s })))
        .catch((err) => {
          console.error('[dashboard] series failed:', err)
          markFailed('series')
        })
    }
  }, [loadAll, range, markFailed])

  const handleRangeChange = useCallback(
    (r: RangeDays) => {
      setRange(r)
      if (series[r] !== null) return
      setSeriesLoading(true)
      const db = createClient()
      loadConversationsSeries(db, r)
        .then((s) => setSeries((prev) => ({ ...prev, [r]: s })))
        .catch((err) => {
          console.error('[dashboard] series failed:', err)
          markFailed('series')
        })
        .finally(() => setSeriesLoading(false))
    },
    [series, markFailed],
  )

  return (
    // Explicit mt-* per section (rather than a blanket space-y-* on this
    // container) so the three section-opener gaps below can be widened
    // independently — space-y's margin-top would otherwise win over a
    // per-child override at equal specificity.
    <div>
      {/* Header — the top bar (components/layout/header.tsx) already
          renders the "Dashboard" H1 for this route; only the subtitle
          belongs here. */}
      <p className="text-sm text-muted-foreground">
        Análise em tempo real de conversas, contatos, negócios, transmissões e automações.
      </p>

      {/* Falha parcial: gráficos que não carregaram ficariam em skeleton
          para sempre — avisa e permite recarregar tudo. As seções de
          métricas e IA têm o próprio estado de erro abaixo. */}
      {(failed.has('series') || failed.has('status') || failed.has('responseTime') || failed.has('activity')) && (
        <ErrorState
          className="mt-5 min-h-0"
          title="Parte do painel não pôde ser carregada"
          onRetry={retryAll}
        />
      )}

      {/* Metric cards */}
      <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {failed.has('metrics') ? (
          <ErrorState
            className="sm:col-span-2 lg:col-span-4"
            title="Não foi possível carregar os indicadores"
            onRetry={retryAll}
          />
        ) : metricsLoading || !metrics ? (
          Array.from({ length: 4 }).map((_, i) => (
            <SkeletonCard key={i} className="min-h-[120px]" />
          ))
        ) : (
          <>
            <MetricCard
              title="Conversas Ativas"
              value={metrics.activeConversations.current.toLocaleString()}
              icon={MessageSquare}
              delta={{
                sign: metrics.activeConversations.previous,
                label: deltaLabel(metrics.activeConversations.previous, 'novas hoje vs ontem'),
              }}
            />
            <MetricCard
              title="Conversas Pendentes"
              value={metrics.pendingConversations.current.toLocaleString()}
              icon={UserPlus}
              delta={{
                sign: metrics.pendingConversations.previous,
                label: deltaLabel(metrics.pendingConversations.previous, 'vs ontem'),
              }}
            />
            <MetricCard
              title="Conversas Resolvidas Hoje"
              value={metrics.resolvedConversationsToday.current.toLocaleString()}
              icon={CheckCircle}
              delta={{
                sign: metrics.resolvedConversationsToday.current - metrics.resolvedConversationsToday.previous,
                label: deltaLabel(
                  metrics.resolvedConversationsToday.current - metrics.resolvedConversationsToday.previous,
                  'vs ontem',
                ),
              }}
            />
            <MetricCard
              title="Mensagens Enviadas Hoje"
              value={metrics.messagesSentToday.current.toLocaleString()}
              icon={Send}
              delta={{
                sign:
                  metrics.messagesSentToday.current - metrics.messagesSentToday.previous,
                label: deltaLabel(
                  metrics.messagesSentToday.current - metrics.messagesSentToday.previous,
                  'vs ontem',
                ),
              }}
            />
          </>
        )}
      </div>

      {/* Quick actions */}
      <div className="mt-5">
        <QuickActions />
      </div>

      {/* Recuperação Financeira */}
      <div className="mt-10">
        <h3 className="mb-4 text-sm font-semibold text-muted-foreground uppercase tracking-wider">Recuperação Financeira</h3>
        {failed.has('ai') ? (
          <ErrorState title="Não foi possível carregar a recuperação financeira" onRetry={retryAll} />
        ) : (
          <FinancialPerformance data={aiPerformance} loading={aiPerformanceLoading} />
        )}
      </div>

      {/* Desempenho da IA e Vendas */}
      <div className="mt-10">
        <h3 className="mb-4 text-sm font-semibold text-muted-foreground uppercase tracking-wider">Desempenho da IA & Conversão</h3>
        {failed.has('ai') ? (
          <ErrorState title="Não foi possível carregar o desempenho da IA" onRetry={retryAll} />
        ) : (
          <AiPerformance data={aiPerformance} loading={aiPerformanceLoading} />
        )}
      </div>

      {/* Charts row */}
      <div className="mt-10 grid grid-cols-1 gap-4 lg:grid-cols-5">
        <div className="h-full lg:col-span-3">
          <ConversationsChart
            series={series}
            loading={seriesLoading}
            range={range}
            onRangeChange={handleRangeChange}
          />
        </div>
        <div className="h-full lg:col-span-2">
          <ConversationsStatusDonut
            data={statusData}
            loading={statusLoading}
          />
        </div>
      </div>

      {/* Response time */}
      <div className="mt-5">
        <ResponseTimeChart data={responseTime} loading={responseTimeLoading} />
      </div>

      {/* Activity feed */}
      <div className="mt-5">
        <ActivityFeed items={activity} loading={activityLoading} />
      </div>
    </div>
  )
}

function deltaLabel(delta: number, suffix: string): string {
  if (delta === 0) return `Sem alteração ${suffix}`
  const sign = delta > 0 ? '+' : ''
  return `${sign}${delta.toLocaleString()} ${suffix}`
}
