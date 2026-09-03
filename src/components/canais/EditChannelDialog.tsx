"use client";

import { apiFetch } from "@/lib/api-fetch";

// ============================================================
// EditChannelDialog — same form as NewChannelDialog, pre-filled, POST
// with `id` set (there is no PUT — Passo 0 confirmed
// src/app/api/whatsapp/config/route.ts only has GET/POST/DELETE;
// whatsapp-config.tsx's handleSave uses the same POST for create AND
// update, keyed on whether `id` is in the body).
//
// GET /api/whatsapp/config never returns waha_api_key, waba_id, or
// verify_token (see types.ts's ChannelConfig comment) — same gap
// whatsapp-config.tsx has, not introduced here. phone_number_id is
// only available via phone_info.id, and only when the Meta health
// check last succeeded.
//
// Deliberate improvement over whatsapp-config.tsx for WAHA specifically:
// that component initializes wahaApiKey to '' (not the masked
// placeholder) when editing, because c.waha_api_key is never present
// in the GET response — so saving without retyping the key sends ''
// to the server, which the server treats as "no key provided" and
// overwrites the existing encrypted key with null. This dialog always
// shows the masked placeholder for an existing WAHA channel and sends
// the literal MASKED_TOKEN sentinel when untouched, which route.ts
// already handles correctly (`if (waha_api_key === MASKED_TOKEN)
// wahaConfigObj.waha_api_key = existing.waha_api_key`) — using only
// the server's own existing branch, not new server logic.
// ============================================================

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { MASKED_TOKEN, normalizeSessionName, type ChannelConfig } from "./types";

const NO_FLOW = "__none__";

export function EditChannelDialog({
  config,
  flows,
  open,
  onOpenChange,
  onSaved,
}: {
  config: ChannelConfig | null;
  flows: { id: string; name: string }[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [flowId, setFlowId] = useState<string>(NO_FLOW);
  // Shared by both providers (same whatsapp_config columns, same PATCH
  // endpoint the /canais table's inline toggles use).
  const [receptivo, setReceptivo] = useState(true);
  const [habilitado, setHabilitado] = useState(true);

  // WAHA
  const [wahaSession, setWahaSession] = useState("");
  const [wahaUrl, setWahaUrl] = useState("");
  const [wahaApiKey, setWahaApiKey] = useState(MASKED_TOKEN);
  const [apiKeyEdited, setApiKeyEdited] = useState(false);

  // Meta
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [wabaId, setWabaId] = useState("");
  const [verifyToken, setVerifyToken] = useState("");
  const [accessToken, setAccessToken] = useState(MASKED_TOKEN);
  const [tokenEdited, setTokenEdited] = useState(false);
  // App Secret is never returned by GET (like access_token), but unlike
  // it, there's no masked-placeholder dance here — it just starts blank.
  // Blank on submit means "keep the value already in the DB" (see
  // route.ts's POST handler).
  const [appSecret, setAppSecret] = useState("");

  useEffect(() => {
    if (!config) return;
    setFlowId(config.flow_id ?? NO_FLOW);
    setReceptivo(config.receptivo);
    setHabilitado(config.habilitado);
    if (config.provider === "waha") {
      setWahaSession(config.waha_session ?? "");
      setWahaUrl(config.waha_url ?? "");
      setWahaApiKey(MASKED_TOKEN);
      setApiKeyEdited(false);
    } else {
      setPhoneNumberId(config.phone_info?.id ?? "");
      setWabaId("");
      setVerifyToken("");
      // A channel that's down because of a bad/expired token gets the
      // token field pre-opened (as if "Substituir token" was already
      // clicked) instead of the masked placeholder — the whole point
      // of opening this dialog for one of these is to paste a new
      // token, so don't make the user find the reveal button first.
      const hasInvalidToken = config.reason === "token_corrupted" || config.needs_reset === true;
      if (hasInvalidToken) {
        setAccessToken("");
        setTokenEdited(true);
        toast.warning("Este canal está com token inválido. Cole o novo token de acesso abaixo.", {
          duration: 8000,
        });
      } else {
        setAccessToken(MASKED_TOKEN);
        setTokenEdited(false);
      }
      setAppSecret("");
    }
  }, [config]);

  // flow_id/receptivo/habilitado have no home in POST (that endpoint
  // never reads them — see route.ts's destructuring) — they're
  // persisted through the same PATCH /canais's inline toggles use
  // (migration 056 + the PATCH handler). Fired after the provider POST
  // succeeds so a settings-save failure doesn't look like the whole
  // edit failed.
  //
  // receptivo/habilitado are always included, unconditionally — `config`
  // is the prop this dialog's own local state was seeded from, so
  // diffing local state against it is always zero unless the user
  // flips a toggle in THIS render of the dialog. Any earlier update
  // (e.g. the /canais table's inline switches) already moved what the
  // "current" value looks like without this dialog's `config` prop
  // necessarily reflecting it, so a diff-based guard can silently skip
  // sending values that are stale relative to the DB. flow_id keeps
  // its diff check — the backend validates flow ownership on every
  // PATCH that includes it, so skipping when unchanged avoids that
  // extra cost on every save.
  async function syncSettings() {
    if (!config) return;
    const nextFlowId = flowId === NO_FLOW ? null : flowId;
    const patch: Record<string, unknown> = {
      receptivo,
      habilitado,
    };
    if (nextFlowId !== (config.flow_id ?? null)) patch.flow_id = nextFlowId;
    try {
      const res = await apiFetch("/api/whatsapp/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: config.id, ...patch }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Falha ao salvar configurações do canal");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao salvar configurações do canal");
    }
  }

  async function handleSaveWaha() {
    if (!config) return;
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
          id: config.id,
          provider: "waha",
          waha_url: wahaUrl.trim(),
          waha_session: session,
          waha_api_key: apiKeyEdited ? wahaApiKey.trim() : MASKED_TOKEN,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Falha ao salvar canal");
      await syncSettings();
      toast.success(data.message || "Canal atualizado.");
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao salvar canal WAHA");
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveMeta() {
    if (!config) return;
    if (!phoneNumberId.trim()) {
      toast.error("Phone Number ID é obrigatório");
      return;
    }
    setSaving(true);
    try {
      const res = await apiFetch("/api/whatsapp/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: config.id,
          provider: "meta",
          phone_number_id: phoneNumberId.trim(),
          waba_id: wabaId.trim() || null,
          access_token: tokenEdited ? accessToken.trim() : MASKED_TOKEN,
          // Omitted (not empty string) when left blank, so the server's
          // "was this key even present?" check treats it the same as
          // never having touched the field — keep the existing value.
          app_secret: appSecret.trim() || undefined,
          verify_token: verifyToken.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Falha ao salvar canal");
      await syncSettings();
      toast.success("Canal Meta atualizado.");
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao salvar canal Meta");
    } finally {
      setSaving(false);
    }
  }

  if (!config) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Editar canal</DialogTitle>
        </DialogHeader>

        {config.provider === "waha" ? (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="edit-waha-session">Nome da sessão</Label>
              <Input
                id="edit-waha-session"
                value={wahaSession}
                onChange={(e) => setWahaSession(e.target.value)}
                disabled={saving}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-waha-url">URL do WAHA</Label>
              <Input
                id="edit-waha-url"
                value={wahaUrl}
                onChange={(e) => setWahaUrl(e.target.value)}
                disabled={saving}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-waha-key">API Key</Label>
              {apiKeyEdited ? (
                <Input
                  id="edit-waha-key"
                  type="password"
                  value={wahaApiKey}
                  onChange={(e) => setWahaApiKey(e.target.value)}
                  disabled={saving}
                  autoFocus
                />
              ) : (
                <div className="flex items-center gap-2">
                  <Input id="edit-waha-key" value={MASKED_TOKEN} disabled className="flex-1" />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setApiKeyEdited(true);
                      setWahaApiKey("");
                    }}
                  >
                    Substituir
                  </Button>
                </div>
              )}
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="edit-waha-receptivo">Receptivo</Label>
              <Switch
                id="edit-waha-receptivo"
                checked={receptivo}
                onCheckedChange={setReceptivo}
                disabled={saving}
              />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="edit-waha-habilitado">Habilitado</Label>
              <Switch
                id="edit-waha-habilitado"
                checked={habilitado}
                onCheckedChange={setHabilitado}
                disabled={saving}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-waha-flow">Fluxo (opcional)</Label>
              <Select value={flowId} onValueChange={(v) => v && setFlowId(v)}>
                <SelectTrigger id="edit-waha-flow" className="w-full" disabled={saving}>
                  <SelectValue>
                    {(v: string) => (v === NO_FLOW ? "Nenhum" : flows.find((f) => f.id === v)?.name ?? v)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent className="z-50">
                  <SelectItem value={NO_FLOW}>Nenhum</SelectItem>
                  {flows.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex justify-between pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={saving}
                className="border-border text-muted-foreground hover:bg-muted"
              >
                Cancelar
              </Button>
              <Button
                onClick={handleSaveWaha}
                disabled={saving}
                className="bg-[#FF5706] text-white hover:bg-[#FF5706]/90"
              >
                {saving ? "Salvando…" : "Salvar"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="edit-meta-phone-id">Phone Number ID</Label>
              <Input
                id="edit-meta-phone-id"
                value={phoneNumberId}
                onChange={(e) => setPhoneNumberId(e.target.value)}
                disabled={saving}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-meta-waba-id">WABA ID</Label>
              <Input
                id="edit-meta-waba-id"
                value={wabaId}
                onChange={(e) => setWabaId(e.target.value)}
                placeholder="(opcional)"
                disabled={saving}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-meta-token">Access Token</Label>
              {tokenEdited ? (
                <Input
                  id="edit-meta-token"
                  type="password"
                  value={accessToken}
                  onChange={(e) => setAccessToken(e.target.value)}
                  disabled={saving}
                  autoFocus
                />
              ) : (
                <div className="flex items-center gap-2">
                  <Input id="edit-meta-token" value={MASKED_TOKEN} disabled className="flex-1" />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setTokenEdited(true);
                      setAccessToken("");
                    }}
                  >
                    Substituir token
                  </Button>
                </div>
              )}
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-meta-app-secret">App Secret</Label>
              <Input
                id="edit-meta-app-secret"
                type="password"
                value={appSecret}
                onChange={(e) => setAppSecret(e.target.value)}
                placeholder="(deixe em branco para manter o atual)"
                disabled={saving}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-meta-verify">Verify Token</Label>
              <Input
                id="edit-meta-verify"
                value={verifyToken}
                onChange={(e) => setVerifyToken(e.target.value)}
                placeholder="(opcional)"
                disabled={saving}
              />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="edit-meta-receptivo">Receptivo</Label>
              <Switch
                id="edit-meta-receptivo"
                checked={receptivo}
                onCheckedChange={setReceptivo}
                disabled={saving}
              />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="edit-meta-habilitado">Habilitado</Label>
              <Switch
                id="edit-meta-habilitado"
                checked={habilitado}
                onCheckedChange={setHabilitado}
                disabled={saving}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-meta-flow">Fluxo (opcional)</Label>
              <Select value={flowId} onValueChange={(v) => v && setFlowId(v)}>
                <SelectTrigger id="edit-meta-flow" className="w-full" disabled={saving}>
                  <SelectValue>
                    {(v: string) => (v === NO_FLOW ? "Nenhum" : flows.find((f) => f.id === v)?.name ?? v)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent className="z-50">
                  <SelectItem value={NO_FLOW}>Nenhum</SelectItem>
                  {flows.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex justify-between pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={saving}
                className="border-border text-muted-foreground hover:bg-muted"
              >
                Cancelar
              </Button>
              <Button
                onClick={handleSaveMeta}
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