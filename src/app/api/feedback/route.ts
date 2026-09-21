import { NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

// Recebe reports de bug/problema do botão de feedback flutuante
// (src/components/feedback-button.tsx), gravados em wacrm.system_logs
// (source='feedback', migration 101) e exibidos em /ddm-logs. Mesmo
// padrão de auth (getCurrentAccount) e de admin client de
// src/app/api/telemetry/route.ts — escrita em system_logs precisa
// bypassar RLS.
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

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();

    const body = (await request.json().catch(() => null)) as {
      message?: unknown;
      page?: unknown;
      user_agent?: unknown;
    } | null;

    const message = str(body?.message);
    if (!message) {
      return NextResponse.json({ error: "'message' é obrigatório" }, { status: 400 });
    }
    const page = str(body?.page);
    const userAgent = str(body?.user_agent);

    const { error } = await supabaseAdmin().from("system_logs").insert({
      account_id: ctx.accountId,
      user_id: ctx.userId,
      level: "warn",
      source: "feedback",
      event: "user_bug_report",
      message,
      page,
      payload: {
        user_agent: userAgent,
        timestamp: new Date().toISOString(),
      },
    });
    if (error) throw error;

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
