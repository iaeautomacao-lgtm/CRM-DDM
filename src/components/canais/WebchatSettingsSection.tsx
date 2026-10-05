"use client";

// Card "Webchat" em /canais: configuração da página que o cliente abre
// pelo link (nome, boas-vindas, cor, validade) e os padrões do convite da
// campanha (texto, botão, fluxo). O Webchat em si é disparado pela opção
// "enviar para o Webchat" da campanha ou pelo nó "Enviar Webchat" do fluxo.
// Dados em /api/webchat/settings (migration 133).

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Globe, Loader2 } from "lucide-react";
import { apiFetch } from "@/lib/api-fetch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  DEFAULT_WEBCHAT_SETTINGS,
  WEBCHAT_BUTTON_MAX,
  WEBCHAT_SESSION_HOURS_MAX,
  type WebchatSettings,
} from "@/lib/webchat/settings";

type Option = { id: string; name: string };

export function WebchatSettingsSection({ flows }: { flows: Option[] }) {
  const [form, setForm] = useState<WebchatSettings>(DEFAULT_WEBCHAT_SETTINGS);
  const [ready, setReady] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/webchat/settings")
      .then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        setForm({ ...DEFAULT_WEBCHAT_SETTINGS, ...(json.settings ?? {}) });
        setReady(!!json.ready);
      })
      .catch(() => {
        if (!cancelled) toast.error("Falha ao carregar a configuração do Webchat");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const set = (patch: Partial<WebchatSettings>) => setForm((f) => ({ ...f, ...patch }));

  async function save() {
    setSaving(true);
    try {
      const res = await apiFetch("/api/webchat/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setForm({ ...DEFAULT_WEBCHAT_SETTINGS, ...json.settings });
      toast.success("Configuração do Webchat salva.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao salvar");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
          <Globe className="size-4 text-cyan-600 dark:text-cyan-400" />
          Webchat
        </h2>
        <p className="text-sm text-muted-foreground">
          Página de atendimento que o cliente abre pelo link enviado no WhatsApp. É usada pela opção
          &quot;Enviar para o Webchat&quot; da campanha e pelo nó &quot;Enviar Webchat&quot; do fluxo.
        </p>
      </div>

      {ready === false && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          Configure <code>NEXT_PUBLIC_APP_URL</code> (https) no servidor: sem ela os links do Webchat não são gerados.
        </div>
      )}

      <div className="rounded-xl border border-border bg-card p-4">
        {loading ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="wc-name">Nome exibido</Label>
              <Input
                id="wc-name"
                value={form.display_name ?? ""}
                maxLength={60}
                placeholder="Nome da conta"
                onChange={(e) => set({ display_name: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wc-color">Cor</Label>
              <div className="flex items-center gap-2">
                <input
                  id="wc-color"
                  type="color"
                  value={form.accent_color ?? "#ff5706"}
                  onChange={(e) => set({ accent_color: e.target.value })}
                  className="h-9 w-12 cursor-pointer rounded-md border border-border bg-background"
                  aria-label="Cor do Webchat"
                />
                {form.accent_color && (
                  <Button variant="ghost" size="sm" onClick={() => set({ accent_color: null })}>
                    Usar a cor do tema
                  </Button>
                )}
              </div>
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="wc-welcome">Mensagem de boas-vindas</Label>
              <Textarea
                id="wc-welcome"
                rows={2}
                maxLength={300}
                value={form.welcome_message ?? ""}
                placeholder="Olá, {nome}! Já vamos te atender."
                onChange={(e) => set({ welcome_message: e.target.value })}
              />
              <p className="text-[11px] text-muted-foreground">{"{nome}"} vira o primeiro nome do cliente.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wc-hours">Validade do link (horas)</Label>
              <Input
                id="wc-hours"
                type="number"
                min={1}
                max={WEBCHAT_SESSION_HOURS_MAX}
                value={form.session_hours}
                onChange={(e) =>
                  set({
                    session_hours: Math.min(
                      WEBCHAT_SESSION_HOURS_MAX,
                      Math.max(1, Math.trunc(Number(e.target.value)) || 1),
                    ),
                  })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wc-flow">Fluxo padrão do convite de campanha</Label>
              <select
                id="wc-flow"
                value={form.default_flow_id ?? ""}
                onChange={(e) => set({ default_flow_id: e.target.value || null })}
                className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground"
              >
                <option value="">— a campanha escolhe —</option>
                {flows.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-muted-foreground">
                Só fluxos ativos. Campanhas com Webchat ligado e sem fluxo próprio passam a usar este.
              </p>
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="wc-invite">Texto padrão do convite</Label>
              <Textarea
                id="wc-invite"
                rows={2}
                maxLength={1000}
                value={form.default_invite_message ?? ""}
                placeholder="Usado quando a campanha não define o seu"
                onChange={(e) => set({ default_invite_message: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wc-button">
                Texto padrão do botão ({(form.default_button_text ?? "").length}/{WEBCHAT_BUTTON_MAX})
              </Label>
              <Input
                id="wc-button"
                maxLength={WEBCHAT_BUTTON_MAX}
                value={form.default_button_text ?? ""}
                placeholder="Abrir atendimento"
                onChange={(e) => set({ default_button_text: e.target.value })}
              />
            </div>
            <div className="flex items-end justify-end md:col-span-2">
              <Button onClick={save} disabled={saving}>
                {saving && <Loader2 className="size-4 animate-spin" />}
                Salvar Webchat
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
