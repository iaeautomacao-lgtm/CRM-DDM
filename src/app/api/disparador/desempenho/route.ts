import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/auth/account";
import { requireDisparadorAccess } from "@/lib/disparador/route-auth";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import {
  computeWindowMetrics,
  deriveThroughputFromTicks,
  formatThroughputSeries,
  formatTickRow,
  parseJanela,
  windowStartIso,
  type ChannelInfo,
  type RawSystemLogTick,
  type RawThroughputRow,
  type ThroughputDataPoint,
} from "@/lib/disparador/desempenho";
import {
  aggregateChannelStats,
  computeCapacity,
  fetchAllTicks,
  fetchThroughputRows,
  peakPerNumber,
} from "@/lib/disparador/desempenho-extra";

// ============================================================
// GET /api/disparador/desempenho?janela=15m|1h|6h|24h
//
// Retorna a telemetria do motor de disparo (cron_tick em system_logs)
// e a vazão por minuto por número (view dispatch_throughput_per_minute).
//
// Acesso: restrito a owner e admin (requireDisparadorAccess).
// A leitura do banco usa o client com service_role (supabaseAdmin)
// APÓS a checagem de permissão da rota.
// ============================================================

export async function GET(request: Request) {
  try {
    const { accountId } = await requireDisparadorAccess();

    const { searchParams } = new URL(request.url);
    const janela = parseJanela(searchParams.get("janela"));
    const startIso = windowStartIso(janela);

    const db = supabaseAdmin();

    // 1. Busca os canais vinculados à conta para rotular e filtrar
    const { data: channelRows, error: channelError } = await db
      .from("whatsapp_config")
      .select("id, phone_number, display_name, provider")
      .eq("account_id", accountId);

    if (channelError) {
      console.warn("[Desempenho] Falha ao listar whatsapp_config:", channelError.message);
    }

    const channelsMap = new Map<string, ChannelInfo>();
    const channelsList: ChannelInfo[] = [];

    for (const c of channelRows ?? []) {
      const label =
        c.display_name?.trim() ||
        c.phone_number?.trim() ||
        `Canal ${c.id.slice(0, 8)}`;

      const info: ChannelInfo = {
        id: c.id,
        label,
        provider: (c.provider as "meta" | "waha") ?? "unknown",
        phoneNumber: c.phone_number ?? null,
      };

      channelsMap.set(c.id, info);
      channelsList.push(info);
    }

    // 2. Busca os registros do cron_tick em system_logs — a janela INTEIRA, paginada (antes:
    //    .limit(1000), que cortava 24 h em ~16,7 h e distorcia médias/p95 da janela).
    let rawTicks: RawSystemLogTick[];
    let ticksTruncated = false;
    try {
      const fetched = await fetchAllTicks(db, startIso);
      rawTicks = fetched.rows;
      ticksTruncated = fetched.truncated;
    } catch (logError) {
      console.error("[Desempenho] Erro ao consultar system_logs:", logError);
      return NextResponse.json(
        { ok: false, error: "Falha ao consultar logs de telemetria do disparador" },
        { status: 500 }
      );
    }

    // 3. Busca a vazão por minuto por número na view wacrm.dispatch_throughput_per_minute
    let throughputSeries: ThroughputDataPoint[] = [];
    const accountSessionIds = (channelRows ?? []).map((c) => c.id);

    let throughputTruncated = false;
    try {
      // Paginada em ordem decrescente de minuto: acima de 1000 linhas o corte do PostgREST caía nos
      // minutos MAIS RECENTES (a leitura era crescente e sem limite).
      const view = await fetchThroughputRows(db, startIso, accountSessionIds);
      throughputTruncated = view.truncated;

      if (view.available && view.rows.length > 0) {
        throughputSeries = formatThroughputSeries(
          view.rows as RawThroughputRow[],
          channelsMap
        );
      } else {
        // Fallback robusto se a migration 164 não foi aplicada ou a view está vazia
        throughputSeries = deriveThroughputFromTicks(rawTicks, channelsMap);
      }
    } catch (viewEx) {
      console.warn("[Desempenho] View dispatch_throughput_per_minute indisponível, usando fallback de ticks:", viewEx);
      throughputSeries = deriveThroughputFromTicks(rawTicks, channelsMap);
    }

    // 4. Calcula o sumário consolidado e as 20 linhas mais recentes para a tabela
    const metrics = computeWindowMetrics(rawTicks);
    const recentTicks = rawTicks.slice(0, 20).map(formatTickRow);
    // 5. Por número (channels{} do cron_tick) e capacidade teórica × real — só canais da conta.
    const channelStats = aggregateChannelStats(rawTicks, channelsMap);
    const capacity = computeCapacity({
      latest: rawTicks.find((t) => t.payload)?.payload ?? null,
      series: throughputSeries,
      peakPerNumber: peakPerNumber(throughputSeries),
    });

    return NextResponse.json({
      ok: true,
      janela,
      metrics,
      ticks: recentTicks,
      throughputSeries,
      channels: channelsList,
      channelStats,
      capacity,
      truncated: { ticks: ticksTruncated, throughput: throughputTruncated },
      refreshedAt: new Date().toISOString(),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
