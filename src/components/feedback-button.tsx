"use client";

import { useState } from "react";
import { Bug } from "lucide-react";

import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

// Botão flutuante em todas as páginas autenticadas (montado uma vez em
// dashboard-shell.tsx, mesmo padrão headless-mount de PresenceHeartbeat)
// — deixa qualquer usuário reportar um problema técnico direto pro
// /ddm-logs (POST /api/feedback -> system_logs, source='feedback').
// Sempre opcional: nunca bloqueia a UI, nenhum erro de envio é exibido
// (falha silenciosa — reportar um bug não pode virar um bug em si).
export function FeedbackButton() {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [page, setPage] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setSent(false);
      setPage(window.location.pathname);
    }
  }

  async function handleSubmit() {
    if (!message.trim() || sending) return;
    setSending(true);
    try {
      await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: message.trim(),
          page: page.trim() || window.location.pathname,
          user_agent: navigator.userAgent,
        }),
      });
      setSent(true);
      setMessage("");
      setTimeout(() => setOpen(false), 3000);
    } catch {
      // Best-effort — ver comentário no topo do arquivo.
    } finally {
      setSending(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        aria-label="Reportar problema"
        className="fixed z-40 flex h-12 w-12 items-center justify-center rounded-full bg-[#FF5706] text-white shadow-lg transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-[#FF5706]/50"
        style={{ bottom: 80, right: 20 }}
      >
        <Bug className="h-5 w-5" />
      </PopoverTrigger>
      <PopoverContent className="w-80" side="top" align="end" sideOffset={10}>
        {sent ? (
          <p className="py-4 text-center text-sm font-medium text-[#FF5706]">
            Obrigado! Problema reportado.
          </p>
        ) : (
          <div className="space-y-3">
            <PopoverTitle>Reportar problema</PopoverTitle>
            <Textarea
              placeholder="Descreva o problema que encontrou..."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={4}
              autoFocus
            />
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Em qual página/tela?</label>
              <Input value={page} onChange={(e) => setPage(e.target.value)} />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
                Cancelar
              </Button>
              <Button
                size="sm"
                className="bg-[#FF5706] text-white hover:bg-[#FF5706]/90"
                disabled={!message.trim() || sending}
                onClick={handleSubmit}
              >
                {sending ? "Enviando..." : "Enviar"}
              </Button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
