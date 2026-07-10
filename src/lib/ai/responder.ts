import { createClient } from "@supabase/supabase-js";
import { decrypt } from "@/lib/whatsapp/encryption";
import { sendTextMessage, sendMediaMessage } from "@/lib/whatsapp/meta-api";
import { sendWahaTextMessage, sendWahaMediaMessage } from "@/lib/whatsapp/waha-api";
import {
  sanitizePhoneForMeta,
  phoneVariants,
  isValidE164,
  isRecipientNotAllowedError,
} from "@/lib/whatsapp/phone-utils";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabaseAdmin = () => createClient(supabaseUrl, supabaseServiceKey, {
  db: {
    schema: 'wacrm'
  }
});

interface DdmCpfResponse {
  instituicao?: string;
  valor_divida?: number | string;
  [key: string]: any;
}

async function fetchDdmCpfDetails(cpf: string): Promise<DdmCpfResponse | null> {
  const token = process.env.DDM_TOKEN || process.env.DDM_API_KEY || "2e30b68c0feda298f9d6d40ab36c1a09";

  try {
    // Passo 1: Localizar devedor por CPF no localiza_dev.php
    const localizaUrl = `https://www.ddmacordos.com/calc/localiza_dev.php?tk=${token}&cpf=${cpf}`;
    const resLocaliza = await fetch(localizaUrl);
    if (!resLocaliza.ok) {
      console.warn(`[AI Agent] DDM localiza_dev failed with status: ${resLocaliza.status}`);
      return null;
    }

    const localizaData = await resLocaliza.json();
    if (!Array.isArray(localizaData) || localizaData.length === 0) {
      console.log(`[AI Agent] No debtor found for CPF ${cpf}`);
      return null;
    }

    const debtor = localizaData[0];
    const iddev = debtor.iddev;
    const sistema = debtor.sistema; // ex: 'cruzeiro'
    const instituicao = debtor.instituicao || "Cruzeiro";
    const nome = debtor.nome || "";

    if (!iddev || !sistema) {
      console.warn("[AI Agent] Missing iddev or sistema in debtor localiza data");
      return { nome, instituicao };
    }

    // Passo 2: Buscar detalhes de cálculo da dívida com desconto de 40%
    const calcUrl = `https://ddmacordos.com/calc/?tk=${token}&idDev=${iddev}&cli=${sistema}&Desconto=40`;
    const resCalc = await fetch(calcUrl);
    if (!resCalc.ok) {
      console.warn(`[AI Agent] DDM calc failed with status: ${resCalc.status}`);
      return { nome, instituicao };
    }

    const calcData = await resCalc.json();
    let valor_divida = "0,00";

    if (Array.isArray(calcData)) {
      const pgtoAvista = calcData.find((obj: any) => obj.PgtoAvista);
      if (pgtoAvista && pgtoAvista.PgtoAvista && pgtoAvista.PgtoAvista.ValorFinal) {
        valor_divida = pgtoAvista.PgtoAvista.ValorFinal;
      }
    }

    return {
      nome,
      instituicao,
      valor_divida,
      iddev,
      sistema
    };
  } catch (err) {
    console.error("[AI Agent] DDM API sequence error:", err);
    return null;
  }
}

export async function handleAiAutoResponse(
  accountId: string,
  contactId: string,
  conversationId: string,
  incomingText: string
) {
  const db = supabaseAdmin();

  // 1. Fetch AI Configuration
  const { data: aiConfig, error: aiConfigError } = await db
    .from("ai_config")
    .select("*")
    .eq("account_id", accountId)
    .maybeSingle();

  if (aiConfigError || !aiConfig || !aiConfig.enabled) {
    return; // AI disabled or not configured
  }

  // 2. Load recent conversation history (last 10 messages)
  const { data: messages, error: messagesError } = await db
    .from("messages")
    .select("id, content_text, content_type, media_url, created_at, sender_type")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(10);

  if (messagesError) {
    console.error("[AI Agent] failed to load messages context:", messagesError);
    return;
  }

  // Order chronologically for the LLM
  const history = (messages || []).reverse();

  const configKey = aiConfig.api_key?.trim();

  let masterKey = "";
  if (aiConfig.api_provider === "hermes") {
    masterKey = process.env.OPENROUTER_API_KEY || "";
  } else if (aiConfig.api_provider === "openai") {
    masterKey = process.env.OPENAI_API_KEY || "";
  } else if (aiConfig.api_provider === "claude") {
    masterKey = process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY || "";
  } else if (aiConfig.api_provider === "gemini") {
    masterKey = process.env.GEMINI_API_KEY || "";
  }

  const activeKey = !configKey ? masterKey : configKey;

  if (!activeKey) {
    console.warn(`[AI Agent] Missing API Key for provider: ${aiConfig.api_provider}`);
    return;
  }

  // 3. Audio Message Transcription (Whisper)
  let incomingWasAudio = false;
  const lastMsg = history[history.length - 1];

  if (lastMsg && lastMsg.content_type === "audio" && lastMsg.media_url && aiConfig.multimodal_enabled) {
    incomingWasAudio = true;
    let whisperKey = aiConfig.api_provider === "openai" ? activeKey : (process.env.OPENAI_API_KEY || "");

    if (whisperKey) {
      try {
        console.log("[AI Agent] Transcribing audio with Whisper...", lastMsg.media_url);
        let fetchUrl = lastMsg.media_url;
        if (!fetchUrl.startsWith("http")) {
          const { data: publicUrlData } = db.storage.from("chat-media").getPublicUrl(fetchUrl);
          fetchUrl = publicUrlData.publicUrl;
        }

        const audioRes = await fetch(fetchUrl);
        if (audioRes.ok) {
          const arrayBuffer = await audioRes.arrayBuffer();
          const formData = new FormData();
          const blob = new Blob([arrayBuffer], { type: "audio/ogg" });
          formData.append("file", blob, "audio.ogg");
          formData.append("model", "whisper-1");
          formData.append("language", "pt");

          const whisperRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${whisperKey}`,
            },
            body: formData,
          });

          if (whisperRes.ok) {
            const whisperData = await whisperRes.json();
            if (whisperData.text) {
              const transcribedText = whisperData.text;
              console.log("[AI Agent] Whisper transcribed:", transcribedText);
              
              // Update local history
              lastMsg.content_text = transcribedText;
              incomingText = transcribedText;
              
              // Update in database so it shows up in CRM chat
              await db
                .from("messages")
                .update({ content_text: `🎙️ _Áudio transcrito:_ "${transcribedText}"` })
                .eq("id", lastMsg.id);
            }
          } else {
            console.error("[AI Agent] Whisper API error:", await whisperRes.text());
          }
        }
      } catch (err) {
        console.error("[AI Agent] Whisper error:", err);
      }
    }
  }

  // 4. Load Knowledge Base (File Search RAG) Context
  const { data: kbFiles } = await db
    .from("knowledge_base_files")
    .select("name, content")
    .eq("account_id", accountId);

  let systemPromptWithKb = aiConfig.system_prompt || `Você é o(a) Aleh, assistente comercial especializado do Grupo DDM.
Sua missão é atender leads/clientes de forma humana, simpática e focada em SUPORTE.

### DIRETRIZES DE ESTILO:
1. Seja sempre breve e vá direto ao ponto. No WhatsApp, mensagens muito longas são ignoradas.
2. Use quebras de linha para facilitar a leitura.
3. Use emojis de forma moderada (apenas 1 ou 2 por mensagem) para parecer amigável.
4. Nunca use termos robóticos como "Em que posso ser útil hoje?". Em vez disso, prefira "Como posso te ajudar?" ou "Como posso te apoiar?".
5. Jamais invente informações. Se não souber de algo (como preços ou detalhes técnicos que não estão na Base de Conhecimento), diga gentilmente que vai verificar com a equipe humana.

### FLUXO DO DIÁLOGO:
- Entenda a necessidade do cliente fazendo perguntas curtas.
- Apresente a solução de forma consultiva.`;
  if (kbFiles && kbFiles.length > 0) {
    const kbContext = kbFiles
      .map((file) => `[ARQUIVO: ${file.name}]\n${file.content}\n---`)
      .join("\n\n");
    
    systemPromptWithKb = `${systemPromptWithKb}

=== BASE DE CONHECIMENTO DISPONÍVEL ===
${kbContext}
=== FIM DA BASE DE CONHECIMENTO ===

Use as informações da base de conhecimento acima para responder às dúvidas do cliente com a maior precisão possível. Se a informação não estiver na base, aja de acordo com suas instruções normais.`;
  }

  // 4b. Orquestrador de Agentes (Lógica Gojenier com API DDM)
  const cpfRegex = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/;
  let foundCpf: string | null = null;

  for (let idx = history.length - 1; idx >= 0; idx--) {
    const textToSearch = history[idx].content_text || "";
    const m = textToSearch.match(cpfRegex);
    if (m) {
      foundCpf = m[0].replace(/\D/g, "");
      break;
    }
  }

  let ddmData: DdmCpfResponse | null = null;
  if (foundCpf && foundCpf.length === 11) {
    console.log(`[AI Agent] Found CPF ${foundCpf} in conversation. Calling DDM API...`);
    ddmData = await fetchDdmCpfDetails(foundCpf);
  }

  if (ddmData) {
    const inst = ddmData.instituicao || ddmData.institution || "Cruzeiro";
    const debt = ddmData.valor_divida || ddmData.valor || "0,00";
    const sistema = ddmData.sistema || "";

    if (inst.toLowerCase().includes("cruzeiro") || sistema.toLowerCase() === "cruzeiro") {
      systemPromptWithKb = `Você é Sabrina, Representante Financeiro da Universidade Cruzeiro do Sul, atuando como analista financeira consultiva da assessoria DDM.

=== DADOS DO CLIENTE (DDM API) ===
- Nome do Cliente: ${ddmData.nome || "Não informado"}
- CPF consultado: ${foundCpf}
- Instituição: Universidade Cruzeiro do Sul
- Valor para Quitação à Vista (ValorFinal): R$ ${debt}

=== COMPORTAMENTO E TOM ===
Você é uma especialista financeira. Seja cordial, um pouco descontraída, educada e muito profissional.
Sua saudação inicial preferencial: "Olá! Tudo bem? Me chamo Sabrina, sou Representante Financeiro da Universidade Cruzeiro do Sul."

=== INSTRUÇÕES DE NEGOCIAÇÃO ===
Sua missão é ajudar o aluno a regularizar sua situação financeira de forma consultiva:
1. **Confirmação:** Confirme que localizou os débitos referentes à Cruzeiro do Sul para o CPF informado.
2. **Escada de Negociação (Passo a Passo):**
   - **1ª Tentativa (À Vista):** Apresente o valor à vista de R$ ${debt} (do campo ValorFinal da API) com foco em quitar e encerrar a dívida.
   - **2ª Tentativa (Cartão de Crédito):** Se o aluno recusar o valor à vista ou pedir parcelamento, ofereça a opção de parcelar no cartão de crédito através do link oficial: https://novoportal.cruzeirodosul.edu.br/
   - **3ª Tentativa (Boleto Bancário):** Se o aluno disser explicitamente que não consegue pagar no cartão, informe que há opções de parcelamento em boleto. Peça para ele dizer em quantas parcelas gostaria de pagar.
3. **Regra Crítica de Mensagens:**
   - Mantenha mensagens curtas, diretas e objetivas (entre 80 e 120 caracteres, cerca de 2 frases curtas).
   - Apresente apenas uma opção de negociação por vez. Sempre aguarde a resposta do aluno antes de enviar a próxima.
   - Nunca faça cálculos manuais ou estimativas de parcelas.
4. **Regra Crítica de Formalização:**
   - NUNCA feche ou formalize o acordo sem a confirmação explícita e inequívoca do cliente (ex: "sim", "quero fechar", "fechado").
   - Antes de formalizar, confirme obrigatoriamente: E-mail, Número de celular, Forma de pagamento e Condições do acordo.
   - Quando o acordo for confirmado de forma explícita, retorne a tag especial #ACORDOFORMALIZADO ao final do resumo.
5. **Tratamento de Recusas:**
   - Se o cliente recusar, argumente gentilmente até 3 vezes lembrando-o das consequências (acúmulo de juros, ações de cobrança e órgãos de proteção de crédito) antes de desistir. Caso ele mantenha a recusa após as 3 tentativas, retorne #RECUSA no final da mensagem.`;
    } else {
      systemPromptWithKb = `${systemPromptWithKb}

=== INFORMAÇÕES DE CONSULTA (DDM API) ===
O cliente informou o CPF e possui uma dívida ativa localizada na DDM.
- Instituição Responsável: ${inst}
- Valor da Dívida: R$ ${debt}

=== REGRAS DE ATENDIMENTO DA INSTITUIÇÃO (${inst}) ===
Você agora é um atendente oficial da instituição ${inst}.
1. Confirme para o cliente que localizou a pendência referente à instituição ${inst}.
2. Informe o valor da dívida de R$ ${debt} de forma clara e amigável.
3. Pergunte se ele gostaria de ver as opções de acordo para quitar essa pendência.
4. Siga estritamente as regras de negociação da instituição ${inst}.`;
    }
  } else {
    systemPromptWithKb = `${systemPromptWithKb}

=== INFORMAÇÃO OBRIGATÓRIA ANTES DE INICIAR ===
Você é o orquestrador geral de atendimento.
Você NÃO deve passar nenhuma informação sobre dívidas, simulações ou acordos até que o cliente forneça o CPF.
1. Se o cliente ainda não enviou o CPF dele nesta conversa, peça-o educadamente e de forma natural (ex: "Para que eu possa consultar suas pendências, poderia me informar o seu CPF?").
2. Não invente nenhuma informação ou simulação antes de receber o CPF.`;
  }

  // 5. Generate response using chosen LLM API
  let generatedText = "";
  try {
    if (aiConfig.api_provider === "openai") {
      generatedText = await generateOpenAiResponse(
        activeKey,
        systemPromptWithKb,
        history
      );
    } else if (aiConfig.api_provider === "claude") {
      generatedText = await generateClaudeResponse(
        activeKey,
        systemPromptWithKb,
        history
      );
    } else if (aiConfig.api_provider === "hermes") {
      generatedText = await generateHermesResponse(
        activeKey,
        systemPromptWithKb,
        history
      );
    } else {
      generatedText = await generateGeminiResponse(
        activeKey,
        systemPromptWithKb,
        history
      );
    }
  } catch (err) {
    console.error("[AI Agent] LLM generation error:", err);
    return;
  }

  generatedText = generatedText.trim();
  if (!generatedText) return;

  // 6. Voice Reply Generation (ElevenLabs)
  let voiceMediaUrl = "";
  if (incomingWasAudio && aiConfig.elevenlabs_enabled && aiConfig.elevenlabs_api_key && aiConfig.elevenlabs_voice_id) {
    try {
      console.log("[AI Agent] Generating voice reply with ElevenLabs...");
      const ttsUrl = `https://api.elevenlabs.io/v1/text-to-speech/${aiConfig.elevenlabs_voice_id}`;
      const ttsRes = await fetch(ttsUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": aiConfig.elevenlabs_api_key,
        },
        body: JSON.stringify({
          text: generatedText,
          model_id: "eleven_multilingual_v2",
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
          },
        }),
      });

      if (ttsRes.ok) {
        const audioBuffer = await ttsRes.arrayBuffer();
        const filename = `voice-reply-${Date.now()}.mp3`;
        const storagePath = `account-${accountId}/${filename}`;

        const { error: uploadError } = await db.storage
          .from("chat-media")
          .upload(storagePath, Buffer.from(audioBuffer), {
            contentType: "audio/mpeg",
            cacheControl: "31536000",
            upsert: true,
          });

        if (!uploadError) {
          const { data: publicUrlData } = db.storage.from("chat-media").getPublicUrl(storagePath);
          voiceMediaUrl = publicUrlData.publicUrl;
          console.log("[AI Agent] Voice reply generated and uploaded:", voiceMediaUrl);
        } else {
          console.error("[AI Agent] Failed to upload ElevenLabs audio to Storage:", uploadError.message);
        }
      } else {
        console.error("[AI Agent] ElevenLabs TTS API failed:", await ttsRes.text());
      }
    } catch (err) {
      console.error("[AI Agent] ElevenLabs error:", err);
    }
  }

  // 7. Load WhatsApp configuration
  const { data: config, error: configError } = await db
    .from("whatsapp_config")
    .select("*")
    .eq("account_id", accountId)
    .maybeSingle();

  if (configError || !config) {
    console.error("[AI Agent] WhatsApp config not found");
    return;
  }

  const { data: contact } = await db
    .from("contacts")
    .select("phone")
    .eq("id", contactId)
    .single();

  if (!contact?.phone) return;

  const sanitized = sanitizePhoneForMeta(contact.phone);
  const variants = phoneVariants(sanitized);
  let sentMessageId = "";
  let workingPhone = sanitized;

  const isWaha = config.provider === "waha";
  const wahaConfig = isWaha
    ? {
        waha_url: config.waha_url,
        waha_session: config.waha_session,
        waha_api_key: config.waha_api_key ? decrypt(config.waha_api_key) : null,
      }
    : null;
  const accessToken = isWaha ? "" : decrypt(config.access_token);

  // 8. Send message via WAHA or Meta
  for (const variant of variants) {
    try {
      if (isWaha) {
        if (voiceMediaUrl) {
          const result = await sendWahaMediaMessage(wahaConfig!, variant, voiceMediaUrl, "audio", "voice.mp3");
          sentMessageId = result.messageId;
        } else {
          const result = await sendWahaTextMessage(wahaConfig!, variant, generatedText);
          sentMessageId = result.messageId;
        }
      } else {
        if (voiceMediaUrl) {
          const result = await sendMediaMessage({
            phoneNumberId: config.phone_number_id,
            accessToken,
            to: variant,
            kind: "audio",
            link: voiceMediaUrl,
          });
          sentMessageId = result.messageId;
        } else {
          const result = await sendTextMessage({
            phoneNumberId: config.phone_number_id,
            accessToken,
            to: variant,
            text: generatedText,
          });
          sentMessageId = result.messageId;
        }
      }
      workingPhone = variant;
      break;
    } catch (err) {
      if (isWaha) {
        console.error("[AI Agent] WAHA send error:", err);
        break;
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (!isRecipientNotAllowedError(msg)) {
        console.error("[AI Agent] Meta send error:", err);
        break;
      }
    }
  }

  if (!sentMessageId) return;

  if (workingPhone !== sanitized) {
    await db.from("contacts").update({ phone: workingPhone }).eq("id", contactId);
  }

  // 9. Save sent message to database
  const messageDate = new Date().toISOString();
  const { error: newMsgErr } = await db
    .from("messages")
    .insert({
      account_id: accountId,
      conversation_id: conversationId,
      message_id: sentMessageId,
      content_type: voiceMediaUrl ? "audio" : "text",
      content_text: generatedText,
      media_url: voiceMediaUrl || null,
      status: "sent",
      sender_type: "bot",
      created_at: messageDate,
    });

  if (newMsgErr) {
    console.error("[AI Agent] Failed to save outbound message:", newMsgErr);
    return;
  }

  // 10. Update conversation values
  await db
    .from("conversations")
    .update({
      last_message_text: voiceMediaUrl ? "🎙️ [Áudio de Voz]" : generatedText,
      last_message_at: messageDate,
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversationId);
}

async function generateGeminiResponse(
  apiKey: string,
  systemPrompt: string,
  history: any[]
): Promise<string> {
  const model = "gemini-1.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const contents = [];

  for (const msg of history) {
    const isCustomer = msg.sender_type === "customer";
    
    // Multi-modal image handler
    if (msg.content_type === "image" && msg.media_url) {
      try {
        let fetchUrl = msg.media_url;
        if (!fetchUrl.startsWith("http")) {
          const { data: publicUrlData } = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!,
            { db: { schema: 'wacrm' } }
          ).storage.from("chat-media").getPublicUrl(fetchUrl);
          fetchUrl = publicUrlData.publicUrl;
        }

        const imgRes = await fetch(fetchUrl);
        if (imgRes.ok) {
          const buffer = await imgRes.arrayBuffer();
          const base64 = Buffer.from(buffer).toString("base64");
          const mimeType = imgRes.headers.get("content-type") || "image/jpeg";
          
          contents.push({
            role: isCustomer ? "user" : "model",
            parts: [
              { text: msg.content_text || "O que está nesta imagem?" },
              {
                inlineData: {
                  mimeType,
                  data: base64
                }
              }
            ],
          });
          continue;
        }
      } catch (err) {
        console.error("[AI Agent] Gemini failed to load image:", err);
      }
    }

    contents.push({
      role: isCustomer ? "user" : "model",
      parts: [{ text: msg.content_text || "" }],
    });
  }

  const systemInstruction = systemPrompt
    ? {
        parts: [{ text: systemPrompt }],
      }
    : undefined;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents,
      systemInstruction,
      generationConfig: {
        maxOutputTokens: 1000,
        temperature: 0.7,
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

async function generateOpenAiResponse(
  apiKey: string,
  systemPrompt: string,
  history: any[]
): Promise<string> {
  const url = "https://api.openai.com/v1/chat/completions";
  const messages = [];

  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }

  for (const msg of history) {
    const isCustomer = msg.sender_type === "customer";
    
    // Multi-modal image handler
    if (msg.content_type === "image" && msg.media_url) {
      let fetchUrl = msg.media_url;
      if (!fetchUrl.startsWith("http")) {
        const { data: publicUrlData } = createClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!,
          { db: { schema: 'wacrm' } }
        ).storage.from("chat-media").getPublicUrl(fetchUrl);
        fetchUrl = publicUrlData.publicUrl;
      }

      messages.push({
        role: isCustomer ? "user" : "assistant",
        content: [
          { type: "text", text: msg.content_text || "O que está nesta imagem?" },
          { type: "image_url", image_url: { url: fetchUrl } }
        ]
      });
    } else {
      messages.push({
        role: isCustomer ? "user" : "assistant",
        content: msg.content_text || "",
      });
    }
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.7,
      max_tokens: 1000,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  return data?.choices?.[0]?.message?.content || "";
}

async function generateClaudeResponse(
  apiKey: string,
  systemPrompt: string,
  history: any[]
): Promise<string> {
  const url = "https://api.anthropic.com/v1/messages";
  const messages = [];

  for (const msg of history) {
    const isCustomer = msg.sender_type === "customer";
    messages.push({
      role: isCustomer ? ("user" as const) : ("assistant" as const),
      content: msg.content_text || "",
    });
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1000,
      system: systemPrompt,
      messages,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Claude API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  return data?.content?.[0]?.text || "";
}

async function generateHermesResponse(
  apiKey: string,
  systemPrompt: string,
  history: any[]
): Promise<string> {
  const url = "https://openrouter.ai/api/v1/chat/completions";
  const messages = [];

  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }

  for (const msg of history) {
    const isCustomer = msg.sender_type === "customer";
    messages.push({
      role: isCustomer ? "user" : "assistant",
      content: msg.content_text || "",
    });
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://wacrm.vercel.app",
      "X-Title": "WA CRM",
    },
    body: JSON.stringify({
      model: "nousresearch/hermes-3-llama-3.1-405b",
      messages,
      temperature: 0.7,
      max_tokens: 1000,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Hermes OpenRouter API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  return data?.choices?.[0]?.message?.content || "";
}
