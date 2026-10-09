"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Play, Trash2, Clock, GitCommit } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface StageOption {
  id: string;
  name: string;
  pipelineName: string;
}

interface AgingRule {
  id: string;
  source_stage_id: string;
  target_stage_id: string;
  days_limit: number;
}

export function PipelineAutomations() {
  const supabase = createClient();
  const { accountId, canEditSettings } = useAuth();

  const [stages, setStages] = useState<StageOption[]>([]);
  const [rules, setRules] = useState<AgingRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);

  // Form states
  const [sourceStageId, setSourceStageId] = useState("");
  const [targetStageId, setTargetStageId] = useState("");
  const [daysLimit, setDaysLimit] = useState(7);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (!accountId) return;
    fetchStagesAndRules();
  }, [accountId]);

  async function fetchStagesAndRules() {
    setLoading(true);
    try {
      // 1. Fetch pipelines and stages
      const { data: pipelinesData, error: pipelinesError } = await supabase
        .from("pipelines")
        .select("name, pipeline_stages(id, name, position)")
        .eq("account_id", accountId);

      if (pipelinesError) throw pipelinesError;

      const stageList: StageOption[] = [];
      pipelinesData?.forEach((p: any) => {
        const sortedStages = [...(p.pipeline_stages || [])].sort(
          (a, b) => a.position - b.position
        );
        sortedStages.forEach((s: any) => {
          stageList.push({
            id: s.id,
            name: s.name,
            pipelineName: p.name,
          });
        });
      });
      setStages(stageList);

      if (stageList.length >= 2) {
        setSourceStageId(stageList[0].id);
        setTargetStageId(stageList[1].id);
      }

      // 2. Fetch current rules
      const { data: rulesData, error: rulesError } = await supabase
        .from("deal_aging_rules")
        .select("*")
        .eq("account_id", accountId);

      if (rulesError) throw rulesError;
      setRules(rulesData || []);
    } catch (err) {
      console.error("Error loading CRM automations:", err);
      toast.error("Falha ao carregar automações do CRM");
    } finally {
      setLoading(false);
    }
  }

  async function handleAddRule(e: React.FormEvent) {
    e.preventDefault();
    if (!accountId || !sourceStageId || !targetStageId) return;

    if (sourceStageId === targetStageId) {
      toast.error("A etapa de origem deve ser diferente da etapa de destino");
      return;
    }

    if (daysLimit <= 0) {
      toast.error("O limite de dias deve ser maior que zero");
      return;
    }

    setAdding(true);
    const { error } = await supabase.from("deal_aging_rules").insert({
      account_id: accountId,
      source_stage_id: sourceStageId,
      target_stage_id: targetStageId,
      days_limit: daysLimit,
    });

    if (error) {
      toast.error("Falha ao criar regra");
    } else {
      toast.success("Regra de envelhecimento criada!");
      fetchStagesAndRules();
    }
    setAdding(false);
  }

  async function handleDeleteRule(id: string) {
    const { error } = await supabase
      .from("deal_aging_rules")
      .delete()
      .eq("id", id);

    if (error) {
      toast.error("Falha ao remover regra");
    } else {
      toast.success("Regra removida");
      setRules((prev) => prev.filter((r) => r.id !== id));
    }
  }

  async function handleRunNow() {
    if (!accountId) return;
    setRunning(true);
    const { data, error } = await supabase.rpc("run_all_deal_aging_rules", {
      p_account_id: accountId,
    });

    if (error) {
      toast.error("Falha ao executar regras");
    } else {
      const totalMoved = (data as any[])?.reduce(
        (sum, item) => sum + (item.moved_count || 0),
        0
      );
      toast.success(
        totalMoved > 0
          ? `${totalMoved} negócio(s) movido(s) com sucesso`
          : "Nenhum negócio pendente de envelhecimento"
      );
    }
    setRunning(false);
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
          <div>
            <CardTitle className="flex items-center gap-2 text-foreground">
              <Clock className="size-4 text-primary" />
              Regras de Envelhecimento de Cards (Pipeline)
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              Transfira automaticamente negócios entre colunas se eles ficarem estagnados por um determinado período.
            </CardDescription>
          </div>
          {rules.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleRunNow}
              disabled={running}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {running ? (
                <Loader2 className="size-3.5 animate-spin mr-1.5" />
              ) : (
                <Play className="size-3.5 mr-1.5" />
              )}
              Executar agora
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Create Rule Form */}
          {canEditSettings && stages.length >= 2 && (
            <form onSubmit={handleAddRule} className="p-4 rounded-lg border border-border bg-muted/40 space-y-4">
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <GitCommit className="size-4 text-primary" /> Nova Regra de Transição
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Se o negócio estiver na coluna:</Label>
                  <select
                    value={sourceStageId}
                    onChange={(e) => setSourceStageId(e.target.value)}
                    className="h-9 w-full rounded-lg border border-border bg-card px-2.5 text-xs text-foreground outline-none focus:border-primary"
                  >
                    {stages.map((s) => (
                      <option key={s.id} value={s.id}>
                        [{s.pipelineName}] — {s.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">E não receber atualizações por:</Label>
                  <div className="relative">
                    <Input
                      type="number"
                      min={1}
                      value={daysLimit}
                      onChange={(e) => setDaysLimit(Number(e.target.value))}
                      className="pr-12 text-xs"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">
                      dias
                    </span>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Mover para a coluna:</Label>
                  <select
                    value={targetStageId}
                    onChange={(e) => setTargetStageId(e.target.value)}
                    className="h-9 w-full rounded-lg border border-border bg-card px-2.5 text-xs text-foreground outline-none focus:border-primary"
                  >
                    {stages.map((s) => (
                      <option key={s.id} value={s.id}>
                        [{s.pipelineName}] — {s.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <Button
                type="submit"
                disabled={adding}
                size="sm"
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {adding && <Loader2 className="size-3.5 animate-spin mr-1.5" />}
                Adicionar Regra
              </Button>
            </form>
          )}

          {/* List of current Rules */}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-foreground">Regras Ativas</h3>
            {loading ? (
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <Loader2 className="size-4 animate-spin" />
                Carregando regras...
              </div>
            ) : rules.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nenhuma regra de envelhecimento cadastrada ainda.</p>
            ) : (
              <div className="divide-y divide-border rounded-lg border border-border overflow-hidden bg-card">
                {rules.map((rule) => {
                  const src = stages.find((s) => s.id === rule.source_stage_id);
                  const tgt = stages.find((s) => s.id === rule.target_stage_id);
                  return (
                    <div
                      key={rule.id}
                      className="flex items-center justify-between p-3 text-sm text-foreground hover:bg-muted/30"
                    >
                      <div className="min-w-0 flex-1 flex flex-wrap items-center gap-1 text-xs">
                        <span>Se parado em</span>
                        <span className="font-semibold text-primary">
                          {src ? `${src.name} (${src.pipelineName})` : "Desconhecida"}
                        </span>
                        <span>por</span>
                        <span className="font-semibold bg-muted px-1.5 py-0.5 rounded text-foreground">
                          {rule.days_limit} dias
                        </span>
                        <span>→ Mover para</span>
                        <span className="font-semibold text-success">
                          {tgt ? `${tgt.name} (${tgt.pipelineName})` : "Desconhecida"}
                        </span>
                      </div>
                      {canEditSettings && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => handleDeleteRule(rule.id)}
                          className="text-muted-foreground hover:text-danger hover:bg-danger-soft shrink-0"
                          aria-label="Excluir regra"
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
