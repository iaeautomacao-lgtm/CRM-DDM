"use client";

// Guarda do 2FA no painel (src/lib/auth/mfa.ts): se a sessão está em aal1 e o usuário tem fator verificado
// (nextLevel aal2), manda para /login/2fa preservando o caminho atual em ?next=. O bloqueio real é no servidor
// (getUser → 401 mfa_required); isto só evita mostrar o painel vazio. Sem rede: o Supabase calcula pelo JWT e pelos
// fatores da sessão local.

import { useEffect } from "react";

import { createClient } from "@/lib/supabase/client";
import { mfaRedirectUrl } from "@/lib/auth/mfa";

export function useMfaGuard(active: boolean) {
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void createClient()
      .auth.mfa.getAuthenticatorAssuranceLevel()
      .then(({ data }) => {
        if (cancelled || !data) return;
        if (data.currentLevel === "aal1" && data.nextLevel === "aal2") {
          window.location.replace(mfaRedirectUrl(window.location.pathname + window.location.search));
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [active]);
}
