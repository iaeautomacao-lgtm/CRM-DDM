"use client";

import { windowError } from "@/lib/billing/client-validation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Segmented } from "@/components/ddm/segmented";
import { StatusChip, type StatusTone } from "@/components/ddm/status-chip";
import { DetailDrawer } from "@/components/ddm/list-with-drawer";
import { ErrorState } from "@/components/ddm/states";
import { StepsEditor, type TemplateOption } from "@/components/regua/steps-editor";
import { ReportPanel } from "@/components/regua/report-panel";
import { billingFetch, errorMessage } from "@/lib/billing/client-api";
import {
  ENROLLMENT_STATUS_LABEL,
  RULER_STATE_LABEL,
  STOP_REASON_LABEL,
  WEEKDAY_LABELS,
  formatOffset,
  rulerState,
  type DryRunResult,
  type Ruler,
  type RulerMetrics,
  type RulerState,
  type RulerStep,
  type StopReason,
} from "@/lib/billing/client-types";

export interface LineChoice {
  id: string;
  name: string;
  provider: "meta" | "waha" | null;
}

export const STATE_TONE: Record<RulerState, StatusTone> = { off: "mute", simulation: "warn", live: "ok" };

type DrawerTab = "config" | "steps" | "simulate" | "metrics" | "report";

const TAB_OPTIONS = [
  { value: "config", label: "Configuração" },
  { value: "steps", label: "Etapas" },
  { value: "simulate", label: "Simulação" },
  { value: "metrics", label: "Métricas" },
  { value: "report", label: "Relatório" },
] as const;

const SELECT_CLASS =
  "h-9 w-full rounded-md border border-border bg-card px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-[3px] focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-60";

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Gaveta da régua: Configuração (janela, dias, teto, tolerância, ligar/simular), Etapas, Simulação (dry-run, sem fila nem envio)
 * e Métricas. Quem só tem `billing.view` vê tudo em modo leitura; ações de escrita exigem `billing.manage`.
 */
export function RulerDrawer({
  rulerId,
  lines,
  canManage,
  onClose,
  onChanged,
  onDeleted,
}: {
  rulerId: string | null;
  lines: LineChoice[];
  canManage: boolean;
  onClose: () => void;
  /** Régua alterada (lista da página se atualiza). */
  onChanged: (ruler: Ruler) => void;
  onDeleted: (id: string) => void;
}) {
  const { accountId } = useAuth();
  const [tab, setTab] = useState<DrawerTab>("config");
  const [ruler, setRuler] = useState<Ruler | null>(null);
  const [steps, setSteps] = useState<RulerStep[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [templates, setTemplates] = useState<TemplateOption[]>([]);

  const load = useCallback(async () => {
    if (!rulerId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await billingFetch<{ ruler: Ruler; steps: RulerStep[] }>(`/rulers/${rulerId}`);
      setRuler(res.ruler);
      setSteps(res.steps);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [rulerId]);

  useEffect(() => {
    setTab("config");
    setRuler(null);
    setSteps([]);
    void load();
  }, [rulerId, load]);

  // Templates aprovados da conta (mesma fonte do seletor de templates do Disparador).
  useEffect(() => {
    if (!rulerId || !accountId) return;
    let cancelled = false;
    createClient()
      .from("message_templates")
      .select("id, name, body_text")
      .eq("account_id", accountId)
      .eq("status", "APPROVED")
      .order("name", { ascending: true })
      .then(({ data, error: err }) => {
        if (cancelled) return;
        if (err) console.error("[regua] failed to load templates:", err);
        else setTemplates((data ?? []) as TemplateOption[]);
      });
    return () => {
      cancelled = true;
    };
  }, [rulerId, accountId]);

  const provider = useMemo(() => lines.find((l) => l.id === ruler?.channel_id)?.provider ?? null, [lines, ruler?.channel_id]);

  const state = ruler ? rulerState(ruler) : null;

  return (
    <DetailDrawer
      open={!!rulerId}
      onOpenChange={(o) => !o && onClose()}
      title={ruler?.name ?? "Régua"}
      description={ruler ? `${ruler.steps_count ?? steps.length} etapa(s)` : undefined}
      headerExtra={state ? <StatusChip tone={STATE_TONE[state]}>{RULER_STATE_LABEL[state]}</StatusChip> : undefined}
      size="xl"
    >
      <div className="flex flex-col gap-4 p-5">
        <Segmented<DrawerTab> ariaLabel="Seção da régua" options={TAB_OPTIONS} value={tab} onChange={setTab} size="lg" className="self-start" />

        {loading && (
          <div className="flex flex-col gap-3" aria-busy="true">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-2/3" />
            <Skeleton className="h-24 w-full" />
          </div>
        )}
        {error && !loading && <ErrorState className="min-h-0" title="Não foi possível carregar a régua" hint={error} onRetry={() => void load()} />}

        {ruler && !loading && (
          <div key={tab} className="animate-ddm-fade">
            {tab === "config" && (
              <ConfigForm
                ruler={ruler}
                lines={lines}
                canManage={canManage}
                onSaved={(r) => {
                  setRuler((prev) => ({ ...r, steps_count: prev?.steps_count }));
                  onChanged({ ...r, steps_count: ruler.steps_count });
                }}
                onDeleted={() => onDeleted(ruler.id)}
              />
            )}
            {tab === "steps" && (
              <StepsEditor
                ruler={ruler}
                steps={steps}
                templates={templates}
                provider={provider}
                canManage={canManage}
                onSaved={(next) => {
                  setSteps(next);
                  const r = { ...ruler, steps_count: next.length };
                  setRuler(r);
                  onChanged(r);
                }}
              />
            )}
            {tab === "simulate" && <SimulatePanel ruler={ruler} canManage={canManage} />}
            {tab === "metrics" && <MetricsPanel ruler={ruler} />}
            {tab === "report" && <ReportPanel ruler={ruler} />}
          </div>
        )}
      </div>
    </DetailDrawer>
  );
}

// ── Configuração ───────────────────────────────────────────────────────────

function ConfigForm({
  ruler,
  lines,
  canManage,
  onSaved,
  onDeleted,
}: {
  ruler: Ruler;
  lines: LineChoice[];
  canManage: boolean;
  onSaved: (r: Ruler) => void;
  onDeleted: () => void;
}) {
  const [form, setForm] = useState(ruler);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => setForm(ruler), [ruler]);

  const set = <K extends keyof Ruler>(key: K, value: Ruler[K]) => setForm((f) => ({ ...f, [key]: value }));
  const toggleDay = (d: number) =>
    set("weekdays", form.weekdays.includes(d) ? form.weekdays.filter((x) => x !== d) : [...form.weekdays, d].sort((a, b) => a - b));

  const FIELDS = [
    "name",
    "active",
    "dry_run",
    "channel_id",
    "window_start",
    "window_end",
    "weekdays",
    "daily_cap_per_debtor",
    "tolerance_days",
    "pause_on_open_conversation",
    "priority",
  ] as const;
  const patch = Object.fromEntries(FIELDS.filter((k) => JSON.stringify(form[k]) !== JSON.stringify(ruler[k])).map((k) => [k, form[k]]));
  const dirty = Object.keys(patch).length > 0;
  const windowProblem = windowError(form.window_start, form.window_end);

  async function save() {
    if (windowProblem) return;
    setSaving(true);
    try {
      const res = await billingFetch<{ ruler: Ruler }>(`/rulers/${ruler.id}`, { method: "PATCH", body: patch });
      toast.success("Régua salva");
      onSaved(res.ruler);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    setDeleting(true);
    try {
      await billingFetch(`/rulers/${ruler.id}`, { method: "DELETE" });
      toast.success("Régua apagada");
      setConfirmDelete(false);
      onDeleted();
    } catch (err) {
      toast.error(errorMessage(err));
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  }

  const live = form.active && !form.dry_run;

  return (
    <div className="flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-xs text-foreground-2">
        Nome
        <Input value={form.name} maxLength={120} disabled={!canManage} onChange={(e) => set("name", e.target.value)} />
      </label>

      <label className="flex flex-col gap-1 text-xs text-foreground-2">
        Canal de envio
        <select className={SELECT_CLASS} value={form.channel_id ?? ""} disabled={!canManage} onChange={(e) => set("channel_id", e.target.value || null)}>
          <option value="">Nenhum</option>
          {lines.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
              {l.provider ? ` · ${l.provider === "meta" ? "Meta" : "WAHA"}` : ""}
            </option>
          ))}
        </select>
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-foreground-2">
          Janela: início (Brasília)
          <Input type="time" value={form.window_start} disabled={!canManage} aria-invalid={windowProblem ? true : undefined} aria-describedby={windowProblem ? "ruler-window-err" : undefined} onChange={(e) => set("window_start", e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-foreground-2">
          Janela: fim (Brasília)
          <Input type="time" value={form.window_end} disabled={!canManage} aria-invalid={windowProblem ? true : undefined} aria-describedby={windowProblem ? "ruler-window-err" : undefined} onChange={(e) => set("window_end", e.target.value)} />
        </label>
      </div>
      {windowProblem && (
        <p id="ruler-window-err" role="alert" className="-mt-2 text-xs text-danger">
          {windowProblem}
        </p>
      )}

      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-xs text-foreground-2">Dias de envio</legend>
        <div className="flex flex-wrap gap-1.5">
          {WEEKDAY_LABELS.map((label, d) => {
            const on = form.weekdays.includes(d);
            return (
              <button
                key={d}
                type="button"
                aria-pressed={on}
                disabled={!canManage}
                onClick={() => toggleDay(d)}
                className={
                  on
                    ? "h-8 min-w-11 rounded-md bg-primary-soft px-2.5 text-xs font-semibold text-primary-text disabled:opacity-70"
                    : "h-8 min-w-11 rounded-md border border-border bg-card px-2.5 text-xs font-medium text-foreground-2 hover:bg-surface-hover disabled:opacity-70"
                }
              >
                {label}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-xs text-foreground-2">
          Teto de mensagens por devedor/dia
          <Input type="number" min={1} max={10} value={form.daily_cap_per_debtor} disabled={!canManage} onChange={(e) => set("daily_cap_per_debtor", Number(e.target.value))} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-foreground-2">
          Tolerância de atraso (dias)
          <Input type="number" min={0} max={30} value={form.tolerance_days} disabled={!canManage} onChange={(e) => set("tolerance_days", Number(e.target.value))} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-foreground-2">
          Prioridade (menor vem antes)
          <Input type="number" min={0} max={10000} value={form.priority} disabled={!canManage} onChange={(e) => set("priority", Number(e.target.value))} />
        </label>
      </div>
      <p className="-mt-2 text-xs text-muted-foreground">
        Etapas atrasadas além da tolerância expiram em vez de sair juntas. A campanha manual conta no teto diário do devedor.
      </p>

      <div className="flex flex-col divide-y divide-border rounded-[10px] border border-border">
        <SwitchRow
          label="Pausar quando houver conversa aberta"
          hint="Se ligado, o devedor com conversa aberta não recebe a etapa."
          checked={form.pause_on_open_conversation}
          disabled={!canManage}
          onChange={(v) => set("pause_on_open_conversation", v)}
        />
        <SwitchRow
          label="Régua ligada"
          hint="Desligada, o motor não calcula nem enfileira nada."
          checked={form.active}
          disabled={!canManage}
          onChange={(v) => set("active", v)}
        />
        <SwitchRow
          label="Modo simulação (não envia)"
          hint="Com a régua ligada em simulação, o motor só mede. Desligue a simulação para enviar de verdade."
          checked={form.dry_run}
          disabled={!canManage}
          onChange={(v) => set("dry_run", v)}
        />
      </div>
      {live && (
        <p role="status" className="rounded-md bg-warning-soft px-3 py-2 text-xs text-warning">
          Ao salvar, a régua passa a enviar mensagens de verdade, dentro da janela e dos tetos configurados.
        </p>
      )}

      {canManage && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" className="text-danger" onClick={() => setConfirmDelete(true)}>
            Apagar régua
          </Button>
          <span className="flex-1" />
          <Button type="button" variant="ghost" disabled={!dirty || saving} onClick={() => setForm(ruler)}>
            Descartar
          </Button>
          <Button type="button" disabled={!dirty || saving || !!windowProblem} onClick={() => void save()}>
            {saving ? "Salvando…" : "Salvar"}
          </Button>
        </div>
      )}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apagar esta régua?</AlertDialogTitle>
            <AlertDialogDescription>
              Só é possível apagar régua desligada e sem histórico de cobrança. Esta ação não pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => void remove()} disabled={deleting}>
              {deleting ? "Apagando…" : "Apagar"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function SwitchRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-3 px-4 py-3">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </span>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} aria-label={label} />
    </label>
  );
}

// ── Simulação ──────────────────────────────────────────────────────────────

function SimulatePanel({ ruler, canManage }: { ruler: Ruler; canManage: boolean }) {
  const [date, setDate] = useState(todayIso);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<DryRunResult | null>(null);

  async function run() {
    setRunning(true);
    try {
      setResult(await billingFetch<DryRunResult>(`/rulers/${ruler.id}/dry-run`, { method: "POST", body: { date } }));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setRunning(false);
    }
  }

  if (!canManage) {
    return <p className="text-sm text-muted-foreground">A simulação é de quem gerencia a régua.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-foreground-2">Veja quantas dívidas teriam etapa em uma data. Nada é enviado nem enfileirado.</p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-foreground-2">
          Data
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <Button type="button" disabled={!date || running} onClick={() => void run()}>
          {running ? "Simulando…" : "Simular"}
        </Button>
      </div>
      {result && (
        <div className="overflow-hidden rounded-[10px] border border-border">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="bg-surface-3 text-left text-xs text-muted-foreground">
                <th className="px-4 py-2 font-semibold">Etapa</th>
                <th className="px-4 py-2 text-right font-semibold">Dívidas</th>
              </tr>
            </thead>
            <tbody>
              {result.steps.map((s) => (
                <tr key={s.step_id} className="border-t border-border">
                  <td className="px-4 py-2">{s.offset_days == null ? `Etapa ${s.position}` : formatOffset(s.offset_days)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{s.debts.toLocaleString("pt-BR")}</td>
                </tr>
              ))}
              {result.steps.length === 0 && (
                <tr className="border-t border-border">
                  <td colSpan={2} className="px-4 py-6 text-center text-muted-foreground">
                    Nenhuma etapa por dias ativa nesta régua.
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr className="border-t border-border bg-surface-3 font-semibold">
                <td className="px-4 py-2">Total</td>
                <td className="px-4 py-2 text-right tabular-nums">{result.total.toLocaleString("pt-BR")}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Métricas ───────────────────────────────────────────────────────────────

// Tom por situação do envio (o texto sempre acompanha a cor): ok = chegou, bad = falhou/bloqueado, warn = não saiu, info = a caminho.
const SEND_STATUS_TONE: Record<string, StatusTone> = {
  reserved: "info",
  enqueued: "info",
  sent: "ok",
  delivered: "ok",
  read: "ok",
  error: "bad",
  quality_blocked: "bad",
  cancelled: "mute",
  expired: "warn",
  deferred: "warn",
};

const SEND_STATUS_LABEL: Record<string, string> = {
  reserved: "Reservada",
  enqueued: "Na fila",
  sent: "Enviada",
  delivered: "Entregue",
  read: "Lida",
  error: "Erro",
  cancelled: "Cancelada",
  expired: "Expirada",
  deferred: "Adiada",
  quality_blocked: "Bloqueada pela qualidade do número",
};

function MetricsPanel({ ruler }: { ruler: Ruler }) {
  const [data, setData] = useState<RulerMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    billingFetch<RulerMetrics>(`/rulers/${ruler.id}/metrics`)
      .then((res) => {
        if (cancelled) return;
        setError(null);
        setData(res);
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [ruler.id, attempt]);

  if (error) return <ErrorState className="min-h-0" title="Não foi possível carregar as métricas" hint={error} onRetry={() => setAttempt((n) => n + 1)} />;
  if (!data) return <Skeleton className="h-32 w-full" />;

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-foreground">Envios por etapa</h3>
        {data.steps.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sem etapas.</p>
        ) : (
          data.steps.map((s) => (
            <div key={s.step_id} className="flex flex-wrap items-center gap-2 rounded-[10px] border border-border bg-card px-4 py-3">
              <span className="w-24 text-sm font-semibold text-foreground">{s.offset_days == null ? `Etapa ${s.position}` : formatOffset(s.offset_days)}</span>
              {!s.active && <StatusChip tone="mute">Inativa</StatusChip>}
              <span className="flex-1" />
              {Object.entries(s.by_status).map(([status, n]) => (
                <StatusChip key={status} tone={SEND_STATUS_TONE[status] ?? "mute"} dot={false}>
                  {SEND_STATUS_LABEL[status] ?? status}: {n.toLocaleString("pt-BR")}
                </StatusChip>
              ))}
              {s.total === 0 && <span className="text-xs text-muted-foreground">Nenhum envio</span>}
            </div>
          ))
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-foreground">Inscrições</h3>
        {data.enrollments.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhuma dívida inscrita.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {data.enrollments.map((e, i) => (
              <StatusChip key={`${e.status}-${e.stop_reason ?? ""}-${i}`} tone="mute" dot={false}>
                {ENROLLMENT_STATUS_LABEL[e.status as keyof typeof ENROLLMENT_STATUS_LABEL] ?? e.status}
                {e.stop_reason ? ` · ${STOP_REASON_LABEL[e.stop_reason as StopReason] ?? e.stop_reason}` : ""}: {e.total.toLocaleString("pt-BR")}
              </StatusChip>
            ))}
          </div>
        )}
      </section>

      <p className="text-xs text-muted-foreground">Respondidas e “pagas após cobrança” estão na aba Relatório.</p>
    </div>
  );
}
