"use client";

// /disparador/controles — editar por número: vagas (max_in_flight), limite por hora e pausar/retomar.
// Toda mudança mostra o "antes → depois", pede o MOTIVO e confirmação, é auditada e vale no próximo tick
// (sem restart). Os ajustes globais (variáveis de ambiente) aparecem só para leitura, com explicação.

import { useCallback, useEffect, useState } from "react";
import { Loader2, PauseCircle, PlayCircle, RefreshCw, SlidersHorizontal } from "lucide-react";

import { apiFetch } from "@/lib/api-fetch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
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

const QUALITY_LABEL: Record<string, string> = { GREEN: "Verde", YELLOW: "Amarela", RED: "Vermelha", UNKNOWN: "Sem leitura" };
const QUALITY_CLASS: Record<string, string> = {
  GREEN: "border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
  YELLOW: "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200",
  RED: "border-rose-500/40 bg-rose-500/10 text-rose-800 dark:text-rose-200",
};
const SOURCE_LABEL: Record<string, string> = {
  webhook: "Aviso da Meta",
  poll: "Consulta automática",
  admin: "Alteração manual",
  revert_auto: "Voltou ao automático",
  policy: "Política da conta",
};

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
      <p className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
        Limite por segundo indisponível: aplique a migration 190 (limite por qualidade da Meta).
      </p>
    );
  }
  if (!info) {
    return <p className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">Sem leitura de qualidade para este número ainda.</p>;
  }
  const quality = info.quality ?? "UNKNOWN";
  const above = info.autoTargetPerSecond !== null && Number(draft.rate.replace(",", ".")) > info.autoTargetPerSecond;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold">Limite por segundo</h3>
        <Badge variant="outline" className={QUALITY_CLASS[quality]}>
          Qualidade {QUALITY_LABEL[quality] ?? quality}
        </Badge>
      </div>
      <dl className="grid grid-cols-3 gap-2 text-xs">
        <div>
          <dt className="text-muted-foreground">Automático</dt>
          <dd className="font-medium tabular-nums">{info.autoPerSecond ?? "—"}/s{info.ramping ? " (subindo)" : ""}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Manual</dt>
          <dd className="font-medium tabular-nums">{info.manualPerSecond !== null ? `${info.manualPerSecond}/s` : "—"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Vale agora</dt>
          <dd className="font-bold tabular-nums">
            {info.effectivePerSecond ?? "—"}/s{info.inCooldown ? " (freio)" : ""}
          </dd>
        </div>
      </dl>
      {info.manualReason && info.manualPerSecond !== null && <p className="text-[11px] text-muted-foreground">Motivo do manual: {info.manualReason}</p>}
      {info.requiresOwnerConfirmation && <p className="text-[11px] text-rose-700 dark:text-rose-300">Qualidade vermelha: campanha nova neste número exige confirmação do owner.</p>}
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs font-medium">
          Novo limite manual (envios/s{ceiling !== null ? `, até ${ceiling}` : ""})
          <Input
            inputMode="decimal"
            className="h-9 w-40"
            placeholder="Ex.: 40"
            value={draft.rate}
            onChange={(e) => props.onDraft({ ...draft, rate: e.target.value })}
          />
        </label>
        <Button size="sm" variant="outline" className="h-9 text-xs" disabled={draft.rate.trim() === ""} onClick={() => props.onReview(n, info)}>
          Revisar limite/s
        </Button>
        {info.manualPerSecond !== null && (
          <Button size="sm" variant="ghost" className="h-9 text-xs" onClick={() => props.onRevert(n, info)}>
            Voltar ao automático
          </Button>
        )}
      </div>
      {above && (
        <label className="flex items-start gap-2 text-[11px] text-muted-foreground">
          <input type="checkbox" className="mt-0.5" checked={draft.force} onChange={(e) => props.onDraft({ ...draft, force: e.target.checked })} />
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
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Histórico de mudanças</CardTitle>
        <CardDescription className="text-xs">Vagas, limite por hora, pausa e limite por segundo (inclui quedas de qualidade da Meta), com quem fez e por quê.</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        {rows.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">Nenhuma mudança registrada ainda.</p>
        ) : (
          <table className="w-full min-w-[640px] text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-2 pr-3 font-medium">Quando</th>
                <th className="py-2 pr-3 font-medium">Número</th>
                <th className="py-2 pr-3 font-medium">Quem</th>
                <th className="py-2 pr-3 font-medium">Mudança</th>
                <th className="py-2 font-medium">Motivo</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 80).map((h) => (
                <tr key={h.id} className="border-t border-border/60 align-top">
                  <td className="whitespace-nowrap py-2 pr-3 text-xs text-muted-foreground" title={new Date(h.at).toLocaleString("pt-BR")}>
                    {timeAgoPt(Math.max(0, Math.round((now - Date.parse(h.at)) / 1000)))}
                  </td>
                  <td className="py-2 pr-3">{h.numero ?? "—"}</td>
                  <td className="py-2 pr-3">{h.quem}</td>
                  <td className="py-2 pr-3 text-xs">{h.mudanca}</td>
                  <td className="py-2 text-xs text-muted-foreground">{h.motivo ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
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
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-4 lg:p-6">
      <div className="flex flex-col justify-between gap-3 border-b border-border/60 pb-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight sm:text-2xl">
            <SlidersHorizontal className="h-6 w-6 text-primary" aria-hidden="true" />
            Controles do disparador
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Ajuste cada número sem mexer em banco ou servidor. Toda mudança pede motivo, fica registrada e vale no próximo ciclo do motor.
          </p>
        </div>
        <Button variant="outline" size="sm" className="h-9 gap-1.5 text-xs" onClick={() => void load()}>
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} aria-hidden="true" />
          Atualizar
        </Button>
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-800 dark:text-rose-200">
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-800 dark:text-emerald-200">
          {notice}
        </div>
      )}
      {overview && !overview.pauseSupported && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
          Pausar número exige a migration 192, que ainda não foi aplicada neste banco. Vagas e limite por hora já funcionam.
        </div>
      )}

      {loading && !overview ? (
        <div className="flex h-40 items-center justify-center text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden="true" /> Carregando…
        </div>
      ) : (
        <>
          <section aria-label="Controles por número" className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {(overview?.numbers ?? []).map((n) => {
              const d = drafts[n.id] ?? { maxInFlight: String(n.effectiveMaxInFlight), hourlyLimit: n.hourlyLimit === null ? "" : String(n.hourlyLimit) };
              return (
                <Card key={n.id} className={cn("shadow-sm", n.paused && "border-amber-500/50")}>
                  <CardHeader className="pb-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <CardTitle className="text-base">{n.label}</CardTitle>
                        <CardDescription className="text-xs">
                          {n.phone ?? "sem telefone"} · {n.provider === "meta" ? "API oficial (Meta)" : n.provider === "waha" ? "WAHA" : "provedor não definido"}
                        </CardDescription>
                      </div>
                      {n.paused && (
                        <Badge variant="outline" className="gap-1 border-amber-500/50 bg-amber-500/10 text-amber-800 dark:text-amber-200">
                          <PauseCircle className="h-3 w-3" aria-hidden="true" /> Pausado
                        </Badge>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <label className="flex flex-col gap-1 text-xs font-medium">
                        Vagas simultâneas (1 a {n.maxAllowed})
                        <Input
                          inputMode="numeric"
                          className="h-9"
                          value={d.maxInFlight}
                          onChange={(e) => setDraft(n.id, { maxInFlight: e.target.value })}
                        />
                        <span className="font-normal text-muted-foreground">
                          Hoje: {n.effectiveMaxInFlight} {n.hasRow ? "(definido no número)" : `(padrão do provedor: ${n.defaultMaxInFlight})`}.
                          {n.provider !== "meta" && " WAHA tem teto próprio, menor que o da Meta."}
                        </span>
                      </label>
                      <label className="flex flex-col gap-1 text-xs font-medium">
                        Limite por hora do número
                        <Input
                          inputMode="numeric"
                          className="h-9"
                          placeholder="vazio = sem limite"
                          value={d.hourlyLimit}
                          onChange={(e) => setDraft(n.id, { hourlyLimit: e.target.value })}
                        />
                        <span className="font-normal text-muted-foreground">Hoje: {show(n.hourlyLimit)}. Conta envios + em voo na última hora.</span>
                      </label>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" className="h-9 text-xs" onClick={() => review(n)}>
                        Revisar mudança
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-9 gap-1.5 text-xs"
                        disabled={!overview?.pauseSupported}
                        onClick={() => reviewPause(n)}
                      >
                        {n.paused ? <PlayCircle className="h-4 w-4" aria-hidden="true" /> : <PauseCircle className="h-4 w-4" aria-hidden="true" />}
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
                  </CardContent>
                </Card>
              );
            })}
          </section>

          {g && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Ajustes globais (somente leitura)</CardTitle>
                <CardDescription className="text-xs">
                  Vêm de variáveis de ambiente do servidor; mudar exige acesso à infraestrutura. Os controles acima já valem sem isso.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
                  <div>
                    <dt className="font-medium">Concorrência global: {g.processConcurrency}</dt>
                    <dd className="text-xs text-muted-foreground">Quantos envios o servidor mantém em andamento ao mesmo tempo, somando todos os números. Com vários números ativos, é este limite que manda.</dd>
                  </div>
                  <div>
                    <dt className="font-medium">Orçamento do ciclo: {g.tickBudgetSeconds} s</dt>
                    <dd className="text-xs text-muted-foreground">Tempo que cada ciclo do motor usa para iniciar envios; depois disso, só termina o que já começou.</dd>
                  </div>
                  <div>
                    <dt className="font-medium">Ciclo encadeado: {sim(g.tickChainEnabled)}</dt>
                    <dd className="text-xs text-muted-foreground">Ligado, um ciclo chama o próximo logo que termina, em vez de esperar o minuto seguinte.</dd>
                  </div>
                  <div>
                    <dt className="font-medium">Claim em lote: {sim(g.batchClaimEnabled)}</dt>
                    <dd className="text-xs text-muted-foreground">Ligado, o motor reserva vários itens de uma vez no banco (menos idas e vindas em volumes altos).</dd>
                  </div>
                  <div>
                    <dt className="font-medium">Freio automático: {sim(g.adaptiveBackoff)}</dt>
                    <dd className="text-xs text-muted-foreground">Reduz sozinho a velocidade quando a Meta limita ou o servidor sofre.</dd>
                  </div>
                  <div>
                    <dt className="font-medium">
                      Vagas padrão sem ajuste: Meta {g.perNumberDefaults.meta} · WAHA {g.perNumberDefaults.waha}
                    </dt>
                    <dd className="text-xs text-muted-foreground">Valem para o número que não tem vagas definidas aqui.</dd>
                  </div>
                </dl>
              </CardContent>
            </Card>
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
            <ul className="flex flex-col gap-1 rounded-lg border border-border p-3">
              {pending?.lines.map((l) => (
                <li key={l.label} className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-muted-foreground">{l.label}</span>
                  <span className="font-medium tabular-nums">
                    {l.before} → {l.after}
                  </span>
                </li>
              ))}
            </ul>
            {pending?.warnings.map((w) => (
              <p key={w} className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
                {w}
              </p>
            ))}
            <label className="flex flex-col gap-1 text-xs font-medium">
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
              <p role="alert" className="text-xs text-rose-700 dark:text-rose-300">
                {dialogError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)} disabled={saving}>
              Cancelar
            </Button>
            <Button onClick={() => void confirm()} disabled={saving || reason.trim().length < REASON_MIN} className="gap-2">
              {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              Confirmar e aplicar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
