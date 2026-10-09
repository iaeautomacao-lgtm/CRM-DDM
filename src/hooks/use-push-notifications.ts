"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { disablePush, enablePush, getPushState, type PushState } from "@/lib/push/client";

/**
 * Estado do push do navegador (TASK36, helper do Âncora em lib/push/client).
 * `state` = null enquanto lê o estado inicial. `enable` SÓ deve ser chamado
 * no clique do usuário — é a única hora em que o navegador aceita pedir a
 * permissão; ler o estado nunca pede nada.
 */
export function usePushNotifications() {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getPushState()
      .then((s) => {
        if (!cancelled) setState(s);
      })
      .catch(() => {
        if (!cancelled) setState("unsupported");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const enable = useCallback(async () => {
    setBusy(true);
    try {
      const next = await enablePush();
      setState(next);
      if (next === "on") toast.success("Notificações ativadas neste navegador.");
      else if (next === "denied") toast.error("O navegador bloqueou as notificações.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível ativar as notificações.");
    } finally {
      setBusy(false);
    }
  }, []);

  const disable = useCallback(async () => {
    setBusy(true);
    try {
      setState(await disablePush());
      toast.success("Notificações desativadas neste navegador.");
    } catch {
      toast.error("Não foi possível desativar as notificações.");
    } finally {
      setBusy(false);
    }
  }, []);

  return { state, busy, enable, disable };
}
