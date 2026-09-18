import { NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

// Ingestão de telemetria de frontend (navegação, ação, erro, sessão) —
// ver migrations 092/093/094. Autenticada via sessão CRM normal
// (getCurrentAccount), não Basic Auth — isso protege /ddm-logs
// (leitura), esta é a rota de escrita, chamada pelo próprio app
// enquanto o usuário já está logado.
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

// Mesmo padrão de src/app/api/invitations/[token]/redeem/route.ts.
function getClientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const xri = request.headers.get("x-real-ip");
  if (xri) return xri.trim();
  return "unknown";
}

type TelemetryEventType = "page_view" | "action" | "error" | "session_start" | "session_end";

const VALID_TYPES = new Set<TelemetryEventType>([
  "page_view",
  "action",
  "error",
  "session_start",
  "session_end",
]);

interface TelemetryBody {
  type?: unknown;
  path?: unknown;
  title?: unknown;
  referrer?: unknown;
  duration_ms?: unknown;
  action?: unknown;
  payload?: unknown;
  session_id?: unknown;
  error_message?: unknown;
  error_stack?: unknown;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();

    const body = (await request.json().catch(() => null)) as TelemetryBody | null;
    const type = str(body?.type);
    if (!type || !VALID_TYPES.has(type as TelemetryEventType)) {
      return NextResponse.json(
        { error: "'type' deve ser um de: " + Array.from(VALID_TYPES).join(", ") },
        { status: 400 }
      );
    }

    const admin = supabaseAdmin();

    if (type === "page_view") {
      const path = str(body?.path);
      if (!path) {
        return NextResponse.json({ error: "'path' é obrigatório para page_view" }, { status: 400 });
      }
      const duration_ms = typeof body?.duration_ms === "number" ? body.duration_ms : null;

      const { error } = await admin.from("page_views").insert({
        user_id: ctx.userId,
        account_id: ctx.accountId,
        path,
        title: str(body?.title),
        referrer: str(body?.referrer),
        duration_ms,
      });
      if (error) throw error;

      // session_id opcional — o frontend só passa a enviá-lo quando a
      // captura de navegação (Prompt B) linkar cada page_view à sessão
      // atual. Increment atômico via RPC (migration 095): user_id no
      // WHERE garante que não dá pra inflar page_count de uma sessão de
      // outro usuário passando um session_id alheio.
      const sessionId = str(body?.session_id);
      if (sessionId) {
        const { error: incrementError } = await admin.rpc("increment_session_page_count", {
          p_session_id: sessionId,
          p_user_id: ctx.userId,
        });
        if (incrementError) {
          console.error("[telemetry] falha ao incrementar page_count:", incrementError.message);
        }
      }

      return NextResponse.json({ ok: true });
    }

    if (type === "session_start") {
      // full_name não vem de getCurrentAccount() (não expõe o user
      // bruto) — busca à parte, mesmo client RLS-scoped do ctx (um
      // usuário sempre pode ler o próprio profile).
      const { data: profile } = await ctx.supabase
        .from("profiles")
        .select("full_name")
        .eq("user_id", ctx.userId)
        .maybeSingle();

      const { data, error } = await admin
        .from("user_sessions")
        .insert({
          user_id: ctx.userId,
          account_id: ctx.accountId,
          user_name: (profile as { full_name: string | null } | null)?.full_name ?? null,
          ip_address: getClientIp(request),
          user_agent: request.headers.get("user-agent"),
        })
        .select("id")
        .single();
      if (error) throw error;
      return NextResponse.json({ ok: true, id: (data as { id: string }).id });
    }

    if (type === "session_end") {
      const sessionId = str(body?.session_id);
      if (!sessionId) {
        return NextResponse.json(
          { error: "'session_id' é obrigatório para session_end" },
          { status: 400 }
        );
      }
      // Escopado por user_id — sem RLS nesta tabela (só o service-role
      // a toca), então esse filtro é o que impede um usuário de encerrar
      // a sessão de outro adivinhando/reusando um session_id alheio.
      const { error } = await admin
        .from("user_sessions")
        .update({ ended_at: new Date().toISOString() })
        .eq("id", sessionId)
        .eq("user_id", ctx.userId);
      if (error) throw error;
      return NextResponse.json({ ok: true });
    }

    // action | error → wacrm.system_logs (com user_id/page/action —
    // migration 092; source='frontend' — migration 092b).
    const isError = type === "error";
    const actionName = str(body?.action);
    const event = isError ? "frontend_error" : actionName ?? "frontend_action";
    const message = isError
      ? str(body?.error_message) ?? "Erro de frontend"
      : actionName
        ? `Ação: ${actionName}`
        : "Ação de frontend";

    const payload: Record<string, unknown> =
      typeof body?.payload === "object" && body?.payload !== null
        ? { ...(body.payload as Record<string, unknown>) }
        : {};
    if (isError) {
      const stack = str(body?.error_stack);
      if (stack) payload.error_stack = stack;
    }

    const { error } = await admin.from("system_logs").insert({
      account_id: ctx.accountId,
      user_id: ctx.userId,
      level: isError ? "error" : "info",
      source: "frontend",
      event,
      message,
      page: str(body?.path),
      action: actionName,
      payload,
    });
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
