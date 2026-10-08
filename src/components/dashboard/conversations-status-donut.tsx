"use client"

import { MessageSquare } from 'lucide-react'
import type { ConversationsStatusData } from '@/lib/dashboard/types'
import { EmptyState } from './empty-state'
import { Skeleton } from './skeleton'

interface ConversationsStatusDonutProps {
  data: ConversationsStatusData | null
  loading: boolean
}

export function ConversationsStatusDonut({ data, loading }: ConversationsStatusDonutProps) {
  return (
    <section className="h-full rounded-lg border border-border/80 bg-card/25 p-4">
      <header>
        <h2 className="text-sm font-semibold text-foreground">Situação atual</h2>
      </header>

      <div className="mt-5">
        {loading || !data ? (
          <Skeleton className="h-44 w-full" />
        ) : data.slices.length === 0 || data.totalCount === 0 ? (
          <EmptyState
            icon={MessageSquare}
            title="Nenhuma conversa registrada"
            hint="As conversas em operação aparecerão aqui."
          />
        ) : (
          <>
            <div>
              <p className="text-[30px] font-semibold leading-none tracking-[-0.035em] tabular-nums text-foreground">
                {data.totalCount.toLocaleString("pt-BR")}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">conversas em operação</p>
            </div>

            <ul className="mt-6 space-y-4">
              {data.slices.map((slice) => {
                const percent = Math.round((slice.count / (data.totalCount || 1)) * 100)
                return (
                  <li key={slice.status}>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs text-muted-foreground">{slice.label}</span>
                      <span className="text-xs font-medium tabular-nums text-foreground">
                        {slice.count.toLocaleString("pt-BR")}
                        <span className="ml-1.5 text-muted-foreground">· {percent}%</span>
                      </span>
                    </div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: String(Math.max(2, percent)) + "%" }}
                      />
                    </div>
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </div>
    </section>
  )
}
