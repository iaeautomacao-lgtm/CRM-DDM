"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Workflow,
  Plus,
  Trash2,
  Pencil,
  Loader2,
  MessageSquare,
  HelpCircle,
  UserPlus,
  FileText,
  Copy,
  Download,
  Upload,
  Search,
  History,
  ChevronRight,
} from "lucide-react";

import { usePermission } from "@/hooks/use-permission";
import { apiFetch } from "@/lib/api-fetch";
import { Button } from "@/components/ui/button";
import { GatedButton } from "@/components/ui/gated-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import { CountUp } from "@/components/motion/count-up";
import { KpiStrip } from "@/components/ddm/kpi-strip";
import { PageBody, PageToolbar } from "@/components/ddm/page-toolbar";
import { Segmented } from "@/components/ddm/segmented";
import { StatusChip } from "@/components/ddm/status-chip";
import { CellMain, DenseTable, TableCard, Td, Th, Tr } from "@/components/ddm/table-card";
import { DetailDrawer } from "@/components/ddm/list-with-drawer";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/dashboard/error-state";

/**
 * Flows list page.
 *
 * Open to every authenticated user. Flows is in soft-GA — the "Beta"
 * chip in the header is the only remaining signal that the surface
 * is new. The previous per-account beta gate was removed in PR #134.
 */

interface FlowRow {
  id: string;
  name: string;
  description: string | null;
  status: "draft" | "active" | "archived";
  trigger_type: "keyword" | "first_inbound_message" | "manual";
  trigger_config: { keywords?: string[] } | Record<string, unknown>;
  execution_count: number;
  last_executed_at: string | null;
  created_at: string;
  updated_at: string;
}

const STATUS_LABELS: Record<FlowRow["status"], string> = {
  draft: "Rascunho",
  active: "Ativo",
  archived: "Arquivado",
};

interface TemplateSummary {
  slug: string;
  name: string;
  description: string;
  icon: "MessageSquare" | "HelpCircle" | "UserPlus";
  trigger_type: string;
  node_count: number;
}

const TEMPLATE_ICONS = {
  MessageSquare,
  HelpCircle,
  UserPlus,
} as const;

export default function FlowsPage() {
  const router = useRouter();
  const canCreate = usePermission("flows.edit");
  const [flows, setFlows] = useState<FlowRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [importing, setImporting] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | FlowRow["status"]>("all");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [flowsRes, tmplRes] = await Promise.all([
          apiFetch("/api/flows"),
          apiFetch("/api/flows/templates"),
        ]);
        if (!flowsRes.ok) {
          throw new Error(`Failed to load flows: ${flowsRes.status}`);
        }
        const flowsJson = (await flowsRes.json()) as { flows: FlowRow[] };
        if (!cancelled) setFlows(flowsJson.flows ?? []);
        // Templates endpoint is forward-looking — if it 404s on an
        // older deployment, gracefully fall through.
        if (tmplRes.ok) {
          const tmplJson = (await tmplRes.json()) as {
            templates: TemplateSummary[];
          };
          if (!cancelled) setTemplates(tmplJson.templates ?? []);
        }
      } catch (err) {
        if (!cancelled) {
          console.error(err);
          setLoadError(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  async function handleCreate() {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const res = await apiFetch("/api/flows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newName.trim(),
          trigger_type: "keyword",
          trigger_config: { keywords: [] },
        }),
      });
      if (!res.ok) throw new Error(`Falha ao criar: ${res.status}`);
      const json = (await res.json()) as { flow: FlowRow };
      setCreateOpen(false);
      setNewName("");
      router.push(`/flows/${json.flow.id}`);
    } catch (err) {
      console.error(err);
      toast.error("Não foi possível criar o fluxo.");
    } finally {
      setCreating(false);
    }
  }

  async function handleUseTemplate(slug: string) {
    setCreating(true);
    try {
      const res = await apiFetch("/api/flows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template_slug: slug }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? `Falha ao clonar: ${res.status}`);
      }
      const json = (await res.json()) as { flow: FlowRow };
      setCreateOpen(false);
      router.push(`/flows/${json.flow.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Falha ao clonar";
      toast.error(msg);
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(flow: FlowRow) {
    const yes = window.confirm(
      `Excluir "${flow.name}"? Todas as execuções ativas serão finalizadas imediatamente.`,
    );
    if (!yes) return;
    try {
      const res = await apiFetch(`/api/flows/${flow.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`Falha ao excluir: ${res.status}`);
      setFlows((prev) => prev.filter((f) => f.id !== flow.id));
      toast.success("Fluxo excluído.");
    } catch (err) {
      console.error(err);
      toast.error("Não foi possível excluir o fluxo.");
    }
  }

  async function handleExport(flow: FlowRow) {
    try {
      const res = await apiFetch(`/api/flows/${flow.id}/export`);
      if (!res.ok) throw new Error(`Falha ao exportar: ${res.status}`);
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition");
      const match = disposition?.match(/filename="([^"]+)"/);
      const filename = match?.[1] ?? `${flow.name}.json`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      toast.error("Não foi possível exportar o fluxo.");
    }
  }

  // Duplicar = exportar + importar como cópia (rascunho, sem canal ligado).
  async function handleDuplicate(flow: FlowRow) {
    try {
      const exp = await apiFetch(`/api/flows/${flow.id}/export`);
      if (!exp.ok) throw new Error(`Falha ao ler o fluxo: ${exp.status}`);
      const json = (await exp.json()) as Record<string, unknown>;
      const res = await apiFetch("/api/flows/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...json, mode: "duplicate" }),
      });
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error ?? `Falha ao duplicar: ${res.status}`);
      }
      const { flow_id } = (await res.json()) as { flow_id: string };
      toast.success("Cópia criada como rascunho.", {
        action: { label: "Editar", onClick: () => router.push(`/flows/${flow_id}`) },
      });
      const flowsRes = await apiFetch("/api/flows");
      if (flowsRes.ok) {
        const flowsJson = (await flowsRes.json()) as { flows: FlowRow[] };
        setFlows(flowsJson.flows ?? []);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível duplicar o fluxo.");
    }
  }

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setImporting(true);
    try {
      const text = await file.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error("Arquivo inválido: não é um JSON válido.");
      }

      const res = await apiFetch("/api/flows/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(json),
      });
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error ?? `Import failed: ${res.status}`);
      }
      const { flow_id } = (await res.json()) as { flow_id: string };

      toast.success("Fluxo importado com sucesso.", {
        action: {
          label: "Editar",
          onClick: () => router.push(`/flows/${flow_id}`),
        },
      });

      const flowsRes = await apiFetch("/api/flows");
      if (flowsRes.ok) {
        const flowsJson = (await flowsRes.json()) as { flows: FlowRow[] };
        setFlows(flowsJson.flows ?? []);
      }
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Falha ao importar fluxo.";
      toast.error(msg);
    } finally {
      setImporting(false);
    }
  }

  const counts = {
    all: flows.length,
    active: flows.filter((f) => f.status === "active").length,
    draft: flows.filter((f) => f.status === "draft").length,
    archived: flows.filter((f) => f.status === "archived").length,
  };
  const totalExecutions = flows.reduce((sum, f) => sum + (f.execution_count ?? 0), 0);
  const q = search.trim().toLowerCase();
  const visibleFlows = flows.filter(
    (f) =>
      (statusFilter === "all" || f.status === statusFilter) &&
      (!q || `${f.name} ${f.description ?? ""} ${describeTrigger(f)}`.toLowerCase().includes(q)),
  );
  const detailFlow = detailId ? flows.find((f) => f.id === detailId) ?? null : null;

  return (
    <PageBody>
      <div className="flex flex-col gap-1.5 pt-1">
        <div className="flex items-center gap-2">
          <h2 className="font-heading text-[28px] font-semibold leading-tight tracking-[-0.025em] text-foreground">Fluxos</h2>
          <StatusChip tone="warn">Beta</StatusChip>
        </div>
        <p className="max-w-[620px] text-sm leading-relaxed text-muted-foreground">
          Conversas ramificadas e orientadas por botões no WhatsApp — menus, FAQs e triagem antes do atendimento humano.
        </p>
      </div>

      {!loading && flows.length > 0 && (
        <KpiStrip
          ariaLabel="Resumo dos fluxos"
          items={[
            { label: "Fluxos", value: <CountUp value={counts.all} /> },
            { label: "Ativos", value: <CountUp value={counts.active} className="text-success" />, note: `de ${counts.all}` },
            { label: "Rascunhos", value: <CountUp value={counts.draft} /> },
            {
              label: "Execuções",
              value: <CountUp value={totalExecutions} />,
              info: "Total de execuções registradas em todos os fluxos desde a criação de cada um.",
            },
          ]}
        />
      )}

      <PageToolbar
        actions={
          <>
            <input ref={importInputRef} type="file" accept=".json" className="hidden" onChange={handleImportFile} />
            <GatedButton
              variant="outline"
              canAct={canCreate}
              gateReason="import flows"
              disabled={importing}
              onClick={() => importInputRef.current?.click()}
            >
              {importing ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
              Importar fluxo
            </GatedButton>
            <GatedButton canAct={canCreate} gateReason="create flows" onClick={() => setCreateOpen(true)}>
              <Plus className="size-3.5" />
              Novo fluxo
            </GatedButton>
          </>
        }
      >
        <label className="relative flex min-w-0 flex-[1_1_240px] items-center sm:max-w-[360px]">
          <Search className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground" aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar fluxo"
            aria-label="Buscar fluxos"
            className="h-[34px] w-full rounded-md border border-border bg-card pl-[34px] pr-2.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary focus:shadow-[0_0_0_3px_var(--primary-soft-2)]"
          />
        </label>
        <Segmented
          ariaLabel="Filtrar por status"
          size="lg"
          value={statusFilter}
          onChange={setStatusFilter}
          options={[
            { value: "all", label: "Todos", count: counts.all },
            { value: "active", label: "Ativos", count: counts.active },
            { value: "draft", label: "Rascunhos", count: counts.draft },
            { value: "archived", label: "Arquivados", count: counts.archived },
          ]}
        />
      </PageToolbar>

      {loading ? (
        <TableCard label="Fluxos">
          <div className="flex flex-col" aria-busy="true">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-3 border-b border-border px-[18px] py-3.5" aria-hidden="true">
                <Skeleton className="size-[30px] rounded-full" />
                <Skeleton className="h-3 w-48" />
                <Skeleton className="ml-auto h-5 w-20 rounded-full" />
              </div>
            ))}
          </div>
        </TableCard>
      ) : loadError ? (
        <ErrorState
          title="Não foi possível carregar os fluxos"
          onRetry={() => {
            setLoadError(false);
            setLoading(true);
            setReloadKey((k) => k + 1);
          }}
        />
      ) : flows.length === 0 ? (
        <EmptyState onCreate={() => setCreateOpen(true)} canCreate={canCreate} />
      ) : (
        <TableCard label="Fluxos">
          {visibleFlows.length === 0 ? (
            <div className="flex animate-ddm-fade flex-col items-center gap-1.5 px-4 py-12 text-center">
              <p className="text-[13.5px] font-semibold text-foreground">Nada encontrado</p>
              <p className="text-[12.5px] text-muted-foreground">Ajuste a busca ou o filtro.</p>
            </div>
          ) : (
            <DenseTable>
              <thead>
                <tr>
                  <Th>Fluxo</Th>
                  <Th>Status</Th>
                  <Th className="hidden lg:table-cell">Gatilho</Th>
                  <Th className="hidden md:table-cell" align="right">Execuções</Th>
                  <Th className="hidden xl:table-cell">Última execução</Th>
                  <Th className="hidden xl:table-cell">Atualizado</Th>
                  <Th className="w-11" />
                </tr>
              </thead>
              <tbody className="ddm-stagger">
                {visibleFlows.map((flow) => (
                  <Tr key={flow.id} onClick={() => setDetailId(flow.id)} className="cursor-pointer">
                    <Td className="max-w-[360px]">
                      <span className="flex min-w-0 items-center gap-2.5">
                        <span className="flex size-[30px] shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary-text" aria-hidden="true">
                          <Workflow className="size-3.5" />
                        </span>
                        <CellMain title={flow.name} sub={flow.description || undefined} />
                      </span>
                    </Td>
                    <Td>
                      <StatusChip tone={STATUS_TONE[flow.status]} dot>
                        {STATUS_LABELS[flow.status]}
                      </StatusChip>
                    </Td>
                    <Td className="hidden max-w-[280px] truncate text-foreground-2 lg:table-cell">{describeTrigger(flow)}</Td>
                    <Td className="hidden md:table-cell" align="right">
                      {(flow.execution_count ?? 0).toLocaleString("pt-BR")}
                    </Td>
                    <Td className="hidden whitespace-nowrap text-muted-foreground xl:table-cell">
                      {flow.last_executed_at ? relativeTime(flow.last_executed_at) : "—"}
                    </Td>
                    <Td className="hidden whitespace-nowrap text-muted-foreground xl:table-cell">{relativeTime(flow.updated_at)}</Td>
                    <Td className="pr-2 text-right text-muted-foreground">
                      <ChevronRight className="ml-auto size-4" aria-hidden="true" />
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </DenseTable>
          )}
        </TableCard>
      )}

      {/* Gaveta de detalhe (primitivo DetailDrawer). */}
      <DetailDrawer
        open={detailFlow !== null}
        onOpenChange={(open) => !open && setDetailId(null)}
        title={detailFlow?.name ?? ""}
        description={detailFlow?.description || "Fluxo"}
        headerExtra={
          detailFlow ? (
            <StatusChip tone={STATUS_TONE[detailFlow.status]} dot>
              {STATUS_LABELS[detailFlow.status]}
            </StatusChip>
          ) : undefined
        }
        footer={
          detailFlow ? (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                variant="ghost"
                className="mr-auto text-danger hover:bg-danger-soft hover:text-danger"
                onClick={() => {
                  setDetailId(null);
                  void handleDelete(detailFlow);
                }}
              >
                <Trash2 className="size-3.5" />
                Excluir
              </Button>
              <Button variant="outline" onClick={() => router.push(`/flows/${detailFlow.id}/runs`)}>
                <History className="size-3.5" />
                Execuções
              </Button>
              <Button onClick={() => router.push(`/flows/${detailFlow.id}`)}>
                <Pencil className="size-3.5" />
                Abrir editor
              </Button>
            </div>
          ) : undefined
        }
      >
        {detailFlow && (
          <div className="flex flex-col gap-4">
            <dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-[13px]">
              <dt className="text-muted-foreground">Gatilho</dt>
              <dd className="text-foreground">{describeTrigger(detailFlow)}</dd>
              <dt className="text-muted-foreground">Execuções</dt>
              <dd className="tabular-nums text-foreground">{(detailFlow.execution_count ?? 0).toLocaleString("pt-BR")}</dd>
              <dt className="text-muted-foreground">Última execução</dt>
              <dd className="text-foreground">{detailFlow.last_executed_at ? relativeTime(detailFlow.last_executed_at) : "—"}</dd>
              <dt className="text-muted-foreground">Criado</dt>
              <dd className="text-foreground">{relativeTime(detailFlow.created_at)}</dd>
              <dt className="text-muted-foreground">Atualizado</dt>
              <dd className="text-foreground">{relativeTime(detailFlow.updated_at)}</dd>
            </dl>
            <div className="flex flex-wrap gap-2 border-t border-border pt-4">
              {canCreate && (
                <Button variant="outline" size="sm" onClick={() => void handleDuplicate(detailFlow)}>
                  <Copy className="size-3.5" />
                  Duplicar
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => void handleExport(detailFlow)}>
                <Download className="size-3.5" />
                Exportar JSON
              </Button>
            </div>
          </div>
        )}
      </DetailDrawer>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        {/* `sm:max-w-4xl` not `max-w-4xl` — shadcn's DialogContent has
            `sm:max-w-sm` baked into its default classes. Without the
            sm: prefix our override applies at base only and the
            sm-scoped 384px wins at every real desktop breakpoint. */}
        <DialogContent className="sm:max-w-4xl bg-popover text-popover-foreground">
          <DialogHeader>
            <DialogTitle>Criar novo fluxo</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Comece a partir de um modelo ou crie do zero.
            </DialogDescription>
          </DialogHeader>

          {templates.length > 0 && (
            <div className="space-y-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                Comece a partir de um modelo
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {templates.map((t) => {
                  const Icon = TEMPLATE_ICONS[t.icon] ?? FileText;
                  return (
                    <button
                      key={t.slug}
                      type="button"
                      onClick={() => handleUseTemplate(t.slug)}
                      disabled={creating}
                      className="flex flex-col gap-2.5 rounded-lg border border-border bg-background p-4 text-left transition-colors hover:border-primary/40 hover:bg-muted disabled:opacity-50"
                    >
                      <Icon className="h-5 w-5 text-primary" />
                      <span className="text-sm font-semibold text-popover-foreground">
                        {t.name}
                      </span>
                      <span className="text-xs leading-relaxed text-muted-foreground">
                        {t.description}
                      </span>
                      <span className="mt-auto border-t border-border pt-2 text-[11px] text-muted-foreground">
                        {t.node_count} {t.node_count === 1 ? "nó" : "nós"}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="space-y-2 border-t border-border pt-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Ou comece do zero
            </p>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="ex.: Menu de boas-vindas"
              className="bg-muted"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
              }}
            />
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setCreateOpen(false)}
              disabled={creating}
            >
              Cancelar
            </Button>
            <Button onClick={handleCreate} disabled={!newName.trim() || creating}>
              {creating && <Loader2 className="h-4 w-4 animate-spin" />}
              Criar fluxo vazio
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageBody>
  );
}

function EmptyState({
  onCreate,
  canCreate,
}: {
  onCreate: () => void;
  canCreate: boolean;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-card/50 px-6 py-16 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted">
        <Workflow className="h-6 w-6 text-muted-foreground" />
      </div>
      <h2 className="mt-4 text-base font-medium text-foreground">
        Nenhum fluxo ainda
      </h2>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">
        Crie sua primeira conversa — um menu de boas-vindas, consulta de
        pedidos, bot de FAQ. O cliente toca nos botões e o fluxo direciona
        para a resposta certa (ou o agente certo).
      </p>
      <GatedButton
        canAct={canCreate}
        gateReason="create flows"
        onClick={onCreate}
        className="mt-5"
      >
        <Plus className="h-4 w-4" />
        Criar primeiro fluxo
      </GatedButton>
    </div>
  );
}


function describeTrigger(flow: FlowRow): string {
  if (flow.trigger_type === "keyword") {
    const keywords = Array.isArray(flow.trigger_config.keywords)
      ? (flow.trigger_config.keywords as string[])
      : [];
    if (keywords.length === 0) return "Disparado por palavra-chave (nenhuma definida)";
    return `Disparado por: ${keywords.join(", ")}`;
  }
  if (flow.trigger_type === "first_inbound_message") {
    return "Disparado pela primeira mensagem recebida do contato";
  }
  if ((flow.trigger_type as string) === "called_by_flow") return "Chamado por outro fluxo";
  return "Disparo manual";
}

const STATUS_TONE: Record<FlowRow["status"], "ok" | "mute"> = {
  active: "ok",
  draft: "mute",
  archived: "mute",
};

/** "há 3 dias", "agora" — tempo relativo em pt-BR. */
function relativeTime(iso: string): string {
  return formatDistanceToNow(new Date(iso), { addSuffix: true, locale: ptBR });
}
