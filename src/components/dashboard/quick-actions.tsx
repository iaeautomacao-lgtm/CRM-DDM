"use client"

import Link from 'next/link'
import { UserPlus, Briefcase, Radio, Zap } from 'lucide-react'
import type { ComponentType } from 'react'

// Quick-action shortcuts. Each navigates to the page that owns the
// relevant "create" flow. We deliberately don't try to auto-open any
// modal on the target page — that'd require touching those pages,
// which is out of scope here.
interface Action {
  label: string
  href: string
  icon: ComponentType<{ className?: string }>
  tint: string
}

// All four icons share the same tint — kept as a per-item field (rather
// than hardcoded on the icon wrapper) in case a future action legitimately
// needs to stand out, but today they must all match.
const ACTIONS: Action[] = [
  { label: 'Novo Contato', href: '/contacts', icon: UserPlus, tint: 'text-primary' },
  { label: 'Novo Negócio', href: '/pipelines', icon: Briefcase, tint: 'text-primary' },
  { label: 'Nova Transmissão', href: '/broadcasts/new', icon: Radio, tint: 'text-primary' },
  { label: 'Nova Automação', href: '/automations/new', icon: Zap, tint: 'text-primary' },
]

export function QuickActions() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {ACTIONS.map((a) => {
        const Icon = a.icon
        return (
          <Link
            key={a.href}
            href={a.href}
            className="group flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 transition-colors hover:border-border hover:bg-muted/60"
          >
            <div className={`flex h-9 w-9 items-center justify-center rounded-lg bg-muted ${a.tint}`}>
              <Icon className="h-4 w-4" />
            </div>
            <span className="text-sm font-medium text-foreground">{a.label}</span>
          </Link>
        )
      })}
    </div>
  )
}
