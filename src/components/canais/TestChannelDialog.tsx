"use client";

import { apiFetch } from "@/lib/api-fetch";

import { useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Loader2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import type { ChannelConfig } from "./types";

const META_TEMPLATE_REQUIRED_MESSAGE =
  "Canais Meta exigem template aprovado para enviar mensagens. Use a aba Templates para criar e aprovar um template primeiro.";

export function TestChannelDialog({
  channel,
  onClose,
}: {
  channel: ChannelConfig | null;
  onClose: () => void;
}) {
  const [phone, setPhone] = useState("");
  const [sending, setSending] = useState(false);

  if (!channel) return null;

  function handleOpenChange(open: boolean) {
    if (!open) {
      setPhone("");
      onClose();
    }
  }

  async function handleSendTest() {
    if (!channel) return;
    setSending(true);
    try {
      const res = await apiFetch("/api/whatsapp/channel-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ configId: channel.id, phone }),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) {
        throw new Error(data?.message || data?.error || "Falha ao enviar");
      }
      toast.success("Mensagem enviada com sucesso!");
      setPhone("");
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao enviar");
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={channel !== null} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="size-4" />
            Testar canal — {channel.waha_session ?? "Meta"}
          </DialogTitle>
          <DialogDescription>
            Envia uma mensagem de teste real para verificar se a conexão está
            funcionando.
          </DialogDescription>
        </DialogHeader>

        {channel.provider === "meta" ? (
          <>
            <Alert className="bg-amber-950/40 border-amber-600/40">
              <AlertTriangle className="size-4 text-amber-400" />
              <AlertTitle className="text-amber-200">Não suportado para Meta</AlertTitle>
              <AlertDescription className="text-amber-100/80">
                {META_TEMPLATE_REQUIRED_MESSAGE}
              </AlertDescription>
            </Alert>
            <DialogFooter>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                Fechar
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="space-y-1">
              <Label htmlFor="test-channel-phone">Número de destino</Label>
              <Input
                id="test-channel-phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+5521999999999"
                disabled={sending}
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={sending}>
                Cancelar
              </Button>
              <Button onClick={handleSendTest} disabled={sending || !phone.trim()}>
                {sending ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Enviando…
                  </>
                ) : (
                  "Enviar teste"
                )}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
