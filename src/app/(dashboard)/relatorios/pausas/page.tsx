"use client";

// /relatorios/pausas — pausas de atendimento por atendente.
// Rota: GET /api/pausas/relatorio (o servidor restringe o escopo: supervisor
// vê as equipes dele; admin/owner, a conta toda). Só mostra o que a rota
// devolve; o tempo logado vem de agent_sessions e fica "—" sem sessão.

import { useCallback, useEffect, useId, useState } from "react";
import { Coffee, Loader2, Search } from "lucide-react";
import { format } from "date-fns";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { apiFetch } from "@/lib/api-fetch";
import { pausasApi } from "@/lib/pausas/client";
import {
  endKindLabel,
  formatPauseDuration,
  type Pause,
  type PauseReason,
} from "@/lib/pausas/pause";
import {
  buildPauseReportQuery,
  pauseReportRangeError,
  type PauseReportFilters,
  type PauseReportResponse,
} from "@/lib/pausas/report";
import { loadSharedPeriod, saveSharedPeriod } from "@/lib/relatorios/period";
import { PeriodFilter } from "@/components/relatorios/period-filter";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/dashboard/empty-state";
import { ErrorState } from "@/components/dashboard/error-state";
import { Skeleton } from "@/components/dashboard/skeleton";
import type { AccountMember } from "@/types";

const ALL = "all";
const PAGE_LIMIT = 100;

function today() {
  return format(new Date(), "yyyy-MM-dd");
}

function initialFilters(): PauseReportFilters {
  return { dateFrom: today(), dateTo: today(), teamId: null, userId: null, reasonId: null };
}

export default function RelatorioPausasPage() {
  const uid = useId();
  const { accountId } = useAuth();
  const [draft, setDraft] = useState<PauseReportFilters>(initialFilters);
  const [applied, setApplied] = useState<PauseReportFilters>(initialFilters);
  const [detail, setDetail] = useState(false);
  const [report, setReport] = useState<PauseReportResponse | null>(null);
  const [items, setItems] = useState<Pause[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [members, setMembers] = useState<AccountMember[]>([]);
  const [teams, setTeams] = useState<{ id: string; name: string }[]>([]);
  const [reasons, setReasons] = useState<PauseReason[]>([]);

  // Período único: herda o recorte escolhido em outro relatório da aba.
  useEffect(() => {
    const shared = loadSharedPeriod();
    if (!shared) return;
    queueMicrotask(() => {
      const patch = { dateFrom: shared.dateFrom, dateTo: shared.dateTo };
      setDraft((d) => ({ ...d, ...patch }));
      setApplied((a) => ({ ...a, ...patch }));
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/account/members", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { members?: AccountMember[] }) => !cancelled && setMembers(d.members ?? []))
      .catch(() => {});
    void pausasApi.reasons(true).then((r) => {
      if (!cancelled && r.ok) setReasons(r.data.reasons);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    createClient()
      .from("teams")
      .select("id, name")
      .eq("account_id", accountId)
      .order("name")
      .then(({ data }) => {
        if (!cancelled) setTeams((data ?? []) as { id: string; name: string }[]);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  const run = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiFetch(`/api/pausas/relatorio?${buildPauseReportQuery(applied, { detail, limit: PAGE_LIMIT })}`, {
        cache: "no-store",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLoadError(res.status === 403 ? "Você não tem permissão para ver este relatório." : (json.error ?? "Não foi possível carregar o relatório de pausas"));
        return;
      }
      setReport(json as PauseReportResponse);
      setItems((json as PauseReportResponse).items ?? []);
    } catch {
      setLoadError("Não foi possível carregar o relatório de pausas");
    } finally {
      setLoading(false);
    }
  }, [applied, detail]);

  useEffect(() => {
    void run();
  }, [run]);

  async function loadMore() {
    if (!report?.next_cursor) return;
    setLoadingMore(true);
    try {
      const res = await apiFetch(
        `/api/pausas/relatorio?${buildPauseReportQuery(applied, { detail: true, limit: PAGE_LIMIT, cursor: report.next_cursor })}`,
        { cache: "no-store" },
      );
      const json = (await res.json().catch(() => null)) as PauseReportResponse | null;
      if (res.ok && json) {
        setItems((prev) => [...prev, ...(json.items ?? [])]);
        setReport((prev) => (prev ? { ...prev, next_cursor: json.next_cursor } : prev));
      }
    } finally {
      setLoadingMore(false);
    }
  }

  const rangeMsg = pauseReportRangeError(draft.dateFrom, draft.dateTo);

  return (
    <div className="space-y-4">
      <div className="rounded-card border border-border bg-card p-4">
        <div className="flex flex-wrap items-end gap-3">
          <PeriodFilter
            value={{ dateFrom: draft.dateFrom, dateTo: draft.dateTo }}
            onChange={(r) => setDraft((d) => ({ ...d, ...r }))}
          />

          <FilterSelect
            id={`${uid}-equipe`}
            label="Equipe"
            allLabel="Todas"
            value={draft.teamId}
            options={teams.map((t) => ({ id: t.id, name: t.name }))}
            onChange={(v) => setDraft((d) => ({ ...d, teamId: v }))}
          />
          <FilterSelect
            id={`${uid}-atendente`}
            label="Atendente"
            allLabel="Todos"
            value={draft.userId}
            options={members.map((m) => ({ id: m.user_id, name: m.full_name || m.email || "Sem nome" }))}
            onChange={(v) => setDraft((d) => ({ ...d, userId: v }))}
          />
          <FilterSelect
            id={`${uid}-motivo`}
            label="Motivo"
            allLabel="Todos"
            value={draft.reasonId}
            options={reasons.map((r) => ({ id: r.id, name: r.active ? r.name : `${r.name} (desativado)` }))}
            onChange={(v) => setDraft((d) => ({ ...d, reasonId: v }))}
          />

          <label className="flex h-9 items-center gap-2 text-[13px] text-foreground">
            <input type="checkbox" checked={detail} onChange={(e) => setDetail(e.target.checked)} className="size-4 accent-[var(--primary)]" />
            Ver cada pausa
          </label>

          <Button
            onClick={() => {
              if (rangeMsg) return;
              setApplied(draft);
              saveSharedPeriod({ dateFrom: draft.dateFrom, dateTo: draft.dateTo });
            }}
            disabled={!!rangeMsg}
            className="bg-primary-solid text-primary-foreground hover:bg-primary-solid-hover"
          >
            <Search className="size-4" />
            Pesquisar
          </Button>
        </div>
        {rangeMsg && (
          <p role="alert" className="mt-2 text-xs text-danger">
            {rangeMsg}
          </p>
        )}
      </div>

      <div className="rounded-card border border-border bg-card">
        {loading ? (
          <div className="space-y-3 p-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10 w-full rounded-lg" />
            ))}
          </div>
        ) : loadError ? (
          <div className="p-4">
            <ErrorState title={loadError} onRetry={() => void run()} />
          </div>
        ) : !report || report.agents.length === 0 ? (
          <div className="p-4">
            <EmptyState icon={Coffee} title="Nenhuma pausa no período." hint="Tente outro período ou tire os filtros." />
          </div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Atendente</TableHead>
                  <TableHead className="text-right">Pausas</TableHead>
                  <TableHead className="text-right">Tempo total</TableHead>
                  <TableHead className="text-right">Média</TableHead>
                  <TableHead className="text-right">Maior</TableHead>
                  <TableHead className="text-right">Passou do tempo</TableHead>
                  <TableHead className="text-right">% do tempo logado</TableHead>
                  <TableHead>Por motivo</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.agents.map((a) => (
                  <TableRow key={a.user_id}>
                    <TableCell className="font-medium">
                      {a.name}
                      {a.open_count > 0 && <Badge className="ml-2 bg-warning-soft text-warning">em pausa agora</Badge>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{a.pauses}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatPauseDuration(a.total_seconds)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatPauseDuration(a.avg_seconds)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatPauseDuration(a.longest_seconds)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {a.exceeded_count > 0 ? <span className="font-semibold text-warning">{a.exceeded_count}</span> : "0"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {a.pct_of_logged === null ? "—" : `${a.pct_of_logged.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`}
                    </TableCell>
                    <TableCell className="text-xs text-foreground-2">
                      {a.by_reason.map((r) => `${r.reason_name}: ${r.pauses}× · ${formatPauseDuration(r.total_seconds)}`).join("  |  ") || "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
              Pausa que atravessa o período entra só na parte dentro dele; pausa em andamento conta até agora.
              Tempo logado vem das sessões e fica “—” quando não há sessão registrada.
            </p>
          </>
        )}
      </div>

      {detail && !loading && !loadError && items.length > 0 && (
        <div className="rounded-card border border-border bg-card">
          <div className="border-b border-border bg-muted/40 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Cada pausa
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Atendente</TableHead>
                <TableHead>Motivo</TableHead>
                <TableHead>Início</TableHead>
                <TableHead>Fim</TableHead>
                <TableHead className="text-right">Duração</TableHead>
                <TableHead>Quem pausou</TableHead>
                <TableHead>Como terminou</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>{p.user_name ?? "—"}</TableCell>
                  <TableCell>
                    {p.reason_name}
                    {p.max_minutes !== null && <span className="text-xs text-muted-foreground"> · limite {p.max_minutes} min</span>}
                  </TableCell>
                  <TableCell>{format(new Date(p.started_at), "dd/MM/yyyy HH:mm")}</TableCell>
                  <TableCell>{p.ended_at ? format(new Date(p.ended_at), "dd/MM/yyyy HH:mm") : <Badge className="bg-warning-soft text-warning">Em andamento</Badge>}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatPauseDuration(p.elapsed_seconds)}
                    {p.exceeded && <Badge className="ml-2 bg-warning-soft text-warning">passou do tempo</Badge>}
                  </TableCell>
                  <TableCell>{p.by_supervisor ? (p.started_by_name ?? "Supervisor") : "O próprio atendente"}</TableCell>
                  <TableCell>{endKindLabel(p.end_kind)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {report?.next_cursor && (
            <div className="border-t border-border p-3 text-center">
              <Button variant="outline" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
                Carregar mais
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FilterSelect({
  id,
  label,
  allLabel,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  allLabel: string;
  value: string | null;
  options: { id: string; name: string }[];
  onChange: (value: string | null) => void;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <Select value={value ?? ALL} onValueChange={(v) => v && onChange(v === ALL ? null : v)}>
        <SelectTrigger id={id} className="w-44">
          <SelectValue>{(v: string) => (v === ALL ? allLabel : (options.find((o) => o.id === v)?.name ?? allLabel))}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{allLabel}</SelectItem>
          {options.map((o) => (
            <SelectItem key={o.id} value={o.id}>
              {o.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
