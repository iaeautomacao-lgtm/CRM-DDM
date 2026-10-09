"use client";

import { useState } from "react";
import { Bell, Loader2, X } from "lucide-react";

import { usePermission } from "@/hooks/use-permission";
import { usePushNotifications } from "@/hooks/use-push-notifications";
import { PushDeniedHelp } from "@/components/push/push-denied-help";

const DISMISS_KEY = "wacrm.inbox.pushNudgeDismissed";

function readDismissed() {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Aviso discreto no topo da lista do Inbox: "Ativar notificações" quando o
 * push deste navegador está desligado. A permissão só é pedida no clique.
 * Se o navegador negar no clique, mostra como liberar; "dispensar" esconde
 * o aviso neste navegador (dá para ativar depois pelo Perfil).
 */
export function PushNudge() {
  const canInbox = usePermission("inbox.view");
  const { state, busy, enable } = usePushNotifications();
  const [dismissed, setDismissed] = useState(readDismissed);
  // Só mostra a ajuda de "bloqueado" se o bloqueio veio deste clique —
  // quem já bloqueou antes não recebe o aviso de novo a cada visita.
  const [askedHere, setAskedHere] = useState(false);

  if (!canInbox || dismissed || state === null) return null;
  const showDenied = askedHere && state === "denied";
  if (state !== "off" && !showDenied) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // armazenamento indisponível: some só nesta visita
    }
  };

  return (
    <div className="mx-3 mt-2 flex animate-ddm-fade flex-col gap-2 rounded-lg border border-border bg-surface-3 px-3 py-2">
      <div className="flex items-center gap-2 text-[12.5px] text-foreground-2">
        <Bell className="size-3.5 shrink-0 text-primary-text" aria-hidden="true" />
        <span className="min-w-0 flex-1">Receba aviso de novas mensagens neste navegador.</span>
        {!showDenied && (
          <button
            type="button"
            onClick={() => {
              setAskedHere(true);
              void enable();
            }}
            disabled={busy}
            className="inline-flex shrink-0 items-center gap-1 font-semibold text-primary-text hover:underline disabled:opacity-60"
          >
            {busy && <Loader2 className="size-3 animate-spin" />}
            Ativar notificações
          </button>
        )}
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dispensar aviso de notificações"
          className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-surface-hover hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
      {showDenied && <PushDeniedHelp compact />}
    </div>
  );
}
