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
    <section className="h-full">
      <header className="px-0 pb-3">
        <h2 className="text-sm font-semibold text-foreground">Situação atual</h2>
        
      </header>

      <div className="pt-4">
        {loading || !data ? (
          <Skeleton className="h-56 w-full" />
        ) : data.slices.length === 0 || data.totalCount === 0 ? (
          <EmptyState
            icon={MessageSquare}
            title="Nenhuma conversa registrada"
            hint="Mensagens recebidas e enviadas começarão a preencher esta visão."
          />
        ) : (
          <>
            <div className="mb-5">
              <p className="text-[32px] font-semibold leading-none tracking-[-0.03em] tabular-nums text-foreground">
                {data.totalCount.toLocaleString("pt-BR")}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">conversas em operação</p>
            </div>

            <ul className="space-y-4">
              {data.slices.map((slice) => {
                const percent = Math.round((slice.count / (data.totalCount || 1)) * 100)
                return (
                  <li key={slice.status}>
                    <div className="flex items-center justify-between gap-3 text-xs">
                      <span className="truncate text-muted-foreground">{slice.label}</span>
                      <span className="shrink-0 font-medium tabular-nums text-foreground">
                        {slice.count.toLocaleString("pt-BR")} · {percent}%
                      </span>
                    </div>
                    <div className="mt-1.5 h-1 overflow-hidden bg-muted">
                      <div
                        className="h-full bg-primary"
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
