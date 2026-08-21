import { apiFetch } from "@/lib/api-fetch";
"use client";

// ============================================================
// /relatorios/atendimentos — main operational report: attendance
// time/volume metrics by team and by agent. Backed by the three RPCs
// in supabase/migrations/051_attendance_report_rpc.sql, which do all
// aggregation in Postgres (see that file's header for exactly which
// indicators are real data vs. documented proxy/zero — this page
// trusts those RPCs and does no re-derivation of its own).
//
// Chart color: DDM-orange-anchored 5-slot categorical palette,
// validated with the dataviz skill's validate_palette.js (both light
// and dark surfaces) — pure "orange + analogous" failed the
// lightness-band/contrast checks, so slots 2-5 are borrowed from the
// skill's default validated hue set (blue/aqua/yellow/magenta) to
// keep DDM orange as the anchor while staying CVD-safe. A 6th
// "Outros" bucket (any team/agent past the TOP 5) uses the palette's
// neutral muted-ink gray, never a generated hue, per the skill's
// "never cycle past N categorical slots" rule.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import { format, startOfMonth } from "date-fns";
import { Bot, Filter, Headphones, Search } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
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
import { Skeleton } from "@/components/dashboard/skeleton";
import type { Team } from "@/types";
import { MetricCard } from "@/components/relatorios/MetricCard";
import { AttendanceTable, type AttendanceTableColumn } from "@/components/relatorios/AttendanceTable";
import { formatDuration } from "@/lib/relatorios/format-duration";

const ALL = "all";

// Validated order: #FF5706 (DDM primary) first, then the dataviz
// skill's default blue/aqua/yellow/magenta slots — passes lightness
// band, chroma floor, CVD separation (≥8 target) and normal-vision
// floor (≥15) on both light and dark surfaces. Light mode carries a
// contrast WARN on 3 of the 5 slots, mitigated by the direct % pie
// labels + this page's tables (the required "relief" channel).
const CATEGORICAL = ["#FF5706", "#2a78d6", "#1baf7a", "#eda100", "#e87ba4"];
const OTHER_COLOR = "#898781"; // muted ink — "Outros" bucket, never a generated hue

function colorFor(index: number, isOther: boolean) {
  return isOther ? OTHER_COLOR : CATEGORICAL[index % CATEGORICAL.length];
}

// ----------------------------------------------------------
// RPC row shapes (raw, as PostgREST returns them — BIGINT/NUMERIC
// columns arrive as strings, normalized to numbers below).
// ----------------------------------------------------------
interface RawTeamRow {
  team_id: string | null;
  team_name: string | null;
  finalized: string | number;
  transferred: string | number;
  active: string | number;
  inbound: string | number;
  messages_count: string | number;
  media_count: string | number;
  tta_seconds: string | number;
  tma_seconds: string | number;
  ttp_seconds: string | number;
  tmp_seconds: string | number;
  tme_seconds: string | number;
  tmr_seconds: string | number;
}

interface RawAgentRow {
  agent_id: string | null;
  agent_name: string | null;
  finalized: string | number;
  transferred: string | number;
  active: string | number;
  inbound: string | number;
  messages_count: string | number;
  media_count: string | number;
  tta_seconds: string | number;
  tma_seconds: string | number;
  ttp_seconds: string | number;
  tmp_seconds: string | number;
  tme_seconds: string | number;
  tmr_seconds: string | number;
}

interface RawSummary {
  total_agents: string | number;
  human_messages: string | number;
  human_attendances: string | number;
  bot_messages: string | number;
  bot_attendances: string | number;
  active_count: string | number;
  inbound_count: string | number;
}

interface AttendanceRow {
  id: string;
  rawId: string | null;
  name: string;
  finalized: number;
  transferred: number;
  active: number;
  inbound: number;
  messages_count: number;
  media_count: number;
  tta_seconds: number;
  tma_seconds: number;
  ttp_seconds: number;
  tmp_seconds: number;
  tme_seconds: number;
  tmr_seconds: number;
}

function n(value: string | number | null | undefined): number {
  return Number(value ?? 0) || 0;
}

function normalizeTeamRows(rows: RawTeamRow[]): AttendanceRow[] {
  return rows.map((r) => ({
    id: r.team_id ?? "__none__",
    rawId: r.team_id,
    name: r.team_name ?? "Sem equipe",
    finalized: n(r.finalized),
    transferred: n(r.transferred),
    active: n(r.active),
    inbound: n(r.inbound),
    messages_count: n(r.messages_count),
    media_count: n(r.media_count),
    tta_seconds: n(r.tta_seconds),
    tma_seconds: n(r.tma_seconds),
    ttp_seconds: n(r.ttp_seconds),
    tmp_seconds: n(r.tmp_seconds),
    tme_seconds: n(r.tme_seconds),
    tmr_seconds: n(r.tmr_seconds),
  }));
}

function normalizeAgentRows(rows: RawAgentRow[]): AttendanceRow[] {
  return rows.map((r) => ({
    id: r.agent_id ?? "__none__",
    rawId: r.agent_id,
    name: r.agent_name ?? "Sem agente",
    finalized: n(r.finalized),
    transferred: n(r.transferred),
    active: n(r.active),
    inbound: n(r.inbound),
    messages_count: n(r.messages_count),
    media_count: n(r.media_count),
    tta_seconds: n(r.tta_seconds),
    tma_seconds: n(r.tma_seconds),
    ttp_seconds: n(r.ttp_seconds),
    tmp_seconds: n(r.tmp_seconds),
    tme_seconds: n(r.tme_seconds),
    tmr_seconds: n(r.tmr_seconds),
  }));
}

interface Summary {
  totalAgents: number;
  humanMessages: number;
  humanAttendances: number;
  botMessages: number;
  botAttendances: number;
  activeCount: number;
  inboundCount: number;
}

function normalizeSummary(row: RawSummary | null): Summary {
  return {
    totalAgents: n(row?.total_agents),
    humanMessages: n(row?.human_messages),
    humanAttendances: n(row?.human_attendances),
    botMessages: n(row?.bot_messages),
    botAttendances: n(row?.bot_attendances),
    activeCount: n(row?.active_count),
    inboundCount: n(row?.inbound_count),
  };
}

// ----------------------------------------------------------
// Table columns — identical shape for Por Equipe / Por Agente, only
// the first column's header text differs.
// ----------------------------------------------------------
function buildColumns(nameHeader: string): AttendanceTableColumn<AttendanceRow>[] {
  return [
    { key: "name", header: nameHeader, render: (r) => r.name },
    {
      key: "finalized",
      header: "Finalizados",
      align: "right",
      render: (r) => r.finalized,
      total: (rows) => rows.reduce((s, r) => s + r.finalized, 0),
    },
    {
      key: "transferred",
      header: "Transferidos",
      align: "right",
      tooltip: "Não disponível no schema atual — sempre 0 (não há histórico de transferência persistido; ver migration 051).",
      render: (r) => r.transferred,
      total: (rows) => rows.reduce((s, r) => s + r.transferred, 0),
    },
    {
      key: "active",
      header: "Ativos",
      align: "right",
      render: (r) => r.active,
      total: (rows) => rows.reduce((s, r) => s + r.active, 0),
    },
    {
      key: "inbound",
      header: "Receptivos",
      align: "right",
      tooltip: "Não disponível no schema atual — sempre 0 (não há campo de origem/direção da conversa; ver migration 051).",
      render: (r) => r.inbound,
      total: (rows) => rows.reduce((s, r) => s + r.inbound, 0),
    },
    {
      key: "messages_count",
      header: "Mensagens",
      align: "right",
      render: (r) => r.messages_count,
      total: (rows) => rows.reduce((s, r) => s + r.messages_count, 0),
    },
    {
      key: "media_count",
      header: "Mídia",
      align: "right",
      tooltip: "Mensagens cujo tipo não é texto puro (imagem, documento, áudio, vídeo, localização, template).",
      render: (r) => r.media_count,
      total: (rows) => rows.reduce((s, r) => s + r.media_count, 0),
    },
    {
      key: "tta",
      header: "TTA",
      align: "right",
      tooltip: "Tempo Total de Atendimento — soma da duração das conversas finalizadas no período.",
      render: (r) => formatDuration(r.tta_seconds),
      total: (rows) => formatDuration(rows.reduce((s, r) => s + r.tta_seconds, 0)),
    },
    {
      key: "tma",
      header: "TMA",
      align: "right",
      tooltip: "Tempo Médio de Atendimento — média da duração das conversas finalizadas.",
      render: (r) => formatDuration(r.tma_seconds),
      total: (rows) =>
        formatDuration(rows.length ? rows.reduce((s, r) => s + r.tma_seconds, 0) / rows.length : 0),
    },
    {
      key: "ttp",
      header: "TTP",
      align: "right",
      tooltip: "Tempo Total de Primeira Resposta — soma do tempo até a primeira mensagem do agente em cada conversa.",
      render: (r) => formatDuration(r.ttp_seconds),
      total: (rows) => formatDuration(rows.reduce((s, r) => s + r.ttp_seconds, 0)),
    },
    {
      key: "tmp",
      header: "TMP",
      align: "right",
      tooltip: "Tempo Médio de Primeira Resposta — média do tempo até a primeira mensagem do agente.",
      render: (r) => formatDuration(r.tmp_seconds),
      total: (rows) =>
        formatDuration(rows.length ? rows.reduce((s, r) => s + r.tmp_seconds, 0) / rows.length : 0),
    },
    {
      key: "tme",
      header: "TME",
      align: "right",
      tooltip: "Tempo Médio de Espera — simplificação: usa o mesmo cálculo do TMP como proxy (ver migration 051).",
      render: (r) => formatDuration(r.tme_seconds),
      total: (rows) =>
        formatDuration(rows.length ? rows.reduce((s, r) => s + r.tme_seconds, 0) / rows.length : 0),
    },
    {
      key: "tmr",
      header: "TMR",
      align: "right",
      tooltip: "Tempo Médio de Resposta — simplificação: usa o mesmo cálculo do TME/TMP como proxy (ver migration 051).",
      render: (r) => formatDuration(r.tmr_seconds),
      total: (rows) =>
        formatDuration(rows.length ? rows.reduce((s, r) => s + r.tmr_seconds, 0) / rows.length : 0),
    },
  ];
}

// ----------------------------------------------------------
// Chart data — TOP 5 by atendimentos (finalized+active), remainder
// folded into a single "Outros" bucket (never a generated hue).
// Both pies and the bar chart share this one ranked+folded set so
// their categories line up.
// ----------------------------------------------------------
interface ComparisonItem {
  name: string;
  atendimentos: number;
  mensagens: number;
}

function buildComparisonItems(rows: AttendanceRow[]): ComparisonItem[] {
  const items = rows
    .map((r) => ({ name: r.name, atendimentos: r.finalized + r.active, mensagens: r.messages_count }))
    .filter((r) => r.atendimentos > 0 || r.mensagens > 0)
    .sort((a, b) => b.atendimentos - a.atendimentos);

  const top = items.slice(0, 5);
  const rest = items.slice(5);
  if (rest.length === 0) return top;

  const outros = rest.reduce(
    (acc, r) => ({ name: "Outros", atendimentos: acc.atendimentos + r.atendimentos, mensagens: acc.mensagens + r.mensagens }),
    { name: "Outros", atendimentos: 0, mensagens: 0 },
  );
  return [...top, outros];
}

function pct(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((value / total) * 1000) / 10;
}

function renderPieLabel({ percent }: { percent?: number }) {
  return `${Math.round((percent ?? 0) * 100)}%`;
}

// ============================================================
// AttendanceSection — Por Equipe / Por Agente share this exact
// structure (table + 2 pies + 1 bar chart); only the name column
// header and the row set differ between the two callers.
// ============================================================
function AttendanceSection({
  title,
  nameHeader,
  rows,
  loading,
}: {
  title: string;
  nameHeader: string;
  rows: AttendanceRow[];
  loading: boolean;
}) {
  const columns = useMemo(() => buildColumns(nameHeader), [nameHeader]);
  const comparison = useMemo(() => buildComparisonItems(rows), [rows]);

  const totalAtendimentos = useMemo(
    () => rows.reduce((s, r) => s + r.finalized + r.active, 0),
    [rows],
  );
  const totalMensagens = useMemo(() => rows.reduce((s, r) => s + r.messages_count, 0), [rows]);

  const pieAtendimentos = comparison.map((item, i) => ({
    name: item.name,
    value: item.atendimentos,
    color: colorFor(i, item.name === "Outros"),
  }));
  const pieMensagens = comparison.map((item, i) => ({
    name: item.name,
    value: item.mensagens,
    color: colorFor(i, item.name === "Outros"),
  }));
  const barData = comparison.map((item) => ({
    name: item.name,
    "Atendimentos %": pct(item.atendimentos, totalAtendimentos),
    "Mensagens %": pct(item.mensagens, totalMensagens),
  }));

  return (
    <section className="space-y-4">
      <h2 className="text-base font-semibold text-foreground">{title}</h2>

      <div className="rounded-xl border border-border bg-card p-4">
        {loading ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <AttendanceTable rows={rows} columns={columns} getRowKey={(r) => r.id} />
        )}
      </div>

      {!loading && comparison.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-border bg-card p-4">
            <p className="mb-2 text-sm font-medium text-foreground">
              % de atendimentos por {nameHeader.toLowerCase()} (TOP 5)
            </p>
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie
                  data={pieAtendimentos}
                  dataKey="value"
                  nameKey="name"
                  outerRadius={90}
                  label={renderPieLabel}
                >
                  {pieAtendimentos.map((entry) => (
                    <Cell key={entry.name} fill={entry.color} />
                  ))}
                </Pie>
                <RechartsTooltip />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>

          <div className="rounded-xl border border-border bg-card p-4">
            <p className="mb-2 text-sm font-medium text-foreground">
              % de mensagens por {nameHeader.toLowerCase()} (TOP 5)
            </p>
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie
                  data={pieMensagens}
                  dataKey="value"
                  nameKey="name"
                  outerRadius={90}
                  label={renderPieLabel}
                >
                  {pieMensagens.map((entry) => (
                    <Cell key={entry.name} fill={entry.color} />
                  ))}
                </Pie>
                <RechartsTooltip />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>

          <div className="rounded-xl border border-border bg-card p-4 lg:col-span-2">
            <p className="mb-2 text-sm font-medium text-foreground">
              Atendimentos e Mensagens % por {nameHeader.toLowerCase()}
            </p>
            <ResponsiveContainer width="100%" height={Math.max(200, barData.length * 44 + 40)}>
              <BarChart data={barData} layout="vertical" margin={{ left: 16, right: 16 }}>
                <CartesianGrid horizontal={false} stroke="#e1e0d9" />
                <XAxis type="number" domain={[0, 100]} unit="%" stroke="#898781" />
                <YAxis type="category" dataKey="name" width={140} stroke="#898781" />
                <RechartsTooltip />
                <Legend />
                <Bar dataKey="Atendimentos %" fill={CATEGORICAL[0]} radius={[0, 4, 4, 0]} />
                <Bar dataKey="Mensagens %" fill={CATEGORICAL[1]} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </section>
  );
}

interface Filters {
  dateFrom: string;
  dateTo: string;
  teamId: string;
}

function defaultFilters(): Filters {
  return {
    dateFrom: format(startOfMonth(new Date()), "yyyy-MM-dd"),
    dateTo: format(new Date(), "yyyy-MM-dd"),
    teamId: ALL,
  };
}

export default function AtendimentosPage() {
  const { accountId } = useAuth();

  const [teams, setTeams] = useState<Team[]>([]);
  const [members, setMembers] = useState<{ user_id: string; team_id: string | null }[]>([]);

  const [draft, setDraft] = useState<Filters>(defaultFilters);
  const [applied, setApplied] = useState<Filters>(defaultFilters);

  const [teamRows, setTeamRows] = useState<AttendanceRow[]>([]);
  const [agentRows, setAgentRows] = useState<AttendanceRow[]>([]);
  const [summary, setSummary] = useState<Summary>(normalizeSummary(null));
  const [loading, setLoading] = useState(true);

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
          console.error("[atendimentos] failed to load teams:", error);
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
      .then((data: { members?: { user_id: string; team_id: string | null }[] }) => {
        if (!cancelled) setMembers(data.members ?? []);
      })
      .catch((err) => console.error("[atendimentos] failed to load members:", err));
    return () => {
      cancelled = true;
    };
  }, []);

  const runSearch = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    try {
      const db = createClient();
      const p_date_from = `${applied.dateFrom}T00:00:00`;
      const p_date_to = `${applied.dateTo}T23:59:59`;

      const [teamRes, agentRes, summaryRes] = await Promise.all([
        db.rpc("get_attendance_report_by_team", { p_account_id: accountId, p_date_from, p_date_to }),
        db.rpc("get_attendance_report_by_agent", { p_account_id: accountId, p_date_from, p_date_to }),
        db.rpc("get_attendance_summary", { p_account_id: accountId, p_date_from, p_date_to }),
      ]);

      if (teamRes.error) throw teamRes.error;
      if (agentRes.error) throw agentRes.error;
      if (summaryRes.error) throw summaryRes.error;

      setTeamRows(normalizeTeamRows((teamRes.data ?? []) as RawTeamRow[]));
      setAgentRows(normalizeAgentRows((agentRes.data ?? []) as RawAgentRow[]));
      const summaryRow = Array.isArray(summaryRes.data) ? summaryRes.data[0] : summaryRes.data;
      setSummary(normalizeSummary((summaryRow ?? null) as RawSummary | null));
    } catch (err) {
      console.error("[atendimentos] failed to load report:", err);
    } finally {
      setLoading(false);
    }
  }, [accountId, applied]);

  useEffect(() => {
    runSearch();
  }, [runSearch]);

  // "Equipes" filter only scopes the Por Agente section — Por Equipe
  // is the aggregate-by-team view itself, filtering it by team would
  // just isolate one row.
  const filteredAgentRows = useMemo(() => {
    if (applied.teamId === ALL) return agentRows;
    return agentRows.filter((r) => {
      if (!r.rawId) return false;
      const member = members.find((m) => m.user_id === r.rawId);
      return member?.team_id === applied.teamId;
    });
  }, [agentRows, applied.teamId, members]);

  function handlePesquisar() {
    setApplied(draft);
  }

  return (
    <div className="space-y-6 p-4 lg:p-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Atendimentos</h1>
        <p className="text-sm text-muted-foreground">
          Métricas de tempo e volume de atendimento por equipe e agente.
        </p>
      </div>

      <div className="rounded-xl border border-border bg-card p-4">
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
            <label className="text-xs font-medium text-muted-foreground">Equipes</label>
            <Select value={draft.teamId} onValueChange={(v) => v && setDraft((d) => ({ ...d, teamId: v }))}>
              <SelectTrigger className="w-44">
                <SelectValue>
                  {(v: string) => (v === ALL ? "Todas" : teams.find((t) => t.id === v)?.name ?? v)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Todas</SelectItem>
                {teams.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
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

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-32 w-full rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-3">
          <MetricCard
            title="Atendimento Humano"
            icon={Headphones}
            metrics={[
              { label: "Agentes", value: summary.totalAgents },
              { label: "Msgs", value: summary.humanMessages },
              { label: "Atend", value: summary.humanAttendances },
            ]}
          />
          <MetricCard
            title="Autoatendimento"
            icon={Bot}
            metrics={[
              { label: "Msgs", value: summary.botMessages },
              { label: "Atend", value: summary.botAttendances },
            ]}
          />
          <MetricCard
            title="Classificação"
            icon={Filter}
            metrics={[
              { label: "Ativos", value: "—" },
              { label: "Receptivos", value: "—" },
            ]}
          />
        </div>
      )}

      <AttendanceSection title="Por Equipe" nameHeader="Equipe" rows={teamRows} loading={loading} />
      <AttendanceSection title="Por Agente" nameHeader="Agente" rows={filteredAgentRows} loading={loading} />
    </div>
  );
}
