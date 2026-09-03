import {
  sendWahaTextMessage,
  sendWahaMediaMessage,
  sendWahaVoiceMessage,
  startWacallsCall,
  playWacallsAudio,
  getWacallsCallStatus,
} from "@/lib/whatsapp/waha-api";
import { decrypt } from "@/lib/whatsapp/encryption";
import { applyTemplateVars } from "@/lib/disparador/template-vars";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import OpenAI from "openai";

export interface QueueItem {
  id: string;
  campaign_id: string;
  contact_id: string;
  session_id: string;
  tipo: string;
  mensagem_final: string;
  media_url?: string;
  tentativas?: number;
  contacts?: { name?: string; phone?: string; company?: string };
}

export interface Campaign {
  id: string;
  status: string;
  janela_inicio?: string;
  janela_fim?: string;
}

export type ProcessResult =
  | { outcome: "sent"; messageId: string }
  | { outcome: "deferred"; reason: string }
  | { outcome: "blocked"; reason: string }
  | { outcome: "error"; error: string };

export function checkWithinWindow(inicio: string, fim: string): boolean {
  const now = new Date();
  try {
    const brTimeStr = now.toLocaleTimeString("pt-BR", {
      timeZone: "America/Sao_Paulo",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const [brHour, brMinute] = brTimeStr.split(":").map(Number);
    const nowMinutes = brHour * 60 + brMinute;
    const [hInicio, mInicio] = inicio.split(":").map(Number);
    const [hFim, mFim] = fim.split(":").map(Number);
    return nowMinutes >= hInicio * 60 + mInicio && nowMinutes <= hFim * 60 + mFim;
  } catch {
    const [hInicio, mInicio] = inicio.split(":").map(Number);
    const [hFim, mFim] = fim.split(":").map(Number);
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    return nowMinutes >= hInicio * 60 + mInicio && nowMinutes <= hFim * 60 + mFim;
  }
}

export async function processQueueItem(
  item: QueueItem,
  campaign: Campaign
): Promise<ProcessResult> {
  const { janela_inicio, janela_fim } = campaign;
  const hasWindow =
    janela_inicio &&
    janela_fim &&
    janela_inicio !== "00:00" &&
    janela_fim !== "23:59";

  if (hasWindow && !checkWithinWindow(janela_inicio!, janela_fim!)) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const [h, m] = janela_inicio!.split(":");
    tomorrow.setHours(parseInt(h, 10), parseInt(m, 10), 0, 0);

    await supabaseAdmin()
      .from("disp_message_queue")
      .update({ status: "agendado", scheduled_at: tomorrow.toISOString() })
      .eq("id", item.id);

    return { outcome: "deferred", reason: "outside_window" };
  }

  await supabaseAdmin()
    .from("disp_message_queue")
    .update({ status: "enviando" })
    .eq("id", item.id);

  const phone = item.contacts?.phone || item.mensagem_final;

  const { data: blacklisted } = await supabaseAdmin()
    .from("blacklist")
    .select("id")
    .eq("telefone", phone)
    .maybeSingle();

  if (blacklisted) {
    await supabaseAdmin()
      .from("disp_message_queue")
      .update({ status: "bloqueado", erro: "Número na Blacklist" })
      .eq("id", item.id);
    return { outcome: "blocked", reason: "blacklisted" };
  }

  const { data: config } = await supabaseAdmin()
    .from("whatsapp_config")
    .select("*")
    .eq("id", item.session_id)
    .maybeSingle();

  if (!config) {
    throw new Error(`Canal não encontrado para session_id: ${item.session_id}`);
  }

  const provider = config.provider as "waha" | "meta";
  const tipo = item.tipo || "texto";
  let messageText = item.mensagem_final;

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
      console.warn("[processQueue] AI generation failed, using prompt text:", aiErr);
    }
  }

  const cleanText = applyTemplateVars(messageText, item.contacts).replace(
    /{nome}/g,
    item.contacts?.name || "Cliente"
  );
  const normalizedPhone = phone.replace("+", "");

  let externalMessageId: string;
  if (provider === "meta") {
    externalMessageId = await sendViaMeta(config, item, normalizedPhone, cleanText, tipo);
  } else {
    externalMessageId = await sendViaWaha(config, item, normalizedPhone, cleanText, tipo);
  }

  await supabaseAdmin()
    .from("disp_message_queue")
    .update({
      status: "enviado",
      sent_at: new Date().toISOString(),
      waha_message_id: externalMessageId,
      tentativas: (item.tentativas || 0) + 1,
    })
    .eq("id", item.id);

  await supabaseAdmin().from("message_logs").insert({
    queue_id: item.id,
    campaign_id: item.campaign_id,
    contact_id: item.contact_id,
    session_id: item.session_id,
    direcao: "saida",
    mensagem: cleanText,
    status: "enviado",
    waha_message_id: externalMessageId,
  });

  await supabaseAdmin().rpc("increment_campaign_metric", {
    p_campaign_id: item.campaign_id,
    p_field: "total_enviados",
  });

  return { outcome: "sent", messageId: externalMessageId };
}

async function sendViaWaha(
  config: any,
  item: QueueItem,
  phone: string,
  text: string,
  tipo: string
): Promise<string> {
  const wahaConfig = {
    waha_url: config.waha_url,
    waha_session: config.waha_session,
    waha_api_key: config.waha_api_key ? decrypt(config.waha_api_key) : null,
  };

  if (tipo === "imagem") {
    const res = await sendWahaMediaMessage(wahaConfig, phone, item.media_url!, "image", "imagem.png", text);
    return res.messageId;
  }
  if (tipo === "video") {
    const res = await sendWahaMediaMessage(wahaConfig, phone, item.media_url!, "video", "video.mp4", text);
    return res.messageId;
  }
  if (tipo === "audio") {
    const res = await sendWahaVoiceMessage(wahaConfig, phone, item.media_url!);
    return res.messageId;
  }
  if (tipo === "arquivo") {
    const res = await sendWahaMediaMessage(wahaConfig, phone, item.media_url!, "document", "documento", text);
    return res.messageId;
  }
  if (tipo === "ligacao") {
    const { callId } = await startWacallsCall(wahaConfig, phone);
    if (!callId) throw new Error("Não foi possível gerar um CallID para a ligação");

    let isConnected = false;
    let ended = false;
    for (let attempt = 0; attempt < 25; attempt++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const callInfo = await getWacallsCallStatus(wahaConfig, callId);
        if (callInfo.status === "connected") { isConnected = true; break; }
        if (callInfo.ended || callInfo.status === "ended") { ended = true; break; }
      } catch (err) {
        console.warn(`[processQueue] Falha ao checar status da ligação ${callId}:`, err);
      }
    }
    if (!isConnected) {
      throw new Error(
        ended
          ? "Chamada rejeitada ou encerrada pelo destinatário"
          : "Chamada não atendida (tempo esgotado)"
      );
    }
    await playWacallsAudio(wahaConfig, callId, item.media_url!);
    return `call_${callId}`;
  }

  const res = await sendWahaTextMessage(wahaConfig, phone, text);
  return res.messageId;
}

async function sendViaMeta(
  _config: any,
  _item: QueueItem,
  _phone: string,
  _text: string,
  tipo: string
): Promise<string> {
  if (tipo === "ligacao") {
    throw new Error("Tipo 'ligacao' não é suportado em canais Meta Cloud API");
  }
  // TODO Fase 2: implementar sendMetaTemplateMessage
  throw new Error(
    "[Disparador] Envio via Meta Cloud API ainda não implementado. Use um canal WAHA para esta campanha."
  );
}
