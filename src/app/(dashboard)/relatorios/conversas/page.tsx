"use client";

import { apiFetch } from "@/lib/api-fetch";

// ============================================================
// /relatorios/conversas — paginated conversation list with filters
// and inline message expansion, inspired by Fortics Chat Center's
// "Conversas" report. Backed by wacrm.get_conversations_report
// (supabase/migrations/053_conversations_report_rpc.sql).
//
// Filters NOT implemented (no schema equivalent, per spec): Protocolo,
// Exibir mensagens, Privacidade, Origem do atendimento, Nota
// pós-atendimento.
//
// Expansion reuses MessageThread (src/components/contact-timeline/
// MessageThread.tsx) exactly the way ConversationCard.tsx already
// does on /historico: MessageThread is presentational only (messages/
// loading/hasMore are props, it fetches nothing itself), so this page
// lazy-fetches via loadConversationMessages on first expand, same as
// that component.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  FileSpreadsheet,
  Globe,
  MessageCircle,
  Search,
  SlidersHorizontal,
  UserRound,
} from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Skeleton } from "@/components/dashboard/skeleton";
import type { AccountMember, Team } from "@/types";
import { startOfDayIso, endOfDayIso } from "@/lib/relatorios/date-range";
import { buildPageList } from "@/lib/relatorios/pagination";
import { exportWithHistory } from "@/lib/relatorios/export-with-history";
import {
  loadConversationMessages,
  type TimelineMessage,
} from "@/lib/contact-timeline/queries";
import { MessageThread } from "@/components/contact-timeline/MessageThread";

const ALL = "all";
const PAGE_SIZE = 60;

const SCOPE_OPTIONS = [
  { value: "created", label: "Conversas iniciadas no período" },
  { value: "closed", label: "Conversas finalizadas no período" },
] as const;

const STATUS_OPTIONS = [
  { value: ALL, label: "Todos" },
  { value: "open", label: "Em andamento" },
  { value: "closed", label: "Encerrado" },
] as const;

interface RawRow {
  conversation_id: string;
  contact_name: string | null;
  contact_phone: string | null;
  waha_session: string | null;
  status: string;
  agent_name: string | null;
  team_name: string | null;
  started_at: string;
  ended_at: string | null;
  message_count: string | number;
  total_count: string | number;
}

interface ConversationRow {
  id: string;
  contactName: string | null;
  contactPhone: string | null;
  wahaSession: string | null;
  status: string;
  agentName: string | null;
  teamName: string | null;
  startedAt: string;
  endedAt: string | null;
  messageCount: number;
}

function normalizeRows(rows: RawRow[]): ConversationRow[] {
  return rows.map((r) => ({
    id: r.conversation_id,
    contactName: r.contact_name,
    contactPhone: r.contact_phone,
    wahaSession: r.waha_session,
    status: r.status,
    agentName: r.agent_name,
    teamName: r.team_name,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    messageCount: Number(r.message_count ?? 0) || 0,
  }));
}

function contactLabel(name: string | null, phone: string | null): string {
  if (name && phone) return `${name} - ${phone}`;
  return name || phone || "Contato";
}

function formatRange(startedAt: string, endedAt: string | null): string {
  const start = format(new Date(startedAt), "dd/MM HH:mm");
  if (!endedAt) return start;
  return `${start} - ${format(new Date(endedAt), "dd/MM HH:mm")}`;
}

function todayStr() {
  return format(new Date(), "yyyy-MM-dd");
}

function startOfMonthStr() {
  const d = new Date();
  return format(new Date(d.getFullYear(), d.getMonth(), 1), "yyyy-MM-dd");
}

interface Filters {
  dateFrom: string;
  dateTo: string;
  wahaSession: string;
  search: string;
  agentId: string;
  teamId: string;
  scope: "created" | "closed";
  status: string;
}

function defaultFilters(): Filters {
  return {
    dateFrom: startOfMonthStr(),
    dateTo: todayStr(),
    wahaSession: ALL,
    search: "",
    agentId: ALL,
    teamId: ALL,
    scope: "created",
    status: ALL,
  };
}

// ============================================================
// ConversationAccordionItem — header + lazy message expansion.
// ============================================================
function ConversationAccordionItem({ row }: { row: ConversationRow }) {
  const [expanded, setExpanded] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [messages, setMessages] = useState<TimelineMessage[] | null>(null);
  const [hasMore, setHasMore] = useState(false);

  async function toggleExpand() {
    const next = !expanded;
    setExpanded(next);
    if (next && messages === null) {
      setLoadingMessages(true);
      try {
        const db = createClient();
        const { messages: rows, hasMore: more } = await loadConversationMessages(db, row.id);
        setMessages(rows);
        setHasMore(more);
      } catch (err) {
        console.error("[conversas] failed to load messages:", err);
        setMessages([]);
      } finally {
        setLoadingMessages(false);
      }
    }
  }

  const isClosed = row.status === "closed";
  const contactInitial = contactLabel(row.contactName, row.contactPhone).charAt(0).toUpperCase();

  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <div
        role="button"
        tabIndex={0}
        onClick={toggleExpand}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") toggleExpand();
        }}
        className="flex cursor-pointer flex-wrap items-center justify-between gap-2 bg-[#1e293b] px-4 py-3 text-white"
      >
        <div className="flex min-w-0 items-center gap-2">
          <UserRound className="size-4 shrink-0 text-slate-300" />
          <span className="truncate text-sm font-medium">
            {contactLabel(row.contactName, row.contactPhone)}
          </span>
          {row.wahaSession ? (
            <MessageCircle className="size-4 shrink-0 text-[#25D366]" />
          ) : (
            <Globe className="size-4 shrink-0 text-slate-400" />
          )}
          <span className="truncate text-xs text-slate-300">
            {row.wahaSession || "Meta/Webchat"}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xs text-slate-300">{formatRange(row.startedAt, row.endedAt)}</span>
          <Badge className={isClosed ? "bg-white/10 text-slate-300" : "bg-white/15 text-white"}>
            {isClosed ? "Encerrado" : "Em andamento"}
          </Badge>
          {expanded ? (
            <ChevronDown className="size-4 shrink-0 text-slate-300" />
          ) : (
            <ChevronRight className="size-4 shrink-0 text-slate-300" />
          )}
        </div>
      </div>

      {expanded && (
        <div className="bg-background">
          <MessageThread
            conversationId={row.id}
            loading={loadingMessages}
            messages={messages ?? []}
            hasMore={hasMore}
            contactInitial={contactInitial}
            agentName={row.agentName}
          />
        </div>
      )}
    </div>
  );
}

export default function ConversasPage() {
  const { accountId } = useAuth();

  const [filtersOpen, setFiltersOpen] = useState(true);
  const [teams, setTeams] = useState<Team[]>([]);
  const [members, setMembers] = useState<AccountMember[]>([]);
  const [channelOptions, setChannelOptions] = useState<string[]>([]);

  const [draft, setDraft] = useState<Filters>(defaultFilters);
  const [applied, setApplied] = useState<Filters>(defaultFilters);
  const [page, setPage] = useState(1);

  const [rows, setRows] = useState<ConversationRow[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState<"xlsx" | "csv" | null>(null);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    const db = createClient();
    db.from("teams")
      .select("*")
      .eq("account_id", accountId)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error("[conversas] failed to load teams:", error);
          return;
        }
        setTeams((data ?? []) as Team[]);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/account/members", { cache: "no-store" })
      .then((res) => res.json())
      .then((data: { members?: AccountMember[] }) => {
        if (!cancelled) setMembers(data.members ?? []);
      })
      .catch((err) => console.error("[conversas] failed to load members:", err));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    const db = createClient();
    db.from("conversations")
      .select("waha_session")
      .eq("account_id", accountId)
      .not("waha_session", "is", null)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error("[conversas] failed to load channel options:", error);
          return;
        }
        const unique = Array.from(
          new Set((data ?? []).map((r) => r.waha_session as string).filter(Boolean)),
        );
        setChannelOptions(unique);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  // Search auto-applies after 300ms of no typing — every other filter
  // waits for the explicit "Pesquisar" click (handlePesquisar below),
  // same draft→applied pattern as the rest of /relatorios.
  useEffect(() => {
    const t = setTimeout(() => {
      setApplied((a) => (a.search === draft.search ? a : { ...a, search: draft.search }));
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.search]);

  const buildRpcParams = useCallback(
    (f: Filters, limit: number, offset: number) => ({
      p_account_id: accountId,
      p_date_from: startOfDayIso(f.dateFrom),
      p_date_to: endOfDayIso(f.dateTo),
      p_scope: f.scope,
      p_waha_session: f.wahaSession !== ALL ? f.wahaSession : null,
      p_agent_id: f.agentId !== ALL ? f.agentId : null,
      p_team_id: f.teamId !== ALL ? f.teamId : null,
      p_status: f.status !== ALL ? f.status : null,
      p_search: f.search.trim() ? f.search.trim() : null,
      p_limit: limit,
      p_offset: offset,
    }),
    [accountId],
  );

  const runSearch = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    try {
      const db = createClient();
      const { data, error } = await db.rpc(
        "get_conversations_report",
        buildRpcParams(applied, PAGE_SIZE, (page - 1) * PAGE_SIZE),
      );
      if (error) throw error;
      const raw = (data ?? []) as RawRow[];
      setRows(normalizeRows(raw));
      setTotalCount(raw.length > 0 ? Number(raw[0].total_count) || 0 : 0);
    } catch (err) {
      console.error("[conversas] failed to load conversations:", err);
    } finally {
      setLoading(false);
    }
  }, [accountId, applied, page, buildRpcParams]);

  useEffect(() => {
    runSearch();
  }, [runSearch]);

  const groups = useMemo(() => {
    const map = new Map<string, ConversationRow[]>();
    for (const row of rows) {
      const key = format(new Date(row.startedAt), "MMMM yyyy", { locale: ptBR });
      const list = map.get(key);
      if (list) list.push(row);
      else map.set(key, [row]);
    }
    return Array.from(map.entries());
  }, [rows]);

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const pageList = useMemo(() => buildPageList(page, totalPages), [page, totalPages]);
  const rangeStart = totalCount === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(page * PAGE_SIZE, totalCount);

  function handlePesquisar() {
    setApplied(draft);
    setPage(1);
  }

  async function handleExport(kind: "xlsx" | "csv") {
    if (!accountId) return;
    setExporting(kind);
    try {
      const db = createClient();
      // All pages, no pagination — per spec, exports ignore the
      // current page and pull everything matching the applied filters.
      const { data, error } = await db.rpc("get_conversations_report", buildRpcParams(applied, 9999, 0));
      if (error) throw error;
      const allRows = normalizeRows((data ?? []) as RawRow[]);
      const exportRows = allRows.map((r) => ({
        contato: r.contactName ?? "",
        telefone: r.contactPhone ?? "",
        canal: r.wahaSession || "Meta/Webchat",
        status: r.status === "closed" ? "Encerrado" : "Em andamento",
        agente: r.agentName ?? "",
        equipe: r.teamName ?? "",
        iniciadoEm: format(new Date(r.startedAt), "dd/MM/yyyy HH:mm:ss"),
        encerradoEm: r.endedAt ? format(new Date(r.endedAt), "dd/MM/yyyy HH:mm:ss") : "",
        mensagens: r.messageCount,
      }));
      await exportWithHistory({
        data: exportRows,
        columns: [
          { key: "contato", label: "Contato" },
          { key: "telefone", label: "Telefone" },
          { key: "canal", label: "Canal" },
          { key: "status", label: "Status" },
          { key: "agente", label: "Agente" },
          { key: "equipe", label: "Equipe" },
          { key: "iniciadoEm", label: "Iniciado em" },
          { key: "encerradoEm", label: "Encerrado em" },
          { key: "mensagens", label: "Mensagens" },
        ],
        exportType: "conversas",
        description: `Conversas - ${format(new Date(applied.dateFrom), "dd/MM/yyyy")} a ${format(new Date(applied.dateTo), "dd/MM/yyyy")}`,
        periodFrom: new Date(applied.dateFrom),
        periodTo: new Date(applied.dateTo),
        format: kind,
      });
    } catch (err) {
      console.error("[conversas] export failed:", err);
    } finally {
      setExporting(null);
    }
  }

  function agentLabel(id: string) {
    if (id === ALL) return "Todos";
    return members.find((m) => m.user_id === id)?.full_name ?? id;
  }

  function teamLabel(id: string) {
    if (id === ALL) return "Todas";
    return teams.find((t) => t.id === id)?.name ?? id;
  }

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Conversas</h1>
        <p className="text-sm text-muted-foreground">
          Lista de conversas com filtros avançados e visualização inline das mensagens.
        </p>
      </div>

      <div className="rounded-xl border border-border bg-card">
        <button
          type="button"
          onClick={() => setFiltersOpen((o) => !o)}
          className="flex w-full items-center justify-between gap-2 px-4 py-3"
        >
          <span className="flex items-center gap-2 text-sm font-medium text-foreground">
            <SlidersHorizontal className="size-4 text-primary" />
            Filtros
          </span>
          <ChevronDown className={`size-4 text-muted-foreground transition-transform ${filtersOpen ? "rotate-180" : ""}`} />
        </button>

        {filtersOpen && (
          <div className="border-t border-border p-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Período (de)</label>
                <Input
                  type="date"
                  value={draft.dateFrom}
                  onChange={(e) => setDraft((d) => ({ ...d, dateFrom: e.target.value }))}
                  className="w-40"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Período (até)</label>
                <Input
                  type="date"
                  value={draft.dateTo}
                  onChange={(e) => setDraft((d) => ({ ...d, dateTo: e.target.value }))}
                  className="w-40"
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Canal</label>
                <Select
                  value={draft.wahaSession}
                  onValueChange={(v) => v && setDraft((d) => ({ ...d, wahaSession: v }))}
                >
                  <SelectTrigger className="w-40">
                    <SelectValue>{(v: string) => (v === ALL ? "Todos" : v)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>Todos</SelectItem>
                    {channelOptions.map((session) => (
                      <SelectItem key={session} value={session}>
                        {session}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="min-w-[200px] flex-1 space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Identificador</label>
                <Input
                  value={draft.search}
                  onChange={(e) => setDraft((d) => ({ ...d, search: e.target.value }))}
                  placeholder="Nome ou telefone do contato"
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Agente</label>
                <Select value={draft.agentId} onValueChange={(v) => v && setDraft((d) => ({ ...d, agentId: v }))}>
                  <SelectTrigger className="w-44">
                    <SelectValue>{(v: string) => agentLabel(v)}</SelectValue>
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

            </div>

            <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Equipes</label>
                  <Select value={draft.teamId} onValueChange={(v) => v && setDraft((d) => ({ ...d, teamId: v }))}>
                    <SelectTrigger className="w-44">
                      <SelectValue>{(v: string) => teamLabel(v)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent className="z-50">
                      <SelectItem value={ALL}>Todas</SelectItem>
                      {teams.map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          {t.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Escopo</label>
                  <Select
                    value={draft.scope}
                    onValueChange={(v) => v && setDraft((d) => ({ ...d, scope: v as Filters["scope"] }))}
                  >
                    <SelectTrigger className="w-56">
                      <SelectValue>
                        {(v: string) => SCOPE_OPTIONS.find((o) => o.value === v)?.label ?? v}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent className="z-50">
                      {SCOPE_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Status</label>
                  <Select value={draft.status} onValueChange={(v) => v && setDraft((d) => ({ ...d, status: v }))}>
                    <SelectTrigger className="w-36">
                      <SelectValue>
                        {(v: string) => STATUS_OPTIONS.find((o) => o.value === v)?.label ?? v}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent className="z-50">
                      {STATUS_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Button onClick={handlePesquisar} className="bg-[#FF5706] text-white hover:bg-[#FF5706]/90">
                  <Search className="size-4" />
                  Pesquisar
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={exporting !== null}
                  onClick={() => handleExport("xlsx")}
                >
                  <FileSpreadsheet className="size-4" />
                  {exporting === "xlsx" ? "Exportando…" : "XLSX"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={exporting !== null}
                  onClick={() => handleExport("csv")}
                >
                  <Download className="size-4" />
                  {exporting === "csv" ? "Exportando…" : "CSV"}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="space-y-4">
        {loading ? (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-14 w-full rounded-xl" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-xl border border-border bg-card p-4">
            <EmptyState
              icon={MessageCircle}
              title="Nenhuma conversa encontrada"
              hint="Ajuste os filtros para ver conversas do período."
            />
          </div>
        ) : (
          <>
            {groups.map(([monthLabel, monthRows]) => (
              <div key={monthLabel} className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground capitalize">
                  {monthLabel}
                </p>
                <div className="space-y-2">
                  {monthRows.map((row) => (
                    <ConversationAccordionItem key={row.id} row={row} />
                  ))}
                </div>
              </div>
            ))}

            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card px-4 py-3">
              <span className="text-xs text-muted-foreground">
                {rangeStart} - {rangeEnd} de {totalCount} itens
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="icon-sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  aria-label="Página anterior"
                >
                  <ChevronLeft className="size-4" />
                </Button>
                {pageList.map((p, i) =>
                  p === "ellipsis" ? (
                    <span key={`e-${i}`} className="px-1 text-xs text-muted-foreground">
                      …
                    </span>
                  ) : (
                    <Button
                      key={p}
                      variant={p === page ? "default" : "outline"}
                      size="icon-sm"
                      onClick={() => setPage(p)}
                      className={p === page ? "bg-[#FF5706] text-white hover:bg-[#FF5706]/90" : ""}
                    >
                      {p}
                    </Button>
                  ),
                )}
                <Button
                  variant="outline"
                  size="icon-sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  aria-label="Próxima página"
                >
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}