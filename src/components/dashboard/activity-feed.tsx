"use client"

import Link from 'next/link'
import { useState } from 'react'
import { Inbox } from 'lucide-react'
import type { ActivityItem, ActivityKind } from '@/lib/dashboard/types'
import { cn } from '@/lib/utils'
import { EmptyState } from './empty-state'
import { Skeleton } from './skeleton'

interface ActivityFeedProps {
  items: ActivityItem[] | null
  loading: boolean
}

const PAGE_SIZES = [5, 10, 20, 50] as const
type PageSize = (typeof PAGE_SIZES)[number]

const KIND_LABEL: Record<ActivityKind, string> = {
  message: 'Conversa',
  contact: 'Contato',
  deal: 'Negócio',
  automation: 'Automação',
}

export function ActivityFeed({ items, loading }: ActivityFeedProps) {
  const [pageSize, setPageSize] = useState<PageSize>(5)
  const totalLoaded = items?.length ?? 0
  const visible = items?.slice(0, pageSize) ?? []

  const isSizeUseful = (size: PageSize, i: number) =>
    i === 0 || totalLoaded > PAGE_SIZES[i - 1]

  return (
    <section className="">
      <header className="flex items-center justify-between gap-3 pb-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Atividade recente</h2>
          
        </div>
        <Link href="/inbox" className="text-xs font-medium text-primary hover:text-primary/80">
          Ver tudo
        </Link>
      </header>

      {loading || !items ? (
        <div className="space-y-2 border-t border-border pt-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="border-t border-border pt-4">
          <EmptyState
            icon={Inbox}
            title="Nenhuma atividade ainda"
            hint="Mensagens, negócios, contatos e automações aparecerão aqui."
          />
        </div>
      ) : (
        <>
          <ul className="divide-y divide-border border-t border-border">
            {visible.map((item) => {
              const row = (
                <div className="grid grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-3 py-2.5 text-sm">
                  <time className="text-xs tabular-nums text-muted-foreground">{shortTime(item.at)}</time>
                  <span className="min-w-0 truncate text-foreground">{item.text}</span>
                  <span className="text-xs text-muted-foreground">{KIND_LABEL[item.kind]}</span>
                </div>
              )

              return (
                <li key={item.id} className="transition-colors hover:bg-muted/35">
                  {item.href ? (
                    <Link href={item.href} className="block">
                      {row}
                    </Link>
                  ) : (
                    row
                  )}
                </li>
              )
            })}
          </ul>

          <footer className="flex items-center justify-between border-t border-border py-3 text-xs">
            <span className="text-muted-foreground tabular-nums">
              Exibindo {visible.length} de {totalLoaded}{totalLoaded === 50 ? '+' : ''}
            </span>
            <div className="flex items-center gap-1">
              <span className="mr-1 text-muted-foreground">Mostrar</span>
              {PAGE_SIZES.map((size, i) => {
                const disabled = !isSizeUseful(size, i)
                return (
                  <button
                    key={size}
                    type="button"
                    onClick={() => setPageSize(size)}
                    disabled={disabled}
                    className={cn(
                      'rounded px-2 py-1 font-medium tabular-nums transition-colors',
                      pageSize === size
                        ? 'bg-secondary text-secondary-foreground'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                      disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-muted-foreground',
                    )}
                  >
                    {size}
                  </button>
                )
              })}
            </div>
          </footer>
        </>
      )}
    </section>
  )
}

function shortTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}
