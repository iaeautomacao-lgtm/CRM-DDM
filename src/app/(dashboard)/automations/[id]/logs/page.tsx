"use client"

import { use, useCallback, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { formatDistanceToNow } from "date-fns"
import { ptBR } from "date-fns/locale"
import { ArrowLeft, Check, X, ChevronDown, ChevronRight } from "lucide-react"

import { createClient } from "@/lib/supabase/client"
import type {
  Automation,
  AutomationLog,
  AutomationLogStepResult,
} from "@/types"
import { Skeleton } from "@/components/ui/skeleton"
import { CountUp } from "@/components/motion/count-up"
import { KpiStrip } from "@/components/ddm/kpi-strip"
import { PageBody } from "@/components/ddm/page-toolbar"
import { StatusChip, type StatusTone } from "@/components/ddm/status-chip"
import { ErrorState } from "@/components/dashboard/error-state"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { pageRange, splitPage } from "@/lib/pagination"

/** Execuções por página; "Carregar mais" busca a próxima. */
const LOGS_PAGE = 50

export default function AutomationLogsPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)
  const router = useRouter()

  const [automation, setAutomation] = useState<Automation | null>(null)
  const [logs, setLogs] = useState<AutomationLog[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openLogId, setOpenLogId] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState(false)

  const load = useCallback(async () => {
    try {
      const supabase = createClient()
      const [autRes, logRes] = await Promise.all([
        supabase
          .from("automations")
          .select("*")
          .eq("id", id)
          .maybeSingle(),
        supabase
          .from("automation_logs")
          .select("*, contact:contacts(id, name, phone)")
          .eq("automation_id", id)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .range(...pageRange({ limit: LOGS_PAGE, offset: 0 })),
      ])
      if (autRes.error) throw autRes.error
      if (logRes.error) throw logRes.error
      setAutomation(autRes.data as Automation | null)
      const page = splitPage((logRes.data ?? []) as AutomationLog[], LOGS_PAGE)
      setLogs(page.rows)
      setHasMore(page.hasMore)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao carregar os logs")
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  async function loadMore() {
    if (!logs) return
    setLoadingMore(true)
    setMoreError(false)
    try {
      const { data, error: err } = await createClient()
        .from("automation_logs")
        .select("*, contact:contacts(id, name, phone)")
        .eq("automation_id", id)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(...pageRange({ limit: LOGS_PAGE, offset: logs.length }))
      if (err) throw err
      const page = splitPage((data ?? []) as AutomationLog[], LOGS_PAGE)
      setLogs((prev) => [...(prev ?? []), ...page.rows])
      setHasMore(page.hasMore)
    } catch {
      setMoreError(true)
    } finally {
      setLoadingMore(false)
    }
  }

  const back = (
    <button
      type="button"
      onClick={() => router.push("/automations")}
      className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-3" />
      Automações
    </button>
  )

  if (error) {
    return (
      <PageBody>
        <div className="pt-1">{back}</div>
        <ErrorState
          title="Não foi possível carregar os logs"
          hint={error}
          onRetry={() => {
            setError(null)
            setLogs(null)
            void load()
          }}
        />
      </PageBody>
    )
  }

  if (logs === null) {
    return (
      <PageBody>
        <div className="flex flex-col gap-2 pt-1" aria-busy="true">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-7 w-56" />
        </div>
        <div className="flex flex-col gap-2" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[58px] w-full rounded-[10px]" />
          ))}
        </div>
      </PageBody>
    )
  }

  if (!automation) {
    return (
      <PageBody>
        <div className="pt-1">{back}</div>
        <div className="flex animate-ddm-fade flex-col items-center gap-1.5 rounded-[10px] border border-dashed border-border bg-card px-6 py-12 text-center">
          <p className="text-[13.5px] font-semibold text-foreground">Automação não encontrada</p>
          <p className="text-[12.5px] text-muted-foreground">Ela pode ter sido excluída.</p>
        </div>
      </PageBody>
    )
  }

  const counts = {
    success: logs.filter((l) => l.status === "success").length,
    partial: logs.filter((l) => l.status === "partial").length,
    failed: logs.filter((l) => l.status === "failed").length,
  }

  return (
    <PageBody>
      <div className="flex flex-col gap-1.5 pt-1">
        {back}
        <h2 className="font-heading text-[28px] font-semibold leading-tight tracking-[-0.025em] text-foreground">{automation.name}</h2>
        <p className="max-w-[620px] text-sm leading-relaxed text-muted-foreground">Logs de execução</p>
      </div>

      {logs.length > 0 && (
        <KpiStrip
          ariaLabel="Resumo das execuções"
          items={[
            { label: "Execuções", value: <CountUp value={logs.length} />, info: "Execuções carregadas nesta lista, da mais recente para a mais antiga. Use Carregar mais para ver as anteriores." },
            { label: "Sucesso", value: <CountUp value={counts.success} className="text-success" /> },
            { label: "Parciais", value: <CountUp value={counts.partial} className={counts.partial > 0 ? "text-warning" : undefined} /> },
            { label: "Falhas", value: <CountUp value={counts.failed} className={counts.failed > 0 ? "text-danger" : undefined} /> },
          ]}
        />
      )}

      {logs.length === 0 ? (
        <div className="flex animate-ddm-fade flex-col items-center gap-1.5 rounded-[10px] border border-dashed border-border bg-card px-6 py-12 text-center">
          <p className="text-[13.5px] font-semibold text-foreground">Nenhuma execução ainda</p>
          <p className="text-[12.5px] text-muted-foreground">
            Dispare esta automação para ver as execuções aqui.
          </p>
        </div>
      ) : (
        <ul className="ddm-stagger flex flex-col gap-2">
          {logs.map((log) => {
            const isOpen = openLogId === log.id
            return (
              <li
                key={log.id}
                className="rounded-[10px] border border-border bg-card transition-[border-color] duration-200 ease-ddm hover:border-border-strong"
              >
                <button
                  type="button"
                  onClick={() => setOpenLogId(isOpen ? null : log.id)}
                  aria-expanded={isOpen}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left"
                >
                  {isOpen ? (
                    <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <StatusChip tone={STATUS_TONE[log.status] ?? "mute"}>
                    {STATUS_LABEL[log.status] ?? log.status}
                  </StatusChip>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] font-semibold text-foreground">
                      {log.contact?.name ?? log.contact?.phone ?? "Contato desconhecido"}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {log.trigger_event} · {log.steps_executed?.length ?? 0} etapa
                      {log.steps_executed?.length === 1 ? "" : "s"}
                    </div>
                  </div>
                  <div className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
                    {formatDistanceToNow(new Date(log.created_at), { addSuffix: true, locale: ptBR })}
                  </div>
                </button>
                {isOpen && (
                  <div className="animate-ddm-fade border-t border-border px-4 py-3">
                    {log.error_message && (
                      <p className="mb-3 rounded-md bg-danger-soft px-3 py-2 text-xs text-danger">
                        {log.error_message}
                      </p>
                    )}
                    <ul className="space-y-1.5">
                      {(log.steps_executed ?? []).map((r, i) => (
                        <StepRow key={i} result={r} />
                      ))}
                      {(log.steps_executed ?? []).length === 0 && (
                        <li className="text-xs text-muted-foreground">Nenhuma etapa registrada.</li>
                      )}
                    </ul>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {hasMore && (
        <div className="flex flex-col items-center gap-2">
          {moreError && (
            <p role="alert" className="text-xs text-danger">
              Não foi possível carregar mais execuções. Tente de novo.
            </p>
          )}
          <Button type="button" variant="outline" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? "Carregando…" : "Carregar mais"}
          </Button>
        </div>
      )}
    </PageBody>
  )
}

const STATUS_LABEL: Record<string, string> = {
  success: "Sucesso",
  partial: "Parcial",
  failed: "Falhou",
}

const STATUS_TONE: Record<string, StatusTone> = {
  success: "ok",
  partial: "warn",
  failed: "bad",
}

function StepRow({ result }: { result: AutomationLogStepResult }) {
  const ok = result.status === "success"
  return (
    <li className="flex items-start gap-2 text-xs">
      <span
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full",
          ok ? "bg-success-soft text-success" : "bg-danger-soft text-danger",
        )}
        aria-hidden
      >
        {ok ? <Check className="size-3" /> : <X className="size-3" />}
      </span>
      <span className="text-muted-foreground">{result.step_type}</span>
      {result.detail && (
        <span className="truncate text-muted-foreground">— {result.detail}</span>
      )}
    </li>
  )
}
