"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import type { LogLevel, LogSource } from "@/lib/logger";

interface LogRow {
  id: string;
  account_id: string | null;
  level: string;
  source: string;
  event: string;
  message: string;
  payload: unknown;
  created_at: string;
}

interface LogsResponse {
  logs: LogRow[];
  count: number;
  hasMore: boolean;
  nextCursor: string | null;
  error?: string;
}

const SOURCE_OPTIONS: LogSource[] = [
  "disparador",
  "webhook_meta",
  "webhook_waha",
  "flows",
  "ai_agent",
  "automations",
  "import",
  "system",
];

const LEVEL_OPTIONS: LogLevel[] = ["debug", "info", "warn", "error", "critical"];

const PERIOD_OPTIONS: { value: string; label: string; ms: number }[] = [
  { value: "1h", label: "Última 1h", ms: 60 * 60 * 1000 },
  { value: "6h", label: "Últimas 6h", ms: 6 * 60 * 60 * 1000 },
  { value: "24h", label: "Últimas 24h", ms: 24 * 60 * 60 * 1000 },
  { value: "7d", label: "Últimos 7 dias", ms: 7 * 24 * 60 * 60 * 1000 },
];

const LEVEL_BADGE_STYLES: Record<string, string> = {
  debug: "bg-zinc-600/30 text-zinc-300 border-zinc-500/40",
  info: "bg-sky-600/20 text-sky-300 border-sky-500/40",
  warn: "bg-amber-500/20 text-amber-300 border-amber-500/40",
  error: "bg-red-600/25 text-red-300 border-red-500/50",
  critical: "bg-red-600/40 text-red-100 border-red-400/70 animate-pulse",
};

const SOURCE_BADGE_STYLE =
  "bg-[#FF5706]/15 text-[#FF5706] border-[#FF5706]/40";

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

// Mini syntax highlighter pra JSON — sem dependência externa (a página é
// standalone de propósito). Escapa o texto antes de envolver em <span>,
// então é seguro mesmo com payload contendo texto arbitrário do usuário.
function highlightJson(value: unknown): string {
  const json = JSON.stringify(value, null, 2) ?? "null";
  const escaped = json
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped.replace(
    /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (match) => {
      let cls = "text-orange-300"; // número
      if (/^"/.test(match)) {
        cls = /:\s*$/.test(match) ? "text-sky-300" : "text-emerald-300"; // chave vs. valor string
      } else if (/^(true|false)$/.test(match)) {
        cls = "text-purple-300";
      } else if (match === "null") {
        cls = "text-zinc-500";
      }
      return `<span class="${cls}">${match}</span>`;
    }
  );
}

// Threshold de agrupamento — 2 repetições consecutivas ficam separadas,
// só a partir de 3 vira um grupo colapsado.
const GROUP_MIN_SIZE = 3;

type DisplayItem =
  | { type: "single"; log: LogRow }
  | { type: "group"; key: string; logs: LogRow[] };

// Agrupa só corridas CONSECUTIVAS de source+event+message idênticos —
// `logs` já vem ordenado por created_at DESC da API, então "consecutivo"
// aqui é adjacência na lista, não repetição em qualquer posição.
function groupConsecutiveLogs(logs: LogRow[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  let i = 0;
  while (i < logs.length) {
    let j = i + 1;
    while (
      j < logs.length &&
      logs[j].source === logs[i].source &&
      logs[j].event === logs[i].event &&
      logs[j].message === logs[i].message
    ) {
      j++;
    }
    const run = logs.slice(i, j);
    if (run.length >= GROUP_MIN_SIZE) {
      items.push({ type: "group", key: `grp_${run[0].id}`, logs: run });
    } else {
      for (const log of run) items.push({ type: "single", log });
    }
    i = j;
  }
  return items;
}

export default function DdmLogsPage() {
  const [sourceFilter, setSourceFilter] = useState("");
  const [levelFilter, setLevelFilter] = useState("");
  const [period, setPeriod] = useState("24h");

  const [logs, setLogs] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const displayItems = useMemo(() => groupConsecutiveLogs(logs), [logs]);

  const periodMs =
    PERIOD_OPTIONS.find((p) => p.value === period)?.ms ?? 24 * 60 * 60 * 1000;

  const buildUrl = useCallback(
    (cursorParam?: string | null) => {
      const params = new URLSearchParams();
      if (sourceFilter) params.set("source", sourceFilter);
      if (levelFilter) params.set("level", levelFilter);
      params.set("from", new Date(Date.now() - periodMs).toISOString());
      params.set("limit", "200");
      if (cursorParam) params.set("cursor", cursorParam);
      return `/api/ddm-logs?${params.toString()}`;
    },
    [sourceFilter, levelFilter, periodMs]
  );

  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(buildUrl());
      const data: LogsResponse = await res.json();
      if (!res.ok) throw new Error(data.error || "Falha ao carregar logs");
      setLogs(data.logs);
      setHasMore(data.hasMore);
      setCursor(data.nextCursor);
      setLastUpdated(new Date());
    } catch (err: any) {
      setError(err.message || "Erro ao carregar logs");
    } finally {
      setLoading(false);
    }
  }, [buildUrl]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(buildUrl(cursor));
      const data: LogsResponse = await res.json();
      if (!res.ok) throw new Error(data.error || "Falha ao carregar logs");
      setLogs((prev) => [...prev, ...data.logs]);
      setHasMore(data.hasMore);
      setCursor(data.nextCursor);
    } catch (err: any) {
      setError(err.message || "Erro ao carregar logs");
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, buildUrl]);

  // Recarrega do zero sempre que um filtro muda.
  useEffect(() => {
    loadFirstPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceFilter, levelFilter, period]);

  // Auto-refresh — sempre reseta pra primeira página (novos logs mudam a
  // ordenação, não faz sentido só anexar ao final).
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => {
      loadFirstPage();
    }, 30000);
    return () => clearInterval(id);
  }, [autoRefresh, loadFirstPage]);

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Reaproveitada tanto pras linhas não agrupadas quanto pelas linhas
  // individuais de um grupo expandido — mesmo comportamento de
  // clique-pra-expandir-payload nos dois casos.
  const renderLogRow = (log: LogRow) => {
    const isExpanded = expanded.has(log.id);
    const isErrorish = log.level === "error" || log.level === "critical";
    return (
      <Fragment key={log.id}>
        <tr
          onClick={() => toggleExpand(log.id)}
          className={`cursor-pointer border-b border-white/5 transition-colors hover:bg-white/[0.04] ${
            isErrorish ? "bg-red-500/[0.06]" : ""
          }`}
        >
          <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-zinc-400">
            {formatTimestamp(log.created_at)}
          </td>
          <td className="px-3 py-2">
            <span
              className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase ${
                LEVEL_BADGE_STYLES[log.level] ?? LEVEL_BADGE_STYLES.info
              }`}
            >
              {log.level}
            </span>
          </td>
          <td className="px-3 py-2">
            <span
              className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-medium ${SOURCE_BADGE_STYLE}`}
            >
              {log.source}
            </span>
          </td>
          <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-zinc-300">
            {log.event}
          </td>
          <td className="max-w-md truncate px-3 py-2 text-zinc-200">{log.message}</td>
        </tr>
        {isExpanded && (
          <tr className="border-b border-white/5 bg-black/40">
            <td colSpan={5} className="px-3 py-3">
              {log.account_id && (
                <p className="mb-2 font-mono text-[11px] text-zinc-500">
                  account_id: {log.account_id}
                </p>
              )}
              <pre
                className="overflow-x-auto rounded-md bg-black/60 p-3 font-mono text-[11px] leading-relaxed text-zinc-300"
                // Seguro: highlightJson escapa &/</> antes de envolver em
                // <span> com classes fixas — não há atributo/HTML
                // controlado pelo payload.
                dangerouslySetInnerHTML={{
                  __html: highlightJson(log.payload ?? {}),
                }}
              />
            </td>
          </tr>
        )}
      </Fragment>
    );
  };

  return (
    <div className="flex min-h-screen flex-col">
      {/* Header fixo */}
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-white/10 bg-[#1F1F1F]/95 px-4 py-3 backdrop-blur">
        <h1 className="text-lg font-semibold text-white">DDM Logs</h1>
        <span className="rounded-full border border-[#FF5706]/40 bg-[#FF5706]/15 px-2.5 py-0.5 text-xs font-medium text-[#FF5706]">
          {logs.length} {logs.length === 1 ? "linha" : "linhas"}
        </span>

        <div className="ml-auto flex items-center gap-2">
          {lastUpdated && (
            <span className="hidden text-xs text-zinc-500 sm:inline">
              Atualizado às {formatTimestamp(lastUpdated.toISOString())}
            </span>
          )}
          <button
            type="button"
            onClick={() => setAutoRefresh((v) => !v)}
            className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
              autoRefresh
                ? "border-[#FF5706]/60 bg-[#FF5706]/20 text-[#FF5706]"
                : "border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10"
            }`}
          >
            Auto-refresh (30s) {autoRefresh ? "ON" : "OFF"}
          </button>
          <button
            type="button"
            onClick={() => loadFirstPage()}
            disabled={loading}
            className="rounded-md bg-[#FF5706] px-3 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "Atualizando..." : "Atualizar"}
          </button>
        </div>
      </header>

      {/* Filtros */}
      <div className="flex flex-wrap items-center gap-3 border-b border-white/10 bg-white/[0.02] px-4 py-3">
        <label className="flex items-center gap-2 text-xs text-zinc-400">
          Source
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            className="rounded-md border border-white/10 bg-[#262626] px-2 py-1.5 text-xs text-zinc-100 focus:border-[#FF5706]/60 focus:outline-none"
          >
            <option value="">Todos</option>
            {SOURCE_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-xs text-zinc-400">
          Level
          <select
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value)}
            className="rounded-md border border-white/10 bg-[#262626] px-2 py-1.5 text-xs text-zinc-100 focus:border-[#FF5706]/60 focus:outline-none"
          >
            <option value="">Todos</option>
            {LEVEL_OPTIONS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-xs text-zinc-400">
          Período
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            className="rounded-md border border-white/10 bg-[#262626] px-2 py-1.5 text-xs text-zinc-100 focus:border-[#FF5706]/60 focus:outline-none"
          >
            {PERIOD_OPTIONS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Corpo */}
      <main className="flex-1 px-4 py-4">
        {error && (
          <div className="mb-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        {loading && logs.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-sm text-zinc-500">
            Carregando logs...
          </div>
        ) : logs.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-sm text-zinc-500">
            Nenhum log encontrado para os filtros atuais.
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-white/10">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-white/10 bg-white/[0.03] text-xs uppercase tracking-wide text-zinc-500">
                  <th className="px-3 py-2 font-medium">Timestamp</th>
                  <th className="px-3 py-2 font-medium">Level</th>
                  <th className="px-3 py-2 font-medium">Source</th>
                  <th className="px-3 py-2 font-medium">Event</th>
                  <th className="px-3 py-2 font-medium">Message</th>
                </tr>
              </thead>
              <tbody>
                {displayItems.map((item) => {
                  if (item.type === "single") {
                    return renderLogRow(item.log);
                  }

                  const { key, logs: groupLogs } = item;
                  const isGroupExpanded = expandedGroups.has(key);
                  const first = groupLogs[0];
                  const isErrorish = first.level === "error" || first.level === "critical";

                  return (
                    <Fragment key={key}>
                      <tr
                        onClick={() => toggleGroup(key)}
                        className={`cursor-pointer border-b border-white/5 transition-colors hover:bg-white/[0.04] ${
                          isErrorish ? "bg-red-500/[0.06]" : ""
                        }`}
                      >
                        <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-zinc-400">
                          {formatTimestamp(groupLogs[groupLogs.length - 1].created_at)} →{" "}
                          {formatTimestamp(first.created_at)}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase ${
                              LEVEL_BADGE_STYLES[first.level] ?? LEVEL_BADGE_STYLES.info
                            }`}
                          >
                            {first.level}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-medium ${SOURCE_BADGE_STYLE}`}
                          >
                            {first.source}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-zinc-300">
                          {first.event}
                        </td>
                        <td className="max-w-md truncate px-3 py-2 text-zinc-200">
                          <span className="mr-2 inline-block rounded-full border border-[#FF5706]/60 bg-[#FF5706] px-2 py-0.5 text-[10px] font-bold text-white">
                            ×{groupLogs.length}
                          </span>
                          {first.message}
                        </td>
                      </tr>
                      {isGroupExpanded && groupLogs.map((log) => renderLogRow(log))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {hasMore && (
          <div className="mt-4 flex justify-center">
            <button
              type="button"
              onClick={() => loadMore()}
              disabled={loadingMore}
              className="rounded-md border border-white/10 bg-white/5 px-4 py-2 text-xs font-medium text-zinc-300 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loadingMore ? "Carregando..." : "Carregar mais"}
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
