"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { KpiStrip, type KpiItem } from "@/components/ddm/kpi-strip";
import { InfoHint } from "@/components/ddm/info-hint";
import { ErrorState } from "@/components/ddm/states";
import { billingFetch, errorMessage } from "@/lib/billing/client-api";
import {
  PAID_AFTER_NOTE,
  REPLIED_NOTE,
  formatAvgCharges,
  formatCivilDate,
  formatOffset,
  type Ruler,
  type RulerReport,
} from "@/lib/billing/client-types";

const n = (v: number) => v.toLocaleString("pt-BR");

/**
 * Relatório da régua por período (GET /api/billing/rulers/:id/report): totais, funil por etapa e pagamentos detectados.
 * Só os números que a API devolve; nada é calculado ou estimado aqui. Sem datas, a API usa os últimos 30 dias.
 */
export function ReportPanel({ ruler }: { ruler: Ruler }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [applied, setApplied] = useState<{ from: string; to: string }>({ from: "", to: "" });
  const [data, setData] = useState<RulerReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const qs = new URLSearchParams();
    if (applied.from) qs.set("from", applied.from);
    if (applied.to) qs.set("to", applied.to);
    billingFetch<RulerReport>(`/rulers/${ruler.id}/report${qs.size ? `?${qs.toString()}` : ""}`)
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
  }, [ruler.id, applied, attempt]);

  const reload = () => {
    setData(null);
    setError(null);
    setAttempt((x) => x + 1);
  };

  const kpis: KpiItem[] = data
    ? [
        { label: "Enviadas", value: n(data.totals.sent) },
        { label: "Entregues", value: n(data.totals.delivered) },
        { label: "Lidas", value: n(data.totals.read) },
        { label: "Respondidas", value: n(data.totals.replied), info: REPLIED_NOTE },
        { label: "Erros", value: n(data.totals.errors) },
        { label: "Pagas após cobrança", value: n(data.payments.paid_after_charge), info: PAID_AFTER_NOTE },
      ]
    : [];

  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setData(null);
          setError(null);
          setApplied({ from, to });
        }}
      >
        <label className="flex flex-col gap-1 text-xs text-foreground-2">
          De
          <Input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-foreground-2">
          Até
          <Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
        </label>
        <Button type="submit" variant="outline">
          Aplicar
        </Button>
        <span className="text-xs text-muted-foreground">Sem datas, mostra os últimos 30 dias (máximo de 93).</span>
      </form>

      {error && <ErrorState className="min-h-0" title="Não foi possível carregar o relatório" hint={error} onRetry={reload} />}
      {!data && !error && (
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      )}

      {data && (
        <>
          <p className="text-xs text-muted-foreground">
            Período: {formatCivilDate(data.from)} a {formatCivilDate(data.to)}
          </p>
          <KpiStrip items={kpis} ariaLabel="Totais da régua no período" minWidth={140} />

          <section className="flex flex-col gap-2">
            <h3 className="flex items-center gap-1 text-sm font-semibold text-foreground">
              Por etapa
              <InfoHint label="Sobre pagas após cobrança">{PAID_AFTER_NOTE}</InfoHint>
            </h3>
            <div className="overflow-x-auto rounded-[10px] border border-border">
              <table className="w-full min-w-[560px] border-collapse text-[13px]">
                <thead>
                  <tr className="bg-surface-3 text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2 font-semibold">Etapa</th>
                    <th className="px-3 py-2 text-right font-semibold">Enviadas</th>
                    <th className="px-3 py-2 text-right font-semibold">Entregues</th>
                    <th className="px-3 py-2 text-right font-semibold">Lidas</th>
                    <th className="px-3 py-2 text-right font-semibold">Respondidas</th>
                    <th className="px-3 py-2 text-right font-semibold">Erros</th>
                    <th className="px-3 py-2 text-right font-semibold">Pagas após cobrança</th>
                  </tr>
                </thead>
                <tbody>
                  {data.steps.map((s) => (
                    <tr key={s.step_id} className="border-t border-border">
                      <td className="px-3 py-2 font-medium text-foreground">
                        {s.offset_days == null ? `Etapa ${s.position}` : formatOffset(s.offset_days)}
                        {!s.active && <span className="ml-1.5 text-xs font-normal text-muted-foreground">(inativa)</span>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{n(s.sent)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{n(s.delivered)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{n(s.read)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{n(s.replied)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{n(s.errors)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{n(s.paid_after)}</td>
                    </tr>
                  ))}
                  {data.steps.length === 0 && (
                    <tr className="border-t border-border">
                      <td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">
                        Sem etapas nesta régua.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-foreground">Pagamentos detectados</h3>
            <dl className="grid gap-2 sm:grid-cols-3">
              <div className="rounded-[10px] border border-border bg-card px-4 py-3">
                <dt className="text-xs text-muted-foreground">Pagas após cobrança</dt>
                <dd className="text-lg font-semibold tabular-nums text-foreground">{n(data.payments.paid_after_charge)}</dd>
              </div>
              <div className="rounded-[10px] border border-border bg-card px-4 py-3">
                <dt className="text-xs text-muted-foreground">Pagas sem cobrança</dt>
                <dd className="text-lg font-semibold tabular-nums text-foreground">{n(data.payments.paid_without_charge)}</dd>
              </div>
              <div className="rounded-[10px] border border-border bg-card px-4 py-3">
                <dt className="text-xs text-muted-foreground">Média de cobranças até o pagamento</dt>
                <dd className="text-lg font-semibold tabular-nums text-foreground">
                  {formatAvgCharges(data.payments.avg_charges_before_payment)}
                </dd>
              </div>
            </dl>
            {data.payments.by_charges.length > 0 && (
              <ul className="flex flex-wrap gap-2 text-xs text-foreground-2">
                {data.payments.by_charges.map((b) => (
                  <li key={b.charges} className="rounded-full bg-surface-3 px-2.5 py-1">
                    {b.charges} {b.charges === 1 ? "cobrança" : "cobranças"} até pagar: <span className="font-semibold tabular-nums">{n(b.total)}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-muted-foreground">{PAID_AFTER_NOTE}</p>
          </section>

          {data.daily.length > 0 && (
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold text-foreground">Por dia</h3>
              <div className="max-h-64 overflow-y-auto rounded-[10px] border border-border">
                <table className="w-full border-collapse text-[13px]">
                  <thead className="sticky top-0">
                    <tr className="bg-surface-3 text-left text-xs text-muted-foreground">
                      <th className="px-3 py-2 font-semibold">Dia</th>
                      <th className="px-3 py-2 text-right font-semibold">Enviadas</th>
                      <th className="px-3 py-2 text-right font-semibold">Pagas após cobrança</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.daily.map((d) => (
                      <tr key={d.day} className="border-t border-border">
                        <td className="px-3 py-1.5 tabular-nums">{formatCivilDate(d.day)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{n(d.sent)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{n(d.paid_after)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
