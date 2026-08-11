import { NextResponse } from "next/server";
import OpenAI from "openai";
import {
  sendWahaTextMessage,
  sendWahaMediaMessage,
} from "@/lib/whatsapp/waha-api";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { ensureQueueWorkerRunning } from "@/lib/disparador/worker";
import { applyTemplateVars } from "@/lib/disparador/template-vars";

// This endpoint and worker.ts's setInterval both race for the same
// disp_message_queue rows against the same Supabase project as production
// — see the KNOWN LOCAL-TEST RISK note on ensureQueueWorkerRunning in
// worker.ts. A row can be claimed by whichever deployment (this one or
// production's) polls first, so a local test hitting this route doesn't
// guarantee this route's code is what actually processed a given send.
export async function POST(request: Request) {
  try {
    // Fail-closed: without CRON_SECRET configured, refuse rather than
    // run unauthenticated (this endpoint enqueues real WhatsApp sends).
    const expected = process.env.CRON_SECRET;
    if (!expected) {
      return NextResponse.json({ error: "cron not configured" }, { status: 503 });
    }
    const supplied = request.headers.get("x-cron-secret");
    if (supplied !== expected) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    ensureQueueWorkerRunning();
    const now = new Date().toISOString();

    // 1. Fetch the next scheduled item from queue
    const { data: item, error: queryError } = await supabaseAdmin()
      .from("disp_message_queue")
      .select("*, contacts(name, phone, company)")
      .eq("status", "agendado")
      .lte("scheduled_at", now)
      .order("scheduled_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (queryError) {
      console.error("[Disparador Worker] Database error:", queryError);
      return NextResponse.json({ error: queryError.message }, { status: 500 });
    }

    if (!item) {
      return NextResponse.json({ status: "idle", message: "No scheduled messages to send" });
    }

    console.log(`[Disparador Worker] Processing item ${item.id} for campaign ${item.campaign_id}`);

    // 2. Lock item to prevent concurrent process
    await supabaseAdmin()
      .from("disp_message_queue")
      .update({ status: "enviando" })
      .eq("id", item.id);

    // 3. Fetch Campaign to verify status and sending window
    const { data: campaign } = await supabaseAdmin()
      .from("campaigns")
      .select("status, janela_inicio, janela_fim, created_by")
      .eq("id", item.campaign_id)
      .single();

    if (!campaign || campaign.status !== "em_execucao") {
      await supabaseAdmin()
        .from("disp_message_queue")
        .update({ status: "cancelado" })
        .eq("id", item.id);
      return NextResponse.json({ status: "skipped", message: "Campaign is not running" });
    }

    // 4. Validate time window
    if (
      campaign.janela_inicio &&
      campaign.janela_fim &&
      campaign.janela_inicio !== "00:00" &&
      campaign.janela_fim !== "23:59"
    ) {
      const isWithinWindow = checkWithinWindow(campaign.janela_inicio, campaign.janela_fim);
      if (!isWithinWindow) {
        // Adiar para o início da janela de amanhã
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const [h, m] = campaign.janela_inicio.split(":");
        tomorrow.setHours(parseInt(h, 10), parseInt(m, 10), 0, 0);

        await supabaseAdmin()
          .from("disp_message_queue")
          .update({ status: "agendado", scheduled_at: tomorrow.toISOString() })
          .eq("id", item.id);

        return NextResponse.json({ status: "deferred", message: "Deferred outside window" });
      }
    }

    // 5. Check if contact is blacklisted
    const telefone = item.contacts?.phone || item.mensagem_final;
    const { data: blacklisted } = await supabaseAdmin()
      .from("blacklist")
      .select("id")
      .eq("telefone", telefone)
      .maybeSingle();

    if (blacklisted) {
      await supabaseAdmin()
        .from("disp_message_queue")
        .update({ status: "bloqueado", erro: "Número na Blacklist" })
        .eq("id", item.id);
      return NextResponse.json({ status: "blocked", message: "Recipient is blacklisted" });
    }

    // 6. Fetch profiles to resolve Account ID and active WhatsApp config
    const { data: profile } = await supabaseAdmin()
      .from("profiles")
      .select("account_id")
      .eq("user_id", campaign.created_by)
      .maybeSingle();

    const accountId = profile?.account_id;
    if (!accountId) {
      throw new Error("Campaign creator is not associated with an account");
    }

    const { data: config } = await supabaseAdmin()
      .from("whatsapp_config")
      .select("*")
      .eq("account_id", accountId)
      .maybeSingle();

    if (!config || config.provider !== "waha") {
      throw new Error("WhatsApp WAHA connection is not active or configured for this account");
    }

    // 7. Render message and handle types (IA rewriting, Text, Image, Video, Audio, File)
    const tipo = item.tipo || "texto";
    let messageText = item.mensagem_final;

    // Separate key from the AI agent's OPENAI_API_KEY so spend on
    // disparador-generated messages shows up under its own OpenAI
    // Project in the usage dashboard. Falls back to OPENAI_API_KEY in
    // environments where the dedicated key isn't set yet.
    const disparadorOpenAiKey =
      process.env.DISPARADOR_OPENAI_API_KEY || process.env.OPENAI_API_KEY;

    if (tipo === "ia" && disparadorOpenAiKey) {
      try {
        const openai = new OpenAI({ apiKey: disparadorOpenAiKey });
        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content:
                "Você é um assistente de vendas para WhatsApp. Gere uma mensagem natural, sem parecer spam. Responda APENAS com a mensagem, sem explicações.",
            },
            {
              role: "user",
              content: `Contato: nome=${item.contacts?.name || ""}. Prompt: ${messageText}`,
            },
          ],
          max_tokens: 500,
        });
        messageText = completion.choices[0]?.message?.content || messageText;
      } catch (aiErr) {
        console.warn("AI generation failed, fallback to prompt text:", aiErr);
      }
    }

    // Substitute {{variavel}} template vars, then the legacy {nome} placeholder
    const cleanText = applyTemplateVars(messageText, item.contacts).replace(/{nome}/g, item.contacts?.name || "Cliente");
    const normalizedPhone = telefone.replace("+", "");

    // 8. Trigger sending via WAHA
    let wahaMessageId = "";

    if (tipo === "imagem") {
      const res = await sendWahaMediaMessage(config, normalizedPhone, item.media_url, "image", "imagem.png", cleanText);
      wahaMessageId = res.messageId;
    } else if (tipo === "video") {
      const res = await sendWahaMediaMessage(config, normalizedPhone, item.media_url, "video", "video.mp4", cleanText);
      wahaMessageId = res.messageId;
    } else if (tipo === "audio") {
      const res = await sendWahaMediaMessage(config, normalizedPhone, item.media_url, "audio", "audio.ogg");
      wahaMessageId = res.messageId;
    } else if (tipo === "arquivo") {
      const res = await sendWahaMediaMessage(config, normalizedPhone, item.media_url, "document", "documento", cleanText);
      wahaMessageId = res.messageId;
    } else {
      const res = await sendWahaTextMessage(config, normalizedPhone, cleanText);
      wahaMessageId = res.messageId;
    }

    // 9. Update queue item status to success
    await supabaseAdmin()
      .from("disp_message_queue")
      .update({
        status: "enviado",
        sent_at: new Date().toISOString(),
        waha_message_id: wahaMessageId,
        tentativas: (item.tentativas || 0) + 1,
      })
      .eq("id", item.id);

    // 10. Log in message logs
    await supabaseAdmin().from("message_logs").insert({
      queue_id: item.id,
      campaign_id: item.campaign_id,
      contact_id: item.contact_id,
      session_id: item.session_id,
      direcao: "saida",
      mensagem: cleanText,
      status: "enviado",
      waha_message_id: wahaMessageId,
    });

    // 11. Increment campaign statistics
    await supabaseAdmin().rpc("increment_campaign_metric", {
      p_campaign_id: item.campaign_id,
      p_field: "total_enviados",
    });

    return NextResponse.json({ status: "success", messageId: wahaMessageId });
  } catch (err: any) {
    console.error("[Disparador Worker] Error executing send:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

function checkWithinWindow(inicio: string, fim: string): boolean {
  const now = new Date();
  try {
    const brTimeStr = now.toLocaleTimeString("pt-BR", {
      timeZone: "America/Sao_Paulo",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });
    const [brHour, brMinute] = brTimeStr.split(":").map(Number);
    const nowMinutes = brHour * 60 + brMinute;
    const [hInicio, mInicio] = inicio.split(":").map(Number);
    const [hFim, mFim] = fim.split(":").map(Number);
    return nowMinutes >= hInicio * 60 + mInicio && nowMinutes <= hFim * 60 + mFim;
  } catch (e) {
    const [hInicio, mInicio] = inicio.split(":").map(Number);
    const [hFim, mFim] = fim.split(":").map(Number);
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    return nowMinutes >= hInicio * 60 + mInicio && nowMinutes <= hFim * 60 + mFim;
  }
}
