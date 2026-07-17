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
  const token = process.env.DDM_TOKEN || process.env.DDM_API_KEY || "af875d1e5ffab9247c16c56ba2c6b349";

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
    let opcoes_cartao = "";
    let campanha = "2025.1";
    let resumo_parcelamento: any[] = [];
    let acordos: any[] = [];

    const calcArray = Array.isArray(calcData) ? calcData : [calcData];

    if (calcArray.length > 0) {
      const pgtoAvista = calcArray.find((obj: any) => obj.PgtoAvista);
      if (pgtoAvista && pgtoAvista.PgtoAvista && pgtoAvista.PgtoAvista.ValorFinal) {
        valor_divida = pgtoAvista.PgtoAvista.ValorFinal;
      }

      // Extract agreements
      const acordosObj = calcArray.find((obj: any) => obj.acordos);
      if (acordosObj && Array.isArray(acordosObj.acordos)) {
        acordos = acordosObj.acordos;
      }

      // Extract boleto installments
      const pgtoBoletoObj = calcArray.find((obj: any) => obj.PgtoParceladoBoleto || obj.resumo_parcelamento);
      const rawBoleto = pgtoBoletoObj?.PgtoParceladoBoleto || pgtoBoletoObj?.resumo_parcelamento;
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

      const cleanVal = valor_divida.replace(/\./g, "").replace(",", ".");
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
      acordos
    };
  } catch (err) {
    console.error("[AI Agent] DDM API sequence error:", err);
    return null;
  }
}

function extractInstallmentsFromHistory(history: any[]): number {
  for (let idx = 0; idx < history.length; idx++) {
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

  // --- DEBOUNCE E DELAY DE DIGITAÇÃO ---
  // Aguarda 4 segundos antes de prosseguir. Se uma nova mensagem chegar durante esse intervalo,
  // a execução anterior é interrompida porque o histórico de mensagens mudará e haverá um novo gatilho.
  await new Promise((resolve) => setTimeout(resolve, 4000));

  // Recarrega as últimas mensagens para ver se o cliente enviou algo novo depois do gatilho inicial.
  // Se a última mensagem não for a que disparou esta execução, encerramos esta chamada para deixar a mais recente responder.
  const { data: latestCheckMsg } = await db
    .from("messages")
    .select("id, content_text, created_at, sender_type")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (latestCheckMsg && latestCheckMsg.sender_type === "customer") {
    // Se o cliente mandou mais mensagens, esse webhook antigo cancela para o novo responder com todo o contexto junto.
    const lastCheckTime = new Date(latestCheckMsg.created_at).getTime();
    // Adiciona uma tolerância de 500ms para evitar falsos cancelamentos
    if (Date.now() - lastCheckTime < 3800) {
      console.log(`[AI Agent] Debounce triggered on conversation ${conversationId}. Cancelling old execution.`);
      return;
    }
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

=== SAUDAÇÃO INICIAL (CRÍTICO) ===
Se o cliente estiver iniciando a conversa (primeiro contato, "oi", "olá", etc.), responda exatamente apresentando este menu simples de opções:
"Olá! Tudo bem? Me chamo Aleh, assistente virtual do Grupo DDM. Como posso te ajudar hoje? 😊

Escolha uma das opções para começarmos:
1️⃣ Quero negociar uma dívida
2️⃣ Segunda via de boleto/Pix"

### DIRETRIZES DE ESTILO:
1. Seja sempre breve e vá direto ao ponto. No WhatsApp, mensagens muito longas são ignoradas.
2. Use quebras de linha para facilitar a leitura.
3. Use emojis de forma moderada (apenas 1 ou 2 por mensagem) para parecer amigável.
4. Nunca use termos robóticos como "Em que posso ser útil hoje?". Em vez disso, prefira "Como posso te ajudar?" ou "Como posso te apoiar?".
5. Jamais invente informações. Se não souber de algo (como preços ou detalhes técnicos que não estão na Base de Conhecimento), diga gentilmente que vai verificar com a equipe humana.

### FLUXO DO DIÁLOGO E CONSULTA DE DÉBITOS (DDM API):
1. **Solicitação do CPF:** Se o cliente escolher negociar ou pedir segunda via, **peça o CPF dele imediatamente** de forma amigável para localizar o cadastro no sistema. Se o cliente enviar o CPF com formato inválido, oriente-o gentilmente a enviar apenas os 11 números.
2. **Uso dos Dados Injetados:** Assim que o cliente informar o CPF, o sistema injetará as informações de débitos dele no seu contexto (abaixo da seção de Consulta da DDM API). Use **apenas** esses valores reais (instituição, parcelas, valores) para a negociação. Nunca invente dados.
3. **Negociação:** 
   - Ofereça o pagamento à vista (seja por Pix ou por Boleto) ou parcelado (de acordo com as opções disponíveis na API da DDM).
   - Se o cliente preferir ou achar as parcelas altas, ofereça a opção de parcelamento no cartão de crédito através do link de pagamento dinâmico.

=== REGRAS DE FECHAMENTO E TAGS (MUITO IMPORTANTE) ===
1. **Confirmação:** Quando o cliente concordar explicitamente com uma proposta (ex: pagar à vista ou parcelado), confirme resumidamente os termos (vencimento, valor da parcela e a forma de pagamento). Você **NÃO** deve solicitar e-mail ou número de telefone dele, pois já está no WhatsApp.
2. **Disparo do Boleto (#ACORDOFORMALIZADO):** Para disparar o boleto real e o Pix automaticamente no chat para o cliente, você **DEVE obrigatoriamente adicionar a tag \`#ACORDOFORMALIZADO\`** ao final da sua mensagem de confirmação de acordo.
3. **Agendamento de Pagamento (#AGENDAMENTO):** Se o cliente solicitar pagar em uma data futura específica ou agendar o atendimento, agradeça a atenção, oriente-o a retornar o contato na data/horário marcado e encerre a mensagem obrigatoriamente com a tag \`#AGENDAMENTO\`.

=== DIRETRIZ CRÍTICA DE SEGURANÇA E ESCOPO ===
Você é exclusivamente um assistente financeiro de acordos e suporte do Grupo DDM.
1. Você está proibido de responder sobre qualquer assunto fora do Grupo DDM (como dicas de investimento, dividendos de outros fundos, receitas, notícias ou conhecimentos gerais).
2. Se o cliente perguntar algo fora do escopo, responda gentilmente: "Sou um assistente focado em suporte financeiro e acordos de cobrança do Grupo DDM, por isso não consigo te ajudar com outras informações no momento. Como posso te apoiar em relação ao seu boleto ou acordo?"

=== DIRETRIZ DE PERSISTÊNCIA E NEGOCIAÇÃO ===
1. Persista e contorne ao máximo as objeções do cliente (ex: se ele disser que está caro, ofereça a opção de parcelamento no cartão). O seu objetivo principal é fazer com que ele feche o acordo direto com você.
2. Se o cliente recusar de forma definitiva todas as propostas possíveis mesmo após você insistir e tentar contornar 3 vezes, finalize a mensagem adicionando a tag \`#RECUSA\`.
3. Só passe o atendimento para a equipe humana se o cliente:
   - Insistir repetidamente que quer falar com um humano.
   - Disser explicitamente: "Quero pagar, mas só se for com um atendente humano".
4. Apenas nestes casos do item 3, encerre sua resposta educadamente com a tag \`#EQUIPEHUMANA\` para que o operador humano assuma. Caso contrário, continue conduzindo a negociação normalmente.`;
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

    const isEducational = 
      inst.toLowerCase().includes("uva") || 
      inst.toLowerCase().includes("veiga") || 
      inst.toLowerCase().includes("unijorge") || 
      inst.toLowerCase().includes("unisuam") || 
      inst.toLowerCase().includes("castelo") || 
      inst.toLowerCase().includes("bezerra") || 
      inst.toLowerCase().includes("potiguar") ||
      sistema.toLowerCase().includes("uva") || 
      sistema.toLowerCase().includes("veiga") || 
      sistema.toLowerCase().includes("unijorge") || 
      sistema.toLowerCase().includes("unisuam") || 
      sistema.toLowerCase().includes("castelo") || 
      sistema.toLowerCase().includes("bezerra") || 
      sistema.toLowerCase().includes("potiguar");

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

    if ((inst.toLowerCase().includes("cruzeiro") || sistema.toLowerCase() === "cruzeiro") && hasActiveDebt) {
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
    } else if (isEducational && hasActiveDebt) {
      const formattedBoleto = JSON.stringify(ddmData.resumo_parcelamento || []);
      const formattedAcordos = JSON.stringify(ddmData.acordos || []);
      const currentDate = new Date().toLocaleDateString("pt-BR");

      let customPrompt = aiConfig.system_prompt || "";
      if (customPrompt) {
        customPrompt = customPrompt
          .replace(/\{\{valor_final\}\}/g, `R$ ${debt}`)
          .replace(/\{\{resumo_parcelamento\}\}/g, formattedBoleto);
      }

      systemPromptWithKb = customPrompt
        ? `${customPrompt}

=== DADOS DO CLIENTE E CONTEXTO ===
- Data Atual: ${currentDate}
- Nome do Cliente: ${ddmData.nome || "Não informado"}
- CPF consultado: ${foundCpf}
- Instituição: ${inst}
- Valor para Quitação à Vista (ValorFinal): R$ ${debt}
- Opções de Parcelamento no Cartão (Exclusivo): ${ddmData.opcoes_cartao || "Não disponível"}
- Resumo do Parcelamento em Boleto (resumo_parcelamento): ${formattedBoleto}
- Lista de Acordos do Cliente: ${formattedAcordos}`
        : `Você é Julia, analista financeira consultiva da assessoria DDM, parceira da instituição de ensino.
Sua saudação preferencial: "Olá! Tudo bem? Me chamo Julia, sou Representante Financeiro da sua Instituição de ensino."

=== DADOS DO CLIENTE E CONTEXTO ===
- Data Atual: ${currentDate}
- Nome do Cliente: ${ddmData.nome || "Não informado"}
- CPF consultado: ${foundCpf}
- Instituição: ${inst}
- Valor para Quitação à Vista (ValorFinal): R$ ${debt}
- Opções de Parcelamento no Cartão (Exclusivo): ${ddmData.opcoes_cartao || "Não disponível"}
- Resumo do Parcelamento em Boleto (resumo_parcelamento): ${formattedBoleto}
- Lista de Acordos do Cliente: ${formattedAcordos}

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
         - Primeiro ofereça parcelamento no cartão de crédito com o link original do portal: https://ddmpay.ddmacordos.com/acesso/?c=&u=
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
    } else if (!hasActiveDebt) {
      systemPromptWithKb = `${systemPromptWithKb}

=== INFORMAÇÕES DE CONSULTA (DDM API) ===
O cliente informou o CPF e possui cadastro na instituição ${inst}, porém NÃO foram localizadas dívidas ativas (valor de débitos em aberto é de R$ 0,00 ou sem pendências).

=== INSTRUÇÃO DE ATENDIMENTO (SEM DÍVIDA ATIVA) ===
Você é o(a) Aleh.
1. Informe de maneira simpática e educada que realizou a consulta baseada no CPF enviado e não localizou nenhuma pendência financeira em aberto para a instituição ${inst} no momento.
2. Pergunte de forma simpática se pode ajudá-lo em mais alguma coisa.
3. Não fale sobre acordos, cobranças ou valores pendentes.
4. Caso o cliente solicite falar com um atendente ou transferir para um humano, transfira e retorne a tag #EQUIPEHUMANA.`;
    } else {
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
  } else if (foundCpf) {
    systemPromptWithKb = `${systemPromptWithKb}

=== INFORMAÇÕES DE CONSULTA (DDM API) ===
O cliente informou o CPF (${foundCpf}), mas a pesquisa na API da DDM retornou que não há registros ou pendências ativas.

=== INSTRUÇÃO DE DEVOLUÇÃO (CPF NÃO LOCALIZADO) ===
Você é o(a) Aleh.
1. Informe de forma amigável que não localizou nenhuma pendência em aberto para o CPF digitado em nosso sistema.
2. Pergunte de forma aberta e simpática como você pode ajudá-lo hoje.
3. Caso ele solicite falar com um atendente ou peça transferência para um humano, transfira e retorne a tag #EQUIPEHUMANA.`;
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
  if (forceTransferHumanMsg) {
    generatedText = forceTransferHumanMsg;
  } else {
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
  }

  generatedText = generatedText.trim();
  if (!generatedText) return;

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

  if (hasAgreedAcordo && foundCpf) {
    console.log(`[AI Agent] Intercepted #ACORDOFORMALIZADO. Calling DDM formalization API for CPF ${foundCpf}...`);
    try {
      const activeKey = process.env.DDM_TOKEN || process.env.DDM_API_KEY || "af875d1e5ffab9247c16c56ba2c6b349";
      let calculoId = "";
      
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

      // Adiciona o link do boleto gerado à mensagem enviada pela IA no WhatsApp
      if (payBoletoUrl) {
        generatedText = `${generatedText}\n\nSegue o link do seu boleto oficial para pagamento: ${payBoletoUrl}`;
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

      // Tratamento preventivo: Se for WebP ou falhar no download do bucket público, enviamos apenas o texto para evitar erro 400 da OpenAI
      const isWebp = fetchUrl.toLowerCase().includes(".webp");
      if (isWebp) {
        messages.push({
          role: isCustomer ? "user" : "assistant",
          content: msg.content_text || "[Imagem enviada]"
        });
      } else {
        messages.push({
          role: isCustomer ? "user" : "assistant",
          content: [
            { type: "text", text: msg.content_text || "O que está nesta imagem?" },
            { type: "image_url", image_url: { url: fetchUrl } }
          ]
        });
      }
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
