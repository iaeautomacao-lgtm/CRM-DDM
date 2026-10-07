import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/auth/account";
import { requireDisparadorAccess } from "@/lib/disparador/route-auth";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { buildLivePerformanceSnapshot } from "@/lib/disparador/live-performance";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
} as const;

async function countQueue(
  db: ReturnType<typeof supabaseAdmin>,
  campaignIds: string[],
  statuses: string[]
): Promise<number> {
  if (campaignIds.length === 0) return 0;
  const { count, error } = await db
    .from("disp_message_queue")
    .select("id", { count: "exact", head: true })
    .in("campaign_id", campaignIds)
    .in("status", statuses);
  if (error) throw error;
  return count ?? 0;
}

// Snapshot operacional leve para polling curto da tela de desempenho.
// Não substitui /api/disparador/desempenho: o endpoint histórico continua
// responsável por gráficos, p95, memória, event-loop e backoff por cron_tick.
//
// Aqui consultamos apenas índices já existentes:
// - campaigns(account_id/status) para campanhas em execução;
// - disp_message_queue(campaign_id,status,scheduled_at) para estado da fila;
// - disp_message_queue(session_id,sent_at) para a vazão móvel de 60 segundos.
//
// Assim conseguimos UI quase em tempo real sem publicar a fila inteira no
// Supabase Realtime e sem empurrar milhares de eventos individuais ao browser.
export async function GET() {
  try {
    const { accountId } = await requireDisparadorAccess();
    const db = supabaseAdmin();
    const sampledAt = new Date();
    const sentCutoff = new Date(sampledAt.getTime() - 60_000).toISOString();

    const [campaignResult, channelResult] = await Promise.all([
      db
        .from("campaigns")
        .select("id")
        .eq("account_id", accountId)
        .eq("status", "em_execucao")
        .limit(1000),
      db
        .from("whatsapp_config")
        .select("id")
        .eq("account_id", accountId)
        .eq("habilitado", true),
    ]);

    if (campaignResult.error) throw campaignResult.error;
    if (channelResult.error) throw channelResult.error;

    const campaignIds = (campaignResult.data ?? [])
      .map((row) => row.id as string | null)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    const channelIds = (channelResult.data ?? [])
      .map((row) => row.id as string | null)
      .filter((id): id is string => typeof id === "string" && id.length > 0);

    const sentLast60sPromise =
      channelIds.length === 0
        ? Promise.resolve(0)
        : db
            .from("disp_message_queue")
            .select("id", { count: "exact", head: true })
            .in("session_id", channelIds)
            .gte("sent_at", sentCutoff)
            .then(({ count, error }) => {
              if (error) throw error;
              return count ?? 0;
            });

    const [queued, sending, errors, blocked, sentLast60s] = await Promise.all([
      countQueue(db, campaignIds, ["agendado", "pendente", "pausado"]),
      countQueue(db, campaignIds, ["enviando"]),
      countQueue(db, campaignIds, ["erro"]),
      countQueue(db, campaignIds, ["bloqueado"]),
      sentLast60sPromise,
    ]);

    const live = buildLivePerformanceSnapshot({
      sampledAt: sampledAt.toISOString(),
      activeCampaigns: campaignIds.length,
      queued,
      sending,
      errors,
      blocked,
      sentLast60s,
    });

    return NextResponse.json(
      { ok: true, live },
      { headers: NO_STORE_HEADERS }
    );
  } catch (err) {
    const response = toErrorResponse(err);
    response.headers.set("Cache-Control", "no-store, max-age=0");
    return response;
  }
}
