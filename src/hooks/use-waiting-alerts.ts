"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";

// Aviso de conversa em espera no Inbox (PRD 23, item 14): aviso na tela
// (toast com "Abrir"), som curto e notificação do sistema quando a aba
// está em segundo plano — esta só com permissão do navegador, pedida por
// clique do operador. Preferência por navegador (localStorage); o web
// push com a aba fechada fica para depois (PRD 23).

const STORAGE_KEY = "wacrm:inbox:waiting-alerts";

const CHANGE_EVENT = "wacrm:waiting-alerts-change";

function readEnabled(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

function subscribeEnabled(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

/** Dois toques curtos gerados no navegador (sem arquivo de áudio). */
function playChime() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    [0, 0.16].forEach((offset, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = i === 0 ? 880 : 1175;
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.12, now + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.18);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.2);
    });
    window.setTimeout(() => void ctx.close(), 600);
  } catch {
    // Navegador sem áudio liberado (sem interação ainda): fica só o aviso visual.
  }
}

export type BrowserNotificationState = "unsupported" | "default" | "granted" | "denied";

function browserNotificationState(): BrowserNotificationState {
  if (typeof window === "undefined" || typeof Notification === "undefined") return "unsupported";
  return Notification.permission as BrowserNotificationState;
}

export function useWaitingAlerts() {
  // Servidor e 1º render do cliente: ligado (padrão); depois, o salvo.
  const enabled = useSyncExternalStore(subscribeEnabled, readEnabled, () => true);
  const [permission, setPermission] = useState<BrowserNotificationState>(() =>
    typeof window === "undefined" ? "unsupported" : browserNotificationState(),
  );
  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const setEnabled = useCallback(async (next: boolean) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      // Preferência é melhor-esforço.
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
    // Ligar é um clique do operador: momento certo para pedir a permissão.
    if (next && typeof Notification !== "undefined" && Notification.permission === "default") {
      setPermission((await Notification.requestPermission()) as BrowserNotificationState);
    }
  }, []);

  /** Dispara o aviso de uma conversa que acabou de entrar na espera. */
  const notify = useCallback((args: { id: string; name: string | null; onOpen: () => void }) => {
    if (!enabledRef.current) return;
    const description = args.name ? `${args.name} está aguardando atendimento.` : "Um cliente está aguardando atendimento.";
    toast("Nova conversa em espera", {
      id: `waiting-${args.id}`,
      description,
      action: { label: "Abrir", onClick: args.onOpen },
    });
    playChime();
    if (
      typeof Notification !== "undefined" &&
      Notification.permission === "granted" &&
      document.visibilityState === "hidden"
    ) {
      const n = new Notification("Nova conversa em espera", { body: description, tag: `waiting-${args.id}` });
      n.onclick = () => {
        window.focus();
        args.onOpen();
        n.close();
      };
    }
  }, []);

  return { enabled, setEnabled, permission, notify };
}
