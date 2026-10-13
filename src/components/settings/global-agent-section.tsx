"use client";

// Agentes de IA → "Agente global (sem fluxo)": a resposta automática da conta (a que responde quando nenhum fluxo
// atende a mensagem). Prompt global, Google Search, mídia (áudio/imagem), voz ElevenLabs e base de conhecimento.
// Mesma API e mesmos campos da antiga tela de Provedores de IA; o liga/desliga geral, o provedor e a chave
// continuam em Configurações → Integrações → Provedores de IA.

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Bot, FileText, Globe, Loader2, MessageSquare, Sparkles, Trash2, Upload, Volume2 } from "lucide-react";

import { KB_ACCEPT } from "@/lib/ai/knowledge/limits";
import { AgentApiError, fetchKnowledgeBaseFiles, removeKnowledgeFile, uploadKnowledgeFile } from "./agents/api";
import { ErrorState } from "@/components/ddm/states";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SettingsPanelHead } from "./settings-panel-head";
import { PromptHistoryButton } from "@/components/ai/prompt-history-button";
import { useAiConfig } from "./ai-config-shared";

/** Só aparece para quem edita a IA da conta (ai.config): a rota exige a mesma permissão. */
export function GlobalAgentSection() {
  const { accountId, canEdit, form, patch, loading, loadError, retry, saving, save } = useAiConfig();

  // Base de conhecimento: leitura, envio e remoção SÓ pelo servidor (migration 214; texto extraído lá).
  const [kbFiles, setKbFiles] = useState<{ id: string; name: string; created_at: string }[]>([]);
  const [uploadingKb, setUploadingKb] = useState(false);

  async function loadKbFiles() {
    try {
      setKbFiles(await fetchKnowledgeBaseFiles());
    } catch (err) {
      console.error("Failed to load knowledge base files:", err);
    }
  }

  useEffect(() => {
    if (!accountId || !canEdit) return;
    void loadKbFiles();
  }, [accountId, canEdit]);

  if (!canEdit) return null;

  async function handleKbUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !accountId) return;

    setUploadingKb(true);
    try {
      await uploadKnowledgeFile(file);
      toast.success("Documento adicionado à base de conhecimento!");
      void loadKbFiles();
    } catch (err) {
      console.error("Failed to upload file:", err);
      toast.error(err instanceof AgentApiError ? err.message : "Erro ao fazer upload do arquivo");
    } finally {
      setUploadingKb(false);
    }
  }

  async function handleKbDelete(id: string) {
    try {
      await removeKnowledgeFile(id);
      toast.success("Documento removido!");
      void loadKbFiles();
    } catch (err) {
      console.error("Failed to delete document:", err);
      toast.error(err instanceof AgentApiError ? err.message : "Erro ao remover documento");
    }
  }

  if (loading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  // Falha de carga não pode virar formulário com valores padrão (salvar sobrescreveria a configuração real).
  if (loadError) {
    return <ErrorState title="Não foi possível carregar o agente global" hint={loadError} onRetry={retry} />;
  }

  return (
    <section className="mt-10 max-w-3xl space-y-6">
      <SettingsPanelHead
        className="mb-0"
        title="Agente global (sem fluxo)"
        description="Responde as conversas que nenhum fluxo atende e não têm atendente humano atribuído. Liga e desliga em Configurações → Integrações → Provedores de IA."
      />
      {!form.enabled && (
        <p className="rounded-lg border border-warning-border bg-warning-soft p-3 text-xs text-foreground">
          A IA da conta está desligada em Provedores de IA: o agente global não responde até ser ligada.
        </p>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="space-y-6"
      >
        {/* Behavioral Settings Card */}
        <Card className={!form.enabled ? "opacity-60" : ""}>
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
              <div className="flex items-center justify-between gap-2">
                <Label className="text-muted-foreground">Instruções para o Agente</Label>
                {canEdit && (
                  <PromptHistoryButton
                    target={{ scope: "account" }}
                    currentContent={form.systemPrompt.trim()}
                    onRestore={(v) => patch({ systemPrompt: v })}
                    disabled={!form.enabled}
                  />
                )}
              </div>
              <Textarea
                value={form.systemPrompt}
                onChange={(e) => patch({ systemPrompt: e.target.value })}
                disabled={!form.enabled || !canEdit}
                rows={6}
                placeholder={`Você é um assistente virtual atencioso da nossa empresa. Seu objetivo é ajudar os clientes.`}
                className="text-sm font-sans"
              />
            </div>
          </CardContent>
        </Card>

        {/* Advanced Capabilities Card */}
        <Card className={!form.enabled ? "opacity-60" : ""}>
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
                checked={form.googleSearchEnabled}
                onCheckedChange={(v) => patch({ googleSearchEnabled: v })}
                disabled={!form.enabled || !canEdit}
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
                checked={form.multimodalEnabled}
                onCheckedChange={(v) => patch({ multimodalEnabled: v })}
                disabled={!form.enabled || !canEdit}
              />
            </div>
          </CardContent>
        </Card>

        {/* ElevenLabs Card */}
        <Card className={!form.enabled ? "opacity-60" : ""}>
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
                checked={form.elevenlabsEnabled}
                onCheckedChange={(v) => patch({ elevenlabsEnabled: v })}
                disabled={!form.enabled || !canEdit}
              />
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {form.elevenlabsEnabled && (
              <div className="grid gap-4 md:grid-cols-2 animate-in slide-in-from-top-2 duration-200">
                <div className="space-y-2 md:col-span-2">
                  <Label className="text-muted-foreground">ElevenLabs API Key</Label>
                  <Input
                    type="password"
                    value={form.elevenlabsApiKey}
                    onChange={(e) => patch({ elevenlabsApiKey: e.target.value })}
                    disabled={!canEdit}
                    placeholder="Cole sua API Key do ElevenLabs"
                    className="text-sm placeholder:text-muted-foreground"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-muted-foreground">Voice ID</Label>
                  <Input
                    type="text"
                    value={form.elevenlabsVoiceId}
                    onChange={(e) => patch({ elevenlabsVoiceId: e.target.value })}
                    disabled={!canEdit}
                    placeholder="ID da voz (padrão ou clonada)"
                    className="text-sm placeholder:text-muted-foreground"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-muted-foreground">Model ID</Label>
                  <Input
                    type="text"
                    value={form.elevenlabsModelId}
                    onChange={(e) => patch({ elevenlabsModelId: e.target.value })}
                    disabled={!canEdit}
                    placeholder="eleven_multilingual_v2"
                    className="text-sm placeholder:text-muted-foreground"
                  />
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* File Search Knowledge Base Card */}
        <Card className={!form.enabled ? "opacity-60" : ""}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-foreground">
              <FileText className="size-4 text-primary" />
              Base de conhecimento (File Search RAG)
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
                  uploadingKb || !form.enabled ? "pointer-events-none opacity-50" : ""
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
                    <span className="text-sm font-medium text-muted-foreground">Carregar Documento (.pdf, .docx, .txt, .md, .csv)</span>
                  </>
                )}
                <input
                  id="kb-upload"
                  type="file"
                  accept={KB_ACCEPT}
                  onChange={handleKbUpload}
                  disabled={uploadingKb || !form.enabled || !canEdit}
                  className="hidden"
                />
              </Label>
            </div>

            {/* Files List */}
            {kbFiles.length > 0 ? (
              <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3 max-h-52 overflow-y-auto">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
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
                      <span className="text-xs text-muted-foreground">
                        {new Date(file.created_at).toLocaleDateString("pt-BR")}
                      </span>
                      {canEdit && (
                        <button
                          type="button"
                          onClick={() => handleKbDelete(file.id)}
                          className="text-muted-foreground hover:text-danger p-1.5 rounded hover:bg-muted cursor-pointer"
                          title="Remover documento"
                          aria-label={`Remover documento ${file.name}`}
                        >
                          <Trash2 className="size-3.5" aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center p-6 border border-dashed border-border/60 rounded-lg bg-muted/10 text-center">
                <FileText className="size-6 text-muted-foreground mb-1.5" aria-hidden="true" />
                <p className="text-xs text-muted-foreground">Sua base de conhecimento está vazia.</p>
                <p className="text-xs text-muted-foreground mt-0.5">Faça upload de arquivos acima para o robô poder consultá-los.</p>
              </div>
            )}
          </CardContent>
        </Card>


        {canEdit && (
          <Button
            type="submit"
            disabled={saving}
            className="bg-primary-solid text-primary-foreground hover:bg-primary-solid-hover w-full md:w-auto"
          >
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin mr-1.5" />
                Salvando...
              </>
            ) : (
              "Salvar configurações"
            )}
          </Button>
        )}
      </form>
    </section>
  );
}
