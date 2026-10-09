"use client";

// /disparador/controles — editar por número: vagas (max_in_flight), limite por hora e pausar/retomar.
// Toda mudança mostra o "antes → depois", pede o MOTIVO e confirmação, é auditada e vale no próximo tick
// (sem restart). Os ajustes globais (variáveis de ambiente) aparecem só para leitura, com explicação.
// Visual do redesenho DDM; o modelo continua por número (o protótipo global foi descartado — PRD 22, 3.4).

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, PauseCircle, PlayCircle, RefreshCw } from "lucide-react";

import { apiFetch } from "@/lib/api-fetch";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { PageBody, PageToolbar } from "@/components/ddm/page-toolbar";
import { StatusChip, type StatusTone } from "@/components/ddm/status-chip";
import { DenseTable, TableCard, Td, Th, Tr } from "@/components/ddm/table-card";
import { EmptyState, Skeleton } from "@/components/ddm/states";
import { formatInt, timeAgoPt } from "@/lib/disparador/monitor-format";
import type { LimitsOverview, NumberLimits, RateInfo } from "@/lib/disparador/limits";


const REASON_MIN = 5;
const REASON_MAX = 300;

interface Draft {
  maxInFlight: string;
  hourlyLimit: string;
}
interface PendingRequest {
  url: string;
  method: "PUT" | "POST";
  body: Record<string, unknown>;
}
interface Pending {
  number: NumberLimits;
  /** Monta a chamada com o motivo digitado (limites do canal → /limits; limite/s → /rate-limits). */
  request: (reason: string) => PendingRequest;
  lines: Array<{ label: string; before: string; after: string }>;
  warnings: string[];
}

const show = (v: number | null) => (v === null ? "sem limite" : formatInt(v));

async function readJson(res: Response) {
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.ok === false) throw new Error(body?.error || `Erro HTTP ${res.status}`);
  return body;
}

const SOURCE_LABEL: Record<string, string> = {
  webhook: "Aviso da Meta",
  poll: "Consulta automática",
  admin: "Alteração manual",
  revert_auto: "Voltou ao automático",
  policy: "Política da conta",
};


const QUALITY_LABEL: Record<string, string> = { GREEN: "Verde", YELLOW: "Amarela", RED: "Vermelha", UNKNOWN: "Sem leitura" };
const QUALITY_TONE: Record<string, StatusTone> = { GREEN: "ok", YELLOW: "warn", RED: "bad", UNKNOWN: "mute" };

function RateBlock(props: {
  number: NumberLimits;
  info: RateInfo | null;
  available: boolean;
  ceiling: number | null;
  draft: { rate: string; force: boolean };
  onDraft: (v: { rate: string; force: boolean }) => void;
  onReview: (n: NumberLimits, info: RateInfo) => void;
  onRevert: (n: NumberLimits, info: RateInfo) => void;
}) {
  const { number: n, info, available, ceiling, draft } = props;
  if (!available) {
    return (
      <p className="m-0 rounded-lg bg-surface-3 px-3 py-2 text-xs text-muted-foreground">
        Limite por segundo indisponível: aplique a migration 190 (limite por qualidade da Meta).
      </p>
    );
  }
  if (!info) {
    return <p className="m-0 rounded-lg bg-surface-3 px-3 py-2 text-xs text-muted-foreground">Sem leitura de qualidade para este número ainda.</p>;
  }
  const quality = info.quality ?? "UNKNOWN";
  const above = info.autoTargetPerSecond !== null && Number(draft.rate.replace(",", ".")) > info.autoTargetPerSecond;
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="m-0 font-sans text-[13px] font-semibold text-foreground">Limite por segundo</h4>
        <StatusChip tone={QUALITY_TONE[quality] ?? "mute"}>Qualidade {QUALITY_LABEL[quality] ?? quality}</StatusChip>
      </div>
      <dl className="m-0 grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-border bg-border text-xs">
        <div className="bg-card px-3 py-2">
          <dt className="text-muted-foreground">Automático</dt>
          <dd className="m-0 font-semibold tabular-nums text-foreground">
            {info.autoPerSecond ?? "—"}/s{info.ramping ? " (subindo)" : ""}
          </dd>
        </div>
        <div className="bg-card px-3 py-2">
          <dt className="text-muted-foreground">Manual</dt>
          <dd className="m-0 font-semibold tabular-nums text-foreground">
            {info.manualPerSecond !== null ? `${info.manualPerSecond}/s` : "—"}
          </dd>
        </div>
        <div className="bg-card px-3 py-2">
          <dt className="text-muted-foreground">Vale agora</dt>
          <dd className="m-0 text-sm font-semibold tabular-nums text-foreground">
            {info.effectivePerSecond ?? "—"}/s{info.inCooldown ? " (freio)" : ""}
          </dd>
        </div>
      </dl>
      {info.manualReason && info.manualPerSecond !== null && (
        <p className="m-0 text-[11.5px] text-muted-foreground">Motivo do manual: {info.manualReason}</p>
      )}
      {info.requiresOwnerConfirmation && (
        <p className="m-0 flex items-start gap-1.5 text-[11.5px] font-medium text-danger">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
          Qualidade vermelha: campanha nova neste número exige confirmação do owner.
        </p>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs font-medium text-foreground-2">
          Novo limite manual (envios/s{ceiling !== null ? `, até ${ceiling}` : ""})
          <Input
            inputMode="decimal"
            className="h-8 w-40"
            placeholder="Ex.: 40"
            value={draft.rate}
            onChange={(e) => props.onDraft({ ...draft, rate: e.target.value })}
          />
        </label>
        <Button variant="outline" disabled={draft.rate.trim() === ""} onClick={() => props.onReview(n, info)}>
          Revisar limite/s
        </Button>
        {info.manualPerSecond !== null && (
          <Button variant="ghost" onClick={() => props.onRevert(n, info)}>
            Voltar ao automático
          </Button>
        )}
      </div>
      {above && (
        <label className="flex items-start gap-2 text-[11.5px] text-muted-foreground">
          <input
            type="checkbox"
            className="mt-0.5 accent-[var(--primary)]"
            checked={draft.force}
            onChange={(e) => props.onDraft({ ...draft, force: e.target.checked })}
          />
          Manter acima do que a qualidade permite (somente o owner consegue; sem isso a API recusa).
        </label>
      )}
    </div>
  );
}

function HistoryCard({ overview }: { overview: LimitsOverview | null }) {
  const [now] = useState(() => Date.now());
  type Row = { id: string; at: string; numero: string | null; quem: string; mudanca: string; motivo: string | null };
  const rows: Row[] = [];
  for (const h of overview?.history ?? []) {
    rows.push({ id: `l-${h.id}`, at: h.createdAt, numero: h.numero, quem: h.userName ?? "—", mudanca: h.summary?.replace(/^Número [^:]*: /, "") ?? "—", motivo: h.reason });
  }
  for (const r of overview?.rateHistory ?? []) {
    const q = r.qualityOld !== r.qualityNew && r.qualityNew ? `qualidade ${QUALITY_LABEL[r.qualityOld ?? "UNKNOWN"] ?? r.qualityOld ?? "—"} → ${QUALITY_LABEL[r.qualityNew] ?? r.qualityNew}; ` : "";
    rows.push({
      id: `r-${r.id}`,
      at: r.createdAt,
      numero: r.numero,
      quem: SOURCE_LABEL[r.source] ?? r.source,
      mudanca: `${q}limite/s ${r.rateOld ?? "—"} → ${r.rateNew ?? "—"}`,
      motivo: r.reason,
    });
  }
  rows.sort((x, y) => Date.parse(y.at) - Date.parse(x.at));
  return (
    <TableCard
      title="Histórico de mudanças"
      hint="Vagas, limite por hora, pausa e limite por segundo (inclui quedas de qualidade da Meta), com quem fez e por quê."
    >
      {rows.length === 0 ? (
        <EmptyState className="m-4 mt-0" title="Nenhuma mudança registrada ainda" />
      ) : (
        <DenseTable minWidth={680}>
          <thead>
            <tr>
              <Th>Quando</Th>
              <Th>Número</Th>
              <Th>Quem</Th>
              <Th>Mudança</Th>
              <Th>Motivo</Th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 80).map((h) => (
              <Tr key={h.id} className="align-top">
                <Td className="whitespace-nowrap text-xs text-muted-foreground" title={new Date(h.at).toLocaleString("pt-BR")}>
                  {timeAgoPt(Math.max(0, Math.round((now - Date.parse(h.at)) / 1000)))}
                </Td>
                <Td className="font-semibold text-foreground">{h.numero ?? "—"}</Td>
                <Td>{h.quem}</Td>
                <Td className="text-xs">{h.mudanca}</Td>
                <Td className="text-xs text-muted-foreground">{h.motivo ?? "—"}</Td>
              </Tr>
            ))}
          </tbody>
        </DenseTable>
      )}
    </TableCard>
  );
}

export default function ControlesPage() {
  const [overview, setOverview] = useState<LimitsOverview | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [rateDrafts, setRateDrafts] = useState<Record<string, { rate: string; force: boolean }>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = (await readJson(await apiFetch("/api/disparador/limits"))) as LimitsOverview;
      setOverview(data);
      setDrafts((prev) => {
        const next: Record<string, Draft> = {};
        for (const n of data.numbers) {
          // Mantém o que a pessoa está digitando; só inicia quem ainda não tem rascunho.
          next[n.id] = prev[n.id] ?? { maxInFlight: String(n.effectiveMaxInFlight), hourlyLimit: n.hourlyLimit === null ? "" : String(n.hourlyLimit) };
        }
        return next;
      });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao carregar os controles");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setDraft = (id: string, patch: Partial<Draft>) =>
    setDrafts((d) => ({ ...d, [id]: { ...d[id], ...patch } }));

  const review = (n: NumberLimits) => {
    const d = drafts[n.id];
    const patch: { maxInFlight?: number; hourlyLimit?: number | null; paused?: boolean } = {};
    const lines: Pending["lines"] = [];
    const warnings: string[] = [];

    const vagas = Number(d.maxInFlight);
    if (!/^\d+$/.test(d.maxInFlight.trim()) || vagas < 1 || vagas > n.maxAllowed) {
      setError(`${n.label}: vagas devem ser um número de 1 a ${n.maxAllowed}.`);
      return;
    }
    if (vagas !== n.effectiveMaxInFlight) {
      patch.maxInFlight = vagas;
      lines.push({ label: "Vagas por número", before: String(n.effectiveMaxInFlight), after: String(vagas) });
      if (n.provider === "waha" && vagas > 4) warnings.push("WAHA com mais de 4 vagas aumenta o risco de banimento. Suba um número de cada vez e acompanhe o Monitor.");
      if (vagas > n.effectiveMaxInFlight * 2 && vagas >= 20) warnings.push("É mais que o dobro do valor atual. Suba em degraus e acompanhe o Monitor por 15–30 min.");
    }

    const horaTxt = d.hourlyLimit.trim();
    let hora: number | null = null;
    if (horaTxt !== "") {
      if (!/^\d+$/.test(horaTxt) || Number(horaTxt) < 1) {
        setError(`${n.label}: o limite por hora deve ser um número maior que zero (ou vazio, para sem limite).`);
        return;
      }
      hora = Number(horaTxt);
    }
    if (hora !== n.hourlyLimit) {
      patch.hourlyLimit = hora;
      lines.push({ label: "Limite por hora", before: show(n.hourlyLimit), after: show(hora) });
    }

    if (lines.length === 0) {
      setError(null);
      setNotice(`${n.label}: nenhuma mudança para salvar.`);
      return;
    }
    setError(null);
    setNotice(null);
    setReason("");
    setDialogError(null);
    setPending({ number: n, request: limitsRequest(n, patch), lines, warnings });
  };

  const reviewPause = (n: NumberLimits) => {
    const paused = !n.paused;
    setError(null);
    setNotice(null);
    setReason("");
    setDialogError(null);
    setPending({
      number: n,
      request: limitsRequest(n, { paused }),
      lines: [{ label: "Número", before: n.paused ? "pausado" : "ativo", after: paused ? "pausado" : "ativo" }],
      warnings: paused
        ? ["Itens já em envio terminam normalmente; os agendados ficam esperando e saem sozinhos quando você retomar. Nada é cancelado."]
        : [],
    });
  };

  const limitsRequest = (n: NumberLimits, patch: { maxInFlight?: number; hourlyLimit?: number | null; paused?: boolean }) =>
    (reason: string): PendingRequest => ({
      url: "/api/disparador/limits",
      method: "PUT",
      body: {
        sessionId: n.id,
        ...patch,
        reason,
        confirm: true,
        // O "antes" que a tela mostrou: se mudou no banco, a API recusa em vez de sobrescrever.
        expected: { maxInFlight: n.maxInFlight, hourlyLimit: n.hourlyLimit, paused: n.paused },
      },
    });

  const reviewRate = (n: NumberLimits, info: RateInfo) => {
    const d = rateDrafts[n.id] ?? { rate: "", force: false };
    const rate = Number(d.rate.replace(",", "."));
    const ceiling = overview?.rateCeiling ?? null;
    if (!Number.isFinite(rate) || rate <= 0 || (ceiling !== null && rate > ceiling)) {
      setError(`${n.label}: o limite por segundo deve ser maior que zero${ceiling !== null ? ` e no máximo ${ceiling}/s` : ""}.`);
      return;
    }
    const before = info.manualPerSecond !== null ? `${info.manualPerSecond}/s (manual)` : `${info.autoPerSecond ?? "?"}/s (automático)`;
    const warnings: string[] = [];
    const above = info.autoTargetPerSecond !== null && rate > info.autoTargetPerSecond;
    if (above) warnings.push(`Acima do que a qualidade da Meta recomenda hoje (${info.autoTargetPerSecond}/s). ${d.force ? "Você marcou manter acima da qualidade: só o owner consegue." : "Se a Meta limitar, o motor freia sozinho."}`);
    if (info.quality === "RED") warnings.push("A qualidade deste número está VERMELHA. Subir o ritmo pode agravar o bloqueio.");
    setError(null);
    setNotice(null);
    setReason("");
    setDialogError(null);
    setPending({
      number: n,
      lines: [{ label: "Limite por segundo", before, after: `${rate}/s (manual)` }],
      warnings,
      request: (reason) => ({
        url: "/api/disparador/rate-limits",
        method: "PUT",
        body: { session_id: n.id, rate_per_second: rate, reason, force_above_quality: above && d.force },
      }),
    });
  };

  const reviewRevert = (n: NumberLimits, info: RateInfo) => {
    setError(null);
    setNotice(null);
    setReason("");
    setDialogError(null);
    setPending({
      number: n,
      lines: [{ label: "Limite por segundo", before: `${info.manualPerSecond}/s (manual)`, after: `${info.autoPerSecond ?? "?"}/s (automático, pela qualidade)` }],
      warnings: [],
      request: (reason) => ({ url: `/api/disparador/rate-limits/${n.id}/revert-auto`, method: "POST", body: { reason } }),
    });
  };

  const confirm = async () => {
    if (!pending) return;
    const text = reason.trim();
    if (text.length < REASON_MIN) {
      setDialogError(`Informe o motivo (mínimo ${REASON_MIN} caracteres).`);
      return;
    }
    setSaving(true);
    setDialogError(null);
    try {
      const call = pending.request(text);
      await readJson(
        await apiFetch(call.url, {
          method: call.method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(call.body),
        }),
      );
      const id = pending.number.id;
      setPending(null);
      setNotice(`${pending.number.label}: mudança salva. Vale a partir do próximo ciclo do motor (até ~1 min), sem reiniciar.`);
      setDrafts((d) => {
        const rest = { ...d };
        delete rest[id];
        return rest;
      });
      setRateDrafts((d) => {
        const rest = { ...d };
        delete rest[id];
        return rest;
      });
      await load();
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : "Falha ao salvar");
    } finally {
      setSaving(false);
    }
  };

  const g = overview?.globals;
  const sim = (v: boolean) => (v ? "Ligado" : "Desligado");

  return (
    <PageBody>
      <PageToolbar
        actions={
          <Button variant="outline" onClick={() => void load()}>
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} aria-hidden="true" />
            Atualizar
          </Button>
        }
      >
        <p className="m-0 max-w-3xl text-[12.5px] text-muted-foreground">
          Ajuste cada número sem mexer em banco ou servidor. Toda mudança pede motivo, fica registrada e vale no próximo
          ciclo do motor.
        </p>
      </PageToolbar>

      {error && (
        <div role="alert" className="flex animate-ddm-fade items-start gap-2.5 rounded-lg bg-danger-soft px-3.5 py-2.5 text-[13px] text-foreground">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className="flex animate-ddm-fade items-start gap-2.5 rounded-lg bg-success-soft px-3.5 py-2.5 text-[13px] text-foreground">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
          {notice}
        </div>
      )}
      {overview && !overview.pauseSupported && (
        <div className="flex items-start gap-2.5 rounded-lg bg-warning-soft px-3.5 py-2.5 text-[13px] text-foreground">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
          Pausar número exige a migration 192, que ainda não foi aplicada neste banco. Vagas e limite por hora já funcionam.
        </div>
      )}

      {loading && !overview ? (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2" aria-busy="true" aria-label="Carregando controles">
          <Skeleton className="h-64 w-full rounded-[10px]" />
          <Skeleton className="h-64 w-full rounded-[10px]" />
        </div>
      ) : (
        <>
          {(overview?.numbers ?? []).length === 0 ? (
            <EmptyState title="Nenhum número cadastrado nesta conta" />
          ) : (
            <section aria-label="Controles por número" className="ddm-stagger-blocks grid grid-cols-1 gap-3 lg:grid-cols-2">
              {(overview?.numbers ?? []).map((n) => {
                const d = drafts[n.id] ?? { maxInFlight: String(n.effectiveMaxInFlight), hourlyLimit: n.hourlyLimit === null ? "" : String(n.hourlyLimit) };
                return (
                  <section
                    key={n.id}
                    aria-label={n.label}
                    className={cn(
                      "flex flex-col gap-4 rounded-[10px] border bg-card px-5 py-[18px]",
                      n.paused ? "border-warning-border" : "border-border",
                    )}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h3 className="m-0 truncate font-sans text-sm font-semibold text-foreground">{n.label}</h3>
                        <p className="m-0 text-[12.5px] text-muted-foreground">
                          {n.phone ?? "sem telefone"} ·{" "}
                          {n.provider === "meta" ? "API oficial (Meta)" : n.provider === "waha" ? "WAHA" : "provedor não definido"}
                        </p>
                      </div>
                      {n.paused && (
                        <StatusChip tone="warn">
                          <PauseCircle className="size-3" aria-hidden="true" /> Pausado
                        </StatusChip>
                      )}
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <label className="flex flex-col gap-1 text-xs font-medium text-foreground-2">
                        Vagas simultâneas (1 a {n.maxAllowed})
                        <Input
                          inputMode="numeric"
                          className="h-8"
                          value={d.maxInFlight}
                          onChange={(e) => setDraft(n.id, { maxInFlight: e.target.value })}
                        />
                        <span className="font-normal text-muted-foreground">
                          Hoje: {n.effectiveMaxInFlight} {n.hasRow ? "(definido no número)" : `(padrão do provedor: ${n.defaultMaxInFlight})`}.
                          {n.provider !== "meta" && " WAHA tem teto próprio, menor que o da Meta."}
                        </span>
                      </label>
                      <label className="flex flex-col gap-1 text-xs font-medium text-foreground-2">
                        Limite por hora do número
                        <Input
                          inputMode="numeric"
                          className="h-8"
                          placeholder="vazio = sem limite"
                          value={d.hourlyLimit}
                          onChange={(e) => setDraft(n.id, { hourlyLimit: e.target.value })}
                        />
                        <span className="font-normal text-muted-foreground">
                          Hoje: {show(n.hourlyLimit)}. Conta envios + em voo na última hora.
                        </span>
                      </label>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button onClick={() => review(n)}>Revisar mudança</Button>
                      <Button variant="outline" disabled={!overview?.pauseSupported} onClick={() => reviewPause(n)}>
                        {n.paused ? <PlayCircle className="size-3.5" aria-hidden="true" /> : <PauseCircle className="size-3.5" aria-hidden="true" />}
                        {n.paused ? "Retomar número" : "Pausar número"}
                      </Button>
                    </div>
                    {n.provider === "meta" && (
                      <RateBlock
                        number={n}
                        info={overview?.rate?.[n.id] ?? null}
                        available={overview?.rate != null}
                        ceiling={overview?.rateCeiling ?? null}
                        draft={rateDrafts[n.id] ?? { rate: "", force: false }}
                        onDraft={(v) => setRateDrafts((d) => ({ ...d, [n.id]: v }))}
                        onReview={reviewRate}
                        onRevert={reviewRevert}
                      />
                    )}
                  </section>
                );
              })}
            </section>
          )}

          {g && (
            <TableCard
              title="Ajustes globais (somente leitura)"
              hint="Vêm de variáveis de ambiente do servidor; mudar exige acesso à infraestrutura. Os controles acima já valem sem isso."
            >
              <dl className="m-0 grid grid-cols-1 gap-px border-t border-border bg-border md:grid-cols-2">
                {[
                  { k: `Concorrência global: ${g.processConcurrency}`, v: "Quantos envios o servidor mantém em andamento ao mesmo tempo, somando todos os números. Com vários números ativos, é este limite que manda." },
                  { k: `Orçamento do ciclo: ${g.tickBudgetSeconds} s`, v: "Tempo que cada ciclo do motor usa para iniciar envios; depois disso, só termina o que já começou." },
                  { k: `Ciclo encadeado: ${sim(g.tickChainEnabled)}`, v: "Ligado, um ciclo chama o próximo logo que termina, em vez de esperar o minuto seguinte." },
                  { k: `Claim em lote: ${sim(g.batchClaimEnabled)}`, v: "Ligado, o motor reserva vários itens de uma vez no banco (menos idas e vindas em volumes altos)." },
                  { k: `Freio automático: ${sim(g.adaptiveBackoff)}`, v: "Reduz sozinho a velocidade quando a Meta limita ou o servidor sofre." },
                  { k: `Vagas padrão sem ajuste: Meta ${g.perNumberDefaults.meta} · WAHA ${g.perNumberDefaults.waha}`, v: "Valem para o número que não tem vagas definidas aqui." },
                ].map((item) => (
                  <div key={item.k} className="bg-card px-[18px] py-3">
                    <dt className="text-[13px] font-semibold text-foreground">{item.k}</dt>
                    <dd className="m-0 mt-0.5 text-xs text-muted-foreground">{item.v}</dd>
                  </div>
                ))}
              </dl>
            </TableCard>
          )}

          <HistoryCard overview={overview} />
        </>
      )}

      <Dialog open={pending !== null} onOpenChange={(open) => !open && !saving && setPending(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Confirmar mudança — {pending?.number.label}</DialogTitle>
            <DialogDescription>Confira o antes e o depois, informe o motivo e confirme. Vale no próximo ciclo do motor.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 text-sm">
            <ul className="m-0 flex list-none flex-col gap-1.5 rounded-lg bg-surface-3 p-3">
              {pending?.lines.map((l) => (
                <li key={l.label} className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-foreground-2">{l.label}</span>
                  <span className="font-semibold tabular-nums text-foreground">
                    {l.before} → {l.after}
                  </span>
                </li>
              ))}
            </ul>
            {pending?.warnings.map((w) => (
              <p key={w} className="m-0 flex items-start gap-2 rounded-lg bg-warning-soft px-3 py-2 text-xs text-foreground">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden="true" />
                {w}
              </p>
            ))}
            <label className="flex flex-col gap-1 text-xs font-medium text-foreground-2">
              Motivo (obrigatório)
              <Textarea
                rows={3}
                maxLength={REASON_MAX}
                placeholder="Ex.: teste de capacidade com a campanha de cobrança de outubro"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            {dialogError && (
              <p role="alert" className="m-0 text-xs font-medium text-danger">
                {dialogError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)} disabled={saving}>
              Cancelar
            </Button>
            <Button onClick={() => void confirm()} disabled={saving || reason.trim().length < REASON_MIN}>
              {saving && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
              Confirmar e aplicar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageBody>
  );
}
