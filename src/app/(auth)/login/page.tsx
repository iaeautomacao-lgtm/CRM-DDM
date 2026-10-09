"use client";

import { Suspense, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { translateAuthError } from "@/lib/auth/auth-errors";
import { safeReturnPath } from "@/lib/auth/return-path";
import { isPasswordResetSuccess } from "@/lib/auth/recovery-link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, UsersRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { AUTH_INPUT_CLASS, AUTH_SUBMIT_CLASS, AuthNotice, AuthShell } from "@/components/auth/auth-shell";
import {
  logAuthFx,
  summarizeSession,
  summarizeSupabaseCookies,
} from "@/lib/auth/auth-forensics";

// `useSearchParams` opts the component out of static prerendering
// unless it sits under a Suspense boundary. We split the form into
// a child component so the outer page can prerender the chrome
// (background, card frame) while the form hydrates with the query
// string on the client.
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageInner />
    </Suspense>
  );
}

function LoginPageInner() {
  const searchParams = useSearchParams();
  // Forwarded from `/join/<token>` when the visitor already has an
  // account. After a successful sign-in we send them to the join
  // page to accept rather than to /dashboard.
  const inviteToken = searchParams.get("invite");
  // Vindo de /reset-password depois de trocar a senha.
  const passwordReset = isPasswordResetSuccess(searchParams.get("reset"));

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(
    searchParams.get("error") === "auth-callback-failed"
      ? "Não foi possível validar o link. Solicite um novo link de acesso ou recuperação."
      : null
  );
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setError(translateAuthError(error));
      // O botão focado fica desabilitado no envio: devolve o foco ao primeiro campo para quem usa teclado.
      setTimeout(() => firstFieldRef.current?.focus(), 0);
      setLoading(false);
      return;
    }

    logAuthFx("LOGIN", {
      phase: "after-password-login",
      ...summarizeSession(data?.session),
      cookies: summarizeSupabaseCookies(),
    });
    setTimeout(() => {
      logAuthFx("LOGIN", {
        phase: "+1000ms",
        cookies: summarizeSupabaseCookies(),
      });
    }, 1000);

    if (inviteToken) {
      router.push(`/join/${encodeURIComponent(inviteToken)}`);
    } else {
      router.replace(safeReturnPath(searchParams.get("next")));
    }
  };

  return (
    <AuthShell
      icon={
        inviteToken ? (
          <span className="flex size-10 items-center justify-center rounded-full bg-primary-soft text-primary-text">
            <UsersRound className="size-5" aria-hidden="true" />
          </span>
        ) : undefined
      }
      title={inviteToken ? "Entrar para aceitar" : "Bem-vindo de volta"}
      description={inviteToken ? "Faça login e te levaremos ao convite." : "Entre na sua conta"}
      notice={
        error ? (
          <AuthNotice tone="bad" id="login-error">
            {error}
          </AuthNotice>
        ) : passwordReset ? (
          <AuthNotice tone="ok">Senha redefinida com sucesso. Entre com a nova senha.</AuthNotice>
        ) : undefined
      }
      // Sem cadastro público: CRM interno, usuários criados pelo admin.
      footer="Sem acesso? Peça ao administrador para criar o seu usuário."
    >
      <form onSubmit={handleLogin} className="flex flex-col gap-3.5">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email" className="text-[13px] font-semibold text-foreground-2">
            E-mail
          </Label>
          <Input
            id="email"
            ref={firstFieldRef}
            type="email"
            autoComplete="email"
            placeholder="seu@exemplo.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "login-error" : undefined}
            className={AUTH_INPUT_CLASS}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="password" className="text-[13px] font-semibold text-foreground-2">
              Senha
            </Label>
            <Link
              href="/forgot-password"
              className="rounded-sm text-[13px] font-medium text-primary-text hover:underline focus-visible:outline-2 focus-visible:outline-ring"
            >
              Esqueceu sua senha?
            </Link>
          </div>
          <div className="relative flex items-center">
            <Input
              id="password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              placeholder="Digite sua senha"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "login-error" : undefined}
              className={cn(AUTH_INPUT_CLASS, "pr-20")}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-pressed={showPassword}
              aria-label="Mostrar senha"
              aria-controls="password"
              className="absolute right-1.5 h-[30px] rounded-[6px] px-2 text-xs font-semibold text-foreground-2 hover:bg-surface-hover hover:text-foreground"
            >
              {showPassword ? "Ocultar" : "Mostrar"}
            </button>
          </div>
        </div>

        <Button type="submit" disabled={loading} className={cn(AUTH_SUBMIT_CLASS, "mt-1")}>
          {loading && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
          {loading ? "Entrando…" : "Entrar"}
        </Button>
      </form>
    </AuthShell>
  );
}
