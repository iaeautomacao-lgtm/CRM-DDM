"use client"

import Link from 'next/link'

const ACTIONS = [
  { label: 'Novo contato', href: '/contacts' },
  { label: 'Nova automação', href: '/automations/new' },
] as const

export function QuickActions() {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {ACTIONS.map((action) => (
        <Link
          key={action.href}
          href={action.href}
          className="inline-flex h-8 items-center rounded-md border border-border/80 bg-transparent px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {action.label}
        </Link>
      ))}
    </div>
  )
}
