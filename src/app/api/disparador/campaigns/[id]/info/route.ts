import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { HEALTH_STALE_AFTER_MS, refreshChannelHealth } from "@/lib/disparador/channel-health";
import { decrypt } from "@/lib/whatsapp/encryption";
import { getPhoneNumberHealth } from "@/lib/whatsapp/meta-api";

const TIER_LIMITS: Record<string, number> = {
  TIER_50:    250,
  TIER_250:   250,
  TIER_1K:    1000,
  TIER_10K:   10000,
  TIER_100K:  100000,
  UNLIMITED:  Infinity,
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Campanha e canais só da conta de quem pede (antes qualquer usuário
    // logado consultava qualquer campanha pelo id).
    const { accountId } = await getCurrentAccount();

    const { id: campaignId } = await params;

    // Buscar campanha
    const { data: campaign } = await supabaseAdmin()
      .from("campaigns")
      .select("id, session_ids, mensagens")
      .eq("id", campaignId)
      .eq("account_id", accountId)
      .maybeSingle();

    if (!campaign) {
      return NextResponse.json({ error: "Campanha não encontrada" }, { status: 404 });
    }

    const sessionIds = Array.isArray(campaign.session_ids) ? campaign.session_ids : [];
    if (sessionIds.length === 0) {
      return NextResponse.json({ error: "Campanha sem canais configurados" }, { status: 400 });
    }

    // Buscar configs dos canais
    const { data: channels } = await supabaseAdmin()
      .from("whatsapp_config")
      .select("id, provider, phone_number_id, access_token, display_phone_number")
      .eq("account_id", accountId)
      .in("id", sessionIds);

    const metaChannels = (channels ?? []).filter((c) => c.provider === "meta");

    // Se não há canais Meta, retorna info básica sem chamar a API da Meta
    if (metaChannels.length === 0) {
      return NextResponse.json({
        hasMeta: false,
        channels: (channels ?? []).map((c) => ({
          id: c.id,
          provider: c.provider,
          phone_number_id: c.phone_number_id,
          tier: null,
          dailyLimit: null,
        })),
      });
    }

    // Saúde dos números: snapshot do banco (webhook + poll, migration 190). Faltando ou velho, consulta a Meta e grava.
    // Falha NUNCA vira TIER_1K/1000: tier e dailyLimit ficam null e o erro vai junto (a UI não deve assumir verde).
    const db = supabaseAdmin();
    const readSnapshots = async () => {
      const { data, error } = await db
        .from("channel_health")
        .select("session_id, quality_rating, messaging_limit_tier, daily_limit, checked_at, last_error")
        .in("session_id", metaChannels.map((c) => c.id));
      return error ? null : new Map((data ?? []).map((r) => [String(r.session_id), r]));
    };
    let snapshots = await readSnapshots();
    const nowMs = Date.now();
    const isFresh = (id: string) => {
      const row = snapshots?.get(id);
      return !!row?.checked_at && !row.last_error && nowMs - new Date(String(row.checked_at)).getTime() < HEALTH_STALE_AFTER_MS;
    };
    if (snapshots) {
      const stale = metaChannels.filter((c) => !isFresh(c.id));
      await Promise.all(
        stale.map((c) =>
          refreshChannelHealth(db, { id: c.id, account_id: accountId, phone_number_id: c.phone_number_id, access_token: c.access_token, display_phone_number: c.display_phone_number }, "poll"),
        ),
      );
      if (stale.length) snapshots = (await readSnapshots()) ?? snapshots;
    }

    const channelInfos = await Promise.all(
      metaChannels.map(async (channel) => {
        const base = { id: channel.id, provider: "meta", phone_number_id: channel.phone_number_id };
        const row = snapshots?.get(channel.id);
        if (row) {
          const tier = (row.messaging_limit_tier as string | null) ?? null;
          const daily = row.daily_limit == null ? (tier ? (TIER_LIMITS[tier] ?? null) : null) : Number(row.daily_limit);
          return {
            ...base,
            display_phone_number: channel.display_phone_number ?? undefined,
            tier,
            dailyLimit: daily,
            quality_rating: (row.quality_rating as string | null) ?? null,
            ...(row.last_error ? { error: String(row.last_error) } : {}),
          };
        }
        // Migration 190 ausente: consulta direta, sem esconder a falha.
        try {
          if (!channel.access_token || !channel.phone_number_id) throw new Error("Token ou phone_number_id ausente");
          const data = await getPhoneNumberHealth({ phoneNumberId: channel.phone_number_id, accessToken: decrypt(channel.access_token) });
          const tier = data.messaging_limit_tier ?? null;
          return {
            ...base,
            display_phone_number: data.display_phone_number,
            tier,
            dailyLimit: tier ? (TIER_LIMITS[tier] ?? null) : null,
            quality_rating: data.quality_rating ?? null,
          };
        } catch (err) {
          return { ...base, tier: null, dailyLimit: null, quality_rating: null, error: err instanceof Error ? err.message : "Falha ao consultar Meta API" };
        }
      }),
    );

    return NextResponse.json({
      hasMeta: true,
      channels: channelInfos,
    });
  } catch (err) {
    // 401/403 do getCurrentAccount; o resto vira 500 sem vazar detalhe.
    return toErrorResponse(err);
  }
}
