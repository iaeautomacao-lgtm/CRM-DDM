"use client";

// Provedores de IA → "Acordito no atendimento": liga/desliga do copiloto interno (as 3 sugestões de resposta no
// inbox) e o texto de orientação, que é da operação. GET/PUT /api/account/copilot-config (gravar exige ai.config).
// O Acordito nunca envia nada ao cliente; os Agentes de IA são outra coisa e não usam esse nome.

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { AcorditoMark, AcorditoMascote } from "@/components/ddm/acordito";
import { ErrorState } from "@/components/ddm/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { usePermission } from "@/hooks/use-permission";
import {
  ACORDITO_DEFAULT_GUIDANCE,
  ACORDITO_GUIDANCE_MAX,
  fetchCopilotConfig,
  saveCopilotConfig,
  type CopilotConfig,
} from "@/lib/acordito/client";

export function AcorditoSettingsSection() {
  const canEdit = usePermission("ai.config");
  const [saved, setSaved] = useState<CopilotConfig | null>(null);
  const [form, setForm] = useState<CopilotConfig>({ enabled: false, guidance: "" });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const cfg = await fetchCopilotConfig();
      setSaved(cfg);
      setForm(cfg);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível carregar o Acordito.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex h-24 items-center justify-center">
        <Loader2 className="size-5 animate-spin text-primary" aria-label="Carregando" />
      </div>
    );
  }
  // Falha de carga não vira formulário vazio: salvar sobrescreveria a configuração real.
  if (error) return <ErrorState title="Não foi possível carregar o Acordito" hint={error} onRetry={() => void load()} />;

  const dirty = !!saved && (saved.enabled !== form.enabled || saved.guidance !== form.guidance);

  async function save() {
    setSaving(true);
    try {
      const next = await saveCopilotConfig({ enabled: form.enabled, guidance: form.guidance.trim() });
      setSaved(next);
      setForm(next);
      toast.success("Acordito atualizado!");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível salvar o Acordito.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      className="max-w-3xl"
    >
      <Card>
        <CardHeader className="relative sm:pr-28">
          <AcorditoMascote width={72} className="absolute right-5 top-3 hidden sm:block" />
          <CardTitle className="flex items-center gap-2 text-foreground">
            <AcorditoMark size="md">Acordito no atendimento</AcorditoMark>
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            O Acordito sugere 3 respostas para quem está atendendo. A pessoa escolhe, edita e envia: ele nunca manda nada
            sozinho. Usa a chave de IA e a cota diária da conta.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="acordito-enabled" className="text-sm font-medium text-foreground">
                Sugerir respostas no inbox
              </Label>
              <p className="text-xs text-muted-foreground">Desligado, o painel do Acordito não aparece nas conversas.</p>
            </div>
            <Switch
              id="acordito-enabled"
              checked={form.enabled}
              onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v }))}
              disabled={!canEdit}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="acordito-guidance" className="text-muted-foreground">
              Orientação para o Acordito
            </Label>
            <Textarea
              id="acordito-guidance"
              value={form.guidance}
              onChange={(e) => setForm((f) => ({ ...f, guidance: e.target.value.slice(0, ACORDITO_GUIDANCE_MAX) }))}
              disabled={!canEdit || !form.enabled}
              rows={4}
              placeholder={ACORDITO_DEFAULT_GUIDANCE}
              className="font-sans text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Tom e regras das sugestões, escritos pela sua operação. Em branco, o Acordito usa uma orientação neutra e curta.
            </p>
          </div>

          {canEdit ? (
            <Button
              type="submit"
              disabled={saving || !dirty}
              className="w-full bg-primary-solid text-primary-foreground hover:bg-primary-solid-hover md:w-auto"
            >
              {saving ? (
                <>
                  <Loader2 className="mr-1.5 size-4 animate-spin" />
                  Salvando...
                </>
              ) : (
                "Salvar Acordito"
              )}
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">Só quem configura a IA da conta pode alterar o Acordito.</p>
          )}
        </CardContent>
      </Card>
    </form>
  );
}
