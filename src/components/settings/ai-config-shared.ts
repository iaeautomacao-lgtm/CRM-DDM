"use client";

// Estado e API compartilhados das duas telas que editam o ai_config da conta: "Provedores de IA" (liga/desliga geral,
// provedor e chave) e "Agente global (sem fluxo)" em Agentes de IA (prompt, recursos e voz). Mesma API de sempre
// (/api/account/ai-config): o POST substitui a linha inteira, então cada tela carrega os valores atuais ao abrir
// e reenvia todos os campos, mudando só os dela.

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { apiFetch } from "@/lib/api-fetch";
import { useAuth } from "@/hooks/use-auth";
import { usePermission } from "@/hooks/use-permission";

// Placeholder shown in api_key/elevenlabs_api_key when the account
// already has one configured (GET /api/account/ai-config masks the real
// value — see maskSecret there). Comparing the field against this exact
// string on save is how we know the user left it untouched vs. typed a
// new key — must match the literal of the same name in
// src/app/api/account/ai-config/route.ts (duplicated on purpose: that
// route imports server-only Node deps that can't ship to the client).
export const MASKED_SENTINEL = "••••••••";

// Preenchimento inicial do campo "Prompt do Sistema" só quando a conta
// ainda não tem nada salvo em ai_config.system_prompt — DEFAULT pra
// contas novas, não um override permanente. Antes, loadConfig() setava
// isso incondicionalmente logo depois de carregar o valor real do
// banco, então qualquer prompt customizado salvo pelo usuário nunca
// aparecia de volta na tela (o valor do banco era jogado fora todo
// carregamento, mesmo continuando salvo — bug puramente de exibição,
// não apagava nada).
export const DEFAULT_SYSTEM_PROMPT = `Você é o(a) Aleh, assistente comercial especializado do Grupo DDM.
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

export type AiProviderId = "gemini" | "openai" | "claude" | "hermes";

export interface AiConfigForm {
  enabled: boolean;
  apiProvider: AiProviderId;
  apiKey: string;
  systemPrompt: string;
  googleSearchEnabled: boolean;
  multimodalEnabled: boolean;
  elevenlabsEnabled: boolean;
  elevenlabsApiKey: string;
  elevenlabsVoiceId: string;
  elevenlabsModelId: string;
}

const INITIAL: AiConfigForm = {
  enabled: false,
  apiProvider: "gemini",
  apiKey: "",
  systemPrompt: "",
  googleSearchEnabled: false,
  multimodalEnabled: false,
  elevenlabsEnabled: false,
  elevenlabsApiKey: "",
  elevenlabsVoiceId: "",
  elevenlabsModelId: "eleven_multilingual_v2",
};

export function useAiConfig() {
  const { accountId } = useAuth();
  // Mesma chave que o servidor exige em /api/account/ai-config (guardPermission('ai.config')).
  const canEdit = usePermission("ai.config");
  const [form, setForm] = useState<AiConfigForm>(INITIAL);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const patch = useCallback((p: Partial<AiConfigForm>) => setForm((prev) => ({ ...prev, ...p })), []);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      // Rota do servidor: api_key/elevenlabs_api_key nunca voltam em texto puro (vêm mascaradas;
      // MASKED_SENTINEL é o que vai no campo quando já existe uma chave).
      const res = await apiFetch("/api/account/ai-config");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Falha ao carregar configuração");
      if (data) {
        setForm({
          enabled: data.enabled,
          apiProvider: data.api_provider,
          apiKey: data.api_key ? MASKED_SENTINEL : "",
          systemPrompt: data.system_prompt || DEFAULT_SYSTEM_PROMPT,
          googleSearchEnabled: data.google_search_enabled || false,
          multimodalEnabled: data.multimodal_enabled || false,
          elevenlabsEnabled: data.elevenlabs_enabled || false,
          elevenlabsApiKey: data.elevenlabs_api_key ? MASKED_SENTINEL : "",
          elevenlabsVoiceId: data.elevenlabs_voice_id || "",
          elevenlabsModelId: data.elevenlabs_model_id || "eleven_multilingual_v2",
        });
      }
    } catch (err) {
      console.error("Failed to load AI config:", err);
      setLoadError(err instanceof Error ? err.message : "Falha ao carregar configuração do Agente de IA");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!accountId || !canEdit) return;
    void load();
  }, [accountId, canEdit, load]);

  const retry = useCallback(() => {
    setLoading(true);
    void load();
  }, [load]);

  /** Valida (mesmas regras de antes) e grava todos os campos; devolve true se salvou. */
  const save = useCallback(async (): Promise<boolean> => {
    if (!accountId) return false;
    if (form.enabled && form.apiProvider !== "hermes" && !form.apiKey.trim()) {
      toast.error("A chave de API é obrigatória para ativar o Agente de IA");
      return false;
    }
    if (form.elevenlabsEnabled && (!form.elevenlabsApiKey.trim() || !form.elevenlabsVoiceId.trim())) {
      toast.error("Preencha a API Key e o Voice ID para ativar o ElevenLabs");
      return false;
    }
    setSaving(true);
    try {
      // api_key/elevenlabs_api_key só são enviadas quando o usuário de fato digitou algo novo (valor !== MASKED_SENTINEL):
      // a rota trata o sentinel como "não mexeu, mantém o que já tá gravado" e criptografa no servidor o que for novo.
      const res = await apiFetch("/api/account/ai-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: form.enabled,
          api_provider: form.apiProvider,
          api_key: form.apiKey,
          system_prompt: form.systemPrompt.trim(),
          google_search_enabled: form.googleSearchEnabled,
          multimodal_enabled: form.multimodalEnabled,
          elevenlabs_enabled: form.elevenlabsEnabled,
          elevenlabs_api_key: form.elevenlabsApiKey,
          elevenlabs_voice_id: form.elevenlabsVoiceId.trim() || null,
          elevenlabs_model_id: form.elevenlabsModelId.trim() || "eleven_multilingual_v2",
        }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || "Falha ao salvar");
      toast.success("Configurações do Agente de IA salvas!");
      return true;
    } catch (err) {
      console.error("Failed to save AI config:", err);
      toast.error("Erro ao salvar configurações do Agente de IA");
      return false;
    } finally {
      setSaving(false);
    }
  }, [accountId, form]);

  return { accountId, canEdit, form, patch, loading, loadError, retry, saving, save };
}
