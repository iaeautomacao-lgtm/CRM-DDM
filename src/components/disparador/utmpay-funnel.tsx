"use client";

import { AttendantRanking, AttributionBar } from "@/components/utmpay/attribution-card";
import { ErrorState, Skeleton } from "@/components/ddm/states";
import { useUtmpayData } from "@/hooks/use-utmpay-data";
import { fetchFunil, fetchRanking, fmtPercent, type UtmpayFunil } from "@/lib/utmpay/client";
import { cn } from "@/lib/utils";

interface Step {
  key: string;
  label: string;
  value: number;
  rate: number | null;
  cls: string;
  hint: string;
}

/** Degraus do funil: entregues → clicou → fechou acordo → pagou (barras relativas às entregues). */
export function funnelSteps(f: UtmpayFunil): Step[] {
  return [
    { key: "entregues", label: "Entregues", value: f.entregues, rate: f.entregues > 0 ? 1 : null, cls: "bg-surface-3", hint: "Mensagens entregues ou lidas." },
    { key: "clicou", label: "Clicou", value: f.clicou, rate: f.taxas.clicou, cls: "bg-info-fill", hint: "Abriu o link rastreado (previews de WhatsApp e robôs não contam)." },
    { key: "fechou", label: "Fechou acordo", value: f.fechou, rate: f.taxas.fechou, cls: "bg-primary-solid", hint: "Iniciou o pagamento do acordo." },
    { key: "pagou", label: "Pagou", value: f.pagou, rate: f.taxas.pagou, cls: "bg-success-fill", hint: "Pagamento confirmado na API DDM." },
  ];
}

export function FunnelSteps({ funil }: { funil: UtmpayFunil }) {
  const steps = funnelSteps(funil);
  const base = Math.max(funil.entregues, ...steps.map((s) => s.value), 1);
  return (
    <ol className="flex flex-col gap-2.5" aria-label="Funil: entregues, clicou, fechou acordo, pagou">
      {steps.map((s) => (
        <li key={s.key} className="grid grid-cols-[110px_1fr_auto] items-center gap-3 text-[13px] max-sm:grid-cols-[90px_1fr_auto]">
          <span className="font-medium text-foreground" title={s.hint}>
            {s.label}
          </span>
          <span className="h-3 overflow-hidden rounded-full bg-surface-3" aria-hidden="true">
            <span className={cn("block h-full rounded-full", s.cls === "bg-surface-3" ? "bg-muted-foreground/40" : s.cls)} style={{ width: `${Math.max((s.value / base) * 100, s.value > 0 ? 1.5 : 0)}%` }} />
          </span>
          <span className="tabular-nums text-foreground">
            <strong>{s.value.toLocaleString("pt-BR")}</strong>
            {s.key !== "entregues" && <span className="ml-1.5 text-muted-foreground">{fmtPercent(s.rate)}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Funil da campanha com "quem fechou" e ranking. Some quando a conta não usa o UTMpay; avisa quando falta a migration. */
export function CampaignUtmpayFunnel({ campaignId }: { campaignId: string }) {
  const { state, reload } = useUtmpayData(campaignId, fetchFunil);

  if (!state || state.status === "loading") {
    return (
      <section aria-label="Funil do rastreamento" aria-busy="true" className="flex flex-col gap-3 rounded-card border border-border bg-card px-[18px] py-4">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-24 w-full" />
      </section>
    );
  }
  // 403 (sem permissão do Disparador) ou 404: não é erro para o usuário, a seção só não existe para ele.
  if (state.status === "error") {
    if (state.code === 403 || state.code === 404) return null;
    return <ErrorState title="Não foi possível carregar o funil do rastreamento" hint={state.message} onRetry={reload} />;
  }
  const f = state.data;
  if (!f.available) {
    return <p className="rounded-card border border-border bg-card px-[18px] py-3 text-[13px] text-muted-foreground">O rastreamento ainda não está disponível neste ambiente.</p>;
  }
  if (!f.tracking) return null;

  return (
    <section aria-label="Funil do rastreamento" className="flex flex-col gap-4 rounded-card border border-border bg-card px-[18px] py-4">
      <div>
        <h2 className="font-heading text-[15px] font-semibold text-foreground">Funil da campanha</h2>
        <p className="text-xs text-muted-foreground">
          {f.links.toLocaleString("pt-BR")} links rastreados, um por contato. Taxas sobre as mensagens entregues.
        </p>
      </div>
      <FunnelSteps funil={f} />
      <div className="grid gap-4 border-t border-border-soft pt-4 sm:grid-cols-2">
        <AttributionBar titulo="Quem fechou" valores={f.por_atribuicao.fechou} />
        <AttributionBar titulo="Quem pagou" valores={f.por_atribuicao.pagou} />
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="text-[13px] font-semibold text-foreground">Atendentes</h3>
        <AttendantRanking items={f.por_atendente} />
      </div>
    </section>
  );
}

const PERIODOS = [7, 30, 90] as const;

/** Ranking da conta (todas as campanhas com links criados no período), para a tela de Desempenho. */
export function AccountUtmpayRanking({ dias, onDiasChange }: { dias: number; onDiasChange?: (d: number) => void }) {
  const { state, reload } = useUtmpayData(String(dias), (d) => fetchRanking(Number(d)));

  if (!state || state.status === "loading") {
    return <Skeleton className="h-40 w-full rounded-card" aria-busy="true" />;
  }
  if (state.status === "error") {
    if (state.code === 403 || state.code === 404) return null;
    return <ErrorState title="Não foi possível carregar o ranking de acordos" hint={state.message} onRetry={reload} />;
  }
  const r = state.data;
  if (!r.available) return null;
  const vazio = r.fechou === 0 && r.pagou === 0 && r.por_atendente.length === 0;

  return (
    <section aria-label="Quem fechou acordos" className="flex flex-col gap-4 rounded-card border border-border bg-card px-[18px] py-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-heading text-[15px] font-semibold text-foreground">Quem fechou acordos</h2>
          <p className="text-xs text-muted-foreground">
            {r.fechou.toLocaleString("pt-BR")} acordos fechados e {r.pagou.toLocaleString("pt-BR")} pagos, nos links criados nos últimos {dias} dias.
          </p>
        </div>
        {onDiasChange && (
          <div role="group" aria-label="Período" className="inline-flex rounded-md bg-surface-3 p-0.5">
            {PERIODOS.map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={p === dias}
                onClick={() => onDiasChange(p)}
                className={cn("h-7 rounded-md px-2.5 text-[12.5px] font-medium", p === dias ? "bg-card text-foreground shadow-sm ring-1 ring-border" : "text-muted-foreground hover:text-foreground")}
              >
                {p} dias
              </button>
            ))}
          </div>
        )}
      </div>
      {vazio ? (
        <p className="text-[13px] text-muted-foreground">Ainda não há acordos fechados neste período.</p>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <AttributionBar titulo="Quem fechou" valores={r.por_atribuicao.fechou} />
            <AttributionBar titulo="Quem pagou" valores={r.por_atribuicao.pagou} />
          </div>
          <AttendantRanking items={r.por_atendente} />
        </>
      )}
    </section>
  );
}
