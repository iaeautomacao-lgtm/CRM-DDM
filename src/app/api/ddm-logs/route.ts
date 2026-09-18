import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Antes protegida só pela obscuridade da URL — agora exige HTTP Basic
// Auth via DDM_LOGS_USER/DDM_LOGS_PASSWORD (fallback "ddm"/"ddm2026"
// se as env vars não estiverem setadas, ver .env.local.example). A
// página passou a carregar user_id/page/action (migration 092) e
// page_views/user_sessions (093/094), com dado atribuível a um
// usuário real — a obscuridade de URL deixou de ser proteção
// suficiente pra esse volume de PII.
function isAuthorized(request: Request): boolean {
  const header = request.headers.get("authorization");
  if (!header || !header.startsWith("Basic ")) return false;

  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return false;
  }
  const sepIdx = decoded.indexOf(":");
  if (sepIdx === -1) return false;

  const user = decoded.slice(0, sepIdx);
  const password = decoded.slice(sepIdx + 1);
  const expectedUser = process.env.DDM_LOGS_USER || "ddm";
  const expectedPassword = process.env.DDM_LOGS_PASSWORD || "ddm2026";

  // timingSafeEqual exige buffers do mesmo tamanho — comparar o
  // tamanho primeiro não vaza mais informação do que a própria API já
  // vaza (tamanho de senha não é segredo), só evita o throw.
  const userBuf = Buffer.from(user);
  const expectedUserBuf = Buffer.from(expectedUser);
  const passwordBuf = Buffer.from(password);
  const expectedPasswordBuf = Buffer.from(expectedPassword);

  const userMatches =
    userBuf.length === expectedUserBuf.length && timingSafeEqual(userBuf, expectedUserBuf);
  const passwordMatches =
    passwordBuf.length === expectedPasswordBuf.length &&
    timingSafeEqual(passwordBuf, expectedPasswordBuf);

  return userMatches && passwordMatches;
}

function unauthorizedResponse(): NextResponse {
  return NextResponse.json(
    { error: "Unauthorized" },
    { status: 401, headers: { "WWW-Authenticate": 'Basic realm="DDM Logs"' } }
  );
}

let _adminClient: SupabaseClient | null = null;
function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || "",
      process.env.SUPABASE_SERVICE_ROLE_KEY || "",
      {
        db: {
          schema: "wacrm",
        },
      }
    ) as any;
  }
  return _adminClient!;
}

interface UnifiedLogRow {
  id: string;
  account_id: string | null;
  user_id?: string | null;
  page?: string | null;
  action?: string | null;
  level: string;
  source: string;
  event: string;
  message: string;
  payload: unknown;
  created_at: string;
}

const VALID_LEVELS = new Set(["debug", "info", "warn", "error", "critical"]);
const VALID_SOURCES = new Set([
  "disparador",
  "webhook_meta",
  "webhook_waha",
  "flows",
  "ai_agent",
  "automations",
  "import",
  "system",
  "frontend",
]);

type Tab = "events" | "users" | "sessions" | "actions";
const VALID_TABS = new Set<Tab>(["events", "users", "sessions", "actions"]);

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return unauthorizedResponse();
  }

  try {
    const { searchParams } = new URL(request.url);

    const tabParam = searchParams.get("tab");
    const tab: Tab = tabParam && VALID_TABS.has(tabParam as Tab) ? (tabParam as Tab) : "events";

    const userIdParam = searchParams.get("user_id");
    const userId = userIdParam && userIdParam.trim() ? userIdParam.trim() : null;

    const actionParam = searchParams.get("action");
    const action = actionParam && actionParam.trim() ? actionParam.trim() : null;

    const sourceParam = searchParams.get("source");
    const source = sourceParam && VALID_SOURCES.has(sourceParam) ? sourceParam : null;

    const levelParam = searchParams.get("level");
    const level = levelParam && VALID_LEVELS.has(levelParam) ? levelParam : null;

    const to = searchParams.get("to");
    const cursor = searchParams.get("cursor");
    const from =
      searchParams.get("from") || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const limitRaw = parseInt(searchParams.get("limit") || String(DEFAULT_LIMIT), 10);
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(limitRaw, 1), MAX_LIMIT)
      : DEFAULT_LIMIT;

    const db = supabaseAdmin();

    if (tab === "users") {
      return await getUsersTab(db, from);
    }
    if (tab === "sessions") {
      return await getSessionsTab(db, { from, to, cursor, limit, userId });
    }
    if (tab === "actions") {
      return await getActionsTab(db, { from, cursor, limit, userId, action });
    }
    return await getEventsTab(db, { source, level, from, to, cursor, limit, userId });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Erro ao buscar logs" }, { status: 500 });
  }
}

// ------------------------------------------------------------
// tab=events (default) — comportamento existente, intocado. Único
// acréscimo é o filtro opcional de user_id (parâmetro novo — quando
// ausente, o comportamento é idêntico ao de antes desta mudança):
// disp_message_queue/flow_run_events nunca têm user_id, então um
// filtro de usuário exclui as duas fontes secundárias da mesma forma
// que já acontecia para source/level.
// ------------------------------------------------------------
async function getEventsTab(
  db: SupabaseClient,
  params: {
    source: string | null;
    level: string | null;
    from: string;
    to: string | null;
    cursor: string | null;
    limit: number;
    userId: string | null;
  }
): Promise<NextResponse> {
  const { source, level, from, to, cursor, limit, userId } = params;

  // 1. wacrm.system_logs — fonte nativa, todos os campos.
  let systemLogsQuery = db
    .from("system_logs")
    .select("*")
    .gte("created_at", from)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (to) systemLogsQuery = systemLogsQuery.lte("created_at", to);
  if (cursor) systemLogsQuery = systemLogsQuery.lt("created_at", cursor);
  if (source) systemLogsQuery = systemLogsQuery.eq("source", source);
  if (level) systemLogsQuery = systemLogsQuery.eq("level", level);
  if (userId) systemLogsQuery = systemLogsQuery.eq("user_id", userId);

  // 2. wacrm.disp_message_queue (status='erro') — normalizado. Só
  // participa se o filtro de source/level (quando presentes) permitir
  // 'disparador'/'error' — senão nem consulta a tabela à toa. Nunca
  // participa sob filtro de user_id (a tabela não tem essa coluna).
  const includeQueue =
    !userId && (!source || source === "disparador") && (!level || level === "error");
  let queueQuery = includeQueue
    ? db
        .from("disp_message_queue")
        .select("*")
        .eq("status", "erro")
        .gte("created_at", from)
        .order("created_at", { ascending: false })
        .limit(limit)
    : null;
  if (queueQuery && to) queueQuery = queueQuery.lte("created_at", to);
  if (queueQuery && cursor) queueQuery = queueQuery.lt("created_at", cursor);

  // 3. wacrm.flow_run_events (event_type de erro) — normalizado. Mesma
  // lógica de participação condicional.
  const includeFlowEvents =
    !userId && (!source || source === "flows") && (!level || level === "error");
  let flowEventsQuery = includeFlowEvents
    ? db
        .from("flow_run_events")
        .select("*")
        .in("event_type", ["error", "node_error", "run_error"])
        .gte("created_at", from)
        .order("created_at", { ascending: false })
        .limit(limit)
    : null;
  if (flowEventsQuery && to) flowEventsQuery = flowEventsQuery.lte("created_at", to);
  if (flowEventsQuery && cursor) flowEventsQuery = flowEventsQuery.lt("created_at", cursor);

  const [systemLogsRes, queueRes, flowEventsRes] = await Promise.all([
    systemLogsQuery,
    queueQuery ?? Promise.resolve({ data: [] as any[], error: null as any }),
    flowEventsQuery ?? Promise.resolve({ data: [] as any[], error: null as any }),
  ]);

  if (systemLogsRes.error) throw systemLogsRes.error;
  if (queueRes.error) throw queueRes.error;
  if (flowEventsRes.error) throw flowEventsRes.error;

  // Merge de 3 streams já ordenados desc, cada um limitado a `limit` —
  // o top-N do merge é garantidamente correto mesmo sem uma única query
  // SQL unificada (nenhuma fonte pode contribuir com mais de `limit`
  // itens para o top-`limit` global). Paginação por cursor em cada
  // fonte independentemente garante o mesmo em páginas seguintes.
  const combined: UnifiedLogRow[] = [
    ...(systemLogsRes.data ?? []).map((row: any) => ({
      id: `sl_${row.id}`,
      account_id: row.account_id ?? null,
      user_id: row.user_id ?? null,
      page: row.page ?? null,
      action: row.action ?? null,
      level: row.level,
      source: row.source,
      event: row.event,
      message: row.message,
      payload: row.payload ?? null,
      created_at: row.created_at,
    })),
    ...(queueRes.data ?? []).map((row: any) => ({
      id: `dmq_${row.id}`,
      // disp_message_queue não tem account_id confiável hoje (migration
      // 040 que o adicionaria está marcada "DO NOT APPLY" / não
      // executada) — nem QueueItem em processQueue.ts carrega essa
      // coluna. Deixa null em vez de adivinhar.
      account_id: null,
      level: "error",
      source: "disparador",
      event: "message_failed",
      message: row.erro ?? "Erro no envio (sem mensagem registrada)",
      payload: {
        campaign_id: row.campaign_id,
        contact_id: row.contact_id,
        erro_permanente: row.erro_permanente,
      },
      created_at: row.created_at,
    })),
    ...(flowEventsRes.data ?? []).map((row: any) => ({
      id: `fre_${row.id}`,
      account_id: row.account_id ?? null,
      level: "error",
      source: "flows",
      event: row.event_type,
      message: row.error_message || `Evento de erro no flow (${row.event_type})`,
      payload: row.payload ?? null,
      created_at: row.created_at,
    })),
  ];

  combined.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));

  const hasMore = combined.length > limit;
  const page = combined.slice(0, limit);
  const nextCursor = hasMore ? page[page.length - 1]?.created_at ?? null : null;

  return NextResponse.json({
    logs: page,
    count: page.length,
    hasMore,
    nextCursor,
  });
}

// ------------------------------------------------------------
// tab=users — ranking de erros por usuário, via RPC (agregação não
// expressável no query builder). Sem paginação por cursor — a RPC já
// limita a 50 linhas, ordenadas por error_count desc.
// ------------------------------------------------------------
async function getUsersTab(db: SupabaseClient, from: string): Promise<NextResponse> {
  const { data, error } = await db.rpc("get_user_log_ranking", { p_from: from });
  if (error) throw error;

  return NextResponse.json({
    users: data ?? [],
    count: (data ?? []).length,
  });
}

// ------------------------------------------------------------
// tab=sessions — user_sessions, mais recente primeiro. user_name já
// vem gravado na própria linha (setado em POST /api/telemetry a
// partir de profiles.full_name no momento do session_start), então
// não precisa de join pra exibir o nome — evita uma query extra, já
// que user_sessions.user_id referencia auth.users, não profiles
// (sem FK direta entre as duas, PostgREST não embeda automático).
// ------------------------------------------------------------
async function getSessionsTab(
  db: SupabaseClient,
  params: {
    from: string;
    to: string | null;
    cursor: string | null;
    limit: number;
    userId: string | null;
  }
): Promise<NextResponse> {
  const { from, to, cursor, limit, userId } = params;

  let query = db
    .from("user_sessions")
    .select("*")
    .gte("started_at", from)
    .order("started_at", { ascending: false })
    .limit(limit + 1);
  if (to) query = query.lte("started_at", to);
  if (cursor) query = query.lt("started_at", cursor);
  if (userId) query = query.eq("user_id", userId);

  const { data, error } = await query;
  if (error) throw error;

  const rows = data ?? [];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? page[page.length - 1]?.started_at ?? null : null;

  return NextResponse.json({
    sessions: page,
    count: page.length,
    hasMore,
    nextCursor,
  });
}

// ------------------------------------------------------------
// tab=actions — system_logs com source='frontend' e action definido
// (exclui os erros de frontend, que também têm source='frontend' mas
// action null — esses continuam só na aba Eventos). Via RPC (migration
// 097): LEFT JOIN em profiles pra trazer user_name/user_email junto —
// não expressável no query builder — e filtro de p_action agora
// server-side (antes era client-side na UI). Sem suporte a `to` aqui:
// a RPC só recebeu os parâmetros pedidos (p_from/p_cursor/p_limit/
// p_user_id/p_action); `to` nunca foi exposto na UI mesmo, só existia
// no query builder da versão antiga.
// ------------------------------------------------------------
async function getActionsTab(
  db: SupabaseClient,
  params: {
    from: string;
    cursor: string | null;
    limit: number;
    userId: string | null;
    action: string | null;
  }
): Promise<NextResponse> {
  const { from, cursor, limit, userId, action } = params;

  const { data, error } = await db.rpc("get_action_logs", {
    p_from: from,
    p_cursor: cursor,
    p_limit: limit + 1,
    p_user_id: userId,
    p_action: action,
  });
  if (error) throw error;

  const rows = (data ?? []) as any[];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? page[page.length - 1]?.created_at ?? null : null;

  return NextResponse.json({
    logs: page,
    count: page.length,
    hasMore,
    nextCursor,
  });
}
