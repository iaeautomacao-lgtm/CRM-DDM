'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Eye, EyeOff, Loader2, KeyRound } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { MIN_PASSWORD_LENGTH, translateAuthError } from '@/lib/auth/auth-errors';

// Regra única de tamanho mínimo (lib/auth/auth-errors.ts).
const MIN_PASSWORD = MIN_PASSWORD_LENGTH;

export function PasswordForm() {
  const { profile } = useAuth();
  const supabase = createClient();

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [currentError, setCurrentError] = useState<string | null>(null);
  const [showPasswords, setShowPasswords] = useState(false);

  const tooShortError = confirmError !== null && next.length < MIN_PASSWORD;
  const mismatchError = confirmError !== null && !tooShortError;

  // Um único botão por campo, todos controlam a mesma visibilidade.
  const toggleVisibility = (
    <button
      type="button"
      onClick={() => setShowPasswords((v) => !v)}
      className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
      aria-label={showPasswords ? 'Ocultar senhas' : 'Mostrar senhas'}
      aria-pressed={showPasswords}
    >
      {showPasswords ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
    </button>
  );

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile?.email) {
      toast.error('Não é possível trocar a senha sem um e-mail atual');
      return;
    }
    if (next.length < MIN_PASSWORD) {
      setConfirmError(`A senha deve ter pelo menos ${MIN_PASSWORD} caracteres`);
      return;
    }
    if (next !== confirm) {
      setConfirmError('A nova senha e a confirmação não coincidem');
      return;
    }
    setConfirmError(null);
    setSaving(true);

    try {
      // Supabase doesn't expose a "verify password without issuing a
      // session" API, so we re-authenticate with the provided current
      // password. If it matches, the session refreshes silently; if it
      // doesn't, we abort before calling updateUser.
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: profile.email,
        password: current,
      });
      if (signInError) {
        setCurrentError('Senha atual incorreta');
        return;
      }

      const { error: updateError } = await supabase.auth.updateUser({
        password: next,
      });
      if (updateError) {
        toast.error(`Falha ao atualizar senha: ${translateAuthError(updateError)}`);
        return;
      }

      setCurrent('');
      setNext('');
      setConfirm('');
      toast.success('Senha atualizada');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erro desconhecido';
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <KeyRound className="size-4 text-primary" />
          Senha
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          Use pelo menos {MIN_PASSWORD} caracteres. Você continua conectado
          neste dispositivo depois de trocar.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="current-password" className="text-foreground">
              Senha atual
            </Label>
            <div className="relative">
              <Input
                id="current-password"
                type={showPasswords ? 'text' : 'password'}
                value={current}
                onChange={(e) => {
                  setCurrent(e.target.value);
                  setCurrentError(null);
                }}
                autoComplete="current-password"
                aria-invalid={currentError ? true : undefined}
                aria-describedby={currentError ? 'current-password-error' : undefined}
                className={`pr-9${currentError ? ' border-danger' : ''}`}
                disabled={saving}
                required
              />
              {toggleVisibility}
            </div>
            {currentError && (
              <p id="current-password-error" role="alert" className="text-xs text-danger">
                {currentError}
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="new-password" className="text-foreground">
                Nova senha
              </Label>
              <div className="relative">
                <Input
                  id="new-password"
                  type={showPasswords ? 'text' : 'password'}
                  value={next}
                  onChange={(e) => {
                    setNext(e.target.value);
                    setConfirmError(null);
                  }}
                  autoComplete="new-password"
                  minLength={MIN_PASSWORD}
                  aria-invalid={tooShortError ? true : undefined}
                  aria-describedby={tooShortError ? 'password-form-error' : undefined}
                  className={`pr-9${tooShortError ? ' border-danger' : ''}`}
                  disabled={saving}
                  required
                />
                {toggleVisibility}
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm-password" className="text-foreground">
                Confirmar nova senha
              </Label>
              <div className="relative">
                <Input
                  id="confirm-password"
                  type={showPasswords ? 'text' : 'password'}
                  value={confirm}
                  onChange={(e) => {
                    setConfirm(e.target.value);
                    setConfirmError(null);
                  }}
                  autoComplete="new-password"
                  minLength={MIN_PASSWORD}
                  aria-invalid={mismatchError ? true : undefined}
                  aria-describedby={mismatchError ? 'password-form-error' : undefined}
                  className={`pr-9${mismatchError ? ' border-danger' : ''}`}
                  disabled={saving}
                  required
                />
                {toggleVisibility}
              </div>
            </div>
          </div>

          {confirmError && (
            <p
              id="password-form-error"
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {confirmError}
            </p>
          )}

          <div className="flex justify-end">
            <Button
              type="submit"
              disabled={saving || !current || !next || !confirm}
            >
              {saving ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Atualizando…
                </>
              ) : (
                'Atualizar senha'
              )}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
