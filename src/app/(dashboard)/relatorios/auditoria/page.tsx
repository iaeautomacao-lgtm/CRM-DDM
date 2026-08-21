"use client";

import { apiFetch } from "@/lib/api-fetch";

// ============================================================
// /relatorios/auditoria — audit log report, inspired by Fortics Chat
// Center's audit screen. Two-step filter UX (draft → "Pesquisar"),
// same pattern as Monitoramento's filter panel and /historico's
// ContactTimeline.
//
// `user_name` is read straight off the row instead of joined against
// `profiles` live: audit_logs.user_name is a snapshot captured at
// write time (see supabase/migrations/050_audit_logs.sql), and there
// is no FK from audit_logs to profiles to embed anyway (both
// reference auth.users independently) — a live join would also drift
// from the truth if the actor later renames themselves, which is
// wrong for an audit trail. The "Usuário" filter dropdown still needs
// the account roster, fetched the same way Monitoramento/ContactTimeline
// already do (GET /api/account/members).
// ============================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import { Eye, Search } from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Skeleton } from "@/components/dashboard/skeleton";
import type { AccountMember } from "@/types";
import { AuditDetailModal, type AuditLog } from "@/components/relatorios/AuditDetailModal";
import { startOfDayIso, endOfDayIso } from "@/lib/relatorios/date-range";

const ALL = "all";

const EVENT_OPTIONS = [
  { value: ALL, label: "Todos" },
  { value: "created", label: "Criado" },
  { value: "updated", label: "Atualizado" },
  { value: "deleted", label: "Deletado" },
] as const;

const RESOURCE_OPTIONS = [
  { value: ALL, label: "Todos" },
  { value: "contact", label: "Contato" },
  { value: "conversation", label: "Conversa" },
] as const;

export const RESOURCE_LABEL: Record<string, string> = {
  contact: "Contato",
  conversation: "Conversa",
};

const EVENT_BADGE: Record<AuditLog["event_type"], { label: string; className: string }> = {
  created: { label: "Criado", className: "bg-[#CCFBF1] text-[#0F766E]" },
  updated: { label: "Atualizado", className: "bg-[#DBEAFE] text-[#1D4ED8]" },
  deleted: { label: "Deletado", className: "bg-[#FEE2E2] text-[#B91C1C]" },
};

function todayStr() {
  return format(new Date(), "yyyy-MM-dd");
}

interface AuditFilters {
  from: string;
  to: string;
  userId: string;
  eventType: string;
  resourceType: string;
}

function defaultFilters(): AuditFilters {
  const today = todayStr();
  return { from: today, to: today, userId: ALL, eventType: ALL, resourceType: ALL };
}

export default function AuditoriaPage() {
  const { accountId } = useAuth();

  const [members, setMembers] = useState<AccountMember[]>([]);
  const [draft, setDraft] = useState<AuditFilters>(defaultFilters);
  const [applied, setApplied] = useState<AuditFilters>(defaultFilters);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedLog, setSelectedLog] = useState<AuditLog | null>(null);

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
    if (!accountId) return;
    setLoading(true);
    try {
      const db = createClient();
      let query = db
        .from("audit_logs")
        .select("*")
        .eq("account_id", accountId)
        .gte("created_at", startOfDayIso(applied.from))
        .lte("created_at", endOfDayIso(applied.to))
        .order("created_at", { ascending: false })
        .limit(200);

      if (applied.userId !== ALL) query = query.eq("user_id", applied.userId);
      if (applied.eventType !== ALL) query = query.eq("event_type", applied.eventType);
      if (applied.resourceType !== ALL) query = query.eq("resource_type", applied.resourceType);

      const { data, error } = await query;
      console.log("[audit] result:", data, error);
      if (error) throw error;
      setLogs((data ?? []) as AuditLog[]);
    } catch (err) {
      console.error("[auditoria] failed to load audit logs:", err);
    } finally {
      setLoading(false);
    }
  }, [accountId, applied]);

  useEffect(() => {
    runSearch();
  }, [runSearch]);

  // Query is already ordered by created_at desc, so grouping preserves
  // month-descending order without a second sort.
  const groups = useMemo(() => {
    const map = new Map<string, AuditLog[]>();
    for (const log of logs) {
      const key = format(new Date(log.created_at), "MMMM yyyy", { locale: ptBR });
      const list = map.get(key);
      if (list) list.push(log);
      else map.set(key, [log]);
    }
    return Array.from(map.entries());
  }, [logs]);

  function handlePesquisar() {
    setApplied(draft);
  }

  function userLabel(userId: string) {
    if (userId === ALL) return "Todos";
    return members.find((m) => m.user_id === userId)?.full_name ?? userId;
  }

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Auditoria</h1>
        <p className="text-sm text-muted-foreground">
          Histórico de eventos de criação, atualização e exclusão de recursos da conta.
        </p>
      </div>

      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Período (de)</label>
            <Input
              type="date"
              value={draft.from}
              onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
              className="w-40"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Período (até)</label>
            <Input
              type="date"
              value={draft.to}
              onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
              className="w-40"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Usuário</label>
            <Select value={draft.userId} onValueChange={(v) => v && setDraft((d) => ({ ...d, userId: v }))}>
              <SelectTrigger className="w-44">
                <SelectValue>{(v: string) => userLabel(v)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Todos</SelectItem>
                {members.map((m) => (
                  <SelectItem key={m.user_id} value={m.user_id}>
                    {m.full_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Evento</label>
            <Select
              value={draft.eventType}
              onValueChange={(v) => v && setDraft((d) => ({ ...d, eventType: v }))}
            >
              <SelectTrigger className="w-36">
                <SelectValue>
                  {(v: string) => EVENT_OPTIONS.find((o) => o.value === v)?.label ?? v}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {EVENT_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Recurso</label>
            <Select
              value={draft.resourceType}
              onValueChange={(v) => v && setDraft((d) => ({ ...d, resourceType: v }))}
            >
              <SelectTrigger className="w-36">
                <SelectValue>
                  {(v: string) => RESOURCE_OPTIONS.find((o) => o.value === v)?.label ?? v}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {RESOURCE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
            <EmptyState
              icon={Search}
              title="Nenhum evento encontrado"
              hint="Ajuste os filtros para ver eventos de auditoria."
            />
          </div>
        ) : (
          groups.map(([monthLabel, monthLogs]) => (
            <div key={monthLabel}>
              <div className="border-b border-border bg-muted/40 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground capitalize">
                {monthLabel}
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Data</TableHead>
                    <TableHead>Evento</TableHead>
                    <TableHead>Recurso</TableHead>
                    <TableHead>Usuário</TableHead>
                    <TableHead>IP</TableHead>
                    <TableHead className="text-right">Visualizar</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {monthLogs.map((log) => {
                    const badge = EVENT_BADGE[log.event_type];
                    return (
                      <TableRow key={log.id}>
                        <TableCell>{format(new Date(log.created_at), "dd/MM HH:mm")}</TableCell>
                        <TableCell>
                          <Badge className={badge.className}>{badge.label}</Badge>
                        </TableCell>
                        <TableCell>{RESOURCE_LABEL[log.resource_type] ?? log.resource_type}</TableCell>
                        <TableCell>{log.user_name ?? "-"}</TableCell>
                        <TableCell>{log.ip_address ?? "-"}</TableCell>
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
            </div>
          ))
        )}
      </div>

      <AuditDetailModal
        log={selectedLog}
        open={!!selectedLog}
        onOpenChange={(open) => {
          if (!open) setSelectedLog(null);
        }}
      />
    </div>
  );
}