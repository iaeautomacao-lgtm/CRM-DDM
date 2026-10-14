"use client";

// Configurações → Integrações → Provedores de IA: liga/desliga geral da IA da conta, provedor e chave de API.
// O prompt global, os recursos avançados e a voz moram em Agentes de IA → "Agente global (sem fluxo)".

import { Bot, Key, Loader2, MessageSquare } from "lucide-react";

import { aiProviderLabel } from "@/lib/ai/models";
import { cn } from "@/lib/utils";
import { ErrorState } from "@/components/ddm/states";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SettingsPanelHead } from "./settings-panel-head";
import { useAiConfig } from "./ai-config-shared";

export function AiProvidersPanel() {
  const { canEdit, form, patch, loading, loadError, retry, saving, save } = useAiConfig();

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  // Falha de carga não pode virar formulário com valores padrão (salvar sobrescreveria a configuração real).
  if (loadError) {
    return <ErrorState title="Não foi possível carregar a configuração do Agente de IA" hint={loadError} onRetry={retry} />;
  }

  return (
    <section className="max-w-3xl space-y-6">
      <SettingsPanelHead
        className="mb-0"
        title="Provedores de IA"
        description="Liga ou desliga a IA da conta e define o provedor e a chave usados pelos agentes, pelas respostas automáticas e pelo Acordito. Só o proprietário da conta altera."
      />

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="space-y-6"
      >
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
                checked={form.enabled}
                onCheckedChange={(v) => patch({ enabled: v })}
                disabled={!canEdit}
              />
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-2 rounded-lg border border-warning-border bg-warning-soft p-3 text-xs text-foreground">
              <MessageSquare className="size-4 shrink-0 text-warning" />
              <span>
                <strong>Nota:</strong> O agente de IA responderá apenas as conversas que <strong>não possuírem</strong> um atendente humano atribuído.
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Integration Card */}
        <Card className={!form.enabled ? "opacity-60" : ""}>
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
            <div className="space-y-2">
              <Label id="ai-provider-label" className="text-muted-foreground">Provedor ativo</Label>
              <div role="radiogroup" aria-labelledby="ai-provider-label" className="flex flex-wrap gap-2">
                {(["gemini", "openai", "claude", "hermes"] as const).map((p) => {
                  const on = form.apiProvider === p;
                  return (
                    <button
                      key={p}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      disabled={!form.enabled || !canEdit}
                      onClick={() => patch({ apiProvider: p })}
                      className={cn(
                        "h-9 rounded-md border px-3 text-[13px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60",
                        on ? "border-primary bg-primary-soft text-primary-text" : "border-border bg-card text-foreground hover:bg-surface-hover",
                      )}
                    >
                      {aiProviderLabel(p)}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2 md:col-span-2">
                <Label className="text-muted-foreground">Chave de API (API Key)</Label>
                <Input
                  type="password"
                  value={form.apiKey}
                  onChange={(e) => patch({ apiKey: e.target.value })}
                  disabled={!form.enabled || !canEdit}
                  placeholder={
                    form.apiProvider === "gemini"
                      ? "AIzaSy..."
                      : form.apiProvider === "openai"
                      ? "sk-proj-..."
                      : form.apiProvider === "claude"
                      ? "sk-ant-..."
                      : "Opcional"
                  }
                  className="text-sm placeholder:text-muted-foreground"
                />
              </div>
            </div>
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
