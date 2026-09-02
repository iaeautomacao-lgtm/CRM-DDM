import { createClient } from "@supabase/supabase-js";
// TEMP DEBUG — remove before commit, along with every appendFileSync
// call below that writes to AI_DEBUG_LOG_PATH.
import { appendFileSync } from "fs";
import type { AiAgentTool } from "@/lib/flows/types";
import { decrypt } from "@/lib/whatsapp/encryption";
import { sendTextMessage, sendMediaMessage } from "@/lib/whatsapp/meta-api";
import { sendWahaTextMessage, sendWahaMediaMessage } from "@/lib/whatsapp/waha-api";
import {
  sanitizePhoneForMeta,
  phoneVariants,
  isValidE164,
  isRecipientNotAllowedError,
} from "@/lib/whatsapp/phone-utils";

// TEMP DEBUG — remove before commit.
const AI_DEBUG_LOG_PATH = '/tmp/ai_debug.log';

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
  const token = process.env.DDM_TOKEN || process.env.DDM_API_KEY || "af875d1e5ffab9247c16c56ba2c6b349";

  try {
    // Passo 1: Localizar devedor por CPF no localiza_dev.php com timeout de 10s
    const localizaUrl = `https://www.ddmacordos.com/calc/localiza_dev.php?tk=${token}&cpf=${cpf}`;
    const resLocaliza = await fetch(localizaUrl, { signal: AbortSignal.timeout(10000) });
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
    const instituicao = debtor.apelido || debtor.Apelido || debtor.instituicao || "Cruzeiro";
    const nome = debtor.nome || "";

    if (!iddev || !sistema) {
      console.warn("[AI Agent] Missing iddev or sistema in debtor localiza data");
      return { nome, instituicao };
    }

    // Passo 2: Buscar detalhes de cálculo com timeout de 10s
    const calcUrl = `https://ddmacordos.com/calc/?tk=${token}&idDev=${iddev}&cli=${sistema}&Desconto=40`;
    const resCalc = await fetch(calcUrl, { signal: AbortSignal.timeout(10000) });
    if (!resCalc.ok) {
      console.warn(`[AI Agent] DDM calc failed with status: ${resCalc.status}`);
      return { nome, instituicao };
    }

    const calcData = await resCalc.json();
    let valor_divida = "0,00";
    let opcoes_cartao = "";
    let campanha = "2025.1";
    let resumo_parcelamento: any[] = [];
    let acordos: any[] = [];

    let calculoId = "";

    const calcArray = Array.isArray(calcData) ? calcData : [calcData];

    if (calcArray.length > 0) {
      const dadosObj = calcArray.find((obj: any) => obj.Dados);
      if (dadosObj && dadosObj.Dados) {
        calculoId = String(dadosObj.Dados.CalculoID || dadosObj.Dados.idcalc || "");
      }

      const pgtoAvista = calcArray.find((obj: any) => obj.PgtoAvista);
      if (pgtoAvista && pgtoAvista.PgtoAvista && pgtoAvista.PgtoAvista.ValorFinal) {
        valor_divida = pgtoAvista.PgtoAvista.ValorFinal;
      }

      // Extract agreements (case-insensitive key handling)
      const acordosObj = calcArray.find((obj: any) => obj.acordos || obj.Acordos);
      if (acordosObj) {
        const rawAcordos = acordosObj.acordos || acordosObj.Acordos;
        if (Array.isArray(rawAcordos)) {
          acordos = rawAcordos;
        }
      }

      // Extract boleto installments (case-insensitive key handling)
      const pgtoBoletoObj = calcArray.find((obj: any) => obj.PgtoParceladoBoleto || obj.pgtoParceladoBoleto || obj.resumo_parcelamento);
      const rawBoleto = pgtoBoletoObj?.PgtoParceladoBoleto || pgtoBoletoObj?.pgtoParceladoBoleto || pgtoBoletoObj?.resumo_parcelamento;
      if (rawBoleto) {
        if (Array.isArray(rawBoleto)) {
          resumo_parcelamento = rawBoleto.map((item: any) => ({
            entrada: item.entrada || "0,00",
            parcelas: item.parcelas || 1,
            valor_parcela: item.valor_parcela || item.valor || "0,00"
          }));
        } else if (typeof rawBoleto === "object") {
          resumo_parcelamento = Object.entries(rawBoleto).map(([key, val]: [string, any]) => ({
            entrada: val.entrada || "0,00",
            parcelas: parseInt(key) || val.parcelas || 1,
            valor_parcela: val.valor_parcela || val.valor || "0,00"
          }));
        }
      }

      // Extrai os débitos para analisar o ano de cada parcela
      const calculosObj = calcArray.find((obj: any) => obj.Calculos);
      const calculosList = calculosObj?.Calculos || [];

      let temDebitoAte2019 = false;
      for (const calc of calculosList) {
        const dataParc = calc?.debitos?.data_parcela; // YYYY-MM-DD
        if (dataParc) {
          const ano = parseInt(dataParc.split("-")[0]);
          if (ano <= 2019) {
            temDebitoAte2019 = true;
          }
        }
      }

      let maxParcelas = 6;
      let parcelaMinima = 150.0;
      if (temDebitoAte2019) {
        campanha = "Até 2019";
        maxParcelas = 10;
        parcelaMinima = 100.0;
      } else {
        campanha = "2025.1";
      }

      const cleanVal = String(valor_divida).replace(/\./g, "").replace(",", ".");
      const totalFloat = parseFloat(cleanVal);

      if (!isNaN(totalFloat) && totalFloat > 0) {
        const validParcels = [];
        for (let p = 1; p <= maxParcelas; p++) {
          const valParcela = totalFloat / p;
          if (p === 1 || valParcela >= parcelaMinima) {
            validParcels.push(`${p}x de R$ ${valParcela.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
          }
        }
        opcoes_cartao = validParcels.join(", ");
      }
    }

    return {
      nome,
      instituicao,
      valor_divida,
      iddev,
      sistema,
      opcoes_cartao,
      campanha,
      resumo_parcelamento,
      acordos,
      calculoId
    };
  } catch (err) {
    console.error("[AI Agent] DDM API sequence error:", err);
    return null;
  }
}

function extractInstallmentsFromHistory(history: any[]): number {
  for (let idx = history.length - 1; idx >= 0; idx--) {
    const text = (history[idx].content_text || "").toLowerCase();
    const sender = history[idx].sender_type;

    if (sender === "customer") {
      const matchX = text.match(/\b(\d+)\s*x\b/);
      if (matchX) {
        const num = parseInt(matchX[1]);
        if (num >= 1 && num <= 12) return num;
      }

      const matchVezes = text.match(/\b(\d+)\s*(vezes|parcela|parc|pgto|parcels)/);
      if (matchVezes) {
        const num = parseInt(matchVezes[1]);
        if (num >= 1 && num <= 12) return num;
      }

      if (/^\s*\d+\s*$/.test(text)) {
        const num = parseInt(text.trim());
        if (num >= 1 && num <= 12) return num;
      }
    }
  }
  return 1;
}

export async function handleAiAutoResponse(
  accountId: string,
  contactId: string,
  conversationId: string,
  incomingText: string,
  systemPromptOverride?: string,
  skipDebounce?: boolean,
  historyAfter?: string,
  historyBefore?: string,
  tools?: AiAgentTool[],
  onToolCall?: (toolName: string, args: Record<string, unknown>) => Promise<void>,
  onToolResult?: (toolName: string, result: string, durationMs: number) => Promise<void>,
  // Node key of the calling ai_agent flow node — only "agente_de_ia"
  // (BEN) gets the #NEGOCIACAO auto-exit in generateOpenAiResponse.
  // "agente_de_ia_2" (Aleh) needs consultar_debitos' data to present
  // installments to the customer, so it must never get suppressed.
  nodeKey?: string
): Promise<string | null | void> {
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

  // --- DEBOUNCE E DELAY DE DIGITAÇÃO ---
  // Aguarda 4 segundos antes de prosseguir. Se uma nova mensagem chegar durante esse intervalo,
  // a execução anterior é interrompida porque o histórico de mensagens mudará e haverá um novo gatilho.
  //
  // Skipped when the caller already debounced (the ai_agent flow node —
  // see debounceAiAgentReply in flows/engine.ts, which serializes replies
  // per run_id before ever calling in here). Stacking both meant every
  // flow-driven AI turn paid this 4s twice for no extra protection.
  if (!skipDebounce) {
    await new Promise((resolve) => setTimeout(resolve, 4000));

    // Recarrega as últimas mensagens para ver se o cliente enviou algo novo depois do gatilho inicial.
    // Se a última mensagem não for a que disparou esta execução, encerramos esta chamada para deixar a mais recente responder.
    //
    // Compara contra received_at (marcado por NOW() no INSERT, isto é,
    // o relógio do nosso servidor), não created_at (o timestamp que o
    // WAHA/Meta manda no payload). created_at reflete o relógio do
    // provedor — qualquer atraso de entrega/fila entre o provedor gerar
    // aquele timestamp e nosso webhook inserir a linha invalidava essa
    // conta de tempo decorrido, deixando duas mensagens rápidas do
    // cliente gerarem duas respostas da IA.
    const { data: latestCheckMsg } = await db
      .from("messages")
      .select("id, content_text, received_at, sender_type")
      .eq("conversation_id", conversationId)
      .order("received_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestCheckMsg && latestCheckMsg.sender_type === "customer") {
      // Se o cliente mandou mais mensagens, esse webhook antigo cancela para o novo responder com todo o contexto junto.
      const lastCheckTime = new Date(latestCheckMsg.received_at).getTime();
      // Adiciona uma tolerância de 500ms para evitar falsos cancelamentos
      if (Date.now() - lastCheckTime < 3800) {
        console.log(`[AI Agent] Debounce triggered on conversation ${conversationId}. Cancelling old execution.`);
        return;
      }
    }
  }

  // 2. Load recent conversation history (last 10 messages)
  let messagesQuery = db
    .from("messages")
    .select("id, content_text, content_type, media_url, created_at, sender_type")
    .eq("conversation_id", conversationId);

  if (historyAfter) {
    messagesQuery = messagesQuery.gt("received_at", historyAfter);
  }
  if (historyBefore) {
    messagesQuery = messagesQuery.lt("received_at", historyBefore);
  }

  const { data: messages, error: messagesError } = await messagesQuery
    .order("created_at", { ascending: false })
    .limit(10);

  if (messagesError) {
    console.error("[AI Agent] failed to load messages context:", messagesError);
    return;
  }

  // --- TRAVA DE MENSAGENS INADEQUADAS OU SACANAGEM (ANTI-SCAM) ---
  // Impede gasto desnecessário de tokens se o cliente estiver xingando, mandando piadas ou tentando "quebrar" o bot.
  const lowerMsg = (incomingText || "").toLowerCase().trim();
  const blacklistedKeywords = [
    "fudido", "corno", "puta", "viado", "caralho", "bosta", "merda", "vsf", "vtnc",
    "chatgpt", "gemini", "prompt", "sistema", "jailbreak", "ignorar instruções", "ignore instructions",
    "sacanagem", "otario", "otário", "imbecil", "idiota", "palhaço", "palhaco",
    "robô", "robo", "bot", "inteligencia artificial", "máquina", "maquina"
  ];

  const containsBlacklisted = blacklistedKeywords.some(keyword => lowerMsg.includes(keyword));

  if (containsBlacklisted) {
    console.warn(`[AI Agent] Anti-scam triggered on conversation ${conversationId}. Suspicious input: "${incomingText}". Transferring to human.`);
    
    // Busca o agente para transferir
    const { data: convData } = await db
      .from("conversations")
      .select("user_id")
      .eq("id", conversationId)
      .single();

    let targetAgentId = convData?.user_id;

    if (!targetAgentId) {
      const { data: wahaCfg } = await db
        .from("whatsapp_config")
        .select("user_id")
        .eq("account_id", accountId)
        .maybeSingle();
      if (wahaCfg?.user_id) {
        targetAgentId = wahaCfg.user_id;
      }
    }

    if (targetAgentId) {
      // Atribui o chat ao atendente e atualiza
      await db
        .from("conversations")
        .update({
          assigned_agent_id: targetAgentId,
          updated_at: new Date().toISOString()
        })
        .eq("id", conversationId);
        
      // Opcional: envia um alerta ou tag de humano no comando no banco
      return; // Interrompe a geração da IA imediatamente sem gastar tokens
    }
  }

  // --- ANTI-LOOP GUARD ---
  // Se as últimas 6 mensagens ocorreram em um intervalo menor que 12 segundos,
  // assumimos que é um loop de bots conversando. Silenciamos o bot e atribuímos ao humano.
  if (messages && messages.length >= 6) {
    const recentMsgs = messages.slice(0, 6);
    const newestTime = new Date(recentMsgs[0].created_at).getTime();
    const oldestTime = new Date(recentMsgs[5].created_at).getTime();
    const diffSeconds = (newestTime - oldestTime) / 1000;

    if (diffSeconds > 0 && diffSeconds < 12) {
      console.warn(`[AI Agent] Bot loop detected on conversation ${conversationId}. Time diff for last 6 messages: ${diffSeconds}s. Transferring to human.`);
      
      const { data: convData } = await db
        .from("conversations")
        .select("user_id")
        .eq("id", conversationId)
        .single();

      // Fallback: se a conversa não tiver user_id (contato novo), busca o user_id configurador do whatsapp
      let targetUserId = convData?.user_id;
      if (!targetUserId) {
        const { data: configData } = await db
          .from("whatsapp_config")
          .select("user_id")
          .eq("account_id", accountId)
          .maybeSingle();
        targetUserId = configData?.user_id;
      }

      if (targetUserId) {
        await db
          .from("conversations")
          .update({
            assigned_agent_id: targetUserId,
            updated_at: new Date().toISOString()
          })
          .eq("id", conversationId);
      }
      return; // Interrompe a resposta automática da IA
    }
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
  // TEMP DEBUG — remove before commit.
  try {
    appendFileSync(AI_DEBUG_LOG_PATH, JSON.stringify({
      ts: new Date().toISOString(),
      type: 'AI_DEBUG_ACTIVE_KEY',
      activeKeyLength: activeKey?.length,
      first10: activeKey?.slice(0, 10),
      accountId,
    }) + '\n');
  } catch {}

  if (!activeKey) {
    console.warn(`[AI Agent] Missing API Key for provider: ${aiConfig.api_provider}`);
    return;
  }

  // 3. Audio Message Transcription (Whisper)
  let incomingWasAudio = false;
  const lastMsg = history[history.length - 1];

  if (lastMsg && lastMsg.content_type === "audio" && lastMsg.media_url && aiConfig.multimodal_enabled) {
    incomingWasAudio = true;
    const whisperKey = aiConfig.api_provider === "openai" ? activeKey : (process.env.OPENAI_API_KEY || "");

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

  // Garante que a mensagem atual do cliente (incomingText) esteja no
  // histórico enviado ao GPT. O filtro historyAfter (nós ai_agent do
  // Flow Builder passam run.started_at) pode excluir da tabela
  // `messages` a própria mensagem que disparou o run, já que ela é
  // inserida ANTES do run existir — received_at fica <= started_at e
  // o `.gt()` do filtro a corta, deixando o GPT sem nenhum turno do
  // cliente. Só adiciona se a última mensagem do cliente no histórico
  // ainda não contiver esse texto (evita duplicar no caminho normal).
  const trimmedIncoming = (incomingText || "").trim();
  if (trimmedIncoming) {
    const lastCustomerMsg = [...history]
      .reverse()
      .find((m: any) => m.sender_type === "customer");
    const alreadyIncluded =
      lastCustomerMsg &&
      (lastCustomerMsg.content_text || "").includes(trimmedIncoming);
    if (!alreadyIncluded) {
      history.push({
        id: null,
        content_text: incomingText,
        content_type: "text",
        media_url: null,
        created_at: new Date().toISOString(),
        sender_type: "customer",
      });
    }
  }

  // 4. Load Knowledge Base (File Search RAG) Context
  const { data: kbFiles } = await db
    .from("knowledge_base_files")
    .select("name, content")
    .eq("account_id", accountId);

  // Node-level override wins over the account's global ai_config prompt,
  // which in turn wins over the hardcoded Aleh default. A flow node override
  // must remain isolated from the legacy CPF/institution blocks below: those
  // blocks belong to the standalone global responder and can contradict a
  // node's own policy. Knowledge-base context still appends to the base.
  const hasOverride = !!systemPromptOverride && systemPromptOverride.trim() !== "";
  let systemPromptWithKb = hasOverride
    ? systemPromptOverride!
    : aiConfig.system_prompt || 'Você é um assistente virtual. Aguarde um momento.';
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

  let forceTransferHumanMsg = "";

  if (ddmData) {
    const inst = ddmData.instituicao || ddmData.institution || "Cruzeiro";
    const debt = ddmData.valor_divida || ddmData.valor || "0,00";
    const sistema = ddmData.sistema || "";
    const hasActiveDebt = debt && debt !== "0,00" && debt !== "0" && debt !== 0;

    // O bloco isEducational (detecção de instituição + transferência
    // forçada) só roda quando o agente global está respondendo. Um nó
    // ai_agent do Flow Builder com system_prompt_override (BEN/Aleh) já
    // tem sua própria lógica via tools — isEducational nunca calculado
    // (fica false) e forceTransferHumanMsg nunca setado nesse caso.
    let isEducational = false;
    if (!hasOverride) {
    isEducational =
      inst.toLowerCase().includes("uva") ||
      inst.toLowerCase().includes("veiga") ||
      inst.toLowerCase().includes("unijorge") ||
      inst.toLowerCase().includes("unisuam") ||
      inst.toLowerCase().includes("castelo") ||
      inst.toLowerCase().includes("bezerra") ||
      inst.toLowerCase().includes("potiguar") ||
      inst.toLowerCase().includes("multivix") ||
      sistema.toLowerCase().includes("uva") ||
      sistema.toLowerCase().includes("veiga") ||
      sistema.toLowerCase().includes("unijorge") ||
      sistema.toLowerCase().includes("unisuam") ||
      sistema.toLowerCase().includes("castelo") ||
      sistema.toLowerCase().includes("bezerra") ||
      sistema.toLowerCase().includes("potiguar") ||
      sistema.toLowerCase().includes("multivix");

    if (isEducational) {
      const acordosList = ddmData.acordos || [];
      const hasPendingAgreement = acordosList.some((acordo: any) => {
        const status = (acordo.status || "").toLowerCase().trim();
        return status !== "" && status !== "quitado";
      });

      // Look at due dates
      const calculosObj = ddmData.Calculos || ddmData.calculos || [];
      const todayStr = new Date().toISOString().split("T")[0];
      let hasNotYetDueDebt = false;
      if (Array.isArray(calculosObj)) {
        for (const calc of calculosObj) {
          const dataParc = calc?.debitos?.data_parcela;
          if (dataParc && dataParc > todayStr) {
            hasNotYetDueDebt = true;
          }
        }
      }

      if (hasPendingAgreement) {
        forceTransferHumanMsg = "Localizei um acordo ativo/pendente em seu cadastro. Para garantir a melhor negociação, vou te transferir agora mesmo para nossa equipe de atendimento humano. Só um instante! #EQUIPEHUMANA";
      } else if (!hasActiveDebt) {
        forceTransferHumanMsg = "Meu sistema está passando por atualizações, um momento. #EQUIPEHUMANA";
      } else if (hasNotYetDueDebt) {
        forceTransferHumanMsg = "Verifiquei que há pendências em aberto, mas com vencimento futuro. Vou te transferir para um atendente para maiores informações. Um momento! #EQUIPEHUMANA";
      }
    }
    }

    if ((inst.toLowerCase().includes("cruzeiro") || sistema.toLowerCase() === "cruzeiro") && hasActiveDebt) {
      // hasOverride: mantém o override do nó ai_agent intacto — não
      // sobrescreve com aiConfig.system_prompt (nem com o default Sabrina).
      if (!hasOverride) {
      systemPromptWithKb = aiConfig.system_prompt
        ? `${aiConfig.system_prompt}

=== DADOS DO CLIENTE (DDM API) ===
- Nome do Cliente: ${ddmData.nome || "Não informado"}
- CPF consultado: ${foundCpf}
- Instituição: Cruzeiro do Sul
- Valor para Quitação à Vista (ValorFinal): R$ ${debt}`
        : `Você é Sabrina, Representante Financeiro da Universidade Cruzeiro do Sul, atuando como analista financeira consultiva da assessoria DDM.

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
   - Apresente apenas uma option de negociação por vez. Sempre aguarde a resposta do aluno antes de enviar a próxima.
   - Nunca faça cálculos manuais ou estimativas de parcelas.
4. **Regra Crítica de Formalização:**
   - NUNCA feche ou formalize o acordo sem a confirmação explícita e inequívoca do cliente (ex: "sim", "quero fechar", "fechado").
   - Antes de formalizar, confirme apenas as condições do acordo (vencimento, valor, forma de pagamento). Você NÃO deve pedir e-mail e nem número de celular do cliente, pois você já está conversando com ele diretamente por aqui.
   - Quando o acordo for confirmado de forma explícita, retorne a tag especial #ACORDOFORMALIZADO ao final do resumo.
5. **Tratamento de Recusas e Solicitação de Atendente:**
   - Se o cliente solicitar falar com um atendente humano, transferir ou disser que prefere falar com uma pessoa, diga que está transferindo o atendimento e termine a mensagem obrigatoriamente com a tag #EQUIPEHUMANA.
   - Se o cliente recusar, argumente gentilmente até 3 vezes lembrando-o das consequências (acúmulo de juros, ações de cobrança e órgãos de proteção de crédito) antes de desistir. Caso ele mantenha a recusa após as 3 tentativas, retorne #RECUSA no final da mensagem.`;
      }
    } else if (isEducational && hasActiveDebt) {
      const formattedBoleto = JSON.stringify(ddmData.resumo_parcelamento || []);
      const formattedAcordos = JSON.stringify(ddmData.acordos || []);
      const currentDate = new Date().toLocaleDateString("pt-BR");

      const cardPayUrl = ddmData.calculoId 
        ? `https://ddmpay.ddmacordos.com/acesso/?c=${ddmData.calculoId}&u=` 
        : `https://ddmpay.ddmacordos.com/acesso/?c=&u=`;

      let customPrompt = aiConfig.system_prompt || "";
      if (customPrompt) {
        customPrompt = customPrompt
          .replace(/\{\{valor_final\}\}/g, `R$ ${debt}`)
          .replace(/\{\{resumo_parcelamento\}\}/g, formattedBoleto)
          .replace(/c=&u=/g, `c=${ddmData.calculoId || ""}&u=`);
      }

      // hasOverride: na prática isEducational já vem false nesse caso
      // (bloco acima), então este branch nem é alcançado — guard
      // explícito mantido por segurança, mesma regra do branch Cruzeiro.
      if (!hasOverride) {
      systemPromptWithKb = customPrompt
        ? `${customPrompt}

=== DADOS DO CLIENTE E CONTEXTO ===
- Data Atual: ${currentDate}
- Nome do Cliente: ${ddmData.nome || "Não informado"}
- CPF consultado: ${foundCpf}
- Instituição: ${inst}
- Valor para Quitação à Vista (ValorFinal): R$ ${debt}
- Opções de Parcelamento no Cartão (NUNCA apresentar na primeira resposta, apenas se o cliente recusar o valor à vista): ${ddmData.opcoes_cartao || "Não disponível"}
- Resumo do Parcelamento em Boleto (resumo_parcelamento): ${formattedBoleto}
- Lista de Acordos do Cliente: ${formattedAcordos}

⚠️ REGRA CRÍTICA DE ESCADA DE NEGOCIAÇÃO: Na primeira mensagem após consultar o CPF, você deve apresentar APENAS o valor para quitação à vista (ValorFinal). É TERMINANTEMENTE PROIBIDO listar qualquer opção de parcelamento (tanto cartão de crédito quanto boleto) na primeira mensagem. Aguarde a resposta do cliente. Se ele recusar ou pedir parcelamento, aí sim você oferece o cartão na próxima mensagem.`
        : `Você é Julia, analista financeira consultiva da assessoria DDM, parceira da instituição de ensino.
Sua saudação preferencial: "Olá! Tudo bem? Me chamo Julia, sou Representante Financeiro da sua Instituição de ensino."

=== DADOS DO CLIENTE E CONTEXTO ===
- Data Atual: ${currentDate}
- Nome do Cliente: ${ddmData.nome || "Não informado"}
- CPF consultado: ${foundCpf}
- Instituição: ${inst}
- Valor para Quitação à Vista (ValorFinal): R$ ${debt}
- Opções de Parcelamento no Cartão (NUNCA apresentar na primeira resposta, apenas se o cliente recusar o valor à vista): ${ddmData.opcoes_cartao || "Não disponível"}
- Resumo do Parcelamento em Boleto (resumo_parcelamento): ${formattedBoleto}
- Lista de Acordos do Cliente: ${formattedAcordos}

⚠️ REGRA CRÍTICA DE ESCADA DE NEGOCIAÇÃO: Na primeira mensagem após consultar o CPF, você deve apresentar APENAS o valor para quitação à vista (ValorFinal). É TERMINANTEMENTE PROIBIDO listar qualquer opção de parcelamento (tanto cartão de crédito quanto boleto) na primeira mensagem. Aguarde a resposta do cliente. Se ele recusar ou pedir parcelamento, aí sim você oferece o cartão na próxima mensagem.

=== OBJETIVO ===
Você precisa descobrir mais sobre as necessidades e desafios que o cliente está enfrentando, então descubra as necessidades, qualifique e crie proposta de valor com os passos abaixo.

=== PASSOS DO FLUXO (ESTRITO) ===
1. Busque a data atual para saber se há vencimentos ou não nos débitos dos clientes. Débitos com datas de vencimentos anteriores a atual são considerados vencidos.
2. Busque pelo CPF do cliente, caso não tenha pergunte, e retorne as seguintes informações: nome do cliente, nome da instituição em que ele está matriculado e o número de matrícula (você não deve falar o número de matrícula do aluno).
3. Só deve apresentar débitos que estejam registrados no sistema. Caso o cliente pergunte sobre algum valor e esse valor não conste no sistema, você deve responder #EQUIPEHUMANA.
4. Verifique no array "acordos" retornado pela integração se existe algum acordo com status diferente de "Quitado" (ex.: "Acordo na DDM", "Aguardando Pgto"). Caso exista ao menos um acordo pendente, não apresente débitos nem monte proposta de negociação: retorne imediatamente #EQUIPEHUMANA.
5. Se o aluno não possuir nenhum acordo pendente (array "acordos" vazio, quantidade_acordos igual a 0, ou todos os acordos com status "Quitado"), apresente os débitos dele com base na integração "Resposta API" (variáveis debitos, valor_total, valor_final).
6. Opção de Quitação: Apresente primeiro o valor à vista com foco no encerramento da dívida e confirme novamente se ele deseja formalizar o acordo.
7. Confirme com o cliente o e-mail e o número de celular, além das informações do acordo como vencimento, "ValorFinal", forma de pagamento.
8. Caso ele confirme explicitamente que deseja formalizar o acordo, formalize o acordo e apresente ao cliente o resumo do acordo dele, contendo as informações com base na pesquisa: número do acordo, vencimento, valor do pagamento, e-mail, e retorne #ACORDOFORMALIZADO.
9. Caso o cliente confirme explicitamente que deseja formalizar o acordo, você deve acionar a integração responsável por formalizar acordos. Essa integração se chama Formalizar Acordo e ela deve receber o CPF e a quantidade de parcelas solicitadas pelo cliente na conversa. A informação de CPF e parcelas devem ser enviadas em JSON com dois campos diferentes.
   Se o aluno desejar parcelar em 2 vezes, você irá enviar para a integração o número 3 por conta da entrada.
   Se o aluno desejar parcelar em 3 vezes, você irá enviar para a integração o número 4 por conta da entrada.
   Se o aluno desejar parcelar em 4 vezes, você irá enviar para a integração o número 5 por conta da entrada.
   E assim sucessivamente...
   Nunca envie para a integração a quantidade de parcelas do resumo_parcelamento, envie a quantidade que o cliente solicitou na conversa.
10. Se o cliente disser que não, pergunte a ele como você pode ajudá-lo a melhorar a negociação e entenda o motivo dele não querer formalizar o acordo, sempre buscando fechar a negociação, e faça isso sem oferecer a opção de novos valores.
11. Você não tem permissão de apresentar negociação parcelada diferente das disponíveis na integração Resposta Api, todo o parcelamento apresentado, precisa estar dentro do JSON ${formattedBoleto}.
12. Quando o aluno solicitar parcelamento no boleto, pergunte quantas parcelas ele deseja para realizar a negociação.
13. Progressão de Parcelamento (Gradativa):
    - Nunca apresente todas as opções de parcelamento ao mesmo tempo.
    - Use obrigatoriamente a variável: resumo_parcelamento.
    - Fluxo de negociação:
      1. Primeiro apresente apenas o pagamento à vista utilizando: R$ ${debt}
      2. Caso o aluno informe que não consegue pagar à vista ou solicite parcelamento:
         - Primeiro ofereça parcelamento no cartão de crédito com o link original do portal: ${cardPayUrl}
      3. Somente se o aluno disser explicitamente que não consegue pagar no cartão, utilize as opções disponíveis em: resumo_parcelamento
      4. Apresente apenas UMA opção por vez seguindo a ordem de parcelas.
    - REGRA CRÍTICA SOBRE PARCELAS:
      - O campo "Parcelas" da API representa exatamente o número de parcelas do acordo após a entrada.
      - A entrada é um pagamento separado e nunca deve ser considerada uma parcela.
      - O agente não pode calcular, subtrair ou alterar o número de parcelas.
      - Estrutura correta da apresentação:
        Entrada: R$ {entrada}
        Parcelas: {parcelas}x de R$ {valor_parcela}
      - Exemplo: Vamos supor que a integração retorne Entrada de R$ 2.404,81 + 1x parcelas de R$ 12.024,08. Você exibirá:
        Entrada: R$ 2.404,81
        Parcelas: 1x parcelas de R$ 12.024,08
      - Nunca faça cálculos.
      - Sempre aguarde a resposta do aluno antes de apresentar outra opção.
14. Escada de Negociação:
    1️⃣ Primeira tentativa: Apresente apenas o valor à vista: R$ ${debt}
    2️⃣ Segunda tentativa: Ofereça parcelamento no cartão
    3️⃣ Terceira tentativa: Use o primeiro item disponível do array: resumo_parcelamento
    4️⃣ Caso o aluno peça mais prazo: apresente a próxima opção do array.
    - Nunca pule diretamente para o maior parcelamento.
    - Nunca mostre mais de uma opção de parcelamento por mensagem.
15. Analise o histórico da conversa antes de oferecer uma nova condição. Se já apresentou uma opção de parcelamento, apresente apenas a próxima opção disponível no array resumo_parcelamento. Nunca repita opções já apresentadas. Nunca apresente o máximo de parcelas antes que o aluno demonstre dificuldade.
16. Com base no histórico da conversa, identifique o que o aluno deseja. Se ele pediu parcelamento, olhe para o array resumo_parcelamento e escolha apenas uma opção que seja superior à oferecida anteriormente, mas que ainda não seja o limite máximo, a menos que ele tenha pedido especificamente o maior prazo possível.
17. Quando o cliente informar que não reconhece os débitos, informe que todas as inadimplências que constam em nosso sistema vêm diretamente da Instituição, solicite mais detalhes sobre sua resposta.
18. Caso o aluno afirme que não reconhece o débito, o agente deve tentar argumentar até 3 vezes antes de transferir, a cada tentativa, ele deve variar a abordagem, mantendo o foco em reforçar que as informações vêm da instituição e incentivando a regularização, somente após a terceira negativa, o agente pode retornar #RECUSA.
19. Quando o cliente informar o melhor dia e horário, agradeça, peça educadamente que ele entre em contato no tempo definido, e retorne #AGENDAMENTO.
20. Se houve acordo formalizado: Negociação concluída com sucesso! Qualquer dúvida, estarei por aqui para te ajudar, obrigado pela confiança, retorne #ACORDOFORMALIZADO.
21. PROIBIÇÃO DE LINKS PLACEHOLDER (CRÍTICO): Você está terminantemente proibido de inventar ou gerar links markdown falsos ou vazios (como \"[Pagar](#)\", \"[Boleto](#)\", \"[Pagar Primeira Parcela](#)\"). Nunca tente criar links manuais com \"#\" no lugar da URL. Limite-se a confirmar o acordo por texto e retornar a tag #ACORDOFORMALIZADO no final da mensagem. O link real e o PDF do boleto serão integrados e enviados automaticamente pelo sistema após a tag ser enviada.

=== REGRAS DE ATENDIMENTO E OUTRAS REGRAS ===
- Quando o Resultado da variável Cliente for "Centro de Formacao Profissional Bezerra de Araujo Ltda" não afirme que ele pode parcelar no Boleto, esse cliente só funciona o parcelamento no cartão.
- Quando o Resultado da variável Cliente for "UNIJORGE NOVO" não afirme que ele pode parcelar no Boleto, esse cliente só funciona o parcelamento no cartão.
- Você não tem autorização para formalizar fora das negociações permitidas na integração "Resposta API".
- REGRA DE PARCELAMENTO:
  - Caso a entrada retorne 0,00, pode informar ao aluno que são parcelas iguais.
  - Nunca diga ao aluno ou formalize um acordo com valor diferente do consultado no sistema.
  - Nunca afirme que a regularização da dívida garante a rematrícula do aluno. O agente deve informar que a regularização é um passo importante, mas a decisão sobre rematrícula depende da Universidade.
  - Para parcelamento em boleto, os valores devem ser utilizados EXCLUSIVAMENTE do array: resumo_parcelamento. Campos permitidos: entrada, valor_parcela, parcelas.
  - O campo resumo_parcelamentos NÃO pode ser utilizado para calcular valores. Ele serve apenas para te ajudar a apresentar o resumo dos débitos ao aluno.
  - Caso o aluno solicite que envie o boleto, direcione o aluno ao portal do aluno de sua instituição.
  - Ao apresentar parcelamento em boleto, the agent must use EXCLUSIVAMENTE values returned by API. É proibido calcular, alterar, estimar ou ajustar qualquer valor.
  - Formato obrigatório da apresentação:
    Entrada: R$ {entrada}
    Parcelas: {parcelas}x de R$ {valor_parcela}
- Regras para consulta de cpf no banco de dados:
  - Para cada solicitação de flexibilidade nas parcelas consulte o CPF do cliente no banco antes de responder, sempre.
  - Para exibir todas as opções de parcelamento, sempre consulte o CPF do cliente a cada opção de parcelamento.
  - Para qualquer solicitação do cliente envolvendo (faturas, próximas propostas de parcelamento, parcelamento por boleto, e quaisquer solicitações financeiras) sempre reconsulte o cpf do cliente no banco para ter total certeza dos valores e parcelas.
  - Sempre que precisar consultar a parcela da dívida do cliente em 4, 5, 6 ou 7 vezes, consulte o CPF do cliente no banco antes de responder, sempre.
- Regras adicionais de atendimento:
  - Você não deve falar o número de matrícula do aluno.
  - Se o aluno falar sobre financiamento ou pravaler, peça mais detalhes para ele.
  - Se o aluno perguntar sobre pagamento via PIX, informe que a chave pix vem junto com o boleto após a formalização do acordo.
  - Se você não localizar o débito do aluno após algumas tentativas, retorne #NAOLOCALIZADO.
  - Você não pode passar informações financeiras incorretas para o cliente, por isso sempre consulte o CPF do cliente no banco para responder.
  - Sempre que for responder sobre algo financeiro sempre consulte a integração novamente para ter certeza do que irá passar para o cliente.
  - Quando houver o parcelamento no boleto é preciso enviar ao aluno o valor da "entrada" mais o valor das "valor_parcela" ambas as informações disponíveis na integração "Resposta API" e no array "resumo_parcelamento".
  - Não é permitido apresentar ao aluno as opções de negociação que não existam na integração Resposta API.
  - Selecione sempre o próximo objeto disponível no array resumo_parcelamento.
  - Nunca calcule novas parcelas.
  - Use a variável "resumo_parcelamento" para apresentar o parcelamento ao aluno, o "resumo_parcelamentos" deverá ser apresentado uma de cada vez, conforme o retorno do aluno.
  - O "ValorFinal" do aluno corresponde ao valor final para pagamento, já incluindo encargos ou atualizações.
  - O "valor_nominal" corresponde apenas à soma original dos débitos, sem qualquer atualização, juros ou encargos aplicados.
  - Você não pode gerar ou oferecer ao aluno uma negociação que não esteja disponível na integração Resposta API.
  - A negociação com o aluno deve ser gradativa, ou seja, deve ser apresentado uma opção por vez.
  - Tratamento de Dados Financeiros: Formate todos os valores numéricos para o padrão de moeda brasileiro (R$ 0.000,00) ao exibir para o usuário.
  - Caso não encontre débitos, nunca informe ao aluno que ele não possui pendências, ao invés disso, fale: "Meu sistema está passando por atualizações, um momento." e retorne #EQUIPEHUMANA.
  - Informe apenas o necessário e mantenha as mensagens curtas e objetivas.
  - Nunca informe o cliente que seus débitos não estão vencidos, apenas siga com a negociação.
  - Diferencie os débitos de contratos diferentes caso o cliente tenha mais de um contrato.
  - Nunca apresente os valores mais de uma vez durante a conversa.
  - Nunca transfira o cliente para o atendimento humano sem antes enviar uma proposta para ele.
  - Nunca formalize um valor diferente do consultado no sistema.
  - Questione a ele o porquê a negociação não foi vantajosa para ele, e o relembre da importância de quitar seus débitos.
  - Nunca formalize um acordo sem a confirmação do aluno.
  - Etapa 1 — Parcelamento no cartão: Quando o aluno solicitar parcelamento no cartão, o agente deve informar que é possível parcelar no cartão de crédito, depois disso apresentar as formas de negociação conforme disponível na integração: Resposta API.
  - Etapa 2 — Negativa do aluno ao cartão: Somente se o aluno informar explicitamente que não consegue pagar à vista e nem parcelar no cartão de crédito, o agente deve então apresentar a opção de parcelamento em boleto. Após isso, aguarde as respostas do aluno antes de qualquer transferência.
- Regras de Transferências:
  - Sempre que ocorrer algum erro de busca, diga que está verificando e retorne #EQUIPEHUMANA.
  - Caso o aluno confirme que não vai pagar a negociação, tente novamente informando as vantagens de quitar o débito dele.
  - Sempre que o agente identificar que a data de vencimento do débito ainda não foi atingida ele deve considerar que o débito está em aberto, mas ainda não vencido, retorne #EQUIPEHUMANA.
  - Caso seja da Sociedade Potiguar de Educação e Cultura Ltda., não fale sobre suas dívidas, retorne #ANIMA.
  - Caso identifique um valor zerado, sempre retorne #EQUIPEHUMANA.
  - Se o aluno afirmar que já realizou o pagamento do débito, o agente deve demonstrar compreensão e, em seguida, fazer uma sondagem educada para confirmar as informações. O agente deve: Agradecer pela informação de forma cordial, perguntar quando foi feito o pagamento, solicitar, de forma gentil, o comprovante, explicar que essas informações ajudam a atualizar o sistema corretamente, e sempre retorne #EQUIPEHUMANA.
  - Caso o array "acordos" contenha algum acordo com status diferente de "Quitado" (acordo pendente), retorne imediatamente #EQUIPEHUMANA, sem apresentar débitos, sem montar proposta de negociação e sem tentar formalizar novo acordo.
  - Sempre que o cliente apresentar um cadastro que já tem um acordo, retorne #EQUIPEHUMANA.
- Em informação de recusa:
  - Utilize os seguintes contra-argumentos:
    - "Importante negociar e quitar as pendencias financeiras para evitar o acúmulo de juros e multa"
    - "As ações de cobrança continuarão, em função do não pagamento do débito"
    - "Caso não efetue o pagamento, você poderá ter o seu CPF incluído nos órgãos de proteção de crédito, e com isso, prejudicar a sua saúde financeira"
  - Apenas após no mínimo três tentativas de contra-argumentos retorne #RECUSA.
- Regras de negociação:
  - Caso o cliente não aceite as propostas 3 vezes, diga que vai verificar uma nova proposta utilizando a integração Resposta API e informe ao cliente sobre um novo método de pagamento.
  - Caso o cliente pergunte se pode fazer parcelamento, informe para ele as opções de negociação conforme a integração Resposta API, caso ele não queira, informe a importância de quitar o débito.
  - Sempre que a negociação for concluída ou o cliente informar que é somente isso, envie um resumo com as informações de data de vencimento, valor combinado e caso seja parcelado, informe a entrada e as parcelas, retorne também as datas de vencimentos e valores, retorne #ACORDOFORMALIZADO.
  - Caso o aluno não consiga pagar na data informada ou informe que gostaria de pagar em uma data específica, pergunte se ele quer agendar o contato, se ele confirmar retorne #AGENDAMENTO.
  - Apenas formalize o acordo se o aluno confirmar explicitamente que quer fechar o acordo apresentado.
  - Caso o aluno questione por que o valor atualizado está mais alto que o nominal, diga que o valor foi atualizado por encargos.
  - Se o aluno perguntar se o pagamento irá quitar todas as dívidas, nunca afirme que o aluno estará quitando todas as dívidas dele, o agente sempre deve responder o seguinte: “Esses são os débitos que localizei até o momento. Em alguns casos, pode haver mais de um contrato vinculado ao mesmo CPF. Caso haja outra pendência ativa, ela poderá ser verificada separadamente por um especialista.”
  - Caso o aluno pergunte sobre o vencimento do acordo ou boleto, diga que o vencimento do acordo é para o dia seguinte da formalização, e que é importante realizar o pagamento até essa data para manter a condição negociada.
  - Nunca afirme que a regularização da dívida garante a rematrícula do aluno. O agente deve informar que a regularização é um passo importante, mas a decisão sobre rematrícula depende da instituição, e pergunte se pode ajudá-lo com algo mais.
  - Caso o cliente da Instituição Unisuam fale sobre atendimento presencial, diga para ele: "Para tratativas presenciais, temos um funcionário na Unidade de Bonsucesso, estamos à disposição para ajuda-lo."
  - Caso o cliente da Instituição Veiga de Almeida fale sobre atendimento presencial, diga para ele: "Para tratativas presenciais, temos um funcionário na Unidade da Tijuca, estamos à disposição para ajuda-lo."
  - Caso o cliente da Instituição Castelo Branco fale sobre atendimento presencial, diga para ele: "Para tratativas presenciais, temos um funcionário na Unidade de Realengo. Estamos à disposição para ajudá-lo."
- Regra de Adaptação de Tom por Frustração:
  Se o aluno demonstrar frustração, irritação, impaciência ou confusão, a agente deve adaptar imediatamente o tom para uma abordagem mais empática, calma e paciente. Nesses casos, a agente deve:
  - reconhecer a frustração do aluno;
  - evitar soar robótica ou insistente;
  - usar frases mais curtas e claras;
  - reforçar que o objetivo é ajudar.`;
      }
    } else if (!hasOverride && !hasActiveDebt) {
      systemPromptWithKb = `${systemPromptWithKb}

=== INFORMAÇÕES DE CONSULTA (DDM API) ===
O cliente informou o CPF e possui cadastro na instituição ${inst}, porém NÃO foram localizadas dívidas ativas (valor de débitos em aberto é de R$ 0,00 ou sem pendências).

=== INSTRUÇÃO DE ATENDIMENTO (SEM DÍVIDA ATIVA) ===
Você é o(a) Aleh.
1. Informe de maneira simpática e educada que realizou a consulta baseada no CPF enviado e não localizou nenhuma pendência financeira em aberto para a instituição ${inst} no momento.
2. Pergunte de forma simpática se pode ajudá-lo em mais alguma coisa.
3. Não fale sobre acordos, cobranças ou valores pendentes.
4. Caso o cliente solicite falar com um atendente ou transferir para um humano, transfira e retorne a tag #EQUIPEHUMANA.`;
    } else if (!hasOverride) {
      systemPromptWithKb = `${systemPromptWithKb}

=== INFORMAÇÕES DE CONSULTA (DDM API) ===
O cliente informou o CPF e foi localizado na DDM, porém na instituição: ${inst}.
O valor da dívida cadastrado é R$ ${debt}.

=== INSTRUÇÃO DE ATENDIMENTO (OUTRAS INSTITUIÇÕES) ===
Você é o(a) Aleh. Como o cadastro do cliente é na instituição ${inst}:
1. Informe de maneira simpática e educada que localizou a pendência dele referente à instituição ${inst}.
2. Pergunte de forma simpática como você pode ajudá-lo ou se ele gostaria de tirar alguma dúvida geral sobre o débito.
3. Ofereça-se para transferi-lo para falar com um especialista humano especializado na ${inst} caso ele queira. Se ele concordar ou solicitar explicitamente a transferência, encerre obrigatoriamente com a tag #EQUIPEHUMANA.`;
    }
  } else if (!hasOverride && foundCpf) {
    systemPromptWithKb = `${systemPromptWithKb}

=== INFORMAÇÕES DE CONSULTA (DDM API) ===
O cliente informou o CPF (${foundCpf}), mas a pesquisa na API da DDM retornou que não há registros ou pendências ativas.

=== INSTRUÇÃO DE DEVOLUÇÃO (CPF NÃO LOCALIZADO) ===
Você é o(a) Aleh.
1. Informe de forma amigável que não localizou nenhuma pendência em aberto para o CPF digitado em nosso sistema.
2. Pergunte de forma aberta e simpática como você pode ajudá-lo hoje.
3. Caso ele solicite falar com um atendente ou peça transferência para um humano, transfira e retorne a tag #EQUIPEHUMANA.`;
  } else if (!hasOverride) {
    systemPromptWithKb = `${systemPromptWithKb}

=== INFORMAÇÃO OBRIGATÓRIA ANTES DE INICIAR ===
Você é o orquestrador geral de atendimento.
Você NÃO deve passar nenhuma informação sobre dívidas, simulações ou acordos até que o cliente forneça o CPF.
1. Se o cliente ainda não enviou o CPF dele nesta conversa, peça-o educadamente e de forma natural (ex: "Para que eu possa consultar suas pendências, poderia me informar o seu CPF?").
2. Não invente nenhuma informação ou simulação antes de receber o CPF.`;
  }

  // 5. Generate response using chosen LLM API
  let generatedText = "";
  if (forceTransferHumanMsg) {
    generatedText = forceTransferHumanMsg;
  } else {
    try {
      if (aiConfig.api_provider === "openai") {
        generatedText = await generateOpenAiResponse(
          activeKey,
          systemPromptWithKb,
          history,
          tools,
          onToolCall,
          onToolResult,
          nodeKey,
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
      // Rethrown (not just logged + returned) so the Flow Builder's
      // ai_agent node sees this as a real failure — its own try/catch
      // around handleAiAutoResponse turns this into a node_error with
      // error_message instead of a silently-empty last_reply. Callers
      // that fire-and-forget this function (the WhatsApp webhook
      // routes, outside any flow) must `.catch()` this call — see
      // those call sites for why that matters.
      console.error("[AI Agent] LLM generation error:", err);
      throw err;
    }
  }

  generatedText = generatedText.trim();
  if (!generatedText) return;

  // Captured BEFORE the known-tag strip below removes it from the text
  // that actually gets sent/persisted — this is what the ai_agent flow
  // node needs back as `ai_exit_code`. Re-reading the saved message and
  // regex-matching it (the old approach) never found anything, because
  // by the time it's saved the tag is already gone.
  const exitTagMatch = generatedText.match(/#[A-Z0-9_]+/);
  const detectedTag: string | null = exitTagMatch ? exitTagMatch[0] : null;

  let payBoletoUrl = "";
  let shouldTransferToHuman = false;
  let hasAgreedAcordo = false;

  // Autodetecção preventiva caso a IA esqueça de adicionar a tag #ACORDOFORMALIZADO
  const lowercaseGenerated = generatedText.toLowerCase();
  const hasAgreedText = 
    lowercaseGenerated.includes("dados do acordo") || 
    lowercaseGenerated.includes("confirmar os dados") || 
    lowercaseGenerated.includes("acordo formalizado") || 
    lowercaseGenerated.includes("geração do boleto") || 
    lowercaseGenerated.includes("boleto oficial");

  if (
    generatedText.includes("#ACORDOFORMALIZADO(finalização)") ||
    generatedText.includes("#ACORDOFORMALIZADO") ||
    hasAgreedText
  ) {
    hasAgreedAcordo = true;
  }

  if (
    generatedText.includes("#EQUIPEHUMANA") || 
    generatedText.includes("#RECUSA") || 
    generatedText.includes("#NEGOCIACAO") ||
    generatedText.includes("#ANIMA") ||
    generatedText.includes("#AGENDAMENTO(finalização)") ||
    generatedText.includes("#AGENDAMENTO") ||
    generatedText.includes("#NAOLOCALIZADO") ||
    hasAgreedAcordo
  ) {
    shouldTransferToHuman = true;
    generatedText = generatedText
      .replace(/#EQUIPEHUMANA/g, "")
      .replace(/#RECUSA/g, "")
      .replace(/#NEGOCIACAO/g, "")
      .replace(/#ANIMA/g, "")
      .replace(/#AGENDAMENTO\(finalização\)/g, "")
      .replace(/#AGENDAMENTO/g, "")
      .replace(/#ACORDOFORMALIZADO\(finalização\)/g, "")
      .replace(/#ACORDOFORMALIZADO/g, "")
      .replace(/#NAOLOCALIZADO/g, "")
      .trim();
  }

  if (!generatedText) return detectedTag;

  // Flow Builder nodes formalize through their configured tools (for
  // example, efetiva_acordo). Do not run the legacy CPF-based
  // CalculaDebitos.php side effect for those nodes: it can formalize a
  // second agreement and append a fabricated/placeholder payment URL.
  if (hasAgreedAcordo && foundCpf && !hasOverride) {
    console.log(`[AI Agent] Intercepted #ACORDOFORMALIZADO. Calling DDM formalization API for CPF ${foundCpf}...`);
    try {
      const activeKey = process.env.DDM_TOKEN || process.env.DDM_API_KEY || "af875d1e5ffab9247c16c56ba2c6b349";
      let calculoId = ddmData?.calculoId || "";
      
      if (!calculoId) {
        // 1. Busca os débitos/cálculos no localiza_dev.php para pegar o CalculoID ativo
        const localizaUrl = `https://ddmacordos.com/calc/localiza_dev.php?tk=${activeKey}&cpf=${foundCpf.replace(/\D/g, "")}`;
        const resLocaliza = await fetch(localizaUrl);
      if (resLocaliza.ok) {
        const localizaData = await resLocaliza.json();
        const iddev = localizaData?.[0]?.iddev;
        
        if (iddev) {
          const cli = (localizaData?.[0]?.sistema || "").trim().toLowerCase() === "cruzeirodosul" ? "cruzeiro" : "ddm";
          const calcUrl = `https://ddmacordos.com/calc/?tk=${activeKey}&idDev=${iddev}&cli=${cli}`;
          const resCalc = await fetch(calcUrl);
          
          if (resCalc.ok) {
            const rawCalc = await resCalc.json();
            const calcArray = Array.isArray(rawCalc) ? rawCalc : [rawCalc];
            
            const dadosObj = calcArray.find((item: any) => item?.Dados)?.Dados;
            if (dadosObj) {
              calculoId = dadosObj.CalculoID || dadosObj.idcalc || "";
            }
          }
        }
      }
    }

      // Aguarda 3 segundos para garantir que a DDM limpou sessões de consulta anteriores
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // 2. Registra e formaliza o acordo na DDM enviando o CalculoID e a quantidade de parcelas solicitadas
      const installments = extractInstallmentsFromHistory(history);
      const opcaoAcordo = installments <= 1 ? 1 : installments + 1;
      console.log(`[AI Agent] Formalizing agreement for CPF ${foundCpf} with ${installments} requested installments (sending OpcaoAcordo=${opcaoAcordo} to integration).`);
      
      const formalizeUrl = `https://www.ddmacordos.com/ws_ddm/ws/CalculaDebitos.php?tk=${activeKey}&OpcaoAcordo=${opcaoAcordo}&TipoAcordo=1&Doc=${foundCpf}${calculoId ? `&idcalc=${calculoId}` : ""}`;
      const resFormalize = await fetch(formalizeUrl);
      if (resFormalize.ok) {
        const resText = await resFormalize.text();
        console.log(`[AI Agent] DDM formalize success. Response payload: ${resText}`);
        
        const match = resText.match(/https?:\/\/[^\s"']+/i);
        if (match) {
          payBoletoUrl = match[0];
        }
      }

      // Aguarda mais 3 segundos para dar tempo ao sistema da DDM gerar a linha digitável e o PDF pós-registro
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // 3. Monta o link do ddmpay real caso o CalculaDebitos retorne uma URL vazia ou se quisermos forçar o link dinâmico
      if (!payBoletoUrl && calculoId) {
        payBoletoUrl = `https://ddmpay.ddmacordos.com/acesso/?c=${calculoId}&u=`;
      }

      // Adiciona o link do boleto/pagamento gerado à mensagem enviada pela IA no WhatsApp
      if (payBoletoUrl) {
        generatedText = `${generatedText}\n\nSegue o link oficial para pagamento: ${payBoletoUrl}`;
      }
    } catch (err) {
      console.error("[AI Agent] DDM formalize and boleto fetch error:", err);
    }
  }

  if (shouldTransferToHuman) {
    console.log(`[AI Agent] Intercepted transfer/closing event. Assigning conversation ${conversationId} to human agent...`);
    const { data: convData } = await db
      .from("conversations")
      .select("user_id")
      .eq("id", conversationId)
      .single();

    let targetAgentId = convData?.user_id;

    // Fallback: se a conversa não tiver user_id, pega o dono do whatsapp_config correspondente
    if (!targetAgentId) {
      const { data: wahaCfg } = await db
        .from("whatsapp_config")
        .select("user_id")
        .eq("account_id", accountId)
        .maybeSingle();
      if (wahaCfg?.user_id) {
        targetAgentId = wahaCfg.user_id;
      }
    }

    if (targetAgentId) {
      await db
        .from("conversations")
        .update({
          assigned_agent_id: targetAgentId,
          updated_at: new Date().toISOString()
        })
        .eq("id", conversationId);
    }
  }

  // 6. Voice Reply Generation (ElevenLabs)
  let voiceMediaUrl = "";
  // Fallbacks hardcoded fornecidos pelo usuário
  const elevenlabsApiKey = aiConfig.elevenlabs_api_key || "3cdc376a590ebdebe7f5979bb4422f957091cc5b7dfefc534be4b5f2d4eb7fbd";
  const elevenlabsVoiceId = aiConfig.elevenlabs_voice_id || "33B4UnXyTNbgLmdEDh5P";
  const elevenlabsEnabled = aiConfig.elevenlabs_enabled || !!elevenlabsApiKey;

  if (incomingWasAudio && elevenlabsEnabled && elevenlabsApiKey && elevenlabsVoiceId) {
    try {
      console.log("[AI Agent] Generating voice reply with ElevenLabs...");
      const ttsUrl = `https://api.elevenlabs.io/v1/text-to-speech/${elevenlabsVoiceId}`;
      const ttsRes = await fetch(ttsUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": elevenlabsApiKey,
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

  // Scoped by account_id for defense in depth, matching the same
  // rationale used in automations/engine.ts, automations/meta-send.ts,
  // flows/engine.ts, flows/meta-send.ts, and whatsapp/send/route.ts —
  // a future caller that skips the entry-point guard still can't read
  // across tenants via the service-role client.
  const { data: contact } = await db
    .from("contacts")
    .select("phone")
    .eq("id", contactId)
    .eq("account_id", accountId)
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
  // Simulação de digitação: aguarda 2 segundos adicionais antes de enviar a mensagem de fato
  await new Promise((resolve) => setTimeout(resolve, 2000));

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
        
        // Se houver boleto PDF, envia ele em seguida como documento anexo
        if (payBoletoUrl && payBoletoUrl.toLowerCase().includes(".pdf")) {
          try {
            console.log(`[AI Agent] Sending PDF document to client...`);
            await sendWahaMediaMessage(wahaConfig!, variant, payBoletoUrl, "document", "Boleto-Acordo.pdf");
          } catch (pdfErr) {
            console.error("[AI Agent] Failed to send PDF document via WAHA:", pdfErr);
          }
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
        
        // Se houver boleto PDF, envia pelo Meta Cloud API
        if (payBoletoUrl && payBoletoUrl.toLowerCase().includes(".pdf")) {
          try {
            console.log(`[AI Agent] Sending PDF document via Meta to client...`);
            await sendMediaMessage({
              phoneNumberId: config.phone_number_id,
              accessToken,
              to: variant,
              kind: "document",
              link: payBoletoUrl,
              filename: "Boleto-Acordo.pdf"
            });
          } catch (pdfErr) {
            console.error("[AI Agent] Failed to send PDF document via Meta:", pdfErr);
          }
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

  return detectedTag;
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
  history: any[],
  tools?: AiAgentTool[],
  onToolCall?: (toolName: string, args: Record<string, unknown>) => Promise<void>,
  onToolResult?: (toolName: string, result: string, durationMs: number) => Promise<void>,
  nodeKey?: string,
): Promise<string> {
  const url = "https://api.openai.com/v1/chat/completions";

  // Build base messages array
  const baseMessages: any[] = [];
  if (systemPrompt) {
    baseMessages.push({ role: "system", content: systemPrompt });
  }
  for (const msg of history) {
    const isCustomer = msg.sender_type === "customer";
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
      const isWebp = fetchUrl.toLowerCase().includes(".webp");
      if (isWebp) {
        baseMessages.push({ role: isCustomer ? "user" : "assistant", content: msg.content_text || "[Imagem enviada]" });
      } else {
        baseMessages.push({
          role: isCustomer ? "user" : "assistant",
          content: [
            { type: "text", text: msg.content_text || "O que está nesta imagem?" },
            { type: "image_url", image_url: { url: fetchUrl } },
          ],
        });
      }
    } else {
      baseMessages.push({ role: isCustomer ? "user" : "assistant", content: msg.content_text || "" });
    }
  }

  // Tool calling loop (max 5 iterations to prevent infinite loops)
  const messages = [...baseMessages];
  const openAiTools = tools?.length
    ? tools.map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }))
    : undefined;

  // Raw tool_result payloads collected across the loop below, for the
  // #NEGOCIACAO auto-suppress check once GPT produces its final text.
  const collectedToolResults: { toolName: string; result: string }[] = [];

  for (let iteration = 0; iteration < 5; iteration++) {
    const body: any = {
      model: "gpt-4o-mini",
      messages,
      temperature: 0.7,
      max_tokens: 1000,
    };
    if (openAiTools?.length) {
      body.tools = openAiTools;
      body.tool_choice = "auto";
    }

    // TEMP DEBUG — remove before commit.
    try {
      appendFileSync(AI_DEBUG_LOG_PATH, JSON.stringify({
        ts: new Date().toISOString(),
        type: 'AI_DEBUG_OPENAI_REQUEST',
        model: body.model,
        messagesCount: messages.length,
        apiKeyFirst10: apiKey?.slice(0, 10),
        apiKeyLength: apiKey?.length,
      }) + '\n');
    } catch {}

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    // TEMP DEBUG — remove before commit.
    try {
      appendFileSync(AI_DEBUG_LOG_PATH, JSON.stringify({
        ts: new Date().toISOString(),
        type: 'AI_DEBUG_RAW',
        finish_reason: data?.choices?.[0]?.finish_reason,
        content: data?.choices?.[0]?.message?.content?.slice(0, 200),
        tool_calls_count: data?.choices?.[0]?.message?.tool_calls?.length,
        usage: data?.usage,
        error: data?.error,
      }) + '\n');
    } catch {}
    const choice = data?.choices?.[0];
    const message = choice?.message;

    // No tool calls — final text response
    if (!message?.tool_calls?.length) {
      // Se consultar_debitos encontrou um débito com nominal > 0,
      // suprime o texto do GPT e retorna só o exit code — o cliente
      // não deve receber texto nesse turno, só o #NEGOCIACAO deve ser
      // processado pelo engine. Só se aplica ao nó BEN (agente_de_ia):
      // o Aleh (agente_de_ia_2) precisa apresentar os dados de
      // consultar_debitos ao cliente, não pode ser suprimido.
      if (nodeKey === "agente_de_ia") {
        const hasPositiveNominal = collectedToolResults.some((tr) => {
          if (tr.toolName !== "consultar_debitos") return false;
          // Formato 1 — Acordos: "nominal" com ponto decimal.
          const acordosMatch = tr.result.match(/"nominal"\s*:\s*"?(\d+\.?\d*)"?/);
          if (acordosMatch) {
            const value = parseFloat(acordosMatch[1]);
            if (!Number.isNaN(value) && value > 0) return true;
          }
          // Formato 2 — Calculos: "NominalPrinc" com vírgula decimal.
          const calculosMatch = tr.result.match(/"NominalPrinc"\s*:\s*"(\d+,\d+)"/);
          if (calculosMatch) {
            const value = parseFloat(calculosMatch[1].replace(",", "."));
            if (!Number.isNaN(value) && value > 0) return true;
          }
          return false;
        });
        if (hasPositiveNominal) {
          return "#NEGOCIACAO";
        }
      }
      return message?.content || "";
    }

    // Has tool calls — execute each and feed results back
    messages.push({ role: "assistant", content: message.content || null, tool_calls: message.tool_calls });

    for (const toolCall of message.tool_calls) {
      const toolName = toolCall.function?.name;
      const toolArgs = (() => {
        try { return JSON.parse(toolCall.function?.arguments || "{}"); } catch { return {}; }
      })();

      const toolDef = tools?.find((t) => t.name === toolName);
      let toolResult = "";

      if (toolDef) {
        const toolStartedAt = Date.now();
        if (onToolCall) {
          await onToolCall(toolName, toolArgs).catch(() => {});
        }
        try {
          // Substitute {{param}} placeholders in URL and body
          const interpolate = (str: string) =>
            str.replace(/\{\{(\w+)\}\}/g, (_, key) =>
              toolArgs[key] !== undefined ? String(toolArgs[key]) : ""
            );

          const resolvedUrl = interpolate(toolDef.http.url);
          const resolvedBody = toolDef.http.body ? interpolate(toolDef.http.body) : undefined;
          const resolvedHeaders: Record<string, string> = {};
          for (const [k, v] of Object.entries(toolDef.http.headers || {})) {
            resolvedHeaders[k] = interpolate(v);
          }

          const httpRes = await fetch(resolvedUrl, {
            method: toolDef.http.method,
            headers: { "Content-Type": "application/json", ...resolvedHeaders },
            ...(resolvedBody ? { body: resolvedBody } : {}),
          });
          const httpText = await httpRes.text();
          const toolDurationMs = Date.now() - toolStartedAt;
          if (onToolResult) {
            await onToolResult(toolName, httpText, toolDurationMs).catch(() => {});
          }
          toolResult = httpText;
        } catch (err) {
          toolResult = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
          const toolDurationMs = Date.now() - toolStartedAt;
          if (onToolResult) {
            await onToolResult(toolName, toolResult, toolDurationMs).catch(() => {});
          }
        }
      } else {
        toolResult = JSON.stringify({ error: `Tool "${toolName}" not found in node config` });
      }

      collectedToolResults.push({ toolName, result: toolResult });

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: toolResult,
      });
    }
    // Loop back to get GPT's response after tool results
  }

  return ""; // Fallback if max iterations reached
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
