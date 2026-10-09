"use client";

import { apiFetch } from "@/lib/api-fetch";

// ============================================================
// /relatorios/agentes — agent login/logout session history,
// inspired by Fortics Chat Center's "Login" report. Same draft →
// "Pesquisar" filter UX and month-grouping as /relatorios/auditoria.
//
// Backed by wacrm.get_agent_sessions_report (supabase/migrations/
// 052_agent_sessions.sql). "Logout" here is always inferred from a
// presence-heartbeat gap or an online→away flip, never a real
// sign-out click (see that migration's header) — so a session row is
// a best-effort approximation, not a guaranteed 1:1 login/logout
// pair. Sessions start being recorded only from whenever 052 is
// applied — nothing is backfilled.
// ============================================================

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { LogIn, Search } from "lucide-react";
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
import { ErrorState } from "@/components/dashboard/error-state";
import { Skeleton } from "@/components/dashboard/skeleton";
import type { AccountMember } from "@/types";
import { startOfDayIso, endOfDayIso } from "@/lib/relatorios/date-range";
import { loadSharedPeriod, saveSharedPeriod } from "@/lib/relatorios/period";
import { PeriodFilter } from "@/components/relatorios/period-filter";
import { formatDuration } from "@/lib/relatorios/format-duration";

const ALL = "all";

interface RawSessionRow {
  session_id: string;
  user_id: string;
  user_name: string | null;
  user_email: string | null;
  logged_in_at: string;
  logged_out_at: string | null;
  duration_sec: string | number;
  cause: string | null;
}

interface SessionRow {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  loggedInAt: string;
  loggedOutAt: string | null;
  durationSeconds: number;
  cause: string | null;
}

function normalizeRows(rows: RawSessionRow[]): SessionRow[] {
  return rows.map((r) => ({
    id: r.session_id,
    userId: r.user_id,
    userName: r.user_name ?? "—",
    userEmail: r.user_email ?? "—",
    loggedInAt: r.logged_in_at,
    loggedOutAt: r.logged_out_at,
    durationSeconds: Number(r.duration_sec ?? 0) || 0,
    cause: r.cause,
  }));
}

function todayStr() {
  return format(new Date(), "yyyy-MM-dd");
}

interface Filters {
  dateFrom: string;
  dateTo: string;
  userId: string;
}

function defaultFilters(): Filters {
  const today = todayStr();
  return { dateFrom: today, dateTo: today, userId: ALL };
}

export default function AgentesPage() {
  const uid = useId();
  const { accountId } = useAuth();

  const [members, setMembers] = useState<AccountMember[]>([]);
  const [draft, setDraft] = useState<Filters>(defaultFilters);
  const [applied, setApplied] = useState<Filters>(defaultFilters);

  // Período único: herda o recorte escolhido em outro relatório desta aba.
  useEffect(() => {
    const shared = loadSharedPeriod();
    if (!shared) return;
    queueMicrotask(() => {
      const patch = { dateFrom: shared.dateFrom, dateTo: shared.dateTo };
      setDraft((d) => ({ ...d, ...patch }));
      setApplied((a) => ({ ...a, ...patch }));
    });
  }, []);
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/account/members", { cache: "no-store" })
      .then((res) => res.json())
      .then((data: { members?: AccountMember[] }) => {
        if (!cancelled) setMembers(data.members ?? []);
      })
      .catch((err) => console.error("[agentes] failed to load members:", err));
    return () => {
      cancelled = true;
    };
  }, []);

  const runSearch = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    setLoadError(false);
    try {
      const db = createClient();
      const { data, error } = await db.rpc("get_agent_sessions_report", {
        p_account_id: accountId,
        p_date_from: startOfDayIso(applied.dateFrom),
        p_date_to: endOfDayIso(applied.dateTo),
        p_user_id: applied.userId !== ALL ? applied.userId : null,
      });
      if (error) throw error;
      setRows(normalizeRows((data ?? []) as RawSessionRow[]));
    } catch (err) {
      console.error("[agentes] failed to load agent sessions:", err);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [accountId, applied]);

  useEffect(() => {
    runSearch();
  }, [runSearch]);

  // Rows already come ordered by logged_in_at desc (the RPC's ORDER
  // BY), so grouping preserves month-descending order without a
  // second sort — same approach as /relatorios/auditoria.
  const groups = useMemo(() => {
    const map = new Map<string, SessionRow[]>();
    for (const row of rows) {
      const key = format(new Date(row.loggedInAt), "MMMM yyyy", { locale: ptBR });
      const list = map.get(key);
      if (list) list.push(row);
      else map.set(key, [row]);
    }
    return Array.from(map.entries());
  }, [rows]);

  function handlePesquisar() {
    setApplied(draft);
    saveSharedPeriod({ dateFrom: draft.dateFrom, dateTo: draft.dateTo });
  }

  function userLabel(userId: string) {
    if (userId === ALL) return "Todos";
    return members.find((m) => m.user_id === userId)?.full_name ?? userId;
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-heading text-xl font-semibold tracking-[-0.015em] text-foreground">Agentes</h2>
        <p className="text-sm text-muted-foreground">
          Histórico de sessões (login/logout) por agente.
        </p>
      </div>

      <div className="rounded-[10px] border border-border bg-card p-4">
        <div className="flex flex-wrap items-end gap-3">
          <PeriodFilter
            value={{ dateFrom: draft.dateFrom, dateTo: draft.dateTo }}
            onChange={(r) => setDraft((d) => ({ ...d, ...r }))}
          />

          <div className="space-y-1">
            <label htmlFor={`${uid}-agente`} className="text-xs font-medium text-muted-foreground">Agente</label>
            <Select value={draft.userId} onValueChange={(v) => v && setDraft((d) => ({ ...d, userId: v }))}>
              <SelectTrigger id={`${uid}-agente`} className="w-44">
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

          <Button onClick={handlePesquisar} className="bg-primary text-primary-foreground hover:bg-primary/90">
            <Search className="size-4" />
            Pesquisar
          </Button>
        </div>
      </div>

      <div className="rounded-[10px] border border-border bg-card">
        {loading ? (
          <div className="space-y-3 p-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10 w-full rounded-lg" />
            ))}
          </div>
        ) : loadError ? (
          <div className="p-4">
            <ErrorState title="Não foi possível carregar as sessões" onRetry={() => runSearch()} />
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={LogIn}
              title="Nenhuma sessão registrada no período."
              hint="As sessões começam a ser gravadas a partir de agora."
            />
          </div>
        ) : (
          <>
            {groups.map(([monthLabel, monthRows]) => (
              <div key={monthLabel}>
                <div className="border-b border-border bg-muted/40 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground capitalize">
                  {monthLabel}
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Agente</TableHead>
                      <TableHead>E-mail</TableHead>
                      <TableHead>Data do login</TableHead>
                      <TableHead>Data do logout</TableHead>
                      <TableHead className="text-right">Tempo</TableHead>
                      <TableHead>Causa</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {monthRows.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell>{row.userName}</TableCell>
                        <TableCell>{row.userEmail}</TableCell>
                        <TableCell>
                          {format(new Date(row.loggedInAt), "dd/MM/yyyy HH:mm:ss")}
                        </TableCell>
                        <TableCell>
                          {row.loggedOutAt ? (
                            format(new Date(row.loggedOutAt), "dd/MM/yyyy HH:mm:ss")
                          ) : (
                            <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300">Ativo</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {formatDuration(row.durationSeconds)}
                        </TableCell>
                        <TableCell>{row.cause ?? "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ))}
            <div className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
              1 - {rows.length} de {rows.length} itens
            </div>
          </>
        )}
      </div>
    </div>
  );
}