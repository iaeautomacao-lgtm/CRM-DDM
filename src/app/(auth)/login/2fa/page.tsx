"use client";

// /login/2fa — passo do código de verificação em duas etapas (TOTP). Quem tem fator verificado e entrou só com a senha
// (sessão aal1) chega aqui pela guarda do painel ou por um 401 mfa_required (src/lib/auth/mfa.ts). Desafio e
// verificação pelo supabase.auth.mfa.* da própria sessão; sucesso eleva a sessão para aal2 e volta para ?next=.
// "Sair" encerra a sessão aal1. Sem loop: esta página não usa o shell do painel nem rotas que exigem aal2.

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, ShieldCheck } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { safeReturnPath } from "@/lib/auth/return-path";
import { normalizeTotpCode, verifyErrorMessage } from "@/lib/auth/mfa";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AUTH_INPUT_CLASS, AUTH_SUBMIT_CLASS, AuthFieldError, AuthNotice, AuthShell } from "@/components/auth/auth-shell";

export default function TwoFactorLoginPage() {
  return (
    <Suspense fallback={null}>
      <TwoFactorLoginInner />
    </Suspense>
  );
}

function TwoFactorLoginInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = safeReturnPath(searchParams.get("next"));
  const supabase = createClient();

  const [factorId, setFactorId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const codeRef = useRef<HTMLInputElement>(null);
  // No erro, volta o foco ao campo com o código selecionado (o botão focado fica desabilitado durante a verificação).
  const focusCode = () => setTimeout(() => {
    codeRef.current?.focus();
    codeRef.current?.select();
  }, 0);
  const [checking, setChecking] = useState(true);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data: aal, error: aalErr } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (cancelled) return;
      if (aalErr || !aal) {
        // Sem sessão: volta ao login preservando o destino.
        router.replace(`/login?next=${encodeURIComponent(next)}`);
        return;
      }
      if (aal.currentLevel === "aal2" || aal.nextLevel !== "aal2") {
        // Já verificado, ou o usuário não tem 2FA: nada a fazer aqui.
        router.replace(next);
        return;
      }
      const { data: factors } = await supabase.auth.mfa.listFactors();
      if (cancelled) return;
      const totp = factors?.totp?.find((f) => f.status === "verified") ?? null;
      if (!totp) {
        setFatal("Não encontramos o aplicativo autenticador desta conta. Saia e entre de novo, ou fale com o administrador.");
      } else {
        setFactorId(totp.id);
      }
      setChecking(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    if (!factorId || code.length !== 6) {
      setError("Digite os 6 dígitos do aplicativo autenticador.");
      focusCode();
      return;
    }
    setVerifying(true);
    setError(null);
    const { error: err } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
    if (err) {
      setError(verifyErrorMessage(err.message));
      focusCode();
      setVerifying(false);
      return;
    }
    router.replace(next);
  }

  async function signOut() {
    await supabase.auth.signOut();
    router.replace("/login");
  }

  return (
    <AuthShell
      title="Código de verificação"
      description="Sua conta usa verificação em duas etapas. Digite o código de 6 dígitos do aplicativo autenticador."
      icon={<ShieldCheck className="size-6 text-primary" aria-hidden />}
      notice={fatal ? <AuthNotice tone="bad">{fatal}</AuthNotice> : undefined}
      footer={
        <button type="button" onClick={() => void signOut()} className="font-medium text-primary-text hover:underline">
          Sair e entrar com outra conta
        </button>
      }
    >
      {checking ? (
        <div role="status" className="flex justify-center py-6" aria-busy="true">
          <Loader2 className="size-5 animate-spin text-primary" aria-hidden="true" />
          <span className="sr-only">Verificando sua sessão…</span>
        </div>
      ) : fatal ? null : (
        <form onSubmit={(e) => void verify(e)} className="flex flex-col gap-4" noValidate>
          <div className="flex flex-col gap-2">
            <Label htmlFor="totp-code">Código</Label>
            <Input
              id="totp-code"
              ref={codeRef}
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              value={code}
              onChange={(e) => setCode(normalizeTotpCode(e.target.value))}
              placeholder="000000"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "totp-error" : undefined}
              className={`${AUTH_INPUT_CLASS} text-center font-mono text-lg tracking-[0.4em]`}
            />
            {error && <AuthFieldError id="totp-error">{error}</AuthFieldError>}
          </div>
          {/* Habilitado mesmo incompleto: o envio mostra o erro em vez de um botão apagado sem explicação. */}
          <Button type="submit" disabled={verifying} className={AUTH_SUBMIT_CLASS}>
            {verifying && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
            {verifying ? "Verificando…" : "Verificar e entrar"}
          </Button>
        </form>
      )}
    </AuthShell>
  );
}
