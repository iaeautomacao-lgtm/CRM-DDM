"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { MIN_PASSWORD_LENGTH, PASSWORD_TOO_SHORT_MESSAGE, translateAuthError } from "@/lib/auth/auth-errors";
import {
  FORGOT_PASSWORD_PATH,
  LOGIN_AFTER_RESET_PATH,
  hasRecoveryLinkError,
  resolveRecoveryStatus,
  type RecoveryStatus,
} from "@/lib/auth/recovery-link";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Link2Off } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { AUTH_INPUT_CLASS, AUTH_SUBMIT_CLASS, AuthNotice, AuthShell, BackToLogin } from "@/components/auth/auth-shell";
import Link from "next/link";

export default function ResetPasswordPage() {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const focusFirst = () => setTimeout(() => firstFieldRef.current?.focus(), 0);
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  // Antes de mostrar o formulário, confere se o link abriu uma sessão de
  // recuperação (o /auth/callback troca o código; link vencido ou já
  // usado chega com ?error= / #error=).
  const [status, setStatus] = useState<RecoveryStatus>("checking");

  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    let cancelled = false;
    const linkError = hasRecoveryLinkError(window.location.search, window.location.hash);
    // Link no formato antigo (tokens no #): o client processa a URL e
    // avisa com PASSWORD_RECOVERY.
    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if (!cancelled && !linkError && event === "PASSWORD_RECOVERY" && session) {
        setStatus("ready");
      }
    });
    void supabase.auth
      .getSession()
      .then(({ data }) => {
        if (cancelled) return;
        const next = resolveRecoveryStatus({ linkError, hasSession: !!data.session });
        setStatus((current) => (current === "ready" && !linkError ? current : next));
      })
      .catch(() => {
        if (!cancelled) setStatus((current) => (current === "ready" ? current : "invalid"));
      });
    return () => {
      cancelled = true;
      listener.subscription.unsubscribe();
    };
  }, [supabase]);

  const handleUpdatePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError("As senhas não coincidem.");
      focusFirst();
      return;
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(PASSWORD_TOO_SHORT_MESSAGE);
      focusFirst();
      return;
    }

    setLoading(true);

    const { error } = await supabase.auth.updateUser({
      password: password,
    });

    if (error) {
      setError(translateAuthError(error));
      focusFirst();
      setLoading(false);
      return;
    }

    // Encerra a sessão de recuperação (e as outras sessões da conta) e volta
    // ao login, que mostra o aviso de sucesso. Falha ao sair não impede o
    // redirecionamento — a senha já foi trocada.
    await supabase.auth.signOut().catch(() => undefined);
    router.replace(LOGIN_AFTER_RESET_PATH);
  };

  if (status === "checking") {
    return (
      <AuthShell title="Definir nova senha" description="Verificando o link de redefinição…">
        <div role="status" aria-busy="true" className="flex flex-col gap-3.5">
          <Skeleton className="h-[42px] w-full rounded-lg" />
          <Skeleton className="h-[42px] w-full rounded-lg" />
          <Skeleton className="h-11 w-full rounded-lg" />
        </div>
      </AuthShell>
    );
  }

  if (status === "invalid") {
    return (
      <AuthShell
        icon={
          <span className="flex size-10 items-center justify-center rounded-full bg-danger-soft text-danger">
            <Link2Off className="size-5" aria-hidden="true" />
          </span>
        }
        title={<span role="alert">Este link expirou ou já foi usado</span>}
        description="Por segurança, cada link de redefinição vale uma vez e por pouco tempo. Peça um novo link para continuar."
        footer={<BackToLogin />}
      >
        <Link href={FORGOT_PASSWORD_PATH} className={cn(buttonVariants(), AUTH_SUBMIT_CLASS)}>
          Pedir um novo link
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Definir nova senha"
      description="Escolha uma nova senha forte para sua conta"
      notice={
        error ? (
          <AuthNotice tone="bad" id="reset-error">
            {error}
          </AuthNotice>
        ) : undefined
      }
      footer={<BackToLogin label="Cancelar e voltar para o login" />}
    >
      <form onSubmit={handleUpdatePassword} className="flex flex-col gap-3.5">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="password" className="text-[13px] font-semibold text-foreground-2">
            Nova senha
          </Label>
          <div className="relative flex items-center">
            <Input
              id="password"
              ref={firstFieldRef}
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              placeholder={`Pelo menos ${MIN_PASSWORD_LENGTH} caracteres`}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "reset-error password-hint" : "password-hint"}
              className={cn(AUTH_INPUT_CLASS, "pr-20")}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-pressed={showPassword}
              aria-label="Mostrar senha"
              aria-controls="password confirmPassword"
              className="absolute right-1.5 h-[30px] rounded-[6px] px-2 text-xs font-semibold text-foreground-2 hover:bg-surface-hover hover:text-foreground"
            >
              {showPassword ? "Ocultar" : "Mostrar"}
            </button>
          </div>
          <span id="password-hint" className="text-xs text-muted-foreground">
            Mínimo de {MIN_PASSWORD_LENGTH} caracteres.
          </span>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="confirmPassword" className="text-[13px] font-semibold text-foreground-2">
            Confirmar nova senha
          </Label>
          <Input
            id="confirmPassword"
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            placeholder="Digite a nova senha novamente"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "reset-error" : undefined}
            className={AUTH_INPUT_CLASS}
          />
        </div>

        <Button type="submit" disabled={loading} className={cn(AUTH_SUBMIT_CLASS, "mt-1")}>
          {loading && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
          {loading ? "Salvando…" : "Redefinir senha"}
        </Button>
      </form>
    </AuthShell>
  );
}
