"use client";

// Integrações → Rastreamento (UTMpay): base URL, chave, segredo do webhook, janela de atribuição e o que fazer se o UTMpay
// cair. GET/PUT /api/account/utmpay-config (settings.account). Chave e segredo são write-only: nunca voltam do servidor,
// só o "já configurado"; vazio = manter. O servidor cifra (resolveSecretForWrite).

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Check, Copy, Loader2 } from "lucide-react";

import { ErrorState } from "@/components/ddm/states";
import { StatusChip } from "@/components/ddm/status-chip";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SettingsPanelHead } from "./settings-panel-head";
import { fetchConfig, saveConfig, testConfig, type UtmpayConfig, type UtmpayConfigInput } from "@/lib/utmpay/api-client";

interface Form {
  enabled: boolean;
  base_url: string;
  api_key: string;
  webhook_secret: string;
  janela_dias: string;
  send_without_tracking: boolean;
}

function toForm(c: UtmpayConfig): Form {
  return {
    enabled: c.enabled,
    base_url: c.base_url,
    api_key: "",
    webhook_secret: "",
    janela_dias: String(c.janela_dias),
    send_without_tracking: c.send_without_tracking,
  };
}

/** Monta o PUT só com o que mudou; chave/segredo vazios ficam de fora (o servidor mantém o atual). */
export function buildInput(form: Form, saved: UtmpayConfig): { input: UtmpayConfigInput; error: string | null } {
  const dias = Number(form.janela_dias);
  if (!Number.isInteger(dias) || dias < 1 || dias > 90) return { input: {}, error: "A janela de atribuição vai de 1 a 90 dias." };
  const base = form.base_url.trim();
  if (base && !/^https:\/\/[^/\s]+\/?$/i.test(base)) return { input: {}, error: "Use o endereço do UTMpay com https e sem caminho (ex.: https://utmpay.suaempresa.com.br)." };
  if (form.enabled && !base) return { input: {}, error: "Informe o endereço do UTMpay para ligar o rastreamento." };
  const input: UtmpayConfigInput = {
    enabled: form.enabled,
    base_url: base.replace(/\/$/, ""),
    janela_dias: dias,
    send_without_tracking: form.send_without_tracking,
  };
  if (form.api_key.trim()) input.api_key = form.api_key.trim();
  if (form.webhook_secret.trim()) input.webhook_secret = form.webhook_secret.trim();
  if (form.enabled && !saved.has_api_key && !input.api_key) return { input: {}, error: "Informe a chave do UTMpay para ligar o rastreamento." };
  if (form.enabled && !saved.has_webhook_secret && !input.webhook_secret) return { input: {}, error: "Informe o segredo do webhook para ligar o rastreamento." };
  return { input, error: null };
}

export function UtmpaySettings() {
  const [saved, setSaved] = useState<UtmpayConfig | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchConfig().then(
      (c) => {
        setSaved(c);
        setForm(toForm(c));
        setLoading(false);
      },
      (e: unknown) => {
        setError((e as Error)?.message ?? "Não foi possível carregar.");
        setLoading(false);
      },
    );
  }, []);
  useEffect(load, [load]);

  if (loading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <Loader2 className="size-5 animate-spin text-primary" aria-label="Carregando" />
      </div>
    );
  }
  // Falha de carga não vira formulário vazio: salvar sobrescreveria a configuração real.
  if (error || !saved || !form) return <ErrorState title="Não foi possível carregar o rastreamento" hint={error ?? undefined} onRetry={load} />;

  if (!saved.available) {
    return (
      <section className="max-w-3xl">
        <SettingsPanelHead className="mb-0" title="Rastreamento (UTMpay)" description="Indisponível neste ambiente: a atualização do banco de dados do rastreamento ainda não foi aplicada." />
      </section>
    );
  }

  const set = (patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch } : f));

  async function onSave() {
    if (!saved || !form) return;
    const { input, error: invalid } = buildInput(form, saved);
    if (invalid) {
      toast.error(invalid);
      return;
    }
    setSaving(true);
    try {
      const next = await saveConfig(input);
      setSaved(next);
      setForm(toForm(next));
      toast.success("Rastreamento atualizado!");
    } catch (e) {
      toast.error((e as Error)?.message ?? "Não foi possível salvar.");
    } finally {
      setSaving(false);
    }
  }

  async function onTest() {
    setTesting(true);
    try {
      const r = await testConfig();
      (r.ok ? toast.success : toast.error)(r.message);
    } catch (e) {
      toast.error((e as Error)?.message ?? "Não foi possível testar agora.");
    } finally {
      setTesting(false);
    }
  }

  async function copyEvents() {
    try {
      await navigator.clipboard.writeText(saved?.events_url ?? "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Não foi possível copiar. Selecione e copie o endereço.");
    }
  }

  const dirty = JSON.stringify(form) !== JSON.stringify(toForm(saved));

  return (
    <section className="max-w-3xl space-y-6">
      <SettingsPanelHead
        className="mb-0"
        title="Rastreamento (UTMpay)"
        description="Cada contato recebe um link rastreado do UTMpay, um por envio. O link que a operação informa na campanha vira o destino; o CRM mostra quem clicou, fechou acordo e pagou."
        action={
          <StatusChip tone={saved.enabled ? "ok" : "mute"}>{saved.enabled ? "Ligado" : saved.configured ? "Desligado" : "Não configurado"}</StatusChip>
        }
      />

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void onSave();
        }}
        className="space-y-6"
      >
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">Conexão</CardTitle>
            <CardDescription>Endereço e credenciais do UTMpay. A chave e o segredo ficam cifrados e nunca são mostrados de novo.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label htmlFor="utmpay-enabled" className="text-sm font-medium text-foreground">
                  Rastrear todos os disparos
                </Label>
                <p className="text-xs text-muted-foreground">Ligado, todo disparo sai com link rastreado. Não há opção por campanha.</p>
              </div>
              <Switch id="utmpay-enabled" checked={form.enabled} onCheckedChange={(v) => set({ enabled: v })} />
            </div>

            <div className="space-y-2">
              <Label htmlFor="utmpay-base">Endereço do UTMpay</Label>
              <Input id="utmpay-base" value={form.base_url} onChange={(e) => set({ base_url: e.target.value })} placeholder="https://utmpay.suaempresa.com.br" inputMode="url" autoComplete="off" />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="utmpay-key">Chave de acesso (X-API-Key)</Label>
                <Input
                  id="utmpay-key"
                  type="password"
                  value={form.api_key}
                  onChange={(e) => set({ api_key: e.target.value })}
                  placeholder={saved.has_api_key ? "••••••••  (deixe em branco para manter)" : "Cole a chave"}
                  autoComplete="new-password"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="utmpay-secret">Segredo do webhook</Label>
                <Input
                  id="utmpay-secret"
                  type="password"
                  value={form.webhook_secret}
                  onChange={(e) => set({ webhook_secret: e.target.value })}
                  placeholder={saved.has_webhook_secret ? "••••••••  (deixe em branco para manter)" : "Crie um segredo forte"}
                  autoComplete="new-password"
                />
              </div>
            </div>

            {saved.events_url && (
              <div className="space-y-1.5">
                <Label htmlFor="utmpay-events">Endereço dos eventos (cadastre no UTMpay)</Label>
                <div className="flex gap-2">
                  <Input id="utmpay-events" readOnly value={saved.events_url} className="font-mono text-xs" />
                  <Button type="button" variant="outline" onClick={() => void copyEvents()} aria-label="Copiar endereço dos eventos">
                    {copied ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">No UTMpay: CRM_EVENTS_URL = este endereço e CRM_EVENTS_SECRET = o segredo do webhook acima.</p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">Atribuição e falhas</CardTitle>
            <CardDescription>Quem fechou: Direto (o contato não escreveu), IA (só a IA ou o fluxo respondeu) ou Humano (algum atendente respondeu; vale o último).</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="max-w-[220px] space-y-2">
              <Label htmlFor="utmpay-janela">Janela de atribuição (dias)</Label>
              <Input id="utmpay-janela" type="number" min={1} max={90} value={form.janela_dias} onChange={(e) => set({ janela_dias: e.target.value })} />
              <p className="text-xs text-muted-foreground">Eventos até esse prazo depois do envio contam para a campanha. Padrão: 7.</p>
            </div>
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label htmlFor="utmpay-fallback" className="text-sm font-medium text-foreground">
                  Enviar sem rastreio se o UTMpay cair
                </Label>
                <p className="text-xs text-muted-foreground">Desligado (recomendado): o item não sai e é tentado de novo, com o erro à vista na campanha.</p>
              </div>
              <Switch id="utmpay-fallback" checked={form.send_without_tracking} onCheckedChange={(v) => set({ send_without_tracking: v })} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">Como funciona o link</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
              <li>O destino precisa ser https e de um domínio permitido no UTMpay; fora da lista, o envio não sai e o erro aparece no item.</li>
              <li>Só a primeira URL da mensagem é rastreada.</li>
              <li>Em template da Meta, a URL precisa estar numa variável ({"{{n}}"}); URL escrita fixa no texto aprovado não é trocada e fica sem rastreio.</li>
            </ul>
          </CardContent>
        </Card>

        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={saving || !dirty} className="bg-primary-solid text-primary-foreground hover:bg-primary-solid-hover">
            {saving ? (
              <>
                <Loader2 className="mr-1.5 size-4 animate-spin" />
                Salvando...
              </>
            ) : (
              "Salvar"
            )}
          </Button>
          {saved.configured && (
            <Button type="button" variant="outline" disabled={testing || dirty} onClick={() => void onTest()} title={dirty ? "Salve antes de testar" : undefined}>
              {testing ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
              Testar conexão
            </Button>
          )}
        </div>
      </form>
    </section>
  );
}
