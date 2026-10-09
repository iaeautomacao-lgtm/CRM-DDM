"use client"

import { apiFetch } from "@/lib/api-fetch";

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { formatDistanceToNow } from "date-fns"
import { ptBR } from "date-fns/locale"
import {
  Zap,
  Plus,
  MoreVertical,
  Copy,
  Pencil,
  Trash2,
  FileText,
  MessageCircle,
  Clock,
  Users,
  PhoneCall,
  Loader2,
} from "lucide-react"

import { createClient } from "@/lib/supabase/client"
import { usePermission } from "@/hooks/use-permission"
import type { Automation } from "@/types"
import { Button } from "@/components/ui/button"
import { GatedButton } from "@/components/ui/gated-button"
import { Switch } from "@/components/ui/switch"
import { Skeleton } from "@/components/ui/skeleton"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { CountUp } from "@/components/motion/count-up"
import { KpiStrip } from "@/components/ddm/kpi-strip"
import { PageBody, PageToolbar } from "@/components/ddm/page-toolbar"
import { Segmented } from "@/components/ddm/segmented"
import { StatusChip } from "@/components/ddm/status-chip"
import { CellMain, DenseTable, TableCard, Td, Th, Tr } from "@/components/ddm/table-card"
import { ErrorState } from "@/components/dashboard/error-state"
import { AUTOMATION_TEMPLATES, type TemplateSlug } from "@/lib/automations/templates"
import { triggerMeta } from "@/lib/automations/trigger-meta"
import { PipelineAutomations } from "@/components/automations/pipeline-automations"

const TEMPLATE_ORDER: TemplateSlug[] = [
  "welcome_message",
  "out_of_office",
  "lead_qualifier",
  "follow_up_reminder",
]

const TEMPLATE_ICON: Record<TemplateSlug, typeof Zap> = {
  welcome_message: MessageCircle,
  out_of_office: Clock,
  lead_qualifier: Users,
  follow_up_reminder: PhoneCall,
}

export default function AutomationsPage() {
  const router = useRouter()
  // Criar/editar automação: automations.edit no servidor (admin+).
  const canCreate = usePermission("automations.edit")
  const [automations, setAutomations] = useState<Automation[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Automation | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [activeTab, setActiveTab] = useState<"chat" | "pipeline">("chat")

  async function load() {
    try {
      const supabase = createClient()
      const { data, error: fetchErr } = await supabase
        .from("automations")
        .select("*")
        .order("created_at", { ascending: false })
      if (fetchErr) throw fetchErr
      setAutomations((data ?? []) as Automation[])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao carregar automações")
    }
  }

  useEffect(() => {
    load()
  }, [])

  async function toggleActive(a: Automation, next: boolean) {
    // Optimistic flip so the switch feels instant.
    setAutomations((prev) =>
      prev?.map((x) => (x.id === a.id ? { ...x, is_active: next } : x)) ?? prev,
    )
    const res = await apiFetch(`/api/automations/${a.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ is_active: next }),
    })
    if (!res.ok) {
      // Roll back on error.
      setAutomations((prev) =>
        prev?.map((x) => (x.id === a.id ? { ...x, is_active: !next } : x)) ?? prev,
      )
      const body = await res.json().catch(() => ({}))
      toast.error(body?.error ?? "Falha ao atualizar")
      return
    }
    toast.success(next ? "Automação ativada" : "Automação pausada")
  }

  async function duplicate(a: Automation) {
    const res = await apiFetch(`/api/automations/${a.id}/duplicate`, { method: "POST" })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      toast.error(body?.error ?? "Falha ao duplicar")
      return
    }
    toast.success("Automação duplicada")
    load()
  }

  async function confirmDelete() {
    if (!pendingDelete) return
    setDeleting(true)
    const res = await apiFetch(`/api/automations/${pendingDelete.id}`, { method: "DELETE" })
    setDeleting(false)
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      toast.error(body?.error ?? "Falha ao excluir")
      return
    }
    toast.success("Automação excluída")
    setPendingDelete(null)
    load()
  }

  async function startFromTemplate(slug: TemplateSlug) {
    router.push(`/automations/new?template=${slug}`)
  }

  const list = automations ?? []
  const activeCount = list.filter((a) => a.is_active).length
  const totalExecutions = list.reduce((sum, a) => sum + (a.execution_count ?? 0), 0)
  const showTemplates = automations !== null && list.length < 3

  return (
    <PageBody>
      <div className="flex flex-col gap-1.5 pt-1">
        <h2 className="font-heading text-[28px] font-semibold leading-tight tracking-[-0.025em] text-foreground">Automações</h2>
        <p className="max-w-[620px] text-sm leading-relaxed text-muted-foreground">
          Crie fluxos automáticos e configure o envelhecimento de cartões do CRM.
        </p>
      </div>

      <PageToolbar
        actions={
          activeTab === "chat" ? (
            <GatedButton canAct={canCreate} gateReason="criar automações" onClick={() => router.push("/automations/new")}>
              <Plus className="size-3.5" />
              Criar automação
            </GatedButton>
          ) : undefined
        }
      >
        <Segmented
          ariaLabel="Tipo de automação"
          size="lg"
          value={activeTab}
          onChange={setActiveTab}
          options={[
            { value: "chat", label: "Automações de Chat", count: automations ? list.length : undefined },
            { value: "pipeline", label: "Automações de Pipeline (CRM)" },
          ]}
        />
      </PageToolbar>

      {activeTab === "pipeline" ? (
        <PipelineAutomations />
      ) : error ? (
        <ErrorState
          title="Não foi possível carregar as automações"
          hint={error}
          onRetry={() => {
            setError(null)
            setAutomations(null)
            void load()
          }}
        />
      ) : (
        <>
          {automations !== null && list.length > 0 && (
            <KpiStrip
              ariaLabel="Resumo das automações"
              items={[
                { label: "Automações", value: <CountUp value={list.length} /> },
                { label: "Ativas", value: <CountUp value={activeCount} className="text-success" />, note: `de ${list.length}` },
                {
                  label: "Execuções",
                  value: <CountUp value={totalExecutions} />,
                  info: "Total de execuções registradas por automação desde a criação.",
                },
              ]}
            />
          )}

          {showTemplates && (
            <section aria-label="Modelos para começar rápido" className="flex flex-col gap-2.5">
              <h3 className="text-[13px] font-semibold text-foreground-2">Modelos para começar rápido</h3>
              <div className="ddm-stagger grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
                {TEMPLATE_ORDER.map((slug) => {
                  const t = AUTOMATION_TEMPLATES[slug]
                  const Icon = TEMPLATE_ICON[slug]
                  return (
                    <button
                      key={slug}
                      type="button"
                      onClick={() => startFromTemplate(slug)}
                      className="group flex flex-col items-start gap-2 rounded-[10px] border border-border bg-card p-4 text-left transition-[border-color,box-shadow,transform] duration-200 ease-ddm hover:-translate-y-0.5 hover:border-primary hover:shadow-overlay"
                    >
                      <span className="flex size-9 items-center justify-center rounded-lg bg-primary-soft text-primary-text">
                        <Icon className="size-[18px]" aria-hidden="true" />
                      </span>
                      <span className="text-[13.5px] font-semibold text-foreground">{t.name}</span>
                      <span className="text-xs leading-relaxed text-muted-foreground">{t.description}</span>
                    </button>
                  )
                })}
              </div>
            </section>
          )}

          <TableCard label="Automações de chat">
            {automations === null ? (
              <div className="flex flex-col" aria-busy="true">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="flex items-center gap-3 border-b border-border px-[18px] py-3.5" aria-hidden="true">
                    <Skeleton className="size-[30px] rounded-full" />
                    <Skeleton className="h-3 w-48" />
                    <Skeleton className="ml-auto h-5 w-9 rounded-full" />
                  </div>
                ))}
              </div>
            ) : list.length === 0 ? (
              <div className="flex animate-ddm-fade flex-col items-center gap-1.5 px-4 py-12 text-center">
                <Zap className="size-5 text-muted-foreground" aria-hidden="true" />
                <p className="text-[13.5px] font-semibold text-foreground">Nenhuma automação ainda</p>
                <p className="text-[12.5px] text-muted-foreground">Escolha um modelo acima ou crie uma do zero.</p>
              </div>
            ) : (
              <DenseTable>
                <thead>
                  <tr>
                    <Th>Automação</Th>
                    <Th className="hidden md:table-cell">Gatilho</Th>
                    <Th className="hidden lg:table-cell" align="right">Execuções</Th>
                    <Th className="hidden xl:table-cell">Última execução</Th>
                    <Th>Ativa</Th>
                    <Th className="w-11" />
                  </tr>
                </thead>
                <tbody className="ddm-stagger">
                  {list.map((a) => (
                    <Tr key={a.id} onClick={() => router.push(`/automations/${a.id}/edit`)} className="cursor-pointer">
                      <Td className="max-w-[360px]">
                        <span className="flex min-w-0 items-center gap-2.5">
                          <span className="flex size-[30px] shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary-text" aria-hidden="true">
                            <Zap className="size-3.5" />
                          </span>
                          <CellMain title={a.name} sub={a.description || undefined} />
                        </span>
                      </Td>
                      <Td className="hidden md:table-cell">
                        <StatusChip tone="info">{triggerMeta(a.trigger_type).label}</StatusChip>
                      </Td>
                      <Td className="hidden tabular-nums lg:table-cell" align="right">
                        {(a.execution_count ?? 0).toLocaleString("pt-BR")}
                      </Td>
                      <Td className="hidden whitespace-nowrap text-muted-foreground xl:table-cell">
                        {a.last_executed_at
                          ? formatDistanceToNow(new Date(a.last_executed_at), { addSuffix: true, locale: ptBR })
                          : "nunca"}
                      </Td>
                      <Td onClick={(e) => e.stopPropagation()}>
                        <Switch
                          checked={a.is_active}
                          onCheckedChange={(v) => toggleActive(a, !!v)}
                          disabled={!canCreate}
                          aria-label={`${a.is_active ? "Desativar" : "Ativar"} ${a.name}`}
                        />
                      </Td>
                      <Td className="pr-2 text-right" onClick={(e) => e.stopPropagation()}>
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            aria-label={`Ações de ${a.name}`}
                            className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground data-[popup-open]:bg-surface-hover"
                          >
                            <MoreVertical className="size-4" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => router.push(`/automations/${a.id}/edit`)}>
                              <Pencil className="size-4" />
                              {canCreate ? "Editar" : "Ver detalhes"}
                            </DropdownMenuItem>
                            {canCreate && (
                              <DropdownMenuItem onClick={() => duplicate(a)}>
                                <Copy className="size-4" />
                                Duplicar
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem onClick={() => router.push(`/automations/${a.id}/logs`)}>
                              <FileText className="size-4" />
                              Ver Logs
                            </DropdownMenuItem>
                            {canCreate && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem variant="destructive" onClick={() => setPendingDelete(a)}>
                                  <Trash2 className="size-4" />
                                  Excluir
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </DenseTable>
            )}
          </TableCard>
        </>
      )}

      <Dialog open={!!pendingDelete} onOpenChange={(v) => !v && setPendingDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Excluir automação</DialogTitle>
            <DialogDescription>
              Isso remove permanentemente{" "}
              <span className="text-foreground">{pendingDelete?.name}</span> e seu histórico de
              execução. Esta ação não pode ser desfeita.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingDelete(null)} disabled={deleting}>
              Cancelar
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleting}>
              {deleting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
              Excluir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageBody>
  )
}
