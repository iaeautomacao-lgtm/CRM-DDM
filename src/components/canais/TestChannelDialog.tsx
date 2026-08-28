"use client";

import { apiFetch } from "@/lib/api-fetch";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Loader2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

interface ApprovedTemplate {
  id: string;
  name: string;
  language: string;
  body_text: string;
}

export function TestChannelDialog({
  channel,
  onClose,
}: {
  channel: ChannelConfig | null;
  onClose: () => void;
}) {
  const [phone, setPhone] = useState("");
  const [sending, setSending] = useState(false);
  const [templates, setTemplates] = useState<ApprovedTemplate[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);

  useEffect(() => {
    if (!channel || channel.provider !== "meta") return;
    let cancelled = false;
    setLoadingTemplates(true);
    apiFetch(`/api/whatsapp/channel-test/templates?configId=${channel.id}`)
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        setTemplates(data.templates ?? []);
      })
      .catch((err) => {
        console.error("[TestChannelDialog] failed to load templates:", err);
      })
      .finally(() => {
        if (!cancelled) setLoadingTemplates(false);
      });
    return () => {
      cancelled = true;
    };
  }, [channel]);

  if (!channel) return null;

  function handleOpenChange(open: boolean) {
    if (!open) {
      setPhone("");
      setSelectedTemplateId(null);
      setTemplates([]);
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

  async function handleSendTestMeta() {
    if (!channel || !selectedTemplateId) return;
    setSending(true);
    try {
      const res = await apiFetch("/api/whatsapp/channel-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          configId: channel.id,
          phone,
          templateId: selectedTemplateId,
        }),
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

  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId) ?? null;

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
          loadingTemplates ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : templates.length === 0 ? (
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
                <Label htmlFor="test-channel-template">Template</Label>
                <Select
                  value={selectedTemplateId ?? ""}
                  onValueChange={(v) => v && setSelectedTemplateId(v)}
                >
                  <SelectTrigger id="test-channel-template" className="w-full">
                    <SelectValue placeholder="Selecione um template...">
                      {selectedTemplate
                        ? `${selectedTemplate.name} (${selectedTemplate.language})`
                        : undefined}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {templates.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name} ({t.language})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {selectedTemplateId && selectedTemplate && (
                <p className="text-xs text-muted-foreground bg-muted rounded p-2 whitespace-pre-wrap">
                  {selectedTemplate.body_text}
                </p>
              )}

              <div className="space-y-1">
                <Label htmlFor="test-channel-phone-meta">Número de destino</Label>
                <Input
                  id="test-channel-phone-meta"
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
                <Button
                  onClick={handleSendTestMeta}
                  disabled={sending || !phone.trim() || !selectedTemplateId}
                >
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
          )
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
