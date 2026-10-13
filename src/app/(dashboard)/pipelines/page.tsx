"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Pipeline, PipelineStage, Deal } from "@/types";
import { PipelineBoard } from "@/components/pipelines/pipeline-board";
import { PipelineSettings } from "@/components/pipelines/pipeline-settings";
import { DealForm } from "@/components/pipelines/deal-form";
import { PipelineAnalytics } from "@/components/pipelines/pipeline-analytics";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GitBranch, Plus, ChevronDown, Settings } from "lucide-react";
import { toast } from "sonner";
import { usePermission } from "@/hooks/use-permission";
import { useAuth } from "@/hooks/use-auth";
import { GatedButton } from "@/components/ui/gated-button";
import { ErrorState } from "@/components/ddm/states";

// Pipeline creation is admin-class (settings-tier write under
// the new RLS); deal creation is operational and only requires
// agent+. The two CTAs gate on different permissions (pipelines.manage
// x contacts.edit, via usePermission),
// not on different copy.

// Spec-defined seed — name and color per the product spec.
const SPEC_DEFAULT_STAGES = [
  { name: "Novo Lead", color: "#3b82f6", position: 0 }, // blue
  { name: "Qualificado", color: "#eab308", position: 1 }, // yellow
  { name: "Proposta Enviada", color: "#f97316", position: 2 }, // orange
  { name: "Negociação", color: "#8b5cf6", position: 3 }, // purple
  { name: "Ganho", color: "#22c55e", position: 4 }, // green
];

export default function PipelinesPage() {
  const supabase = createClient();
  const canEditSettings = usePermission("pipelines.manage");
  const canCreateDeals = usePermission("contacts.edit");
  const { accountId } = useAuth();

  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [selectedPipelineId, setSelectedPipelineId] = useState<string>("");
  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);
  // Falha ao ler os pipelines: mostra erro com retry em vez de "nenhum pipeline" (e não tenta criar o padrão).
  const [loadError, setLoadError] = useState(false);
  // Falha ao ler etapas/negócios do funil selecionado.
  const [boardError, setBoardError] = useState(false);

  // Dialog / sheet state
  const [newPipelineOpen, setNewPipelineOpen] = useState(false);
  const [newPipelineName, setNewPipelineName] = useState("");
  const [creating, setCreating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Deal form state is lifted here so both the top-bar "Add Deal" and
  // the per-column "+" trigger the same Sheet.
  const [dealFormOpen, setDealFormOpen] = useState(false);
  const [editingDeal, setEditingDeal] = useState<Deal | null>(null);
  const [defaultStageId, setDefaultStageId] = useState<string>("");

  // Guard against double-seeding (React StrictMode double-effect in dev).
  const seedAttempted = useRef(false);

  const loadPipelines = useCallback(async () => {
    const { data, error } = await supabase
      .from("pipelines")
      .select("*")
      .order("created_at");
    if (error) {
      console.error("Failed to load pipelines:", error.message);
      setLoadError(true);
      return null;
    }
    setLoadError(false);
    return data ?? [];
  }, [supabase]);

  // Retorna null em caso de erro (o chamador mostra ErrorState em vez de um quadro vazio).
  const loadStages = useCallback(
    async (pipelineId: string): Promise<PipelineStage[] | null> => {
      const { data, error } = await supabase
        .from("pipeline_stages")
        .select("*")
        .eq("pipeline_id", pipelineId)
        .order("position");
      if (error) {
        console.error("Failed to load stages:", error.message);
        return null;
      }
      return data ?? [];
    },
    [supabase],
  );

  // Paginado com .range(): o PostgREST corta em 1000 linhas sem avisar.
  const loadDeals = useCallback(
    async (pipelineId: string): Promise<Deal[] | null> => {
      const PAGE = 1000;
      const all: Deal[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from("deals")
          .select("*, contact:contacts(*), assignee:profiles!deals_assigned_to_fkey(id, user_id, full_name, avatar_url)")
          .eq("pipeline_id", pipelineId)
          .order("created_at", { ascending: false })
          .order("id")
          .range(from, from + PAGE - 1);
        if (error) {
          console.error("Failed to load deals:", error.message);
          return null;
        }
        const rows = (data ?? []) as Deal[];
        all.push(...rows);
        if (rows.length < PAGE) break;
      }
      return all;
    },
    [supabase],
  );

  const seedDefaultPipeline = useCallback(async (): Promise<Pipeline | null> => {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) return null;
    // pipelines.account_id is NOT NULL post-017 with no DB default.
    if (!accountId) return null;

    const { data: pipeline, error } = await supabase
      .from("pipelines")
      .insert({ user_id: user.id, account_id: accountId, name: "Pipeline de Vendas" })
      .select()
      .single();

    if (error || !pipeline) {
      console.error("Failed to seed pipeline:", error?.message);
      return null;
    }

    const stagesPayload = SPEC_DEFAULT_STAGES.map((s) => ({
      pipeline_id: pipeline.id,
      name: s.name,
      color: s.color,
      position: s.position,
    }));
    await supabase.from("pipeline_stages").insert(stagesPayload);

    return pipeline as Pipeline;
  }, [supabase, accountId]);

  // Initial load + seed-if-empty
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      let list = await loadPipelines();

      if (list && list.length === 0 && !seedAttempted.current) {
        seedAttempted.current = true;
        const seeded = await seedDefaultPipeline();
        if (seeded) list = await loadPipelines();
      }

      if (cancelled) return;
      if (list === null) {
        setLoading(false);
        return;
      }
      setPipelines(list);
      if (list.length > 0) {
        setSelectedPipelineId((prev) =>
          prev && list.some((p) => p.id === prev) ? prev : list[0].id,
        );
      } else {
        setSelectedPipelineId("");
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadPipelines, seedDefaultPipeline]);

  // Load stages + deals whenever selected pipeline changes.
  // Clearing on no-selection is a legitimate sync with URL/prop
  // state; the load completion uses async setters inside promise
  // callbacks (not synchronous in the effect body).
  useEffect(() => {
    if (!selectedPipelineId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStages([]);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDeals([]);
      return;
    }
    let cancelled = false;
    (async () => {
      if (accountId) {
        // Run deal aging automations in the background so the board is always up to date
        try {
          await supabase.rpc("run_all_deal_aging_rules", { p_account_id: accountId });
        } catch (err) {
          console.error("Failed to run deal aging rules:", err);
        }
      }
      const [s, d] = await Promise.all([
        loadStages(selectedPipelineId),
        loadDeals(selectedPipelineId),
      ]);
      if (cancelled) return;
      if (s === null || d === null) {
        setBoardError(true);
        return;
      }
      setBoardError(false);
      setStages(s);
      setDeals(d);
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedPipelineId, loadStages, loadDeals]);

  const refreshPipelines = useCallback(async () => {
    const list = await loadPipelines();
    if (list === null) return;
    setPipelines(list);
    if (list.length === 0) setSelectedPipelineId("");
    else if (!list.some((p) => p.id === selectedPipelineId))
      setSelectedPipelineId(list[0].id);
  }, [loadPipelines, selectedPipelineId]);

  const refreshStages = useCallback(async () => {
    if (!selectedPipelineId) return;
    const s = await loadStages(selectedPipelineId);
    if (s === null) {
      setBoardError(true);
      return;
    }
    setBoardError(false);
    setStages(s);
  }, [loadStages, selectedPipelineId]);

  const refreshDeals = useCallback(async () => {
    if (!selectedPipelineId) return;
    const d = await loadDeals(selectedPipelineId);
    if (d === null) {
      setBoardError(true);
      return;
    }
    setBoardError(false);
    setDeals(d);
  }, [loadDeals, selectedPipelineId]);

  const handleDealMoved = useCallback(
    async (dealId: string, newStageId: string) => {
      // Optimistic update — board already animated; just persist.
      setDeals((prev) =>
        prev.map((d) => (d.id === dealId ? { ...d, stage_id: newStageId } : d)),
      );
      const { error } = await supabase
        .from("deals")
        .update({ stage_id: newStageId })
        .eq("id", dealId);
      if (error) {
        toast.error("Falha ao mover negócio");
        refreshDeals();
      }
    },
    [supabase, refreshDeals],
  );

  const handleAddDeal = useCallback(
    (stageId?: string) => {
      setEditingDeal(null);
      setDefaultStageId(stageId ?? stages[0]?.id ?? "");
      setDealFormOpen(true);
    },
    [stages],
  );

  const handleEditDeal = useCallback((deal: Deal) => {
    setEditingDeal(deal);
    setDefaultStageId(deal.stage_id);
    setDealFormOpen(true);
  }, []);

  async function handleCreatePipeline() {
    const name = newPipelineName.trim();
    if (!name) return;
    setCreating(true);

    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) {
      setCreating(false);
      return;
    }
    // pipelines.account_id is NOT NULL post-017 with no DB default.
    if (!accountId) {
      toast.error("Seu perfil não está vinculado a uma conta.");
      setCreating(false);
      return;
    }

    const { data: pipeline, error } = await supabase
      .from("pipelines")
      .insert({ user_id: user.id, account_id: accountId, name })
      .select()
      .single();

    if (error || !pipeline) {
      toast.error("Falha ao criar pipeline");
      setCreating(false);
      return;
    }

    const stagesPayload = SPEC_DEFAULT_STAGES.map((s) => ({
      pipeline_id: pipeline.id,
      name: s.name,
      color: s.color,
      position: s.position,
    }));
    await supabase.from("pipeline_stages").insert(stagesPayload);

    setNewPipelineName("");
    setNewPipelineOpen(false);
    setSelectedPipelineId(pipeline.id);
    await refreshPipelines();
    setCreating(false);
    toast.success("Pipeline criado");
  }

  const selectedPipeline = pipelines.find((p) => p.id === selectedPipelineId);

  if (loadError && !loading && pipelines.length === 0) {
    return (
      <ErrorState
        title="Não foi possível carregar os pipelines"
        onRetry={() => {
          setLoading(true);
          void refreshPipelines().finally(() => setLoading(false));
        }}
      />
    );
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="h-8 w-48 animate-pulse rounded bg-muted" />
          <div className="h-9 w-28 animate-pulse rounded-lg bg-muted" />
        </div>
        <div className="flex gap-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-96 w-72 animate-pulse rounded-xl bg-muted/50" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Cabeçalho (redesenho DDM) */}
      <div className="flex flex-col gap-1.5 pt-1">
        <h2 className="font-heading text-[28px] font-semibold leading-tight tracking-[-0.025em] text-foreground">Pipelines</h2>
        <p className="max-w-[620px] text-sm leading-relaxed text-muted-foreground">Negócios por etapa · arraste para mover</p>
      </div>
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="flex items-center gap-3">
          {/* Pipeline selector dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-[12.5px] font-semibold text-foreground hover:bg-surface-hover data-[popup-open]:bg-surface-hover"
            >
              <GitBranch className="size-3.5 text-primary" />
              <span>
                {selectedPipeline?.name ?? "Selecionar Pipeline"}
              </span>
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="w-64 border-border bg-popover text-popover-foreground"
            >
              {pipelines.length === 0 && (
                <DropdownMenuItem disabled className="text-muted-foreground">
                  Nenhum pipeline ainda
                </DropdownMenuItem>
              )}
              {pipelines.map((p) => (
                <DropdownMenuItem
                  key={p.id}
                  onClick={() => setSelectedPipelineId(p.id)}
                  className={
                    p.id === selectedPipelineId
                      ? "text-primary"
                      : "text-popover-foreground"
                  }
                >
                  <GitBranch className="mr-2 h-3.5 w-3.5" />
                  {p.name}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator className="bg-border" />
              {selectedPipeline && (
                <DropdownMenuItem
                  onClick={() => setSettingsOpen(true)}
                  className="text-popover-foreground"
                >
                  <Settings className="mr-2 h-3.5 w-3.5" />
                  Gerenciar Pipelines
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <span className="flex-1" />
        <div className="flex items-center gap-2">
          <GatedButton
            variant="outline"
            canAct={canEditSettings}
            gateReason="criar pipelines"
            onClick={() => setNewPipelineOpen(true)}
          >
            <Plus className="size-3.5" />
            Adicionar pipeline
          </GatedButton>
          <GatedButton
            canAct={canCreateDeals}
            gateReason="criar negócios"
            disabled={!selectedPipelineId || stages.length === 0}
            onClick={() => handleAddDeal()}
          >
            <Plus className="size-3.5" />
            Adicionar negócio
          </GatedButton>
        </div>
      </div>

      {/* Board */}
      {pipelines.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-20">
          <GitBranch className="h-12 w-12 text-muted-foreground" />
          <h3 className="mt-4 text-lg font-medium text-foreground">
            Nenhum pipeline ainda
          </h3>
          <p className="mt-2 text-sm text-muted-foreground">
            Crie um pipeline para começar a acompanhar negócios
          </p>
          <GatedButton
            canAct={canEditSettings}
            gateReason="criar pipelines"
            onClick={() => setNewPipelineOpen(true)}
            className="mt-4 bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="mr-1 h-4 w-4" />
            Criar Pipeline
          </GatedButton>
        </div>
      ) : boardError ? (
        <ErrorState
          title="Não foi possível carregar as etapas e os negócios"
          onRetry={() => {
            void refreshStages();
            void refreshDeals();
          }}
        />
      ) : (
        <>
          <PipelineAnalytics stages={stages} deals={deals} />
          <PipelineBoard
            stages={stages}
            deals={deals}
            onDealMoved={handleDealMoved}
            onAddDeal={handleAddDeal}
            onEditDeal={handleEditDeal}
            canEdit={canCreateDeals}
          />
        </>
      )}

      {/* New Pipeline Dialog */}
      <Dialog open={newPipelineOpen} onOpenChange={setNewPipelineOpen}>
        <DialogContent className="sm:max-w-sm bg-popover border-border">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">Novo Pipeline</DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <Label htmlFor="new-pipeline-name" className="text-muted-foreground">Nome do Pipeline</Label>
            <Input
              id="new-pipeline-name"
              value={newPipelineName}
              onChange={(e) => setNewPipelineName(e.target.value)}
              placeholder="ex.: Vendas Corporativas"
              className="mt-2 bg-muted border-border text-foreground"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreatePipeline();
              }}
            />
            <p className="mt-2 text-xs text-muted-foreground">
              As etapas padrão (Novo Lead → Ganho) serão criadas automaticamente.
            </p>
          </div>
          <DialogFooter className="bg-popover/50 border-border">
            <Button
              variant="outline"
              onClick={() => setNewPipelineOpen(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              Cancelar
            </Button>
            <Button
              onClick={handleCreatePipeline}
              disabled={creating || !newPipelineName.trim()}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {creating ? "Criando..." : "Criar Pipeline"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Pipeline Settings */}
      {selectedPipeline && (
        <PipelineSettings
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          pipeline={selectedPipeline}
          stages={stages}
          onPipelinesChanged={refreshPipelines}
          onStagesChanged={refreshStages}
          onCreateNewPipeline={() => {
            setSettingsOpen(false);
            setNewPipelineOpen(true);
          }}
        />
      )}

      {/* Deal Form (Sheet) */}
      <DealForm
        open={dealFormOpen}
        onOpenChange={setDealFormOpen}
        deal={editingDeal}
        pipelineId={selectedPipelineId}
        stages={stages}
        defaultStageId={defaultStageId}
        onSaved={refreshDeals}
        readOnly={!canCreateDeals}
      />
    </div>
  );
}
