"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import type { LogLevel, LogSource } from "@/lib/logger";
import { SystemHealthCard } from "@/components/ops/system-health-card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

// Logs use the signed-in CRM session; remove reusable legacy credentials.
const AUTH_STORAGE_KEY = "ddm-logs-auth";

interface LogRow {
  id: string;
  account_id: string | null;
  user_id?: string | null;
  // Só vêm preenchidos na aba Ações (RPC get_action_logs, migration
  // 097, LEFT JOIN em profiles) — ausentes na aba Eventos.
  user_name?: string | null;
  user_email?: string | null;
  page?: string | null;
  action?: string | null;
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

interface UserRankingRow {
  user_id: string;
  full_name: string | null;
  email: string | null;
  error_count: number;
  total_events: number;
  last_seen: string;
}

interface UsersResponse {
  users: UserRankingRow[];
  count: number;
  error?: string;
}

interface SessionRow {
  id: string;
  user_id: string | null;
  account_id: string | null;
  user_name: string | null;
  ip_address: string | null;
  user_agent: string | null;
  started_at: string;
  ended_at: string | null;
  page_count: number;
}

interface SessionsResponse {
  sessions: SessionRow[];
  count: number;
  hasMore: boolean;
  nextCursor: string | null;
  error?: string;
}

// Formato de cada teste individual dentro de uma execução — espelha
// TestResult em src/app/api/stress/run/route.ts.
type TestStatus = "pass" | "warn" | "fail";
interface TestResult {
  name: string;
  status: TestStatus;
  duration_ms: number;
  message: string;
}

// Uma linha de system_logs com event='automated_health_check' — payload
// já vem no formato { results: TestResult[], duration_total_ms: number }
// (ver route.ts). id/created_at/level/message são as colunas nativas de
// system_logs, iguais a qualquer outra aba.
interface TestRunRow {
  id: string;
  created_at: string;
  level: string;
  message: string;
  payload: { results: TestResult[]; duration_total_ms: number } | null;
}

interface TestsResponse {
  runs: TestRunRow[];
  count: number;
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
  "frontend",
  "api_v1",
  "feedback",
];

const LEVEL_OPTIONS: LogLevel[] = ["debug", "info", "warn", "error", "critical"];

const PERIOD_OPTIONS: { value: string; label: string; ms: number }[] = [
  { value: "1h", label: "Última 1h", ms: 60 * 60 * 1000 },
  { value: "6h", label: "Últimas 6h", ms: 6 * 60 * 60 * 1000 },
  { value: "24h", label: "Últimas 24h", ms: 24 * 60 * 60 * 1000 },
  { value: "7d", label: "Últimos 7 dias", ms: 7 * 24 * 60 * 60 * 1000 },
];

const LEVEL_BADGE_STYLES: Record<string, string> = {
  debug: "bg-surface-3 text-foreground-2 border-border",
  info: "bg-[rgba(91,141,239,.14)] text-[#5B8DEF] [html[data-mode=light]_&]:text-[#3B6FD8] border-[#5B8DEF]/40",
  warn: "bg-warning-soft text-warning border-warning/40",
  error: "bg-danger-soft text-danger border-danger/40",
  critical: "bg-danger-soft text-danger border-danger/40 animate-pulse",
};

const SOURCE_BADGE_STYLE =
  "bg-primary/15 text-primary-text border-primary/40";

// Aba Testes — badge do status geral/individual e cor de fundo do card
// por execução (ver overall em route.ts: 'pass' se todos pass, 'warn'
// se algum warn e nenhum fail, 'fail' se algum fail).
const TEST_STATUS_BADGE: Record<TestStatus, string> = {
  pass: "bg-success-soft text-success border-success/40",
  warn: "bg-warning-soft text-warning border-warning/40",
  fail: "bg-danger-soft text-danger border-danger/40",
};
const TEST_STATUS_LABEL: Record<TestStatus, string> = {
  pass: "✅ PASS",
  warn: "⚠️ WARN",
  fail: "❌ FAIL",
};
const TEST_CARD_BG: Record<TestStatus, string> = {
  pass: "border-success/40 bg-success-soft",
  warn: "border-warning/40 bg-warning-soft",
  fail: "border-danger/40 bg-danger-soft",
};

type Tab = "events" | "users" | "sessions" | "actions" | "tests" | "feedback";

const TAB_OPTIONS: { value: Tab; label: string }[] = [
  { value: "events", label: "Eventos" },
  { value: "users", label: "Por Usuário" },
  { value: "sessions", label: "Sessões" },
  { value: "actions", label: "Ações" },
  { value: "tests", label: "Testes" },
  { value: "feedback", label: "Feedbacks" },
];

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

function formatDuration(startIso: string, endIso: string | null): string {
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const ms = Math.max(0, end - new Date(startIso).getTime());
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}min`;
  if (minutes > 0) return `${minutes}min`;
  return `${seconds}s`;
}

// Sem lib externa (página standalone de propósito) — extrai só o nome
// do navegador pra não poluir a tabela com a string de UA inteira.
function summarizeUserAgent(ua: string | null): string {
  if (!ua) return "—";
  const match = ua.match(/(Edg|Chrome|Firefox|Safari|OPR)\/[\d.]+/);
  if (match) return match[0].replace("Edg/", "Edge ").replace("OPR/", "Opera ");
  return ua.slice(0, 40);
}

function getInitials(name?: string | null): string {
  if (!name) return "?";
  return name
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

const ACTION_BADGE_PALETTE = [
  "bg-[rgba(91,141,239,.14)] text-[#5B8DEF] [html[data-mode=light]_&]:text-[#3B6FD8] border-[#5B8DEF]/40",
  "bg-success-soft text-success border-success/40",
  "bg-purple-500/15 text-purple-300 [html[data-mode=light]_&]:text-purple-700 border-purple-500/40",
  "bg-warning-soft text-warning border-warning/40",
  "bg-pink-500/15 text-pink-300 [html[data-mode=light]_&]:text-pink-700 border-pink-500/40",
  "bg-cyan-500/15 text-cyan-300 [html[data-mode=light]_&]:text-cyan-700 border-cyan-500/40",
];

// user_name vem da RPC get_action_logs (LEFT JOIN em profiles,
// migration 097) — cai pro user_id truncado se o join não achou
// profile (usuário sem perfil, ou log sem user_id nenhum).
function displayUserName(log: Pick<LogRow, "user_id" | "user_name">): string {
  if (log.user_name) return log.user_name;
  if (log.user_id) return log.user_id.slice(0, 8);
  return "—";
}

// Hash determinístico string->paleta — ações novas ganham cor estável
// sem precisar manter um mapa manual toda vez que uma ação nova aparece.
function actionBadgeStyle(action: string): string {
  let hash = 0;
  for (let i = 0; i < action.length; i++) {
    hash = (hash * 31 + action.charCodeAt(i)) >>> 0;
  }
  return ACTION_BADGE_PALETTE[hash % ACTION_BADGE_PALETTE.length];
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
      let cls = "text-orange-300 [html[data-mode=light]_&]:text-orange-700"; // número
      if (/^"/.test(match)) {
        cls = /:\s*$/.test(match) ? "text-[#5B8DEF] [html[data-mode=light]_&]:text-[#3B6FD8]" : "text-success"; // chave vs. valor string
      } else if (/^(true|false)$/.test(match)) {
        cls = "text-purple-300 [html[data-mode=light]_&]:text-purple-700";
      } else if (match === "null") {
        cls = "text-muted-foreground";
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
// Reaproveitada pela aba Ações (mesma forma de linha, mesma regra).
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
  const [tab, setTab] = useState<Tab>("events");
  // Setado ao clicar numa linha da aba "Por Usuário" — filtra a aba
  // Eventos (e Sessões) por esse usuário. Chip dispensável no filtro.
  const [userIdFilter, setUserIdFilter] = useState<string | null>(null);

  const [sourceFilter, setSourceFilter] = useState("");
  const [levelFilter, setLevelFilter] = useState("");
  const [period, setPeriod] = useState("24h");

  // ---- Aba Eventos (comportamento pré-existente, intocado) ----
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  // ---- Aba Por Usuário ----
  const [users, setUsers] = useState<UserRankingRow[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState<string | null>(null);

  // ---- Aba Sessões ----
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsLoadingMore, setSessionsLoadingMore] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [sessionsHasMore, setSessionsHasMore] = useState(false);
  const [sessionsCursor, setSessionsCursor] = useState<string | null>(null);

  // ---- Aba Ações ----
  const [actionLogs, setActionLogs] = useState<LogRow[]>([]);
  const [actionsLoading, setActionsLoading] = useState(false);
  const [actionsLoadingMore, setActionsLoadingMore] = useState(false);
  const [actionsError, setActionsError] = useState<string | null>(null);
  const [actionsHasMore, setActionsHasMore] = useState(false);
  const [actionsCursor, setActionsCursor] = useState<string | null>(null);
  const [actionsExpanded, setActionsExpanded] = useState<Set<string>>(new Set());
  const [actionsExpandedGroups, setActionsExpandedGroups] = useState<Set<string>>(new Set());
  const [actionTypeFilter, setActionTypeFilter] = useState("");
  // Acumula (nunca encolhe) todo `action` já visto em qualquer carga —
  // o filtro agora é server-side, então a página carregada só contém o
  // tipo selecionado; sem isso, o próprio ato de filtrar faria o select
  // colapsar pra uma única opção.
  const [knownActionTypes, setKnownActionTypes] = useState<Set<string>>(new Set());

  // ---- Aba Testes ----
  const [testRuns, setTestRuns] = useState<TestRunRow[]>([]);
  const [testsLoading, setTestsLoading] = useState(false);
  const [testsError, setTestsError] = useState<string | null>(null);
  const [expandedTestRuns, setExpandedTestRuns] = useState<Set<string>>(new Set());
  const [runningNow, setRunningNow] = useState(false);
  const [runNowError, setRunNowError] = useState<string | null>(null);
  const [runSecretDialogOpen, setRunSecretDialogOpen] = useState(false);
  // Segredo digitado só vive neste estado enquanto o diálogo está aberto;
  // é limpo ao fechar e nunca é salvo nem exibido.
  const [runSecretInput, setRunSecretInput] = useState("");

  // ---- Aba Feedbacks ----
  const [feedbackLogs, setFeedbackLogs] = useState<LogRow[]>([]);
  const [feedbackLoading, setFeedbackLoading] = useState(false);
  const [feedbackLoadingMore, setFeedbackLoadingMore] = useState(false);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [feedbackHasMore, setFeedbackHasMore] = useState(false);
  const [feedbackCursor, setFeedbackCursor] = useState<string | null>(null);
  const [expandedFeedbackUserAgents, setExpandedFeedbackUserAgents] = useState<Set<string>>(
    new Set()
  );

  const [autoRefresh, setAutoRefresh] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const authHeader = "session";
  const [needsLogin, setNeedsLogin] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  useEffect(() => { window.localStorage.removeItem(AUTH_STORAGE_KEY); }, []);

  const displayItems = useMemo(() => groupConsecutiveLogs(logs), [logs]);

  // actionLogs já vem filtrado pelo servidor (p_action da RPC) —
  // agrupa direto, sem filtro client-side.
  const actionDisplayItems = useMemo(() => groupConsecutiveLogs(actionLogs), [actionLogs]);
  const actionTypes = useMemo(() => Array.from(knownActionTypes).sort(), [knownActionTypes]);

  const periodMs =
    PERIOD_OPTIONS.find((p) => p.value === period)?.ms ?? 24 * 60 * 60 * 1000;
  const fromIso = useMemo(() => new Date(Date.now() - periodMs).toISOString(), [periodMs]);

  const buildUrl = useCallback(
    (cursorParam?: string | null) => {
      const params = new URLSearchParams();
      params.set("tab", "events");
      if (sourceFilter) params.set("source", sourceFilter);
      if (levelFilter) params.set("level", levelFilter);
      if (userIdFilter) params.set("user_id", userIdFilter);
      params.set("from", fromIso);
      params.set("limit", "200");
      if (cursorParam) params.set("cursor", cursorParam);
      return `/api/ddm-logs?${params.toString()}`;
    },
    [sourceFilter, levelFilter, userIdFilter, fromIso]
  );

  const buildUsersUrl = useCallback(() => {
    const params = new URLSearchParams();
    params.set("tab", "users");
    params.set("from", fromIso);
    return `/api/ddm-logs?${params.toString()}`;
  }, [fromIso]);

  const buildSessionsUrl = useCallback(
    (cursorParam?: string | null) => {
      const params = new URLSearchParams();
      params.set("tab", "sessions");
      if (userIdFilter) params.set("user_id", userIdFilter);
      params.set("from", fromIso);
      params.set("limit", "100");
      if (cursorParam) params.set("cursor", cursorParam);
      return `/api/ddm-logs?${params.toString()}`;
    },
    [userIdFilter, fromIso]
  );

  const buildActionsUrl = useCallback(
    (cursorParam?: string | null) => {
      const params = new URLSearchParams();
      params.set("tab", "actions");
      if (userIdFilter) params.set("user_id", userIdFilter);
      if (actionTypeFilter) params.set("action", actionTypeFilter);
      params.set("from", fromIso);
      params.set("limit", "200");
      if (cursorParam) params.set("cursor", cursorParam);
      return `/api/ddm-logs?${params.toString()}`;
    },
    [userIdFilter, actionTypeFilter, fromIso]
  );

  const buildTestsUrl = useCallback(() => {
    const params = new URLSearchParams();
    params.set("tab", "tests");
    return `/api/ddm-logs?${params.toString()}`;
  }, []);

  const buildFeedbackUrl = useCallback(
    (cursorParam?: string | null) => {
      const params = new URLSearchParams();
      params.set("tab", "feedback");
      params.set("from", fromIso);
      params.set("limit", "200");
      if (cursorParam) params.set("cursor", cursorParam);
      return `/api/ddm-logs?${params.toString()}`;
    },
    [fromIso]
  );

  // Fetch autenticado compartilhado por todas as abas — trata 401 num
  // único lugar: limpa a credencial guardada e volta pro formulário de
  // login. Retorna null nesse caso (chamador já não tem mais o que
  // fazer com a resposta).
  const authorizedFetch = useCallback(async (url: string): Promise<Response | null> => {
    const res = await fetch(url, { credentials: "same-origin" });
    if (res.status === 401) { window.location.assign("/login?next=%2Fddm-logs"); return null; }
    if (res.status === 403) { setNeedsLogin(true); setLoginError("Acesso permitido somente a administradores da sua conta."); return null; }
    return res;
  }, []);

  // ---- Eventos: load (comportamento pré-existente) ----
  const loadFirstPage = useCallback(async () => {
    if (!authHeader) return;
    setLoading(true);
    setError(null);
    try {
      const res = await authorizedFetch(buildUrl());
      if (!res) return;
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
  }, [authHeader, authorizedFetch, buildUrl]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore || !authHeader) return;
    setLoadingMore(true);
    try {
      const res = await authorizedFetch(buildUrl(cursor));
      if (!res) return;
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
  }, [cursor, loadingMore, authHeader, authorizedFetch, buildUrl]);

  // ---- Por Usuário: load ----
  const loadUsers = useCallback(async () => {
    if (!authHeader) return;
    setUsersLoading(true);
    setUsersError(null);
    try {
      const res = await authorizedFetch(buildUsersUrl());
      if (!res) return;
      const data: UsersResponse = await res.json();
      if (!res.ok) throw new Error(data.error || "Falha ao carregar ranking");
      setUsers(data.users);
      setLastUpdated(new Date());
    } catch (err: any) {
      setUsersError(err.message || "Erro ao carregar ranking");
    } finally {
      setUsersLoading(false);
    }
  }, [authHeader, authorizedFetch, buildUsersUrl]);

  // ---- Sessões: load ----
  const loadSessionsFirstPage = useCallback(async () => {
    if (!authHeader) return;
    setSessionsLoading(true);
    setSessionsError(null);
    try {
      const res = await authorizedFetch(buildSessionsUrl());
      if (!res) return;
      const data: SessionsResponse = await res.json();
      if (!res.ok) throw new Error(data.error || "Falha ao carregar sessões");
      setSessions(data.sessions);
      setSessionsHasMore(data.hasMore);
      setSessionsCursor(data.nextCursor);
      setLastUpdated(new Date());
    } catch (err: any) {
      setSessionsError(err.message || "Erro ao carregar sessões");
    } finally {
      setSessionsLoading(false);
    }
  }, [authHeader, authorizedFetch, buildSessionsUrl]);

  const loadSessionsMore = useCallback(async () => {
    if (!sessionsCursor || sessionsLoadingMore || !authHeader) return;
    setSessionsLoadingMore(true);
    try {
      const res = await authorizedFetch(buildSessionsUrl(sessionsCursor));
      if (!res) return;
      const data: SessionsResponse = await res.json();
      if (!res.ok) throw new Error(data.error || "Falha ao carregar sessões");
      setSessions((prev) => [...prev, ...data.sessions]);
      setSessionsHasMore(data.hasMore);
      setSessionsCursor(data.nextCursor);
    } catch (err: any) {
      setSessionsError(err.message || "Erro ao carregar sessões");
    } finally {
      setSessionsLoadingMore(false);
    }
  }, [sessionsCursor, sessionsLoadingMore, authHeader, authorizedFetch, buildSessionsUrl]);

  // ---- Ações: load ----
  const loadActionsFirstPage = useCallback(async () => {
    if (!authHeader) return;
    setActionsLoading(true);
    setActionsError(null);
    try {
      const res = await authorizedFetch(buildActionsUrl());
      if (!res) return;
      const data: LogsResponse = await res.json();
      if (!res.ok) throw new Error(data.error || "Falha ao carregar ações");
      setActionLogs(data.logs);
      setActionsHasMore(data.hasMore);
      setActionsCursor(data.nextCursor);
      setLastUpdated(new Date());
      setKnownActionTypes((prev) => {
        const next = new Set(prev);
        for (const l of data.logs) if (l.action) next.add(l.action);
        return next;
      });
    } catch (err: any) {
      setActionsError(err.message || "Erro ao carregar ações");
    } finally {
      setActionsLoading(false);
    }
  }, [authHeader, authorizedFetch, buildActionsUrl]);

  const loadActionsMore = useCallback(async () => {
    if (!actionsCursor || actionsLoadingMore || !authHeader) return;
    setActionsLoadingMore(true);
    try {
      const res = await authorizedFetch(buildActionsUrl(actionsCursor));
      if (!res) return;
      const data: LogsResponse = await res.json();
      if (!res.ok) throw new Error(data.error || "Falha ao carregar ações");
      setActionLogs((prev) => [...prev, ...data.logs]);
      setActionsHasMore(data.hasMore);
      setActionsCursor(data.nextCursor);
      setKnownActionTypes((prev) => {
        const next = new Set(prev);
        for (const l of data.logs) if (l.action) next.add(l.action);
        return next;
      });
    } catch (err: any) {
      setActionsError(err.message || "Erro ao carregar ações");
    } finally {
      setActionsLoadingMore(false);
    }
  }, [actionsCursor, actionsLoadingMore, authHeader, authorizedFetch, buildActionsUrl]);

  // ---- Testes: load ----
  const loadTestsFirstPage = useCallback(async () => {
    if (!authHeader) return;
    setTestsLoading(true);
    setTestsError(null);
    try {
      const res = await authorizedFetch(buildTestsUrl());
      if (!res) return;
      const data: TestsResponse = await res.json();
      if (!res.ok) throw new Error(data.error || "Falha ao carregar testes");
      setTestRuns(data.runs);
      setLastUpdated(new Date());
    } catch (err: any) {
      setTestsError(err.message || "Erro ao carregar testes");
    } finally {
      setTestsLoading(false);
    }
  }, [authHeader, authorizedFetch, buildTestsUrl]);

  // ---- Feedbacks: load ----
  const loadFeedbackFirstPage = useCallback(async () => {
    if (!authHeader) return;
    setFeedbackLoading(true);
    setFeedbackError(null);
    try {
      const res = await authorizedFetch(buildFeedbackUrl());
      if (!res) return;
      const data: LogsResponse = await res.json();
      if (!res.ok) throw new Error(data.error || "Falha ao carregar feedbacks");
      setFeedbackLogs(data.logs);
      setFeedbackHasMore(data.hasMore);
      setFeedbackCursor(data.nextCursor);
      setLastUpdated(new Date());
    } catch (err: any) {
      setFeedbackError(err.message || "Erro ao carregar feedbacks");
    } finally {
      setFeedbackLoading(false);
    }
  }, [authHeader, authorizedFetch, buildFeedbackUrl]);

  const loadFeedbackMore = useCallback(async () => {
    if (!feedbackCursor || feedbackLoadingMore || !authHeader) return;
    setFeedbackLoadingMore(true);
    try {
      const res = await authorizedFetch(buildFeedbackUrl(feedbackCursor));
      if (!res) return;
      const data: LogsResponse = await res.json();
      if (!res.ok) throw new Error(data.error || "Falha ao carregar feedbacks");
      setFeedbackLogs((prev) => [...prev, ...data.logs]);
      setFeedbackHasMore(data.hasMore);
      setFeedbackCursor(data.nextCursor);
    } catch (err: any) {
      setFeedbackError(err.message || "Erro ao carregar feedbacks");
    } finally {
      setFeedbackLoadingMore(false);
    }
  }, [feedbackCursor, feedbackLoadingMore, authHeader, authorizedFetch, buildFeedbackUrl]);

  const toggleFeedbackUserAgent = (id: string) => {
    setExpandedFeedbackUserAgents((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // "Rodar agora" — pede o secret via prompt (nunca fica salvo em lugar
  // nenhum, nem localStorage; é um secret de operação, não de login) e
  // chama POST /api/stress/run diretamente. Não usa authorizedFetch —
  // essa rota não é protegida pelo Basic Auth do /api/ddm-logs, usa seu
  // próprio header x-stress-secret. Ao terminar, recarrega a lista pra
  // mostrar a execução que acabou de rodar.
  const runHealthCheckNow = useCallback(async (secret: string) => {
    if (!secret) return;
    setRunningNow(true);
    setRunNowError(null);
    try {
      const res = await fetch("/api/stress/run", {
        method: "POST",
        headers: { "x-stress-secret": secret },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `Falha ao rodar (status ${res.status})`);
      }
      await loadTestsFirstPage();
    } catch (err: any) {
      setRunNowError(err.message || "Erro ao rodar health check");
    } finally {
      setRunningNow(false);
    }
  }, [loadTestsFirstPage]);

  const toggleTestRun = (id: string) => {
    setExpandedTestRuns((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Recarrega a aba Eventos quando seus filtros mudam — mesmo efeito de
  // antes, só com `tab`/`userIdFilter` a mais na guarda/dependências
  // (não dispara se outra aba estiver ativa).
  useEffect(() => {
    if (!authHeader || tab !== "events") return;
    loadFirstPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceFilter, levelFilter, period, authHeader, tab, userIdFilter]);

  useEffect(() => {
    if (!authHeader || tab !== "users") return;
    loadUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, authHeader, tab]);

  useEffect(() => {
    if (!authHeader || tab !== "sessions") return;
    loadSessionsFirstPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, authHeader, tab, userIdFilter]);

  useEffect(() => {
    if (!authHeader || tab !== "actions") return;
    loadActionsFirstPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, authHeader, tab, userIdFilter, actionTypeFilter]);

  useEffect(() => {
    if (!authHeader || tab !== "tests") return;
    loadTestsFirstPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authHeader, tab]);

  useEffect(() => {
    if (!authHeader || tab !== "feedback") return;
    loadFeedbackFirstPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, authHeader, tab]);

  // Auto-refresh — recarrega a aba ativa no momento do tick. Sempre
  // reseta pra primeira página de cada aba (novos dados mudam a
  // ordenação, não faz sentido só anexar ao final).
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => {
      if (tab === "events") loadFirstPage();
      else if (tab === "users") loadUsers();
      else if (tab === "sessions") loadSessionsFirstPage();
      else if (tab === "actions") loadActionsFirstPage();
      else if (tab === "tests") loadTestsFirstPage();
      else if (tab === "feedback") loadFeedbackFirstPage();
    }, 30000);
    return () => clearInterval(id);
  }, [
    autoRefresh,
    tab,
    loadFirstPage,
    loadUsers,
    loadSessionsFirstPage,
    loadActionsFirstPage,
    loadTestsFirstPage,
    loadFeedbackFirstPage,
  ]);

  const handleUserRowClick = (row: UserRankingRow) => {
    setUserIdFilter(row.user_id);
    setTab("events");
  };

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

  const toggleActionExpand = (id: string) => {
    setActionsExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleActionGroup = (key: string) => {
    setActionsExpandedGroups((prev) => {
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
          className={`cursor-pointer border-b border-border transition-colors hover:bg-surface-3/40 ${
            isErrorish ? "bg-danger/[0.06]" : ""
          }`}
        >
          <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-muted-foreground">
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
              className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase ${SOURCE_BADGE_STYLE}`}
            >
              {log.source}
            </span>
          </td>
          <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-foreground-2">
            {log.event}
          </td>
          <td className="max-w-md truncate px-3 py-2 text-foreground">{log.message}</td>
        </tr>
        {isExpanded && (
          <tr className="border-b border-border bg-surface-3/50">
            <td colSpan={5} className="px-3 py-3">
              {log.account_id && (
                <p className="mb-2 font-mono text-[11px] text-muted-foreground">
                  account_id: {log.account_id}
                </p>
              )}
              <pre
                className="overflow-x-auto rounded-md bg-surface-3 p-3 font-mono text-[11px] leading-relaxed text-foreground-2"
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

  const renderActionRow = (log: LogRow) => {
    const isExpanded = actionsExpanded.has(log.id);
    return (
      <Fragment key={log.id}>
        <tr
          onClick={() => toggleActionExpand(log.id)}
          className="cursor-pointer border-b border-border transition-colors hover:bg-surface-3/40"
        >
          <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-muted-foreground">
            {formatTimestamp(log.created_at)}
          </td>
          <td className="whitespace-nowrap px-3 py-2 text-xs text-foreground-2">
            {displayUserName(log)}
          </td>
          <td className="px-3 py-2">
            <span
              className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-medium ${actionBadgeStyle(
                log.action || log.event
              )}`}
            >
              {log.action || log.event}
            </span>
          </td>
          <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-foreground-2">
            {log.page || "—"}
          </td>
        </tr>
        {isExpanded && (
          <tr className="border-b border-border bg-surface-3/50">
            <td colSpan={4} className="px-3 py-3">
              <pre
                className="overflow-x-auto rounded-md bg-surface-3 p-3 font-mono text-[11px] leading-relaxed text-foreground-2"
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

  if (needsLogin) return <main className="p-8" role="alert"><p>{loginError}</p><a href="/dashboard">Voltar ao CRM</a></main>;

  const activeCount =
    tab === "events"
      ? logs.length
      : tab === "users"
        ? users.length
        : tab === "sessions"
          ? sessions.length
          : tab === "actions"
            ? actionLogs.length
            : tab === "tests"
              ? testRuns.length
              : feedbackLogs.length;

  const activeLoading =
    tab === "events"
      ? loading
      : tab === "users"
        ? usersLoading
        : tab === "sessions"
          ? sessionsLoading
          : tab === "actions"
            ? actionsLoading
            : tab === "tests"
              ? testsLoading
              : feedbackLoading;

  return (
    <div className="flex min-h-screen flex-col">
      {/* Header fixo */}
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-border bg-background/95 px-4 py-3 backdrop-blur">
        <h1 className="font-heading text-lg font-semibold tracking-[-0.01em] text-foreground">Logs do sistema</h1>
        <span className="rounded-full border border-primary/40 bg-primary/15 px-2.5 py-0.5 text-xs font-medium text-primary-text">
          {activeCount} {activeCount === 1 ? "linha" : "linhas"}
        </span>

        <div className="ml-auto flex items-center gap-2">
          {lastUpdated && (
            <span className="hidden text-xs text-muted-foreground sm:inline">
              Atualizado às {formatTimestamp(lastUpdated.toISOString())}
            </span>
          )}
          {tab === "tests" && (
            <button
              type="button"
              onClick={() => setRunSecretDialogOpen(true)}
              disabled={runningNow}
              className="rounded-md border border-success/40 bg-success-soft px-3 py-1.5 text-xs font-semibold text-success transition-colors hover:bg-success-soft disabled:cursor-not-allowed disabled:opacity-50"
            >
              {runningNow ? "Rodando..." : "Rodar agora"}
            </button>
          )}
          <AlertDialog
            open={runSecretDialogOpen}
            onOpenChange={(open) => {
              setRunSecretDialogOpen(open);
              if (!open) setRunSecretInput("");
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Rodar health check agora</AlertDialogTitle>
                <AlertDialogDescription>Digite o STRESS_RUN_SECRET:</AlertDialogDescription>
              </AlertDialogHeader>
              <input
                type="password"
                autoComplete="off"
                autoFocus
                value={runSecretInput}
                onChange={(e) => setRunSecretInput(e.target.value)}
                aria-label="STRESS_RUN_SECRET"
                className="w-full rounded-md border border-border bg-surface-3/60 px-3 py-2 text-sm text-foreground outline-none focus:border-primary/60"
              />
              <AlertDialogFooter>
                <AlertDialogCancel>Cancelar</AlertDialogCancel>
                <AlertDialogAction
                  disabled={!runSecretInput}
                  onClick={() => {
                    const secret = runSecretInput;
                    setRunSecretInput("");
                    void runHealthCheckNow(secret);
                  }}
                >
                  Rodar
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <button
            type="button"
            onClick={() => setAutoRefresh((v) => !v)}
            className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
              autoRefresh
                ? "border-primary/60 bg-primary/20 text-primary-text"
                : "border-border bg-surface-3/60 text-foreground-2 hover:bg-surface-hover"
            }`}
          >
            Auto-refresh (30s) {autoRefresh ? "ON" : "OFF"}
          </button>
          <button
            type="button"
            onClick={() => {
              if (tab === "events") loadFirstPage();
              else if (tab === "users") loadUsers();
              else if (tab === "sessions") loadSessionsFirstPage();
              else if (tab === "actions") loadActionsFirstPage();
              else if (tab === "tests") loadTestsFirstPage();
              else loadFeedbackFirstPage();
            }}
            disabled={activeLoading}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {activeLoading ? "Atualizando..." : "Atualizar"}
          </button>
        </div>
      </header>

      {/* Saúde do sistema (PRD 24, item 5): migrations, cron e fila de mensagens recebidas */}
      <SystemHealthCard className="px-4 pt-4" />

      {/* Abas */}
      <div className="flex items-center gap-1 border-b border-border bg-surface-3/40 px-4 pt-2">
        {TAB_OPTIONS.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => setTab(t.value)}
            className={`rounded-t-md border-b-2 px-3 py-2 text-xs font-medium transition-colors ${
              tab === t.value
                ? "border-primary text-primary-text"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.value === "feedback" ? `${t.label} (${feedbackLogs.length})` : t.label}
          </button>
        ))}
      </div>

      {/* Filtros */}
      <div className="flex flex-wrap items-center gap-3 border-b border-border bg-surface-3/40 px-4 py-3">
        {tab === "events" && (
          <>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              Source
              <select
                value={sourceFilter}
                onChange={(e) => setSourceFilter(e.target.value)}
                className="rounded-md border border-border bg-card px-2 py-1.5 text-xs text-foreground focus:border-primary/60 focus:outline-none"
              >
                <option value="">Todos</option>
                {SOURCE_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              Level
              <select
                value={levelFilter}
                onChange={(e) => setLevelFilter(e.target.value)}
                className="rounded-md border border-border bg-card px-2 py-1.5 text-xs text-foreground focus:border-primary/60 focus:outline-none"
              >
                <option value="">Todos</option>
                {LEVEL_OPTIONS.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}

        {tab === "actions" && (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Tipo de ação
            <select
              value={actionTypeFilter}
              onChange={(e) => setActionTypeFilter(e.target.value)}
              className="rounded-md border border-border bg-card px-2 py-1.5 text-xs text-foreground focus:border-primary/60 focus:outline-none"
            >
              <option value="">Todos</option>
              {actionTypes.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Período
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            className="rounded-md border border-border bg-card px-2 py-1.5 text-xs text-foreground focus:border-primary/60 focus:outline-none"
          >
            {PERIOD_OPTIONS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        {userIdFilter && (tab === "events" || tab === "sessions" || tab === "actions") && (
          <span className="flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/15 px-2.5 py-1 text-xs text-primary-text">
            Filtrado por usuário: {userIdFilter.slice(0, 8)}
            <button
              type="button"
              onClick={() => setUserIdFilter(null)}
              className="ml-1 text-primary-text hover:text-foreground"
            >
              ×
            </button>
          </span>
        )}
      </div>

      {/* Corpo */}
      <main className="flex-1 px-4 py-4">
        {/* ---- Aba Eventos ---- */}
        {tab === "events" && (
          <>
            {error && (
              <div className="mb-3 rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger">
                {error}
              </div>
            )}

            {loading && logs.length === 0 ? (
              <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
                Carregando logs...
              </div>
            ) : logs.length === 0 ? (
              <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
                Nenhum log encontrado para os filtros atuais.
              </div>
            ) : (
              <div className="overflow-hidden rounded-lg border border-border">
                <table className="w-full border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-border bg-surface-3/40 text-xs uppercase tracking-wide text-muted-foreground">
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
                            className={`cursor-pointer border-b border-border transition-colors hover:bg-surface-3/40 ${
                              isErrorish ? "bg-danger/[0.06]" : ""
                            }`}
                          >
                            <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-muted-foreground">
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
                                className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase ${SOURCE_BADGE_STYLE}`}
                              >
                                {first.source}
                              </span>
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-foreground-2">
                              {first.event}
                            </td>
                            <td className="max-w-md truncate px-3 py-2 text-foreground">
                              <span className="mr-2 inline-block rounded-full border border-primary/60 bg-primary px-2 py-0.5 text-[10px] font-bold text-primary-foreground">
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
                  className="rounded-md border border-border bg-surface-3/60 px-4 py-2 text-xs font-medium text-foreground-2 transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {loadingMore ? "Carregando..." : "Carregar mais"}
                </button>
              </div>
            )}
          </>
        )}

        {/* ---- Aba Por Usuário ---- */}
        {tab === "users" && (
          <>
            {usersError && (
              <div className="mb-3 rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger">
                {usersError}
              </div>
            )}

            {usersLoading && users.length === 0 ? (
              <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
                Carregando ranking...
              </div>
            ) : users.length === 0 ? (
              <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
                Nenhum evento com usuário identificado no período.
              </div>
            ) : (
              <div className="overflow-hidden rounded-lg border border-border">
                <table className="w-full border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-border bg-surface-3/40 text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="px-3 py-2 font-medium">Usuário</th>
                      <th className="px-3 py-2 font-medium">Email</th>
                      <th className="px-3 py-2 font-medium">Erros</th>
                      <th className="px-3 py-2 font-medium">Total de eventos</th>
                      <th className="px-3 py-2 font-medium">Último acesso</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u) => (
                      <tr
                        key={u.user_id}
                        onClick={() => handleUserRowClick(u)}
                        className="cursor-pointer border-b border-border transition-colors hover:bg-surface-3/40"
                      >
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2">
                            <span className="flex size-7 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary-text">
                              {getInitials(u.full_name)}
                            </span>
                            <span className="text-foreground">{u.full_name || "Sem nome"}</span>
                          </div>
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                          {u.email || "—"}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                              u.error_count > 10
                                ? "border-danger/40 bg-danger-soft text-danger animate-pulse"
                                : "border-danger/40 bg-danger-soft text-danger"
                            }`}
                          >
                            {u.error_count}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-foreground-2">{u.total_events}</td>
                        <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-muted-foreground">
                          {formatTimestamp(u.last_seen)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {/* ---- Aba Sessões ---- */}
        {tab === "sessions" && (
          <>
            {sessionsError && (
              <div className="mb-3 rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger">
                {sessionsError}
              </div>
            )}

            {sessionsLoading && sessions.length === 0 ? (
              <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
                Carregando sessões...
              </div>
            ) : sessions.length === 0 ? (
              <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
                Nenhuma sessão encontrada para os filtros atuais.
              </div>
            ) : (
              <div className="overflow-hidden rounded-lg border border-border">
                <table className="w-full border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-border bg-surface-3/40 text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="px-3 py-2 font-medium">Usuário</th>
                      <th className="px-3 py-2 font-medium">Início</th>
                      <th className="px-3 py-2 font-medium">Fim</th>
                      <th className="px-3 py-2 font-medium">Duração</th>
                      <th className="px-3 py-2 font-medium">Páginas</th>
                      <th className="px-3 py-2 font-medium">IP</th>
                      <th className="px-3 py-2 font-medium">Navegador</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map((s) => (
                      <tr key={s.id} className="border-b border-border">
                        <td className="px-3 py-2 text-foreground">{s.user_name || "Sem nome"}</td>
                        <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-muted-foreground">
                          {formatTimestamp(s.started_at)}
                        </td>
                        <td className="px-3 py-2">
                          {s.ended_at ? (
                            <span className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                              {formatTimestamp(s.ended_at)}
                            </span>
                          ) : (
                            <span className="inline-block rounded-full border border-success/40 bg-success-soft px-2 py-0.5 text-[10px] font-semibold text-success">
                              Ativa
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-foreground-2">
                          {formatDuration(s.started_at, s.ended_at)}
                        </td>
                        <td className="px-3 py-2 text-foreground-2">{s.page_count}</td>
                        <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                          {s.ip_address || "—"}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {summarizeUserAgent(s.user_agent)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {sessionsHasMore && (
              <div className="mt-4 flex justify-center">
                <button
                  type="button"
                  onClick={() => loadSessionsMore()}
                  disabled={sessionsLoadingMore}
                  className="rounded-md border border-border bg-surface-3/60 px-4 py-2 text-xs font-medium text-foreground-2 transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {sessionsLoadingMore ? "Carregando..." : "Carregar mais"}
                </button>
              </div>
            )}
          </>
        )}

        {/* ---- Aba Ações ---- */}
        {tab === "actions" && (
          <>
            {actionsError && (
              <div className="mb-3 rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger">
                {actionsError}
              </div>
            )}

            {actionsLoading && actionLogs.length === 0 ? (
              <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
                Carregando ações...
              </div>
            ) : actionLogs.length === 0 ? (
              <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
                Nenhuma ação encontrada para os filtros atuais.
              </div>
            ) : (
              <div className="overflow-hidden rounded-lg border border-border">
                <table className="w-full border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-border bg-surface-3/40 text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="px-3 py-2 font-medium">Timestamp</th>
                      <th className="px-3 py-2 font-medium">Usuário</th>
                      <th className="px-3 py-2 font-medium">Ação</th>
                      <th className="px-3 py-2 font-medium">Página</th>
                    </tr>
                  </thead>
                  <tbody>
                    {actionDisplayItems.map((item) => {
                      if (item.type === "single") {
                        return renderActionRow(item.log);
                      }
                      const { key, logs: groupLogs } = item;
                      const isGroupExpanded = actionsExpandedGroups.has(key);
                      const first = groupLogs[0];

                      return (
                        <Fragment key={key}>
                          <tr
                            onClick={() => toggleActionGroup(key)}
                            className="cursor-pointer border-b border-border transition-colors hover:bg-surface-3/40"
                          >
                            <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-muted-foreground">
                              {formatTimestamp(groupLogs[groupLogs.length - 1].created_at)} →{" "}
                              {formatTimestamp(first.created_at)}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 text-xs text-foreground-2">
                              {displayUserName(first)}
                            </td>
                            <td className="px-3 py-2">
                              <span
                                className={`mr-2 inline-block rounded-full border border-primary/60 bg-primary px-2 py-0.5 text-[10px] font-bold text-primary-foreground`}
                              >
                                ×{groupLogs.length}
                              </span>
                              <span
                                className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-medium ${actionBadgeStyle(
                                  first.action || first.event
                                )}`}
                              >
                                {first.action || first.event}
                              </span>
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-foreground-2">
                              {first.page || "—"}
                            </td>
                          </tr>
                          {isGroupExpanded && groupLogs.map((log) => renderActionRow(log))}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {actionsHasMore && (
              <div className="mt-4 flex justify-center">
                <button
                  type="button"
                  onClick={() => loadActionsMore()}
                  disabled={actionsLoadingMore}
                  className="rounded-md border border-border bg-surface-3/60 px-4 py-2 text-xs font-medium text-foreground-2 transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {actionsLoadingMore ? "Carregando..." : "Carregar mais"}
                </button>
              </div>
            )}
          </>
        )}

        {/* ---- Aba Testes ---- */}
        {tab === "tests" && (
          <>
            {runNowError && (
              <div className="mb-3 rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger">
                {runNowError}
              </div>
            )}
            {testsError && (
              <div className="mb-3 rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger">
                {testsError}
              </div>
            )}

            {testsLoading && testRuns.length === 0 ? (
              <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
                Carregando execuções...
              </div>
            ) : testRuns.length === 0 ? (
              <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
                Nenhuma execução de health check ainda. Clique em &quot;Rodar agora&quot; ou
                aguarde o crontab diário (ver README de tests/stress).
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {testRuns.map((run) => {
                  const overall: TestStatus =
                    run.level === "error" ? "fail" : run.level === "warn" ? "warn" : "pass";
                  const results = run.payload?.results ?? [];
                  const passCount = results.filter((r) => r.status === "pass").length;
                  const isExpanded = expandedTestRuns.has(run.id);

                  return (
                    <div
                      key={run.id}
                      className={`overflow-hidden rounded-lg border ${TEST_CARD_BG[overall]}`}
                    >
                      <button
                        type="button"
                        onClick={() => toggleTestRun(run.id)}
                        className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-3/40"
                      >
                        <span className="font-mono text-xs text-muted-foreground">
                          {formatTimestamp(run.created_at)}
                        </span>
                        <span
                          className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-semibold ${TEST_STATUS_BADGE[overall]}`}
                        >
                          {TEST_STATUS_LABEL[overall]}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {run.payload?.duration_total_ms ?? 0}ms total
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {passCount}/{results.length || 7} testes
                        </span>
                        <span className="ml-auto text-xs text-muted-foreground">
                          {isExpanded ? "▲ recolher" : "▼ expandir"}
                        </span>
                      </button>

                      {isExpanded && (
                        <div className="border-t border-border bg-surface-3/50 px-4 py-3">
                          <table className="w-full border-collapse text-left text-sm">
                            <thead>
                              <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                                <th className="px-3 py-2 font-medium">Teste</th>
                                <th className="px-3 py-2 font-medium">Status</th>
                                <th className="px-3 py-2 font-medium">Duração</th>
                                <th className="px-3 py-2 font-medium">Mensagem</th>
                              </tr>
                            </thead>
                            <tbody>
                              {results.map((r) => (
                                <tr key={r.name} className="border-b border-border">
                                  <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-foreground-2">
                                    {r.name}
                                  </td>
                                  <td className="px-3 py-2">
                                    <span
                                      className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase ${TEST_STATUS_BADGE[r.status]}`}
                                    >
                                      {r.status}
                                    </span>
                                  </td>
                                  <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-muted-foreground">
                                    {r.duration_ms}ms
                                  </td>
                                  <td className="px-3 py-2 text-foreground">{r.message}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {/* ---- Aba Feedbacks ---- */}
        {tab === "feedback" && (
          <>
            {feedbackError && (
              <div className="mb-3 rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger">
                {feedbackError}
              </div>
            )}

            {feedbackLoading && feedbackLogs.length === 0 ? (
              <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
                Carregando feedbacks...
              </div>
            ) : feedbackLogs.length === 0 ? (
              <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
                Nenhum problema reportado. 🎉
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {feedbackLogs.map((f) => {
                  const userAgent =
                    typeof (f.payload as any)?.user_agent === "string"
                      ? ((f.payload as any).user_agent as string)
                      : null;
                  const page = f.page || (f.payload as any)?.page || null;
                  const userLabel =
                    f.user_name || f.user_email || (f.user_id ? f.user_id.slice(0, 8) : "desconhecido");
                  const isUaExpanded = expandedFeedbackUserAgents.has(f.id);

                  return (
                    <div
                      key={f.id}
                      className="overflow-hidden rounded-lg border border-warning/40 bg-warning-soft"
                    >
                      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                        <span className="font-mono text-xs text-muted-foreground">
                          {formatTimestamp(f.created_at)}
                        </span>
                        <span
                          className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-semibold uppercase ${LEVEL_BADGE_STYLES[f.level] ?? LEVEL_BADGE_STYLES.warn}`}
                        >
                          {f.level}
                        </span>
                        <span className="text-xs text-foreground-2">{userLabel}</span>
                        {page && (
                          <span className="rounded-full border border-border bg-surface-3/60 px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                            {page}
                          </span>
                        )}
                      </div>

                      <div className="border-t border-border bg-surface-3/50 px-4 py-3">
                        <p className="whitespace-pre-wrap break-words text-sm text-foreground">
                          {f.message}
                        </p>

                        {userAgent && (
                          <div className="mt-3">
                            <button
                              type="button"
                              onClick={() => toggleFeedbackUserAgent(f.id)}
                              className="text-[11px] text-muted-foreground hover:text-foreground-2"
                            >
                              {isUaExpanded ? "▲ recolher user agent" : "▼ ver user agent"}
                            </button>
                            {isUaExpanded && (
                              <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                                {userAgent}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {feedbackHasMore && (
              <div className="mt-4 flex justify-center">
                <button
                  type="button"
                  onClick={() => loadFeedbackMore()}
                  disabled={feedbackLoadingMore}
                  className="rounded-md border border-border bg-surface-3/60 px-4 py-2 text-xs font-medium text-foreground-2 transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {feedbackLoadingMore ? "Carregando..." : "Carregar mais"}
                </button>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
