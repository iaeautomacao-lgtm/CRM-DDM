"use client";

// Recuperar senha — visual do Acesso redesenhado (AuthShell). Mesma lógica: resetPasswordForEmail com o
// retorno por /auth/callback?next=/reset-password.

import { useState } from "react";
import Link from "next/link";
import { Loader2, MailCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { translateAuthError } from "@/lib/auth/auth-errors";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { AUTH_INPUT_CLASS, AUTH_SUBMIT_CLASS, AuthNotice, AuthShell, BackToLogin } from "@/components/auth/auth-shell";


export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const supabase = createClient();

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
    });

    if (error) {
      setError(translateAuthError(error));
      setLoading(false);
      return;
    }

    setSuccess(true);
    setLoading(false);
  };

  if (success) {
    return (
      <AuthShell
        icon={
          <span className="flex size-10 items-center justify-center rounded-full bg-success-soft text-success">
            <MailCheck className="size-5" aria-hidden="true" />
          </span>
        }
        title="Verifique seu e-mail"
        description={
          <span role="status">
            Enviamos um link de redefinição de senha para <span className="font-semibold text-foreground">{email}</span>. Por
            favor, verifique sua caixa de entrada.
          </span>
        }
      >
        <Link href="/login" className={cn(buttonVariants({ variant: "outline" }), AUTH_SUBMIT_CLASS)}>
          Voltar para o login
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Redefinir senha"
      description="Digite seu e-mail e enviaremos um link de redefinição de senha"
      notice={
        error ? (
          <AuthNotice tone="bad" id="forgot-error">
            {error}
          </AuthNotice>
        ) : undefined
      }
      footer={<BackToLogin />}
    >
      <form onSubmit={handleReset} className="flex flex-col gap-3.5">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email" className="text-[13px] font-semibold text-foreground-2">
            E-mail
          </Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            placeholder="seu@exemplo.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "forgot-error" : undefined}
            className={AUTH_INPUT_CLASS}
          />
        </div>
        <Button type="submit" disabled={loading} className={cn(AUTH_SUBMIT_CLASS, "mt-1")}>
          {loading && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
          {loading ? "Enviando…" : "Enviar link de redefinição"}
        </Button>
      </form>
    </AuthShell>
  );
}
