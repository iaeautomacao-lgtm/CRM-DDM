"use client";

import { Bell, BellOff, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { StatusChip } from "@/components/ddm/status-chip";
import { usePermission } from "@/hooks/use-permission";
import { usePushNotifications } from "@/hooks/use-push-notifications";
import { PushDeniedHelp } from "./push-denied-help";

/**
 * Perfil › "Notificações neste navegador": ativa/desativa o push de novas
 * mensagens só NESTE navegador (cada navegador/dispositivo tem a sua
 * inscrição). As rotas de push exigem inbox.view — sem ela o card some.
 */
export function PushSettingsCard() {
  const canInbox = usePermission("inbox.view");
  const { state, busy, enable, disable } = usePushNotifications();

  if (!canInbox) return null;

  return (
    <section className="flex flex-col gap-3 rounded-[10px] border border-border bg-card p-5">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary-text" aria-hidden="true">
          <Bell className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[13.5px] font-semibold text-foreground">Notificações neste navegador</h3>
            {state === "on" && <StatusChip tone="ok">Ativadas</StatusChip>}
            {state === "off" && <StatusChip tone="mute">Desativadas</StatusChip>}
            {state === "denied" && <StatusChip tone="bad">Bloqueadas</StatusChip>}
          </div>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
            Avisos de novas mensagens mesmo com o CRM em outra aba. Clicar no aviso abre a conversa.
            Vale só para este navegador.
          </p>
        </div>
      </div>

      {state === null ? (
        <div className="h-8" aria-busy="true" />
      ) : state === "unsupported" ? (
        <p className="rounded-md bg-surface-3 px-3 py-2 text-[12.5px] text-foreground-2">
          Este navegador não suporta notificações. Use uma versão recente do Chrome, Edge ou Firefox.
        </p>
      ) : state === "denied" ? (
        <PushDeniedHelp />
      ) : (
        <div>
          {state === "on" ? (
            <Button variant="outline" size="sm" onClick={() => void disable()} disabled={busy}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <BellOff className="size-3.5" />}
              Desativar notificações
            </Button>
          ) : (
            <Button size="sm" onClick={() => void enable()} disabled={busy}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Bell className="size-3.5" />}
              Ativar notificações
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
