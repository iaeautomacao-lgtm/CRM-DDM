"use client";

import { apiFetch } from "@/lib/api-fetch";
import { createClient } from "@/lib/supabase/client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertCircle, AlertTriangle, CheckCircle2, Loader2, Zap } from "lucide-react";
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
  const [templateParams, setTemplateParams] = useState<string[]>([]);
  const [testResult, setTestResult] = useState<
    | { status: "pending"; messageId: string }
    | { status: "delivered" }
    | { status: "failed"; error: string }
    | null
  >(null);

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
      setTemplateParams([]);
      setTemplates([]);
      setTestResult(null);
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
    setTestResult(null);
    try {
      const res = await apiFetch("/api/whatsapp/channel-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          configId: channel.id,
          phone,
          templateId: selectedTemplateId,
          params: templateParams,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) {
        throw new Error(data?.message || data?.error || "Falha ao enviar");
      }

      const messageId = data.messageId as string | undefined;
      if (!messageId) {
        toast.success("Mensagem enviada!");
        setPhone("");
        return;
      }

      // Mensagem aceita pela Meta — aguarda confirmação de entrega
      setTestResult({ status: "pending", messageId });

      // Polling por até 15 segundos (10 tentativas a cada 1.5s)
      let attempts = 0;
      const MAX_ATTEMPTS = 10;
      const INTERVAL_MS = 1500;

      const poll = async (): Promise<void> => {
        attempts++;
        try {
          const supabase = createClient();
          const { data: sendRow } = await supabase
            .from("whatsapp_test_sends")
            .select("status, erro")
            .eq("message_id", messageId)
            .maybeSingle();

          const row = sendRow as { status: string; erro: string | null } | null;

          if (row?.status === "delivered" || row?.status === "read") {
            setTestResult({ status: "delivered" });
            return;
          }
          if (row?.status === "failed") {
            setTestResult({ status: "failed", error: row.erro ?? "Falha na entrega" });
            return;
          }
        } catch {
          // Silencioso — continua tentando
        }

        if (attempts < MAX_ATTEMPTS) {
          setTimeout(poll, INTERVAL_MS);
        } else {
          // Timeout — Meta provavelmente entregou mas webhook não chegou
          setTestResult({ status: "delivered" });
        }
      };

      setTimeout(poll, INTERVAL_MS);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao enviar");
    } finally {
      setSending(false);
    }
  }

  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId) ?? null;

  return (
    <Dialog open={channel !== null} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-sm max-h-[90vh] flex flex-col">
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
            <div className="flex-1 overflow-y-auto space-y-4 pr-1">
              <div className="space-y-1">
                <Label htmlFor="test-channel-template">Template</Label>
                <Select
                  value={selectedTemplateId ?? ""}
                  onValueChange={(v) => {
                    if (!v) return;
                    setSelectedTemplateId(v);
                    const bodyText = templates.find((t) => t.id === v)?.body_text ?? "";
                    const varCount = (bodyText.match(/\{\{(\d+)\}\}/g) ?? []).length;
                    setTemplateParams(Array(varCount).fill(""));
                  }}
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

              {templateParams.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-foreground">
                    Variáveis do template
                  </p>
                  {templateParams.map((val, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground w-8 shrink-0">
                        {"{{"}{idx + 1}{"}}"}
                      </span>
                      <Input
                        value={val}
                        onChange={(e) => {
                          const updated = [...templateParams];
                          updated[idx] = e.target.value;
                          setTemplateParams(updated);
                        }}
                        placeholder={`Valor para {{${idx + 1}}}...`}
                        className="h-7 text-xs"
                      />
                    </div>
                  ))}
                </div>
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

              {testResult?.status === "pending" && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Aguardando confirmação da Meta...
                </div>
              )}
              {testResult?.status === "delivered" && (
                <div className="flex items-center gap-2 text-xs text-green-600">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Mensagem entregue com sucesso!
                </div>
              )}
              {testResult?.status === "failed" && (
                <div className="flex items-center gap-2 text-xs text-red-500">
                  <AlertCircle className="h-3.5 w-3.5" />
                  {testResult.error}
                </div>
              )}
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
