import { apiFetch } from "@/lib/api-fetch";
"use client";

// ============================================================
// NewChannelDialog — 2-step: pick provider, then fill its form.
// POST /api/whatsapp/config for both providers (same endpoint
// whatsapp-config.tsx uses — see that file's handleSave, lines
// 422-465 for WAHA, 467-520 for Meta). WAHA's POST auto-starts the
// session server-side (route.ts:384-401), so on success this just
// hands the created channel's waha_session back to the caller, which
// looks it up in a fresh GET and opens ConnectWahaDialog with it.
// ============================================================

import { useState } from "react";
import { toast } from "sonner";
import { MessageCircle, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { normalizeSessionName } from "./types";

type Provider = "waha" | "meta";

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
  const [verifyToken, setVerifyToken] = useState("");

  function reset() {
    setStep("choose");
    setProvider(null);
    setWahaSession("");
    setWahaUrl("");
    setWahaApiKey("");
    setPhoneNumberId("");
    setWabaId("");
    setAccessToken("");
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
          verify_token: verifyToken.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Falha ao criar canal");
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
                <Server className="size-6 text-[#14532D]" />
                <span className="text-sm font-medium text-foreground">WhatsApp Meta</span>
                <span className="text-xs text-muted-foreground">(Cloud API)</span>
              </button>
            </div>
          </div>
        ) : provider === "waha" ? (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="new-waha-session">Nome da sessão</Label>
              <Input
                id="new-waha-session"
                value={wahaSession}
                onChange={(e) => setWahaSession(e.target.value)}
                placeholder="ex.: sessaojoao"
                disabled={saving}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="new-waha-url">URL do WAHA</Label>
              <Input
                id="new-waha-url"
                value={wahaUrl}
                onChange={(e) => setWahaUrl(e.target.value)}
                placeholder="https://waha.exemplo.com"
                disabled={saving}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="new-waha-key">API Key</Label>
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
              <Label htmlFor="new-meta-phone-id">Phone Number ID</Label>
              <Input
                id="new-meta-phone-id"
                value={phoneNumberId}
                onChange={(e) => setPhoneNumberId(e.target.value)}
                disabled={saving}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="new-meta-waba-id">WABA ID</Label>
              <Input
                id="new-meta-waba-id"
                value={wabaId}
                onChange={(e) => setWabaId(e.target.value)}
                placeholder="(opcional)"
                disabled={saving}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="new-meta-token">Access Token</Label>
              <Input
                id="new-meta-token"
                type="password"
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
                disabled={saving}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="new-meta-verify">Verify Token</Label>
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
