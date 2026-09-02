"use client";

import { apiFetch } from "@/lib/api-fetch";

// ============================================================
// NewChannelDialog — 2-step: pick provider, then fill its form.
// POST /api/whatsapp/config for both providers (same endpoint
// whatsapp-config.tsx uses — see that file's handleSave, lines
// 422-465 for WAHA, 467-520 for Meta). WAHA's POST auto-starts the
// session server-side (route.ts:384-401), so on success this just
// hands the created channel's waha_session back to the caller, which
// looks it up in a fresh GET and opens ConnectWahaDialog with it.
// ============================================================

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Cloud, Info, MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { normalizeSessionName } from "./types";

type Provider = "waha" | "meta";

// ------------------------------------------------------------
// Non-sensitive form-field persistence — remembers wahaUrl/
// phoneNumberId/wabaId across dialog sessions (e.g. an org that
// always connects Meta numbers under the same WABA doesn't have to
// retype it every time). Never stores waha_api_key/access_token/
// verify_token — those are credentials, not conveniences.
// ------------------------------------------------------------
const CHANNEL_DEFAULTS_KEY = "wacrm_new_channel_defaults";

interface ChannelDefaults {
  wahaUrl: string;
  phoneNumberId: string;
  wabaId: string;
}

function readChannelDefaults(): Partial<ChannelDefaults> {
  try {
    const raw = localStorage.getItem(CHANNEL_DEFAULTS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // Private browsing / storage disabled — just start blank.
    return {};
  }
}

function writeChannelDefaults(patch: Partial<ChannelDefaults>) {
  try {
    const current = readChannelDefaults();
    localStorage.setItem(CHANNEL_DEFAULTS_KEY, JSON.stringify({ ...current, ...patch }));
  } catch {
    // Non-fatal — the channel is already saved server-side by this point.
  }
}

/** Label + explanatory Info tooltip, used above every field in both forms. */
function FieldLabel({
  htmlFor,
  tooltip,
  children,
}: {
  htmlFor: string;
  tooltip: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Label htmlFor={htmlFor}>{children}</Label>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger
            render={<Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />}
          />
          <TooltipContent className="max-w-[260px] text-xs">{tooltip}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}

export function NewChannelDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (provider: Provider, wahaSession?: string) => void;
}) {
  const [step, setStep] = useState<"choose" | "form">("choose");
  const [provider, setProvider] = useState<Provider | null>(null);
  const [saving, setSaving] = useState(false);

  // WAHA fields
  const [wahaSession, setWahaSession] = useState("");
  const [wahaUrl, setWahaUrl] = useState("");
  const [wahaApiKey, setWahaApiKey] = useState("");

  // Meta fields
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [wabaId, setWabaId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [verifyToken, setVerifyToken] = useState("");

  // Prefill the non-sensitive fields on first mount — this dialog is
  // rendered once by the /canais page and toggled via `open`, so this
  // never re-fires on subsequent opens (reset() below handles that case).
  useEffect(() => {
    const defaults = readChannelDefaults();
    if (defaults.wahaUrl) setWahaUrl(defaults.wahaUrl);
    if (defaults.phoneNumberId) setPhoneNumberId(defaults.phoneNumberId);
    if (defaults.wabaId) setWabaId(defaults.wabaId);
  }, []);

  function reset() {
    // Restores (not blanks) the non-sensitive fields from localStorage —
    // reset() runs every time the dialog closes, so this is what makes
    // "comes back prefilled" true on the *next* open too, not just the
    // component's very first mount.
    const defaults = readChannelDefaults();
    setStep("choose");
    setProvider(null);
    setWahaSession("");
    setWahaUrl(defaults.wahaUrl ?? "");
    setWahaApiKey("");
    setPhoneNumberId(defaults.phoneNumberId ?? "");
    setWabaId(defaults.wabaId ?? "");
    setAccessToken("");
    setAppSecret("");
    setVerifyToken("");
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  function chooseProvider(p: Provider) {
    setProvider(p);
    setStep("form");
  }

  async function handleCreateWaha() {
    const session = normalizeSessionName(wahaSession);
    if (!session) {
      toast.error("Nome da sessão é obrigatório");
      return;
    }
    if (!wahaUrl.trim()) {
      toast.error("URL do WAHA é obrigatória");
      return;
    }
    setSaving(true);
    try {
      const res = await apiFetch("/api/whatsapp/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "waha",
          waha_url: wahaUrl.trim(),
          waha_session: session,
          waha_api_key: wahaApiKey.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Falha ao criar canal");
      writeChannelDefaults({ wahaUrl: wahaUrl.trim() });
      toast.success(data.message || "Canal WAHA criado.");
      handleOpenChange(false);
      onCreated("waha", session);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao criar canal WAHA");
    } finally {
      setSaving(false);
    }
  }

  async function handleCreateMeta() {
    if (!phoneNumberId.trim()) {
      toast.error("Phone Number ID é obrigatório");
      return;
    }
    if (!accessToken.trim()) {
      toast.error("Access Token é obrigatório");
      return;
    }
    if (!appSecret.trim()) {
      toast.error("App Secret é obrigatório");
      return;
    }
    setSaving(true);
    try {
      const res = await apiFetch("/api/whatsapp/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "meta",
          phone_number_id: phoneNumberId.trim(),
          waba_id: wabaId.trim() || null,
          access_token: accessToken.trim(),
          app_secret: appSecret.trim(),
          verify_token: verifyToken.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Falha ao criar canal");
      writeChannelDefaults({ phoneNumberId: phoneNumberId.trim(), wabaId: wabaId.trim() });
      toast.success("Canal Meta salvo.");
      handleOpenChange(false);
      onCreated("meta");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao criar canal Meta");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Novo Canal</DialogTitle>
        </DialogHeader>

        {step === "choose" ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Escolha o tipo de canal:</p>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => chooseProvider("waha")}
                className="flex flex-col items-center gap-2 rounded-xl border border-border p-4 text-center hover:bg-muted"
              >
                <MessageCircle className="size-6 text-[#25D366]" />
                <span className="text-sm font-medium text-foreground">WhatsApp WAHA</span>
                <span className="text-xs text-muted-foreground">(via WAHA API)</span>
              </button>
              <button
                type="button"
                onClick={() => chooseProvider("meta")}
                className="flex flex-col items-center gap-2 rounded-xl border border-border p-4 text-center hover:bg-muted"
              >
                <Cloud className="h-8 w-8 text-[#25D366]" />
                <span className="text-sm font-medium text-foreground">WhatsApp Meta</span>
                <span className="text-xs text-muted-foreground">(Cloud API)</span>
              </button>
            </div>
          </div>
        ) : provider === "waha" ? (
          <div className="space-y-3">
            <div className="space-y-1">
              <FieldLabel
                htmlFor="new-waha-session"
                tooltip="Identificador único desta sessão no servidor WAHA. Use letras minúsculas, números e hífens. Ex.: sessao-ddm-1"
              >
                Nome da sessão
              </FieldLabel>
              <Input
                id="new-waha-session"
                value={wahaSession}
                onChange={(e) => setWahaSession(e.target.value)}
                placeholder="ex.: sessaojoao"
                disabled={saving}
              />
            </div>
            <div className="space-y-1">
              <FieldLabel
                htmlFor="new-waha-url"
                tooltip="Endereço do servidor WAHA onde a sessão será criada. Ex.: https://api.meuchatia.com.br"
              >
                URL do WAHA
              </FieldLabel>
              <Input
                id="new-waha-url"
                value={wahaUrl}
                onChange={(e) => setWahaUrl(e.target.value)}
                placeholder="https://waha.exemplo.com"
                disabled={saving}
              />
            </div>
            <div className="space-y-1">
              <FieldLabel
                htmlFor="new-waha-key"
                tooltip="Chave de autenticação do servidor WAHA. Deixe em branco se o servidor não exigir autenticação."
              >
                API Key
              </FieldLabel>
              <Input
                id="new-waha-key"
                type="password"
                value={wahaApiKey}
                onChange={(e) => setWahaApiKey(e.target.value)}
                placeholder="(opcional)"
                disabled={saving}
              />
            </div>
            <div className="flex justify-between pt-2">
              <Button variant="outline" onClick={() => setStep("choose")} disabled={saving}>
                Voltar
              </Button>
              <Button
                onClick={handleCreateWaha}
                disabled={saving}
                className="bg-[#FF5706] text-white hover:bg-[#FF5706]/90"
              >
                {saving ? "Criando…" : "Criar e conectar"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1">
              <FieldLabel
                htmlFor="new-meta-phone-id"
                tooltip="ID do número de telefone registrado na WhatsApp Cloud API. Encontre em: Meta Developers → seu app → WhatsApp → Configuração da API."
              >
                Número de telefone ID
              </FieldLabel>
              <Input
                id="new-meta-phone-id"
                value={phoneNumberId}
                onChange={(e) => setPhoneNumberId(e.target.value)}
                disabled={saving}
              />
            </div>
            <div className="space-y-1">
              <FieldLabel
                htmlFor="new-meta-waba-id"
                tooltip="ID da conta WhatsApp Business. Encontre ao lado do Phone Number ID no painel do Meta Developers."
              >
                ID WABA
              </FieldLabel>
              <Input
                id="new-meta-waba-id"
                value={wabaId}
                onChange={(e) => setWabaId(e.target.value)}
                placeholder="(opcional)"
                disabled={saving}
              />
            </div>
            <div className="space-y-1">
              <FieldLabel
                htmlFor="new-meta-token"
                tooltip="Token permanente de um Usuário do Sistema com permissões whatsapp_business_messaging e whatsapp_business_management. Gere em: Meta Business Manager → Usuários do sistema."
              >
                Token de acesso
              </FieldLabel>
              <Input
                id="new-meta-token"
                type="password"
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
                disabled={saving}
              />
            </div>
            <div className="space-y-1">
              <FieldLabel
                htmlFor="new-meta-app-secret"
                tooltip="Encontrado em developers.facebook.com → Seu App → Configurações → Básico → App Secret"
              >
                App Secret
              </FieldLabel>
              <Input
                id="new-meta-app-secret"
                type="password"
                value={appSecret}
                onChange={(e) => setAppSecret(e.target.value)}
                disabled={saving}
              />
            </div>
            <div className="space-y-1">
              <FieldLabel
                htmlFor="new-meta-verify"
                tooltip="String definida por você para validar o webhook. Use o valor configurado no CRM: omnicrm_ddm_webhook_2026"
              >
                Verificar token
              </FieldLabel>
              <Input
                id="new-meta-verify"
                value={verifyToken}
                onChange={(e) => setVerifyToken(e.target.value)}
                placeholder="(opcional)"
                disabled={saving}
              />
            </div>
            <div className="flex justify-between pt-2">
              <Button variant="outline" onClick={() => setStep("choose")} disabled={saving}>
                Voltar
              </Button>
              <Button
                onClick={handleCreateMeta}
                disabled={saving}
                className="bg-[#FF5706] text-white hover:bg-[#FF5706]/90"
              >
                {saving ? "Salvando…" : "Salvar"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}