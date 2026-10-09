"use client"

import Link from 'next/link'
import { useState } from 'react'
import { Handshake, Inbox, MessageSquare, UserPlus, Zap, type LucideIcon } from 'lucide-react'
import type { ActivityItem, ActivityKind } from '@/lib/dashboard/types'
import { relativeShort } from '@/lib/dashboard/view'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { DashCard } from './dash-card'
import { EmptyState } from './empty-state'

const KIND: Record<ActivityKind, { icon: LucideIcon; label: string }> = {
  message: { icon: MessageSquare, label: 'Conversa' },
  contact: { icon: UserPlus, label: 'Contato' },
  deal: { icon: Handshake, label: 'Negócio' },
  automation: { icon: Zap, label: 'Automação' },
}

const STEP = 8

/**
 * "Atividade recente": mensagens de clientes, contatos novos, negócios e
 * automações, do mais novo para o mais antigo, com tempo relativo.
 */
export function ActivityFeed({
  items,
  loading,
  nowMs,
}: {
  items: ActivityItem[] | null
  loading: boolean
  /** Relógio da página (atualiza o tempo relativo sem recarregar). */
  nowMs: number
}) {
  const [limit, setLimit] = useState(STEP)
  const visible = items?.slice(0, limit) ?? []

  return (
    <DashCard
      title="Atividade recente"
      className="flex-[2_1_560px] gap-2 pb-2.5"
      action={
        <Link href="/inbox" className="text-[12.5px] font-semibold text-primary-text hover:underline">
          Ver conversas
        </Link>
      }
    >
      {loading || !items ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-11 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="Nenhuma atividade ainda"
          hint="Mensagens, negócios, contatos e automações aparecem aqui."
        />
      ) : (
        <>
          <ul className="ddm-stagger m-0 flex list-none flex-col p-0">
            {visible.map((item) => {
              const k = KIND[item.kind]
              const failed = item.kind === 'automation' && item.text.includes('falhou')
              const Icon = k.icon
              const row = (
                <>
                  <span
                    className={cn(
                      'flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-3',
                      failed ? 'text-danger' : item.kind === 'deal' ? 'text-success' : 'text-foreground-2',
                    )}
                  >
                    <Icon className="size-3.5" aria-hidden="true" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-[13px] leading-[1.45] text-foreground [text-wrap:pretty]">{item.text}</span>
                    <span className="text-xs text-muted-foreground">{k.label}</span>
                  </span>
                  <time
                    dateTime={item.at}
                    title={new Date(item.at).toLocaleString('pt-BR')}
                    className="shrink-0 text-xs tabular-nums text-muted-foreground"
                  >
                    {relativeShort(item.at, nowMs)}
                  </time>
                </>
              )
              const cls = '-mx-2 flex items-start gap-3 rounded-[6px] px-2 py-2.5 text-foreground'
              return (
                <li key={item.id}>
                  {item.href ? (
                    <Link href={item.href} className={cn(cls, 'transition-colors hover:bg-surface-hover')}>
                      {row}
                    </Link>
                  ) : (
                    <div className={cls}>{row}</div>
                  )}
                </li>
              )
            })}
          </ul>
          {items.length > limit && (
            <button
              type="button"
              onClick={() => setLimit(limit + STEP)}
              className="self-start pb-1 text-[12.5px] font-semibold text-primary-text hover:underline"
            >
              Mostrar mais
            </button>
          )}
        </>
      )}
    </DashCard>
  )
}
