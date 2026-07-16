"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { 
  Bot, 
  Loader2, 
  Key, 
  MessageSquare, 
  Volume2, 
  Globe, 
  FileText, 
  Trash2, 
  Upload, 
  Sparkles 
} from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { SettingsPanelHead } from "./settings-panel-head";

export function AiAgentSettings() {
  const supabase = createClient();
  const { accountId, canEditSettings } = useAuth();

  const [enabled, setEnabled] = useState(false);
  const [apiProvider, setApiProvider] = useState<"gemini" | "openai" | "claude" | "hermes">("gemini");
  const [apiKey, setApiKey] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  
  // Advanced Features
  const [googleSearchEnabled, setGoogleSearchEnabled] = useState(false);
  const [multimodalEnabled, setMultimodalEnabled] = useState(false);

  // ElevenLabs
  const [elevenlabsEnabled, setElevenlabsEnabled] = useState(false);
  const [elevenlabsApiKey, setElevenlabsApiKey] = useState("");
  const [elevenlabsVoiceId, setElevenlabsVoiceId] = useState("");
  const [elevenlabsModelId, setElevenlabsModelId] = useState("eleven_multilingual_v2");

  // Knowledge Base
  const [kbFiles, setKbFiles] = useState<{ id: string; name: string; created_at: string }[]>([]);
  const [uploadingKb, setUploadingKb] = useState(false);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!accountId) return;
    loadConfig();
    loadKbFiles();
  }, [accountId]);

  async function loadConfig() {
    try {
      const { data, error } = await supabase
        .from("ai_config")
        .select("*")
        .eq("account_id", accountId)
        .maybeSingle();

      if (error) throw error;
      if (data) {
        setEnabled(data.enabled);
        setApiProvider(data.api_provider);
        setApiKey(data.api_key || "");
        setSystemPrompt(data.system_prompt || "");
        setGoogleSearchEnabled(data.google_search_enabled || false);
        setMultimodalEnabled(data.multimodal_enabled || false);
        setElevenlabsEnabled(data.elevenlabs_enabled || false);
        setElevenlabsApiKey(data.elevenlabs_api_key || "");
        setElevenlabsVoiceId(data.elevenlabs_voice_id || "");
        setElevenlabsModelId(data.elevenlabs_model_id || "eleven_multilingual_v2");
        setSystemPrompt(`Você é o(a) Aleh, assistente comercial especializado do Grupo DDM.
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
4. Apenas nestes casos do item 3, encerre sua resposta educadamente com a tag \`#EQUIPEHUMANA\` para que o operador humano assuma. Caso contrário, continue conduzindo a negociação normalmente.`);
      }
    } catch (err) {
      console.error("Failed to load AI config:", err);
      toast.error("Falha ao carregar configuração do Agente de IA");
    } finally {
      setLoading(false);
    }
  }

  async function loadKbFiles() {
    try {
      const { data, error } = await supabase
        .from("knowledge_base_files")
        .select("id, name, created_at")
        .eq("account_id", accountId)
        .order("created_at", { ascending: false });

      if (error) throw error;
      setKbFiles(data || []);
    } catch (err) {
      console.error("Failed to load knowledge base files:", err);
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!accountId) return;

    if (enabled && apiProvider !== "hermes" && !apiKey.trim()) {
      toast.error("A chave de API é obrigatória para ativar o Agente de IA");
      return;
    }

    if (elevenlabsEnabled && (!elevenlabsApiKey.trim() || !elevenlabsVoiceId.trim())) {
      toast.error("Preencha a API Key e o Voice ID para ativar o ElevenLabs");
      return;
    }

    setSaving(true);
    try {
      const { error } = await supabase
        .from("ai_config")
        .upsert({
          account_id: accountId,
          enabled,
          api_provider: apiProvider,
          api_key: apiKey.trim(),
          system_prompt: systemPrompt.trim(),
          google_search_enabled: googleSearchEnabled,
          multimodal_enabled: multimodalEnabled,
          elevenlabs_enabled: elevenlabsEnabled,
          elevenlabs_api_key: elevenlabsApiKey.trim() || null,
          elevenlabs_voice_id: elevenlabsVoiceId.trim() || null,
          elevenlabs_model_id: elevenlabsModelId.trim() || 'eleven_multilingual_v2',
          updated_at: new Date().toISOString(),
        }, { onConflict: "account_id" });

      if (error) throw error;
      toast.success("Configurações do Agente de IA salvas!");
    } catch (err) {
      console.error("Failed to save AI config:", err);
      toast.error("Erro ao salvar configurações do Agente de IA");
    } finally {
      setSaving(false);
    }
  }

  async function handleKbUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !accountId) return;

    setUploadingKb(true);
    try {
      let content = "";
      if (file.name.endsWith(".txt") || file.name.endsWith(".csv")) {
        content = await file.text();
      } else if (file.name.endsWith(".pdf")) {
        content = await parsePdfClientSide(file);
      } else {
        throw new Error("Formato de arquivo não suportado. Use PDF, TXT ou CSV.");
      }

      if (!content.trim()) {
        throw new Error("O arquivo está vazio ou não pôde ser extraído texto.");
      }

      const { error } = await supabase
        .from("knowledge_base_files")
        .insert({
          account_id: accountId,
          name: file.name,
          content: content,
        });

      if (error) throw error;
      toast.success("Documento adicionado à base de conhecimento!");
      loadKbFiles();
    } catch (err: any) {
      console.error("Failed to upload file:", err);
      toast.error(err.message || "Erro ao fazer upload do arquivo");
    } finally {
      setUploadingKb(false);
      e.target.value = "";
    }
  }

  // Client-side PDF parser using pdf.js from CDN
  const parsePdfClientSide = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      if ((window as any)["pdfjs-dist/build/pdf"]) {
        runParser((window as any)["pdfjs-dist/build/pdf"]);
        return;
      }

      const script = document.createElement("script");
      script.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.min.js";
      script.onload = () => {
        const pdfjsLib = (window as any)["pdfjs-dist/build/pdf"];
        pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js";
        runParser(pdfjsLib);
      };
      script.onerror = () => reject(new Error("Falha ao carregar biblioteca de leitura de PDF."));
      document.head.appendChild(script);

      async function runParser(pdfjsLib: any) {
        try {
          const arrayBuffer = await file.arrayBuffer();
          const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
          let fullText = "";
          for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const textContent = await page.getTextContent();
            const pageText = textContent.items.map((item: any) => item.str).join(" ");
            fullText += pageText + "\n";
          }
          resolve(fullText);
        } catch (err) {
          reject(err);
        }
      }
    });
  };

  async function handleKbDelete(id: string) {
    try {
      const { error } = await supabase
        .from("knowledge_base_files")
        .delete()
        .eq("id", id);
      if (error) throw error;
      toast.success("Documento removido!");
      loadKbFiles();
    } catch (err) {
      console.error("Failed to delete document:", err);
      toast.error("Erro ao remover documento");
    }
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <section className="max-w-3xl space-y-6 animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title="Agente de Atendimento com IA"
        description="Configure um atendente virtual inteligente com multicanalidade, base de conhecimento e resposta de voz."
      />

      <form onSubmit={handleSave} className="space-y-6">
        {/* Status Card */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <CardTitle className="flex items-center gap-2 text-foreground">
                  <Bot className="size-4 text-primary" />
                  Status do Agente
                </CardTitle>
                <CardDescription className="text-muted-foreground">
                  Ative ou desative as respostas automáticas do agente inteligente.
                </CardDescription>
              </div>
              <Switch
                checked={enabled}
                onCheckedChange={setEnabled}
                disabled={!canEditSettings}
              />
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-200">
              <MessageSquare className="size-4 shrink-0 text-amber-400" />
              <span>
                <strong>Nota:</strong> O agente de IA responderá apenas as conversas que <strong>não possuírem</strong> um atendente humano atribuído.
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Integration Card */}
        <Card className={!enabled ? "opacity-60" : ""}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-foreground">
              <Key className="size-4 text-primary" />
              Integração e Chave de API
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              Escolha seu provedor e insira sua chave de API para habilitar o serviço.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label className="text-muted-foreground">Provedor de IA</Label>
                <select
                  value={apiProvider}
                  onChange={(e) => setApiProvider(e.target.value as any)}
                  disabled={!enabled || !canEditSettings}
                  className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary disabled:cursor-not-allowed"
                >
                  <option value="gemini">Google Gemini (Recomendado)</option>
                  <option value="openai">OpenAI (ChatGPT)</option>
                  <option value="claude">Anthropic Claude</option>
                  <option value="hermes">Nous Hermes (Modo Billing)</option>
                </select>
              </div>

              <div className="space-y-2">
                <Label className="text-muted-foreground">Chave de API (API Key)</Label>
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  disabled={!enabled || !canEditSettings}
                  placeholder={
                    apiProvider === "gemini"
                      ? "AIzaSy..."
                      : apiProvider === "openai"
                      ? "sk-proj-..."
                      : apiProvider === "claude"
                      ? "sk-ant-..."
                      : "Opcional"
                  }
                  className="text-sm placeholder:text-muted-foreground"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Behavioral Settings Card */}
        <Card className={!enabled ? "opacity-60" : ""}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-foreground">
              <MessageSquare className="size-4 text-primary" />
              Instruções de Comportamento (System Prompt)
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              Defina a personalidade, as regras de atendimento e as respostas que a IA deve dar aos clientes.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label className="text-muted-foreground">Instruções para o Agente</Label>
              <Textarea
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                disabled={!enabled || !canEditSettings}
                rows={6}
                placeholder={`Você é um assistente virtual atencioso da nossa empresa. Seu objetivo é ajudar os clientes.`}
                className="text-sm font-sans"
              />
            </div>
          </CardContent>
        </Card>

        {/* Advanced Capabilities Card */}
        <Card className={!enabled ? "opacity-60" : ""}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-foreground">
              <Sparkles className="size-4 text-primary" />
              Recursos Avançados
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              Habilite novas capacidades cognitivas e interativas para seu Agente.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Google Search Toggle */}
            <div className="flex items-center justify-between border-b border-border/40 pb-3">
              <div className="space-y-0.5">
                <Label className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                  <Globe className="size-3.5 text-muted-foreground shrink-0" />
                  Pesquisa no Google (Grounding)
                </Label>
                <p className="text-xs text-muted-foreground">
                  Permite que o agente consulte a internet em tempo real para responder dados atualizados.
                </p>
              </div>
              <Switch
                checked={googleSearchEnabled}
                onCheckedChange={setGoogleSearchEnabled}
                disabled={!enabled || !canEditSettings}
              />
            </div>

            {/* Multimodal Cap. Toggle */}
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                  <Bot className="size-3.5 text-muted-foreground shrink-0" />
                  Interpretar Mídia (Áudio e Imagem)
                </Label>
                <p className="text-xs text-muted-foreground">
                  Transcreve automaticamente mensagens de áudio e analisa imagens enviadas pelo cliente.
                </p>
              </div>
              <Switch
                checked={multimodalEnabled}
                onCheckedChange={setMultimodalEnabled}
                disabled={!enabled || !canEditSettings}
              />
            </div>
          </CardContent>
        </Card>

        {/* ElevenLabs Card */}
        <Card className={!enabled ? "opacity-60" : ""}>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <CardTitle className="flex items-center gap-2 text-foreground">
                  <Volume2 className="size-4 text-primary" />
                  Respostas de Voz (ElevenLabs)
                </CardTitle>
                <CardDescription className="text-muted-foreground">
                  Envie respostas sintetizadas por áudio no WhatsApp sempre que o cliente mandar um áudio.
                </CardDescription>
              </div>
              <Switch
                checked={elevenlabsEnabled}
                onCheckedChange={setElevenlabsEnabled}
                disabled={!enabled || !canEditSettings}
              />
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {elevenlabsEnabled && (
              <div className="grid gap-4 md:grid-cols-2 animate-in slide-in-from-top-2 duration-200">
                <div className="space-y-2 md:col-span-2">
                  <Label className="text-muted-foreground">ElevenLabs API Key</Label>
                  <Input
                    type="password"
                    value={elevenlabsApiKey}
                    onChange={(e) => setElevenlabsApiKey(e.target.value)}
                    disabled={!canEditSettings}
                    placeholder="Cole sua API Key do ElevenLabs"
                    className="text-sm placeholder:text-muted-foreground"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-muted-foreground">Voice ID</Label>
                  <Input
                    type="text"
                    value={elevenlabsVoiceId}
                    onChange={(e) => setElevenlabsVoiceId(e.target.value)}
                    disabled={!canEditSettings}
                    placeholder="ID da voz (padrão ou clonada)"
                    className="text-sm placeholder:text-muted-foreground"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-muted-foreground">Model ID</Label>
                  <Input
                    type="text"
                    value={elevenlabsModelId}
                    onChange={(e) => setElevenlabsModelId(e.target.value)}
                    disabled={!canEditSettings}
                    placeholder="eleven_multilingual_v2"
                    className="text-sm placeholder:text-muted-foreground"
                  />
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* File Search Knowledge Base Card */}
        <Card className={!enabled ? "opacity-60" : ""}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-foreground">
              <FileText className="size-4 text-primary" />
              Base de Conhecimento (File Search RAG)
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              Carregue manuais, tabelas e PDFs para fornecer informações exclusivas de suporte e vendas ao robô.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Upload Area */}
            <div className="flex items-center gap-4">
              <Label
                htmlFor="kb-upload"
                className={`flex flex-1 cursor-pointer items-center justify-center gap-2.5 rounded-lg border-2 border-dashed border-border p-6 hover:border-primary/50 hover:bg-muted/30 transition duration-150 ${
                  uploadingKb || !enabled ? "pointer-events-none opacity-50" : ""
                }`}
              >
                {uploadingKb ? (
                  <>
                    <Loader2 className="size-5 animate-spin text-primary" />
                    <span className="text-sm font-medium text-muted-foreground">Extraindo e processando documento...</span>
                  </>
                ) : (
                  <>
                    <Upload className="size-5 text-muted-foreground shrink-0" />
                    <span className="text-sm font-medium text-muted-foreground">Carregar Documento (.pdf, .txt, .csv)</span>
                  </>
                )}
                <input
                  id="kb-upload"
                  type="file"
                  accept=".pdf,.txt,.csv"
                  onChange={handleKbUpload}
                  disabled={uploadingKb || !enabled || !canEditSettings}
                  className="hidden"
                />
              </Label>
            </div>

            {/* Files List */}
            {kbFiles.length > 0 ? (
              <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3 max-h-52 overflow-y-auto">
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                  Documentos na Base ({kbFiles.length})
                </p>
                {kbFiles.map((file) => (
                  <div
                    key={file.id}
                    className="flex items-center justify-between rounded border border-border bg-card/60 px-3 py-2 text-xs hover:bg-muted/40 transition"
                  >
                    <div className="flex items-center gap-2">
                      <FileText className="size-4 text-primary/70 shrink-0" />
                      <span className="font-medium text-foreground truncate max-w-[280px]">
                        {file.name}
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-[10px] text-muted-foreground">
                        {new Date(file.created_at).toLocaleDateString("pt-BR")}
                      </span>
                      {canEditSettings && (
                        <button
                          type="button"
                          onClick={() => handleKbDelete(file.id)}
                          className="text-muted-foreground hover:text-red-400 p-1 rounded hover:bg-muted cursor-pointer"
                          title="Remover Documento"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center p-6 border border-dashed border-border/60 rounded-lg bg-muted/10 text-center">
                <FileText className="size-6 text-muted-foreground/45 mb-1.5" />
                <p className="text-xs text-muted-foreground">Sua base de conhecimento está vazia.</p>
                <p className="text-[10px] text-muted-foreground/70 mt-0.5">Faça upload de arquivos acima para o robô poder consultá-los.</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Submit button */}
        {canEditSettings && (
          <Button
            type="submit"
            disabled={saving}
            className="bg-primary text-primary-foreground hover:bg-primary/90 w-full md:w-auto"
          >
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin mr-1.5" />
                Salvando...
              </>
            ) : (
              "Salvar Configurações"
            )}
          </Button>
        )}
      </form>
    </section>
  );
}
