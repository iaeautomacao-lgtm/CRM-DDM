"use client";

// ============================================================
// /regua — Régua de cobrança (PRD 17, visual do protótipo DDM).
// Lista de réguas + gaveta (configuração, etapas, simulação, métricas)
// e a lista de inscrições por dívida. Só usa /api/billing/* e /api/lines.
// O CONTEÚDO da régua (etapas, dias, textos, tetos) é da operação: a tela
// só edita; nada vem preenchido por padrão. Leitura = billing.view,
// escrita = billing.manage.
// ============================================================

import { useCallback, useEffect, useState } from "react";
import { CalendarClock, Plus } from "lucide-react";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api-fetch";
import { usePermissions } from "@/hooks/use-permission";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Segmented } from "@/components/ddm/segmented";
import { PageBody, PageToolbar } from "@/components/ddm/page-toolbar";
import { StatusChip } from "@/components/ddm/status-chip";
import { ListCard, ListRow } from "@/components/ddm/list-with-drawer";
import { EmptyState, ErrorState, ForbiddenState } from "@/components/ddm/states";
import { EnrollmentsTab } from "@/components/regua/enrollments-tab";
import { RulerDrawer, STATE_TONE, type LineChoice } from "@/components/regua/ruler-drawer";
import { billingFetch, errorMessage } from "@/lib/billing/client-api";
import {
  RULER_STATE_LABEL,
  WEEKDAY_LABELS,
  rulerState,
  type Ruler,
} from "@/lib/billing/client-types";

type View = "rulers" | "enrollments";

const VIEW_OPTIONS = [
  { value: "rulers", label: "Réguas" },
  { value: "enrollments", label: "Inscrições" },
] as const;

function windowSummary(r: Ruler): string {
  const days = r.weekdays.length === 7 ? "todos os dias" : r.weekdays.map((d) => WEEKDAY_LABELS[d]).join(", ");
  return `${r.window_start}–${r.window_end} · ${days}`;
}

/** Porta da página: precisa de billing.view (o servidor também confere em cada rota). */
export default function ReguaPage() {
  const { loading, can, canOpen } = usePermissions();
  if (loading) {
    return (
      <PageBody>
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-64 w-full" />
      </PageBody>
    );
  }
  if (!canOpen("/regua") || !can("billing.view")) {
    return (
      <PageBody>
        <ForbiddenState
          title="Você não tem acesso à Régua de cobrança"
          hint="Se precisar dela, peça a um administrador da organização."
        />
      </PageBody>
    );
  }
  return <ReguaBoard canManage={can("billing.manage")} />;
}

function ReguaBoard({ canManage }: { canManage: boolean }) {
  const [view, setView] = useState<View>("rulers");
  const [rulers, setRulers] = useState<Ruler[]>([]);
  const [lines, setLines] = useState<LineChoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await billingFetch<{ rulers: Ruler[] }>("/rulers");
      setRulers(res.rulers);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Linhas de WhatsApp da conta (Meta ou WAHA) para o seletor de canal.
  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/lines", { cache: "no-store" })
      .then((res) => res.json())
      .then((data: { lines?: Array<{ id: string; channel_type: string; provider: "meta" | "waha" | null; name: string }> }) => {
        if (cancelled) return;
        setLines(
          (data.lines ?? [])
            .filter((l) => l.channel_type === "whatsapp")
            .map((l) => ({ id: l.id, name: l.name, provider: l.provider })),
        );
      })
      .catch((err) => console.error("[regua] failed to load lines:", err));
    return () => {
      cancelled = true;
    };
  }, []);

  const lineName = (id: string | null) => (id ? lines.find((l) => l.id === id)?.name ?? "Canal" : "Sem canal");

  async function create() {
    const name = newName.trim();
    if (!name) return;
    setSaving(true);
    try {
      const res = await billingFetch<{ ruler: Ruler }>("/rulers", { method: "POST", body: { name } });
      setRulers((prev) => [...prev, { ...res.ruler, steps_count: 0 }]);
      setCreating(false);
      setNewName("");
      setSelectedId(res.ruler.id);
      toast.success("Régua criada, desligada e em simulação");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <PageBody>
      <div className="flex animate-ddm-up flex-col gap-1.5 pt-1">
        <h1 className="font-heading text-[28px] font-semibold leading-tight tracking-[-0.025em] text-foreground">
          Régua de cobrança
        </h1>
        <p className="max-w-[620px] text-sm leading-relaxed text-muted-foreground">
          Etapas automáticas por vencimento, que param sozinhas quando a dívida é paga ou o devedor pede para sair.
        </p>
      </div>

      <PageToolbar
        actions={
          canManage && view === "rulers" ? (
            <Button type="button" onClick={() => setCreating(true)}>
              <Plus className="size-4" />
              Nova régua
            </Button>
          ) : undefined
        }
      >
        <Segmented<View> ariaLabel="Visão da régua" options={VIEW_OPTIONS} value={view} onChange={setView} size="lg" />
      </PageToolbar>

      <div key={view} className="animate-ddm-fade">
        {view === "rulers" &&
          (error && !loading ? (
            <ErrorState className="min-h-0" title="Não foi possível carregar as réguas" hint={error} onRetry={() => void load()} />
          ) : loading ? (
            <div className="flex flex-col gap-2" aria-busy="true">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full rounded-[10px]" />
              ))}
            </div>
          ) : rulers.length === 0 ? (
            <EmptyState
              icon={CalendarClock}
              title="Nenhuma régua criada"
              hint={canManage ? "Crie uma régua para começar. Ela nasce desligada e em simulação." : "Peça a um administrador para criar a primeira régua."}
              className="min-h-48"
            />
          ) : (
            <ListCard>
              {rulers.map((r, i) => {
                const state = rulerState(r);
                return (
                  <ListRow key={r.id} index={i} label={r.name} selected={r.id === selectedId} onSelect={() => setSelectedId(r.id)}>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate font-semibold text-foreground">{r.name}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {lineName(r.channel_id)} · {windowSummary(r)}
                      </span>
                    </span>
                    <span className="hidden text-xs tabular-nums text-muted-foreground sm:inline">
                      {(r.steps_count ?? 0).toLocaleString("pt-BR")} {r.steps_count === 1 ? "etapa" : "etapas"}
                    </span>
                    <StatusChip tone={STATE_TONE[state]}>{RULER_STATE_LABEL[state]}</StatusChip>
                  </ListRow>
                );
              })}
            </ListCard>
          ))}

        {view === "enrollments" && <EnrollmentsTab rulers={rulers} canManage={canManage} />}
      </div>

      <RulerDrawer
        rulerId={selectedId}
        lines={lines}
        canManage={canManage}
        onClose={() => setSelectedId(null)}
        onChanged={(ruler) => setRulers((prev) => prev.map((r) => (r.id === ruler.id ? { ...r, ...ruler } : r)))}
        onDeleted={(id) => {
          setSelectedId(null);
          setRulers((prev) => prev.filter((r) => r.id !== id));
        }}
      />

      <Dialog open={creating} onOpenChange={(o) => !saving && setCreating(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nova régua</DialogTitle>
            <DialogDescription>
              A régua nasce desligada e em simulação. Configure o canal, a janela e as etapas antes de ligá-la.
            </DialogDescription>
          </DialogHeader>
          <label className="flex flex-col gap-1 text-xs text-foreground-2">
            Nome
            <Input
              autoFocus
              value={newName}
              maxLength={120}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void create();
              }}
            />
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={() => setCreating(false)}>
              Cancelar
            </Button>
            <Button type="button" disabled={saving || !newName.trim()} onClick={() => void create()}>
              {saving ? "Criando…" : "Criar régua"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageBody>
  );
}
