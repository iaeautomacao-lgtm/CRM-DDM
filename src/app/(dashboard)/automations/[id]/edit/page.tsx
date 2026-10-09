"use client"

import { apiFetch } from "@/lib/api-fetch";

import { use, useCallback, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"

import {
  AutomationBuilder,
  fromServerSteps,
  type BuilderInitial,
  type ServerStepNode,
} from "@/components/automations/automation-builder"
import { ErrorState } from "@/components/dashboard/error-state"
import { Button } from "@/components/ui/button"
import type { AutomationTriggerType } from "@/types"

export default function EditAutomationPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)
  const router = useRouter()
  const [initial, setInitial] = useState<BuilderInitial | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const retry = useCallback(() => {
    setError(null)
    setReloadKey((k) => k + 1)
  }, [])

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await apiFetch(`/api/automations/${id}`)
        if (!res.ok) {
          if (!cancelled) setError(`Falha ao carregar (${res.status})`)
          return
        }
        const body = await res.json()
        if (cancelled) return
        setInitial({
          id: body.automation.id,
          name: body.automation.name ?? "",
          description: body.automation.description ?? "",
          trigger_type: body.automation.trigger_type as AutomationTriggerType,
          trigger_config: body.automation.trigger_config ?? {},
          is_active: !!body.automation.is_active,
          line_ids: body.automation.line_ids ?? [],
          steps: fromServerSteps((body.steps ?? []) as ServerStepNode[]),
        })
      } catch {
        if (!cancelled) setError("Não foi possível carregar a automação. Verifique sua conexão.")
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [id, reloadKey])

  if (error) {
    return (
      <div className="flex h-full min-h-screen flex-col items-center justify-center gap-3 p-6">
        <ErrorState
          title="Não foi possível carregar a automação"
          hint={error}
          onRetry={retry}
          className="max-w-md"
        />
        <Button variant="ghost" size="sm" onClick={() => router.push("/automations")}>
          Voltar para automações
        </Button>
      </div>
    )
  }

  if (!initial) {
    return (
      <div role="status" className="flex h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden="true" />
        <span className="sr-only">Carregando automação…</span>
      </div>
    )
  }

  return <AutomationBuilder initial={initial} />
}
