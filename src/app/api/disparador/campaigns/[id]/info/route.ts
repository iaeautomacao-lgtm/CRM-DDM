import { NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { decrypt } from "@/lib/whatsapp/encryption";

const TIER_LIMITS: Record<string, number> = {
  TIER_50:    250,
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
    const supabase = await createServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
    }

    const { id: campaignId } = await params;

    // Buscar campanha
    const { data: campaign } = await supabaseAdmin()
      .from("campaigns")
      .select("id, session_ids, mensagens")
      .eq("id", campaignId)
      .single();

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
      .select("id, provider, phone_number_id, access_token")
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

    // Para cada canal Meta, buscar tier na Meta API
    const channelInfos = await Promise.all(
      metaChannels.map(async (channel) => {
        try {
          const accessToken = channel.access_token
            ? decrypt(channel.access_token)
            : null;

          if (!accessToken || !channel.phone_number_id) {
            return {
              id: channel.id,
              provider: "meta",
              phone_number_id: channel.phone_number_id,
              tier: "TIER_1K",
              dailyLimit: 1000,
              quality_rating: null,
              error: "Token ou phone_number_id ausente",
            };
          }

          const res = await fetch(
            `https://graph.facebook.com/v21.0/${channel.phone_number_id}` +
            `?fields=messaging_limit_tier,quality_rating,display_phone_number` +
            `&access_token=${accessToken}`
          );

          if (!res.ok) {
            return {
              id: channel.id,
              provider: "meta",
              phone_number_id: channel.phone_number_id,
              tier: "TIER_1K",
              dailyLimit: 1000,
              quality_rating: null,
              error: `Meta API error: ${res.status}`,
            };
          }

          const data = await res.json();
          const tier = data.messaging_limit_tier || "TIER_1K";
          const dailyLimit = TIER_LIMITS[tier] ?? 1000;

          return {
            id: channel.id,
            provider: "meta",
            phone_number_id: channel.phone_number_id,
            display_phone_number: data.display_phone_number,
            tier,
            dailyLimit,
            quality_rating: data.quality_rating,
          };
        } catch {
          return {
            id: channel.id,
            provider: "meta",
            phone_number_id: channel.phone_number_id,
            tier: "TIER_1K",
            dailyLimit: 1000,
            quality_rating: null,
            error: "Falha ao consultar Meta API",
          };
        }
      })
    );

    return NextResponse.json({
      hasMeta: true,
      channels: channelInfos,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
