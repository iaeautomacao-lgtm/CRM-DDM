"use client"

import Link from 'next/link'
import { Plus } from 'lucide-react'
import { Can } from '@/components/auth/can'
import type { Permission } from '@/lib/auth/permissions'

// Atalhos do cabeçalho. Cada um só aparece para quem tem a permissão de
// criar; o servidor continua bloqueando a criação de qualquer forma.
const ACTIONS: ReadonlyArray<{ label: string; href: string; permission: Permission }> = [
  { label: 'Novo contato', href: '/contacts', permission: 'contacts.edit' },
  { label: 'Nova automação', href: '/automations/new', permission: 'automations.edit' },
]

export function QuickActions() {
  return (
    <>
      {ACTIONS.map((action) => (
        <Can key={action.href} permission={action.permission}>
          <Link
            href={action.href}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[6px] border border-border bg-card px-3 text-[12.5px] font-medium text-foreground transition-colors hover:border-border-strong hover:bg-surface-hover"
          >
            <Plus className="size-3.5" aria-hidden="true" />
            {action.label}
          </Link>
        </Can>
      ))}
    </>
  )
}
