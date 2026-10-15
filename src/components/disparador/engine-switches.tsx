"use client";

// Disparador → Controles: as 2 chaves do motor ("Envio em lote" e "Disparo contínuo"). Mostra o valor que o motor usa agora e DE ONDE ele vem
// (esta conta, outra conta, servidor ou padrão); só quem tem campaigns.rate_limit altera; ligar pede confirmação (afeta todas as campanhas em andamento).
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";

import { ConfirmDialog } from "@/components/ddm/confirm-dialog";
import { ErrorState, Skeleton } from "@/components/ddm/states";
import { StatusChip } from "@/components/ddm/status-chip";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { usePermission } from "@/hooks/use-permission";
import {
  ENGINE_COPY,
  ENGINE_KEYS,
  ENGINE_WARNING,
  describeAccount,
  describeSource,
  fetchEngine,
  saveEngine,
  stillOnMessage,
  wouldTurnOn,
  type EngineFlagKey,
  type EngineView,
} from "@/lib/disparador/engine-client";

type State = { status: "loading" } | { status: "ready"; view: EngineView } | { status: "hidden" } | { status: "error"; message: string };
type Feedback = { tone: "ok" | "warn" | "bad"; text: string } | null;

export function EngineSwitches() {
  const canEdit = usePermission("campaigns.rate_limit");
  const [state, setState] = useState<State>({ status: "loading" });
  const [busy, setBusy] = useState<EngineFlagKey | null>(null);
  const [confirm, setConfirm] = useState<{ key: EngineFlagKey; next: boolean | null } | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const load = useCallback(() => {
    setState({ status: "loading" });
    fetchEngine().then(
      (view) => setState({ status: "ready", view }),
      (e: { status?: number; message?: string }) =>
        // Sem permissão para ver (403): a seção simplesmente não existe para esta pessoa.
        setState(e.status === 403 ? { status: "hidden" } : { status: "error", message: e.message ?? "Não foi possível carregar agora." }),
    );
  }, []);
  useEffect(load, [load]);

  async function apply(key: EngineFlagKey, next: boolean | null) {
    setBusy(key);
    setFeedback(null);
    try {
      const view = await saveEngine({ [key]: next });
      setState({ status: "ready", view });
      const still = next !== true ? stillOnMessage(key, view) : null;
      setFeedback(
        still
          ? { tone: "warn", text: `Salvo, mas ${still}` }
          : { tone: "ok", text: `${ENGINE_COPY[key].title}: salvo. Vale no próximo ciclo do motor (em até cerca de 10 segundos).` },
      );
    } catch (e) {
      setFeedback({ tone: "bad", text: (e as Error)?.message ?? "Não foi possível salvar agora. Tente de novo." });
      throw e;
    } finally {
      setBusy(null);
    }
  }

  function request(key: EngineFlagKey, next: boolean | null, view: EngineView) {
    if (wouldTurnOn(key, view, next)) setConfirm({ key, next });
    else void apply(key, next).catch(() => {});
  }

  if (state.status === "hidden") return null;
  if (state.status === "loading") {
    return (
      <section aria-label="Motor de envio" aria-busy="true" className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Skeleton className="h-40 w-full rounded-card" />
        <Skeleton className="h-40 w-full rounded-card" />
      </section>
    );
  }
  if (state.status === "error") return <ErrorState className="min-h-0 py-4" title="Não foi possível carregar as chaves do motor" hint={state.message} onRetry={load} />;
  const view = state.view;

  return (
    <section aria-label="Motor de envio" className="flex flex-col gap-3">
      <div>
        <h2 className="font-heading text-[15px] font-semibold text-foreground">Motor de envio</h2>
        <p className="m-0 mt-0.5 max-w-3xl text-[12.5px] text-muted-foreground">Duas chaves que mudam como o motor tira as mensagens da fila. Os ajustes por número ficam logo abaixo.</p>
      </div>
      <p role="note" className="m-0 flex items-start gap-2.5 rounded-lg bg-warning-soft px-3.5 py-2.5 text-[13px] text-foreground">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
        {ENGINE_WARNING}
      </p>
      {feedback && (
        <p
          role="status"
          className={
            feedback.tone === "ok"
              ? "m-0 flex items-start gap-2.5 rounded-lg bg-success-soft px-3.5 py-2.5 text-[13px] text-foreground"
              : feedback.tone === "warn"
                ? "m-0 flex items-start gap-2.5 rounded-lg bg-warning-soft px-3.5 py-2.5 text-[13px] text-foreground"
                : "m-0 flex items-start gap-2.5 rounded-lg bg-danger-soft px-3.5 py-2.5 text-[13px] text-foreground"
          }
        >
          {feedback.tone === "ok" ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" /> : <AlertTriangle className={`mt-0.5 size-4 shrink-0 ${feedback.tone === "warn" ? "text-warning" : "text-danger"}`} aria-hidden="true" />}
          {feedback.text}
        </p>
      )}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {ENGINE_KEYS.map((key) => {
          const copy = ENGINE_COPY[key];
          const eff = view.effective[key];
          const src = describeSource(key, view);
          const id = `engine-${key}`;
          return (
            <article key={key} className="flex flex-col gap-3 rounded-card border border-border bg-card px-5 py-[18px]">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <label htmlFor={id} className="text-[14.5px] font-semibold text-foreground">
                    {copy.title}
                  </label>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <StatusChip tone={eff.enabled ? "ok" : "mute"}>{eff.enabled ? "Ligado agora" : "Desligado agora"}</StatusChip>
                    <StatusChip tone="info" dot={false} title={src.detail}>
                      Vem de: {src.label}
                    </StatusChip>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {busy === key && <Loader2 className="size-4 animate-spin text-primary" aria-label="Salvando" />}
                  <Switch id={id} checked={eff.enabled} disabled={!canEdit || busy !== null} onCheckedChange={(v) => request(key, v, view)} />
                </div>
              </div>
              <p className="m-0 text-[13px] leading-relaxed text-foreground-2">{copy.what}</p>
              <p className="m-0 text-[12.5px] text-muted-foreground">{copy.advice}</p>
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border-soft pt-3">
                <p className="m-0 text-[12.5px] text-muted-foreground">
                  {src.detail} {describeAccount(key, view)}
                </p>
                {canEdit && view.account[key] !== null && (
                  <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => request(key, null, view)}>
                    Voltar ao padrão do servidor
                  </Button>
                )}
              </div>
              {!canEdit && <p className="m-0 text-xs text-muted-foreground">Só quem pode ajustar os limites do Disparador altera estas chaves.</p>}
            </article>
          );
        })}
      </div>

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        destructive={false}
        title={confirm ? `Ligar “${ENGINE_COPY[confirm.key].title}”?` : ""}
        description={
          confirm ? (
            <>
              {ENGINE_COPY[confirm.key].what} <strong>Isto muda o motor para todas as campanhas em andamento, de todas as contas</strong>, em até cerca de 10 segundos. Você pode desligar depois, no mesmo lugar.
            </>
          ) : undefined
        }
        confirmLabel="Ligar"
        onConfirm={async () => {
          if (!confirm) return;
          const { key, next } = confirm;
          await apply(key, next);
          setConfirm(null);
        }}
      />
    </section>
  );
}
