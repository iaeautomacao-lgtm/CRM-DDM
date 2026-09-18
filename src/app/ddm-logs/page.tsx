"use client";

import { Fragment, useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { LogLevel, LogSource } from "@/lib/logger";

// A API (/api/ddm-logs) agora exige HTTP Basic Auth (ver route.ts) — a
// página guarda o header "Authorization" já pronto no localStorage pra
// sobreviver a reload sem pedir login de novo. Nunca guarda usuário/
// senha em texto puro separadamente, só o header base64 já composto.
const AUTH_STORAGE_KEY = "ddm-logs-auth";

function getStoredAuthHeader(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(AUTH_STORAGE_KEY);
  } catch {
    return null;
  }
}

function encodeBasicAuth(user: string, password: string): string {
  return `Basic ${btoa(`${user}:${password}`)}`;
}

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

type Tab = "events" | "users" | "sessions" | "actions";

const TAB_OPTIONS: { value: Tab; label: string }[] = [
  { value: "events", label: "Eventos" },
  { value: "users", label: "Por Usuário" },
  { value: "sessions", label: "Sessões" },
  { value: "actions", label: "Ações" },
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
  "bg-sky-500/15 text-sky-300 border-sky-500/40",
  "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  "bg-purple-500/15 text-purple-300 border-purple-500/40",
  "bg-amber-500/15 text-amber-300 border-amber-500/40",
  "bg-pink-500/15 text-pink-300 border-pink-500/40",
  "bg-cyan-500/15 text-cyan-300 border-cyan-500/40",
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

  const [autoRefresh, setAutoRefresh] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  // Auth — ver route.ts. authHeader vem do localStorage já pronto;
  // needsLogin começa true quando não há nada guardado, e volta a true
  // sempre que a API responde 401 (credencial nunca setada, errada, ou
  // trocada no servidor depois do login).
  const [authHeader, setAuthHeader] = useState<string | null>(() => getStoredAuthHeader());
  const [needsLogin, setNeedsLogin] = useState<boolean>(() => !getStoredAuthHeader());
  const [loginUser, setLoginUser] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);

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

  // Fetch autenticado compartilhado por todas as abas — trata 401 num
  // único lugar: limpa a credencial guardada e volta pro formulário de
  // login. Retorna null nesse caso (chamador já não tem mais o que
  // fazer com a resposta).
  const authorizedFetch = useCallback(
    async (url: string): Promise<Response | null> => {
      const res = await fetch(url, {
        headers: authHeader ? { Authorization: authHeader } : {},
      });
      if (res.status === 401) {
        try {
          window.localStorage.removeItem(AUTH_STORAGE_KEY);
        } catch {
          // localStorage indisponível — segue, só não persiste.
        }
        setAuthHeader(null);
        setLoginError("Usuário ou senha inválidos");
        setNeedsLogin(true);
        return null;
      }
      return res;
    },
    [authHeader]
  );

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
    }, 30000);
    return () => clearInterval(id);
  }, [autoRefresh, tab, loadFirstPage, loadUsers, loadSessionsFirstPage, loadActionsFirstPage]);

  // Otimista: só grava a credencial e deixa authHeader mudar disparar o
  // fetch (efeitos acima). Se estiver errada, authorizedFetch pega o
  // 401 e volta pro formulário sozinho com loginError preenchido.
  const handleLoginSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!loginUser.trim() || !loginPassword) {
      setLoginError("Informe usuário e senha");
      return;
    }
    const header = encodeBasicAuth(loginUser.trim(), loginPassword);
    try {
      window.localStorage.setItem(AUTH_STORAGE_KEY, header);
    } catch {
      // localStorage indisponível — login ainda funciona pra esta aba,
      // só não sobrevive a reload.
    }
    setLoginPassword("");
    setLoginError(null);
    setAuthHeader(header);
    setNeedsLogin(false);
  };

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

  const renderActionRow = (log: LogRow) => {
    const isExpanded = actionsExpanded.has(log.id);
    return (
      <Fragment key={log.id}>
        <tr
          onClick={() => toggleActionExpand(log.id)}
          className="cursor-pointer border-b border-white/5 transition-colors hover:bg-white/[0.04]"
        >
          <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-zinc-400">
            {formatTimestamp(log.created_at)}
          </td>
          <td className="whitespace-nowrap px-3 py-2 text-xs text-zinc-300">
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
          <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-zinc-300">
            {log.page || "—"}
          </td>
        </tr>
        {isExpanded && (
          <tr className="border-b border-white/5 bg-black/40">
            <td colSpan={4} className="px-3 py-3">
              <pre
                className="overflow-x-auto rounded-md bg-black/60 p-3 font-mono text-[11px] leading-relaxed text-zinc-300"
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

  if (needsLogin) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#141414] px-4">
        <form
          onSubmit={handleLoginSubmit}
          className="w-full max-w-sm space-y-4 rounded-lg border border-white/10 bg-[#1F1F1F] p-6"
        >
          <div>
            <h1 className="text-lg font-semibold text-white">DDM Logs</h1>
            <p className="mt-1 text-xs text-zinc-500">Acesso restrito.</p>
          </div>

          {loginError && (
            <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {loginError}
            </div>
          )}

          <div className="space-y-3">
            <label className="block text-xs text-zinc-400">
              Usuário
              <input
                type="text"
                value={loginUser}
                onChange={(e) => setLoginUser(e.target.value)}
                autoFocus
                className="mt-1 w-full rounded-md border border-white/10 bg-[#262626] px-3 py-2 text-sm text-zinc-100 focus:border-[#FF5706]/60 focus:outline-none"
              />
            </label>
            <label className="block text-xs text-zinc-400">
              Senha
              <input
                type="password"
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                className="mt-1 w-full rounded-md border border-white/10 bg-[#262626] px-3 py-2 text-sm text-zinc-100 focus:border-[#FF5706]/60 focus:outline-none"
              />
            </label>
          </div>

          <button
            type="submit"
            className="w-full rounded-md bg-[#FF5706] px-3 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90"
          >
            Entrar
          </button>
        </form>
      </div>
    );
  }

  const activeCount =
    tab === "events"
      ? logs.length
      : tab === "users"
        ? users.length
        : tab === "sessions"
          ? sessions.length
          : actionLogs.length;

  const activeLoading =
    tab === "events"
      ? loading
      : tab === "users"
        ? usersLoading
        : tab === "sessions"
          ? sessionsLoading
          : actionsLoading;

  return (
    <div className="flex min-h-screen flex-col">
      {/* Header fixo */}
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-white/10 bg-[#1F1F1F]/95 px-4 py-3 backdrop-blur">
        <h1 className="text-lg font-semibold text-white">DDM Logs</h1>
        <span className="rounded-full border border-[#FF5706]/40 bg-[#FF5706]/15 px-2.5 py-0.5 text-xs font-medium text-[#FF5706]">
          {activeCount} {activeCount === 1 ? "linha" : "linhas"}
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
            onClick={() => {
              if (tab === "events") loadFirstPage();
              else if (tab === "users") loadUsers();
              else if (tab === "sessions") loadSessionsFirstPage();
              else loadActionsFirstPage();
            }}
            disabled={activeLoading}
            className="rounded-md bg-[#FF5706] px-3 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {activeLoading ? "Atualizando..." : "Atualizar"}
          </button>
        </div>
      </header>

      {/* Abas */}
      <div className="flex items-center gap-1 border-b border-white/10 bg-white/[0.02] px-4 pt-2">
        {TAB_OPTIONS.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => setTab(t.value)}
            className={`rounded-t-md border-b-2 px-3 py-2 text-xs font-medium transition-colors ${
              tab === t.value
                ? "border-[#FF5706] text-[#FF5706]"
                : "border-transparent text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Filtros */}
      <div className="flex flex-wrap items-center gap-3 border-b border-white/10 bg-white/[0.02] px-4 py-3">
        {tab === "events" && (
          <>
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
          </>
        )}

        {tab === "actions" && (
          <label className="flex items-center gap-2 text-xs text-zinc-400">
            Tipo de ação
            <select
              value={actionTypeFilter}
              onChange={(e) => setActionTypeFilter(e.target.value)}
              className="rounded-md border border-white/10 bg-[#262626] px-2 py-1.5 text-xs text-zinc-100 focus:border-[#FF5706]/60 focus:outline-none"
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

        {userIdFilter && (tab === "events" || tab === "sessions" || tab === "actions") && (
          <span className="flex items-center gap-1.5 rounded-full border border-[#FF5706]/40 bg-[#FF5706]/15 px-2.5 py-1 text-xs text-[#FF5706]">
            Filtrado por usuário: {userIdFilter.slice(0, 8)}
            <button
              type="button"
              onClick={() => setUserIdFilter(null)}
              className="ml-1 text-[#FF5706] hover:text-white"
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
          </>
        )}

        {/* ---- Aba Por Usuário ---- */}
        {tab === "users" && (
          <>
            {usersError && (
              <div className="mb-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                {usersError}
              </div>
            )}

            {usersLoading && users.length === 0 ? (
              <div className="flex items-center justify-center py-16 text-sm text-zinc-500">
                Carregando ranking...
              </div>
            ) : users.length === 0 ? (
              <div className="flex items-center justify-center py-16 text-sm text-zinc-500">
                Nenhum evento com usuário identificado no período.
              </div>
            ) : (
              <div className="overflow-hidden rounded-lg border border-white/10">
                <table className="w-full border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-white/10 bg-white/[0.03] text-xs uppercase tracking-wide text-zinc-500">
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
                        className="cursor-pointer border-b border-white/5 transition-colors hover:bg-white/[0.04]"
                      >
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2">
                            <span className="flex size-7 items-center justify-center rounded-full bg-[#FF5706]/15 text-[10px] font-semibold text-[#FF5706]">
                              {getInitials(u.full_name)}
                            </span>
                            <span className="text-zinc-200">{u.full_name || "Sem nome"}</span>
                          </div>
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-zinc-400">
                          {u.email || "—"}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                              u.error_count > 10
                                ? "border-red-400/70 bg-red-600/40 text-red-100 animate-pulse"
                                : "border-red-500/40 bg-red-600/15 text-red-300"
                            }`}
                          >
                            {u.error_count}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-zinc-300">{u.total_events}</td>
                        <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-zinc-400">
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
              <div className="mb-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                {sessionsError}
              </div>
            )}

            {sessionsLoading && sessions.length === 0 ? (
              <div className="flex items-center justify-center py-16 text-sm text-zinc-500">
                Carregando sessões...
              </div>
            ) : sessions.length === 0 ? (
              <div className="flex items-center justify-center py-16 text-sm text-zinc-500">
                Nenhuma sessão encontrada para os filtros atuais.
              </div>
            ) : (
              <div className="overflow-hidden rounded-lg border border-white/10">
                <table className="w-full border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-white/10 bg-white/[0.03] text-xs uppercase tracking-wide text-zinc-500">
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
                      <tr key={s.id} className="border-b border-white/5">
                        <td className="px-3 py-2 text-zinc-200">{s.user_name || "Sem nome"}</td>
                        <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-zinc-400">
                          {formatTimestamp(s.started_at)}
                        </td>
                        <td className="px-3 py-2">
                          {s.ended_at ? (
                            <span className="whitespace-nowrap font-mono text-xs text-zinc-400">
                              {formatTimestamp(s.ended_at)}
                            </span>
                          ) : (
                            <span className="inline-block rounded-full border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
                              Ativa
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-zinc-300">
                          {formatDuration(s.started_at, s.ended_at)}
                        </td>
                        <td className="px-3 py-2 text-zinc-300">{s.page_count}</td>
                        <td className="px-3 py-2 font-mono text-xs text-zinc-400">
                          {s.ip_address || "—"}
                        </td>
                        <td className="px-3 py-2 text-xs text-zinc-400">
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
                  className="rounded-md border border-white/10 bg-white/5 px-4 py-2 text-xs font-medium text-zinc-300 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
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
              <div className="mb-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                {actionsError}
              </div>
            )}

            {actionsLoading && actionLogs.length === 0 ? (
              <div className="flex items-center justify-center py-16 text-sm text-zinc-500">
                Carregando ações...
              </div>
            ) : actionLogs.length === 0 ? (
              <div className="flex items-center justify-center py-16 text-sm text-zinc-500">
                Nenhuma ação encontrada para os filtros atuais.
              </div>
            ) : (
              <div className="overflow-hidden rounded-lg border border-white/10">
                <table className="w-full border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-white/10 bg-white/[0.03] text-xs uppercase tracking-wide text-zinc-500">
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
                            className="cursor-pointer border-b border-white/5 transition-colors hover:bg-white/[0.04]"
                          >
                            <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-zinc-400">
                              {formatTimestamp(groupLogs[groupLogs.length - 1].created_at)} →{" "}
                              {formatTimestamp(first.created_at)}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 text-xs text-zinc-300">
                              {displayUserName(first)}
                            </td>
                            <td className="px-3 py-2">
                              <span
                                className={`mr-2 inline-block rounded-full border border-[#FF5706]/60 bg-[#FF5706] px-2 py-0.5 text-[10px] font-bold text-white`}
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
                            <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-zinc-300">
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
                  className="rounded-md border border-white/10 bg-white/5 px-4 py-2 text-xs font-medium text-zinc-300 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {actionsLoadingMore ? "Carregando..." : "Carregar mais"}
                </button>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
