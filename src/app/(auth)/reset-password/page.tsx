"use client";

import { useEffect, useState } from "react";
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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { KeyRound, ArrowLeft, Loader2, Link2Off } from "lucide-react";
import Link from "next/link";

export default function ResetPasswordPage() {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
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
      return;
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(PASSWORD_TOO_SHORT_MESSAGE);
      return;
    }

    setLoading(true);

    const { error } = await supabase.auth.updateUser({
      password: password,
    });

    if (error) {
      setError(translateAuthError(error));
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
      <div className="bg-background flex min-h-screen items-center justify-center px-4">
        <div role="status" className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Verificando o link de redefinição...
        </div>
      </div>
    );
  }

  if (status === "invalid") {
    return (
      <div className="bg-background flex min-h-screen items-center justify-center px-4">
        <Card className="border-border bg-card w-full max-w-md">
          <CardHeader className="items-center text-center">
            <div className="bg-primary/10 mb-2 flex h-12 w-12 items-center justify-center rounded-xl">
              <Link2Off className="text-primary h-6 w-6" aria-hidden />
            </div>
            <CardTitle className="text-foreground text-xl" role="alert">
              Este link expirou ou já foi usado
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              Por segurança, cada link de redefinição vale uma vez e por pouco
              tempo. Peça um novo link para continuar.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link
              href={FORGOT_PASSWORD_PATH}
              className={cn(
                buttonVariants(),
                "bg-primary text-primary-foreground hover:bg-primary/90 h-10 w-full",
              )}
            >
              Pedir um novo link
            </Link>
            <Link
              href="/login"
              className="text-muted-foreground hover:text-foreground mt-6 flex items-center justify-center gap-2 text-sm rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              Voltar para o login
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="bg-background flex min-h-screen items-center justify-center px-4">
      <Card className="border-border bg-card w-full max-w-md">
        <CardHeader className="items-center text-center">
          <div className="bg-primary/10 mb-2 flex h-12 w-12 items-center justify-center rounded-xl">
            <KeyRound className="text-primary h-6 w-6" aria-hidden="true" />
          </div>
          <CardTitle className="text-foreground text-xl">
            Definir nova senha
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            Escolha uma nova senha forte para sua conta
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleUpdatePassword} className="flex flex-col gap-4">
            {error && (
              <div
                id="reset-error"
                role="alert"
                className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-destructive"
              >
                {error}
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="password" className="font-medium text-foreground">
                Nova senha
              </Label>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                placeholder={`Pelo menos ${MIN_PASSWORD_LENGTH} caracteres`}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "reset-error" : undefined}
                className="border-border bg-muted text-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label
                htmlFor="confirmPassword"
                className="font-medium text-foreground"
              >
                Confirmar nova senha
              </Label>
              <Input
                id="confirmPassword"
                type="password"
                autoComplete="new-password"
                placeholder="Digite a nova senha novamente"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "reset-error" : undefined}
                className="border-border bg-muted text-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <Button
              type="submit"
              disabled={loading}
              className="bg-primary text-primary-foreground hover:bg-primary/90 mt-2 h-10 w-full disabled:opacity-50"
            >
              {loading ? "Salvando..." : "Redefinir senha"}
            </Button>
          </form>

          <Link
            href="/login"
            className="text-muted-foreground hover:text-foreground mt-6 flex items-center justify-center gap-2 text-sm rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Cancelar e voltar para o login
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
