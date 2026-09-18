import { NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Rota deliberadamente SEM autenticação — página oculta /ddm-logs, protegida
// só pela obscuridade da URL (decisão explícita do time, não descuido).
// Não adicionar checagem de sessão/role aqui sem revisar essa decisão antes.

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
]);

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);

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

    // 2. wacrm.disp_message_queue (status='erro') — normalizado. Só
    // participa se o filtro de source/level (quando presentes) permitir
    // 'disparador'/'error' — senão nem consulta a tabela à toa.
    const includeQueue = (!source || source === "disparador") && (!level || level === "error");
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
    const includeFlowEvents = (!source || source === "flows") && (!level || level === "error");
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
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Erro ao buscar logs" }, { status: 500 });
  }
}
