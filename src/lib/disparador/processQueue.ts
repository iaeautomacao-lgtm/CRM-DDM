import {
  sendWahaTextMessage,
  sendWahaMediaMessage,
  sendWahaVoiceMessage,
  startWacallsCall,
  playWacallsAudio,
  getWacallsCallStatus,
  assertWahaUrlIsSafe,
} from "@/lib/whatsapp/waha-api";
import {
  sendTemplateMessage,
  sendTextMessage,
  sendMediaMessage,
} from "@/lib/whatsapp/meta-api";
import { decrypt } from "@/lib/whatsapp/encryption";
import { applyTemplateVars } from "@/lib/disparador/template-vars";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import OpenAI from "openai";

// Marcador usado em `template_name` para itens de fila de contatos
// externos (contact_id null) enviados via WAHA com texto livre. Contatos
// externos não têm uma linha em `contacts`, então mensagem_final (o único
// campo disponível quando contact_id é null) precisa guardar o telefone
// do destinatário — o texto já resolvido ({{1}}, {{2}}... substituídos)
// vai em template_variables[0] em vez de mensagem_final. Ver
// src/app/api/v1/disparador/campaigns/route.ts, que monta esses itens.
export const EXTERNAL_WAHA_TEXT_MARKER = "__external_waha_text__";

export interface QueueItem {
  id: string;
  campaign_id: string;
  contact_id: string | null;
  session_id: string;
  tipo: string;
  mensagem_final: string;
  media_url?: string;
  tentativas?: number;
  contacts?: { name?: string; phone?: string; company?: string };
  // Migration 070 — campos de template Meta (business-initiated /
  // fora da janela de 24h). Ausentes/undefined em itens WAHA.
  template_name?: string;
  template_language?: string;
  template_variables?: string[];
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

// Após esse número de tentativas, o item é marcado como erro permanente
// em vez de reentrar no funil de reenvio (ver markQueueError).
const MAX_TENTATIVAS = 5;

// Reivindica atomicamente um item já identificado (agendado -> enviando)
// via UPDATE condicionado a status='agendado'. Isso é o que de fato evita
// o double-send: mesmo que worker.ts e cron/route.ts selecionem o mesmo
// item (cada um faz seu próprio SELECT), só um deles consegue vencer esse
// UPDATE — o outro recebe 0 linhas afetadas e desiste. Não depende de
// nenhuma migration: um UPDATE com WHERE é atômico no Postgres por si só.
async function claimItemAtomically(itemId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin()
    .from("disp_message_queue")
    .update({ status: "enviando" })
    .eq("id", itemId)
    .eq("status", "agendado")
    .select("id");
  if (error) throw error;
  return !!data && data.length > 0;
}

// Busca e reivindica o próximo item agendado de uma campanha. Usa a RPC
// wacrm.claim_queue_item (migration 075 — SELECT ... FOR UPDATE SKIP LOCKED)
// quando disponível; sem a migration aplicada, cai para um SELECT do
// candidato seguido do mesmo claim atômico usado acima. O fallback pode
// retornar null sob concorrência alta (perdeu a corrida) — quem chama deve
// apenas tentar de novo no próximo ciclo, o que já é o comportamento normal
// de worker.ts/cron ao não encontrar item.
export async function claimQueueItem(campaignId: string): Promise<QueueItem | null> {
  const supabase = supabaseAdmin();

  try {
    const { data, error } = await supabase.rpc("claim_queue_item", {
      p_campaign_id: campaignId,
    });
    if (!error) return (data as QueueItem) ?? null;
  } catch {
    // RPC ainda não existe (migration 075 não aplicada) — fallback abaixo.
  }

  const now = new Date().toISOString();
  const { data: candidates } = await supabase
    .from("disp_message_queue")
    .select("*")
    .eq("campaign_id", campaignId)
    .eq("status", "agendado")
    .lte("scheduled_at", now)
    .order("scheduled_at", { ascending: true })
    .limit(1);

  const candidate = candidates?.[0];
  if (!candidate) return null;

  const claimed = await claimItemAtomically(candidate.id);
  return claimed ? ({ ...candidate, status: "enviando" } as QueueItem) : null;
}

// Extrai um código HTTP 4xx da mensagem de erro (ex: "WAHA sendText failed
// (404): ..."). Erros da Meta normalmente não embutem o status na mensagem
// (ver throwMetaError em meta-api.ts), então essa checagem é best-effort:
// quando não dá para identificar o status, assume que NÃO é permanente
// (mais seguro deixar tentar de novo do que travar um erro transitório).
function isPermanentSendError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const match = message.match(/\b(4\d{2})\b/);
  if (!match) return false;
  const status = Number(match[1]);
  return status >= 400 && status < 500 && status !== 429;
}

// Grava erro + tentativas no item. Tenta incluir erro_permanente; se a
// coluna ainda não existir (migration 075 não aplicada), regrava sem ela
// para não perder o registro do erro.
async function markQueueError(
  itemId: string,
  message: string,
  permanent: boolean,
  tentativas?: number
): Promise<void> {
  const baseUpdate: Record<string, unknown> = { status: "erro", erro: message };
  if (tentativas !== undefined) baseUpdate.tentativas = tentativas;

  const { error } = await supabaseAdmin()
    .from("disp_message_queue")
    .update({ ...baseUpdate, erro_permanente: permanent })
    .eq("id", itemId);

  if (error) {
    await supabaseAdmin()
      .from("disp_message_queue")
      .update(baseUpdate)
      .eq("id", itemId);
  }
}

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

  const claimed = await claimItemAtomically(item.id);
  if (!claimed) {
    // Outro consumidor (worker.ts / cron) já reivindicou este item entre
    // o SELECT do chamador e esta chamada — não reprocessa.
    return { outcome: "deferred", reason: "already_claimed" };
  }

  const tentativasAtuais = item.tentativas ?? 0;
  if (tentativasAtuais >= MAX_TENTATIVAS) {
    await markQueueError(item.id, "Máximo de tentativas atingido", true, tentativasAtuais);
    return { outcome: "error", error: "Máximo de tentativas atingido" };
  }

  // Para contatos externos (via API), contact_id é null e o
  // telefone está em mensagem_final diretamente.
  const phone = item.contact_id
    ? (item.contacts?.phone || item.mensagem_final)
    : item.mensagem_final;

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
  // Contato externo com texto livre WAHA: mensagem_final guarda o
  // telefone (única forma de resolvê-lo sem contact_id), o texto real
  // fica em template_variables[0].
  let messageText =
    item.template_name === EXTERNAL_WAHA_TEXT_MARKER
      ? item.template_variables?.[0] ?? ""
      : item.mensagem_final;

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
  try {
    externalMessageId =
      provider === "meta"
        ? await sendViaMeta(config, item, normalizedPhone, cleanText, tipo)
        : await sendViaWaha(config, item, normalizedPhone, cleanText, tipo);
  } catch (sendErr: any) {
    const novasTentativas = tentativasAtuais + 1;
    const permanent = isPermanentSendError(sendErr) || novasTentativas >= MAX_TENTATIVAS;
    const message = sendErr?.message || String(sendErr);
    await markQueueError(item.id, message, permanent, novasTentativas);
    return { outcome: "error", error: message };
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
  config: any,
  item: QueueItem,
  phone: string,
  text: string,
  tipo: string
): Promise<string> {
  if (tipo === "ligacao") {
    throw new Error("Tipo 'ligacao' não é suportado em canais Meta Cloud API");
  }

  const accessToken = config.access_token ? decrypt(config.access_token) : null;
  if (!accessToken) {
    throw new Error(`Canal Meta sem access_token configurado (session_id: ${item.session_id})`);
  }
  const phoneNumberId = config.phone_number_id;
  if (!phoneNumberId) {
    throw new Error(`Canal Meta sem phone_number_id configurado (session_id: ${item.session_id})`);
  }

  // Caminho template (business-initiated obrigatório fora da janela 24h)
  if (item.template_name) {
    const variables: string[] = Array.isArray(item.template_variables)
      ? item.template_variables.map(String)
      : [];

    // Sanitiza variáveis — converte Markdown [texto](url) para url pura
    const sanitizedVariables = variables.map(v => {
      const mdLink = v.match(/\[.*?\]\((https?:\/\/[^)]+)\)/);
      if (mdLink) return mdLink[1];
      // Remove formatação Markdown residual
      return v.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    });

    const result = await sendTemplateMessage({
      phoneNumberId,
      accessToken,
      to: phone,
      templateName: item.template_name,
      language: item.template_language ?? "pt_BR",
      params: sanitizedVariables,
    });
    return result.messageId;
  }

  // Caminho texto livre (só válido dentro da janela 24h — customer-initiated)
  if (tipo === "imagem" || tipo === "video" || tipo === "audio" || tipo === "arquivo") {
    const kindMap: Record<string, "image" | "video" | "audio" | "document"> = {
      imagem: "image",
      video: "video",
      audio: "audio",
      arquivo: "document",
    };
    if (!item.media_url) {
      throw new Error(`Item ${item.id} do tipo ${tipo} não tem media_url`);
    }
    const result = await sendMediaMessage({
      phoneNumberId,
      accessToken,
      to: phone,
      kind: kindMap[tipo],
      link: item.media_url,
      caption: text || undefined,
      filename: tipo === "arquivo" ? "documento" : undefined,
    });
    return result.messageId;
  }

  // Texto simples
  const result = await sendTextMessage({
    phoneNumberId,
    accessToken,
    to: phone,
    text,
  });
  return result.messageId;
}

// Dispara um webhook de callback para o sistema externo quando uma
// campanha termina de processar. Best-effort: qualquer falha (URL
// bloqueada, timeout, erro de rede) é só logada — nunca deve derrubar
// o worker que a chama via `void`.
export async function sendCampaignCallback(campaignId: string): Promise<void> {
  try {
    const db = supabaseAdmin();

    // Buscar campanha com callback_url
    const { data: campaign } = await db
      .from("campaigns")
      .select("id, nome, status, callback_url")
      .eq("id", campaignId)
      .maybeSingle();

    if (!campaign?.callback_url) return;

    // Revalida a URL no momento do envio (não só na criação da
    // campanha) — fecha a janela entre criar a campanha e o callback
    // disparar dias depois (DNS rebinding / URL editada direto no banco).
    try {
      await assertWahaUrlIsSafe(campaign.callback_url);
    } catch (err) {
      console.error(`[Callback] Campanha ${campaignId} — callback_url bloqueada:`, err);
      return;
    }

    // Buscar métricas da campanha
    const { data: metrics } = await db
      .from("campaign_metrics")
      .select("*")
      .eq("campaign_id", campaignId)
      .maybeSingle();

    // Buscar resumo dos itens da fila
    const { data: queueSummary } = await db
      .from("disp_message_queue")
      .select("status, template_variables, mensagem_final")
      .eq("campaign_id", campaignId);

    const enviados = queueSummary?.filter(i => i.status === "enviado" || i.status === "entregue" || i.status === "lido").length ?? 0;
    const erros = queueSummary?.filter(i => i.status === "erro").length ?? 0;
    const bloqueados = queueSummary?.filter(i => i.status === "bloqueado").length ?? 0;
    const cancelados = queueSummary?.filter(i => i.status === "cancelado").length ?? 0;

    const payload = {
      event: "campaign.completed",
      campaign_id: campaign.id,
      campaign_name: campaign.nome,
      completed_at: new Date().toISOString(),
      summary: {
        total_enfileirados: queueSummary?.length ?? 0,
        enviados,
        entregues: metrics?.total_entregues ?? 0,
        lidos: metrics?.total_lidos ?? 0,
        erros,
        bloqueados,
        cancelados,
      },
    };

    await fetch(campaign.callback_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });

    console.log(`[Callback] Campanha ${campaignId} — callback enviado para ${campaign.callback_url}`);
  } catch (err: any) {
    console.error(`[Callback] Campanha ${campaignId} — falha ao enviar callback:`, err.message);
  }
}
