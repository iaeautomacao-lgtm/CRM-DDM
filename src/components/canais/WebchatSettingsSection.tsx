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
import { Skeleton } from "@/components/ui/skeleton";
import { TableCard } from "@/components/ddm/table-card";
import { ErrorState } from "@/components/dashboard/error-state";
import {
  DEFAULT_WEBCHAT_SETTINGS,
  WEBCHAT_BUTTON_MAX,
  WEBCHAT_SESSION_HOURS_MAX,
  type WebchatSettings,
} from "@/lib/webchat/settings";

type Option = { id: string; name: string };

export function WebchatSettingsSection({ flows }: { flows: Option[] }) {
  const [form, setForm] = useState<WebchatSettings>(DEFAULT_WEBCHAT_SETTINGS);
  // Último estado salvo: habilita "Descartar"/"Salvar" só quando algo mudou.
  const [saved, setSaved] = useState<WebchatSettings>(DEFAULT_WEBCHAT_SETTINGS);
  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  const [ready, setReady] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // Falha na carga: mostra ErrorState e esconde o formulário (salvar os padrões sobrescreveria a configuração real).
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/webchat/settings")
      .then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        const loaded = { ...DEFAULT_WEBCHAT_SETTINGS, ...(json.settings ?? {}) };
        setForm(loaded);
        setSaved(loaded);
        setReady(!!json.ready);
        setLoadError(null);
      })
      .catch(() => {
        if (!cancelled) setLoadError("Não foi possível carregar a configuração do Webchat.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

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
      const next = { ...DEFAULT_WEBCHAT_SETTINGS, ...json.settings };
      setForm(next);
      setSaved(next);
      toast.success("Configuração do Webchat salva.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao salvar");
    } finally {
      setSaving(false);
    }
  }

  const selectClass =
    "h-9 w-full rounded-md border border-border bg-card px-2 text-[13px] text-foreground outline-none focus:border-primary focus:shadow-[0_0_0_3px_var(--primary-soft-2)]";

  return (
    <TableCard
      title={
        <span className="flex items-center gap-2">
          <Globe className="size-4 text-cyan-600 dark:text-cyan-400" aria-hidden="true" />
          Webchat
        </span>
      }
      label="Webchat"
      hint={
        <>
          Página de atendimento que o cliente abre pelo link enviado no WhatsApp. É usada pela opção
          &quot;Enviar para o Webchat&quot; da campanha e pelo nó &quot;Enviar Webchat&quot; do fluxo.
        </>
      }
    >
      {ready === false && (
        <div className="mx-[18px] mb-3.5 rounded-[10px] border border-warning-border bg-warning-soft px-3.5 py-3 text-[12.5px] text-foreground-2" role="status">
          Configure <code className="font-mono text-foreground">NEXT_PUBLIC_APP_URL</code> (https) no servidor: sem ela os links do Webchat não são gerados.
        </div>
      )}

      <div className="border-t border-border px-[18px] py-4">
        {loading ? (
          <div className="grid gap-4 md:grid-cols-2" aria-busy="true">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex flex-col gap-1.5" aria-hidden="true">
                <Skeleton className="h-3 w-28" />
                <Skeleton className="h-9 w-full" />
              </div>
            ))}
          </div>
        ) : loadError ? (
          <ErrorState
            className="min-h-0"
            title={loadError}
            onRetry={() => {
              setLoading(true);
              setAttempt((n) => n + 1);
            }}
          />
        ) : (
          <div className="grid animate-ddm-fade gap-4 md:grid-cols-2">
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
                  className="h-9 w-12 cursor-pointer rounded-md border border-border bg-card"
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
              <p className="text-[11.5px] text-muted-foreground">{"{nome}"} vira o primeiro nome do cliente.</p>
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
                className={selectClass}
              >
                <option value="">— a campanha escolhe —</option>
                {flows.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
              <p className="text-[11.5px] text-muted-foreground">
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
          </div>
        )}
      </div>

      {/* Rodapé de configurações (padrão do protótipo): só age com mudança. */}
      {!loading && !loadError && (
        <div className="flex items-center justify-end gap-2 border-t border-border bg-card-2 px-[18px] py-3">
          {dirty && <span className="mr-auto text-xs text-muted-foreground">Alterações não salvas</span>}
          <Button variant="outline" onClick={() => setForm(saved)} disabled={!dirty || saving}>
            Descartar
          </Button>
          <Button onClick={save} disabled={!dirty || saving}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            Salvar alterações
          </Button>
        </div>
      )}
    </TableCard>
  );
}
