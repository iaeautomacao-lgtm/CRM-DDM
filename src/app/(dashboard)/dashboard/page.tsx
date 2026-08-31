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

type RangeDays = 7 | 30 | 90

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

  const loadAll = useCallback(() => {
    const db = createClient()

    void loadMetrics(db)
      .then((m) => setMetrics(m))
      .catch((err) => console.error('[dashboard] metrics failed:', err))
      .finally(() => setMetricsLoading(false))

    void loadConversationsSeries(db, 30)
      .then((s) => setSeries((prev) => ({ ...prev, 30: s })))
      .catch((err) => console.error('[dashboard] series failed:', err))
      .finally(() => setSeriesLoading(false))

    void loadConversationsStatusDonut(db)
      .then((p) => setStatusData(p))
      .catch((err) => console.error('[dashboard] status donut failed:', err))
      .finally(() => setStatusLoading(false))

    void loadResponseTime(db)
      .then((r) => setResponseTime(r))
      .catch((err) => console.error('[dashboard] response time failed:', err))
      .finally(() => setResponseTimeLoading(false))

    void loadActivity(db, 50)
      .then((a) => setActivity(a))
      .catch((err) => console.error('[dashboard] activity failed:', err))
      .finally(() => setActivityLoading(false))

    void loadAiAnalytics(db)
      .then((a) => setAiPerformance(a))
      .catch((err) => console.error('[dashboard] ai performance failed:', err))
      .finally(() => setAiPerformanceLoading(false))
  }, [])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  const handleRangeChange = useCallback(
    (r: RangeDays) => {
      setRange(r)
      if (series[r] !== null) return
      setSeriesLoading(true)
      const db = createClient()
      loadConversationsSeries(db, r)
        .then((s) => setSeries((prev) => ({ ...prev, [r]: s })))
        .catch((err) => console.error('[dashboard] series failed:', err))
        .finally(() => setSeriesLoading(false))
    },
    [series],
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

      {/* Metric cards */}
      <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {metricsLoading || !metrics ? (
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

      {/* Recuperação Financeira e Metas */}
      <div className="mt-10">
        <h3 className="mb-4 text-sm font-semibold text-muted-foreground uppercase tracking-wider">Recuperação Financeira</h3>
        <FinancialPerformance data={aiPerformance} loading={aiPerformanceLoading} />
      </div>

      {/* Desempenho da IA e Vendas */}
      <div className="mt-10">
        <h3 className="mb-4 text-sm font-semibold text-muted-foreground uppercase tracking-wider">Desempenho da IA & Conversão</h3>
        <AiPerformance data={aiPerformance} loading={aiPerformanceLoading} />
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
