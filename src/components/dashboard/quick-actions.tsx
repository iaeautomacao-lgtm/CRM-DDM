"use client"

import Link from 'next/link'
import { Plus } from 'lucide-react'

const ACTIONS = [
  { label: 'Novo contato', href: '/contacts' },
  { label: 'Nova automação', href: '/automations/new' },
] as const

export function QuickActions() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {ACTIONS.map((action, index) => (
        <Link
          key={action.href}
          href={action.href}
          className={
            index === 0
              ? 'inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover'
              : 'inline-flex h-9 items-center rounded-md border border-border px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted'
          }
        >
          {index === 0 ? <Plus className="h-4 w-4" aria-hidden /> : null}
          {action.label}
        </Link>
      ))}
    </div>
  )
}
