"use client";

import { apiFetch } from "@/lib/api-fetch";

// ============================================================
// /relatorios/auditoria — trilha de auditoria da conta.
//
// Dados de GET /api/audit-logs (owner/admin; RLS da migration 131),
// paginados no servidor, com exportação para Excel do filtro atual.
// Quem fez / IP / navegador / origem são gravados pelas triggers da
// migration 131 (autor vindo da sessão ou dos headers x-audit-* do nosso
// servidor — src/lib/audit/context.ts) e por logAuditEvent. Registros
// anteriores à 131 continuam sem usuário/IP: isso nunca foi gravado.
//
// Filtro em dois passos (rascunho → "Pesquisar"), como Monitoramento e
// /historico.
// ============================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, ChevronLeft, ChevronRight, Download, Eye, Loader2, Search } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Skeleton } from "@/components/dashboard/skeleton";
import type { AccountMember } from "@/types";
import { AuditDetailModal, EVENT_BADGE } from "@/components/relatorios/AuditDetailModal";
import {
  ACTION_FILTER_OPTIONS,
  ACTOR_LABEL,
  actionLabel,
  actorLabel,
  EVENT_LABEL,
  RESOURCE_LABEL,
  type AuditLog,
} from "@/lib/audit/labels";
import { startOfDayIso, endOfDayIso } from "@/lib/relatorios/date-range";

const ALL = "all";
const PAGE_SIZES = [50, 100, 200] as const;

const EVENT_OPTIONS = [{ value: ALL, label: "Todos" }, ...Object.entries(EVENT_LABEL).map(([value, label]) => ({ value, label }))];
const RESOURCE_OPTIONS = [{ value: ALL, label: "Todos" }, ...Object.entries(RESOURCE_LABEL).map(([value, label]) => ({ value, label }))];
const ACTOR_OPTIONS = [{ value: ALL, label: "Todos" }, ...Object.entries(ACTOR_LABEL).map(([value, label]) => ({ value, label }))];
const ACTION_OPTIONS = [{ value: ALL, label: "Todas" }, ...ACTION_FILTER_OPTIONS];

function todayStr() {
  return format(new Date(), "yyyy-MM-dd");
}

interface AuditFilters {
  from: string;
  to: string;
  userId: string;
  eventType: string;
  resourceType: string;
  action: string;
  actor: string;
  q: string;
}

function defaultFilters(): AuditFilters {
  const today = todayStr();
  return { from: today, to: today, userId: ALL, eventType: ALL, resourceType: ALL, action: ALL, actor: ALL, q: "" };
}

function toQuery(f: AuditFilters): URLSearchParams {
  const qs = new URLSearchParams({ from: startOfDayIso(f.from), to: endOfDayIso(f.to) });
  if (f.userId !== ALL) qs.set("user", f.userId);
  if (f.eventType !== ALL) qs.set("event", f.eventType);
  if (f.resourceType !== ALL) qs.set("resource", f.resourceType);
  if (f.action !== ALL) qs.set("action", f.action);
  if (f.actor !== ALL) qs.set("actor", f.actor);
  if (f.q.trim()) qs.set("q", f.q.trim());
  return qs;
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
  width = "w-40",
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  width?: string;
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <Select value={value} onValueChange={(v) => v && onChange(v)}>
        <SelectTrigger className={width}>
          {/* Base UI mostra o valor cru sem o render: resolve o rótulo aqui. */}
          <SelectValue>{(v: string) => options.find((o) => o.value === v)?.label ?? v}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export default function AuditoriaPage() {
  const [members, setMembers] = useState<AccountMember[]>([]);
  const [draft, setDraft] = useState<AuditFilters>(defaultFilters);
  const [applied, setApplied] = useState<AuditFilters>(defaultFilters);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZES[0]);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [selectedLog, setSelectedLog] = useState<AuditLog | null>(null);
  // Só a resposta da busca mais recente vale (troca rápida de página).
  const requestSeq = useRef(0);

  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/account/members", { cache: "no-store" })
      .then((res) => res.json())
      .then((data: { members?: AccountMember[] }) => {
        if (!cancelled) setMembers(data.members ?? []);
      })
      .catch((err) => console.error("[auditoria] failed to load members:", err));
    return () => {
      cancelled = true;
    };
  }, []);

  const runSearch = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const qs = toQuery(applied);
      qs.set("page", String(page));
      qs.set("pageSize", String(pageSize));
      const res = await apiFetch(`/api/audit-logs?${qs.toString()}`);
      const json = await res.json();
      if (seq !== requestSeq.current) return;
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setLogs(json.logs ?? []);
      setTotal(json.total ?? 0);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      console.error("[auditoria] failed to load audit logs:", err);
      toast.error("Falha ao carregar a auditoria");
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [applied, page, pageSize]);

  useEffect(() => {
    runSearch();
  }, [runSearch]);

  function handlePesquisar() {
    // Objeto novo: refaz a busca mesmo com os mesmos filtros.
    setApplied({ ...draft });
    setPage(1);
  }

  async function handleExport() {
    setExporting(true);
    try {
      const qs = toQuery(applied);
      qs.set("export", "xlsx");
      const res = await apiFetch(`/api/audit-logs?${qs.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `auditoria-${applied.from}-a-${applied.to}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("[auditoria] export failed:", err);
      toast.error("Falha ao exportar");
    } finally {
      setExporting(false);
    }
  }

  const userOptions = [
    { value: ALL, label: "Todos" },
    ...members.map((m) => ({ value: m.user_id, label: m.full_name || m.email || m.user_id })),
  ];
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const set = (patch: Partial<AuditFilters>) => setDraft((d) => ({ ...d, ...patch }));

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Auditoria</h1>
          <p className="text-sm text-muted-foreground">
            Quem fez o quê, quando e de onde — conversas, contatos, campanhas, fluxos, automações, canais e equipe.
          </p>
        </div>
        <Button variant="outline" onClick={handleExport} disabled={exporting || total === 0}>
          {exporting ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
          Exportar Excel
        </Button>
      </div>

      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Período (de)</label>
            <Input type="date" value={draft.from} onChange={(e) => set({ from: e.target.value })} className="w-40" />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Período (até)</label>
            <Input type="date" value={draft.to} onChange={(e) => set({ to: e.target.value })} className="w-40" />
          </div>
          <FilterSelect label="Usuário" value={draft.userId} options={userOptions} onChange={(v) => set({ userId: v })} width="w-44" />
          <FilterSelect label="Tipo de autor" value={draft.actor} options={ACTOR_OPTIONS} onChange={(v) => set({ actor: v })} width="w-36" />
          <FilterSelect label="Ação" value={draft.action} options={ACTION_OPTIONS} onChange={(v) => set({ action: v })} width="w-52" />
          <FilterSelect label="Evento" value={draft.eventType} options={EVENT_OPTIONS} onChange={(v) => set({ eventType: v })} width="w-36" />
          <FilterSelect label="Recurso" value={draft.resourceType} options={RESOURCE_OPTIONS} onChange={(v) => set({ resourceType: v })} width="w-40" />
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Buscar</label>
            <Input
              value={draft.q}
              onChange={(e) => set({ q: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && handlePesquisar()}
              placeholder="Nome, IP, resumo ou ID"
              className="w-56"
            />
          </div>
          <Button onClick={handlePesquisar} className="bg-[#FF5706] text-white hover:bg-[#FF5706]/90">
            <Search className="size-4" />
            Pesquisar
          </Button>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card">
        {loading ? (
          <div className="space-y-3 p-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10 w-full rounded-lg" />
            ))}
          </div>
        ) : logs.length === 0 ? (
          <div className="p-4">
            <EmptyState icon={Search} title="Nenhum evento encontrado" hint="Ajuste os filtros para ver eventos de auditoria." />
          </div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Data</TableHead>
                  <TableHead>Quem</TableHead>
                  <TableHead>IP</TableHead>
                  <TableHead>Ação</TableHead>
                  <TableHead>Recurso</TableHead>
                  <TableHead>Origem</TableHead>
                  <TableHead className="text-right">Detalhes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((log) => {
                  const automatic = !log.user_id;
                  return (
                    <TableRow key={log.id}>
                      <TableCell className="whitespace-nowrap tabular-nums">
                        {format(new Date(log.created_at), "dd/MM/yyyy HH:mm:ss")}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <span className="inline-flex items-center gap-1">
                          {automatic && <Bot className="size-3.5 text-muted-foreground" />}
                          {actorLabel(log)}
                        </span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs">{log.ip_address ?? "—"}</TableCell>
                      <TableCell className="max-w-[360px]">
                        <div className="flex items-center gap-1.5">
                          <Badge className={EVENT_BADGE[log.event_type]}>{actionLabel(log)}</Badge>
                        </div>
                        {log.summary && <p className="mt-0.5 truncate text-xs text-muted-foreground">{log.summary}</p>}
                      </TableCell>
                      <TableCell className="max-w-[220px]">
                        <p className="text-xs text-muted-foreground">{RESOURCE_LABEL[log.resource_type] ?? log.resource_type}</p>
                        <p className="truncate text-sm">{log.resource_label ?? "—"}</p>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{log.source ?? "—"}</TableCell>
                      <TableCell className="text-right">
                        <button
                          type="button"
                          onClick={() => setSelectedLog(log)}
                          aria-label="Visualizar detalhes"
                          className="inline-flex items-center justify-center rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                          <Eye className="size-4" />
                        </button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span>
                  {total.toLocaleString()} evento(s) · página {page} de {totalPages}
                </span>
                <label className="flex items-center gap-1.5">
                  Itens por página
                  <select
                    value={pageSize}
                    onChange={(e) => {
                      setPageSize(Number(e.target.value));
                      setPage(1);
                    }}
                    className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground"
                  >
                    {PAGE_SIZES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  <ChevronLeft className="size-3.5" /> Anterior
                </Button>
                <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                  Próxima <ChevronRight className="size-3.5" />
                </Button>
              </div>
            </footer>
          </>
        )}
      </div>

      <AuditDetailModal
        log={selectedLog}
        open={!!selectedLog}
        onOpenChange={(open) => {
          if (!open) setSelectedLog(null);
        }}
        onSelect={setSelectedLog}
      />
    </div>
  );
}
