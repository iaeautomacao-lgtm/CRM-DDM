"use client"

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
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
    <div className="mx-auto w-full max-w-[1600px] pb-10">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.03em] text-foreground">Dashboard</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">Visão geral da operação.</p>
          <p suppressHydrationWarning className="mt-2 text-xs capitalize text-muted-foreground/80">
            {new Intl.DateTimeFormat('pt-BR', {
              weekday: 'long',
              day: '2-digit',
              month: 'long',
            }).format(new Date())}
          </p>
        </div>
        <QuickActions />
      </div>

      {(failed.has('series') || failed.has('status') || failed.has('responseTime') || failed.has('activity')) && (
        <ErrorState
          className="mt-6 min-h-0"
          title="Parte do painel não pôde ser carregada"
          onRetry={retryAll}
        />
      )}

      <section className="mt-7">
        <SectionHeading
          title="Operação agora"
          description="O que exige atenção neste momento."
          primary
        />

        {failed.has('metrics') ? (
          <ErrorState
            className="mt-3"
            title="Não foi possível carregar os indicadores"
            onRetry={retryAll}
          />
        ) : metricsLoading || !metrics ? (
          <div className="mt-3 grid grid-cols-1 gap-px overflow-hidden border-y border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <SkeletonCard key={i} className="min-h-[112px] rounded-none border-0" />
            ))}
          </div>
        ) : (
          <div className="mt-3 grid grid-cols-1 divide-y divide-border border-y border-border sm:grid-cols-2 sm:divide-x sm:divide-y-0 lg:grid-cols-4">
            <MetricCard
              title="Conversas ativas"
              value={metrics.activeConversations.current.toLocaleString('pt-BR')}
              delta={{
                sign: metrics.activeConversations.previous,
                label: deltaLabel(metrics.activeConversations.previous, 'novas hoje vs ontem'),
              }}
            />
            <MetricCard
              title="Conversas pendentes"
              value={metrics.pendingConversations.current.toLocaleString('pt-BR')}
              delta={{
                sign: metrics.pendingConversations.previous,
                label: deltaLabel(metrics.pendingConversations.previous, 'vs ontem'),
              }}
            />
            <MetricCard
              title="Resolvidas hoje"
              value={metrics.resolvedConversationsToday.current.toLocaleString('pt-BR')}
              delta={{
                sign: metrics.resolvedConversationsToday.current - metrics.resolvedConversationsToday.previous,
                label: deltaLabel(
                  metrics.resolvedConversationsToday.current - metrics.resolvedConversationsToday.previous,
                  'vs ontem',
                ),
              }}
            />
            <MetricCard
              title="Mensagens enviadas hoje"
              value={metrics.messagesSentToday.current.toLocaleString('pt-BR')}
              delta={{
                sign: metrics.messagesSentToday.current - metrics.messagesSentToday.previous,
                label: deltaLabel(
                  metrics.messagesSentToday.current - metrics.messagesSentToday.previous,
                  'vs ontem',
                ),
              }}
            />
          </div>
        )}
      </section>

      <section className="mt-12">
        <SectionHeading title="Movimento da operação" />
        <div className="mt-3 grid grid-cols-1 gap-6 lg:grid-cols-5">
          <div className="lg:col-span-3">
            <ConversationsChart
              series={series}
              loading={seriesLoading}
              range={range}
              onRangeChange={handleRangeChange}
            />
          </div>
          <div className="lg:col-span-2">
            <ConversationsStatusDonut data={statusData} loading={statusLoading} />
          </div>
        </div>
      </section>

      <section className="mt-12">
        <SectionHeading title="Tempo de resposta" />
        <div className="mt-3">
          <ResponseTimeChart data={responseTime} loading={responseTimeLoading} />
        </div>
      </section>

      <section className="mt-12">
        <SectionHeading title="Recuperação financeira" />
        <div className="mt-3">
          {failed.has('ai') ? (
            <ErrorState title="Não foi possível carregar a recuperação financeira" onRetry={retryAll} />
          ) : (
            <FinancialPerformance data={aiPerformance} loading={aiPerformanceLoading} />
          )}
        </div>
      </section>

      <section className="mt-12">
        <SectionHeading title="IA e conversão" />
        <div className="mt-3">
          {failed.has('ai') ? (
            <ErrorState title="Não foi possível carregar o desempenho da IA" onRetry={retryAll} />
          ) : (
            <AiPerformance data={aiPerformance} loading={aiPerformanceLoading} />
          )}
        </div>
      </section>

      <section className="mt-12">
        <ActivityFeed items={activity} loading={activityLoading} />
      </section>
    </div>
  )
}

function SectionHeading({
  title,
  description,
  primary = false,
}: {
  title: string
  description?: string
  primary?: boolean
}) {
  return (
    <div>
      <h2 className={"text-lg font-semibold tracking-[-0.02em] text-foreground"}>
        {title}
      </h2>
      {description ? (
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      ) : null}
    </div>
  )
}

function deltaLabel(delta: number, suffix: string): string {
  if (delta === 0) return `Igual a ontem`
  const sign = delta > 0 ? '+' : ''
  return `${sign}${delta.toLocaleString()} ${suffix}`
}
