"use client";

// Inline "Trocar senha" dialog for the operator sidebar footer — same
// re-auth-then-updateUser logic as settings/password-form.tsx, but as
// a standalone Dialog with Portuguese labels instead of that
// component's English, Card-wrapped /settings look (operators don't
// have a /settings or /perfil route to land the Card version on).

import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const MIN_PASSWORD = 8;

interface ChangePasswordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ChangePasswordDialog({ open, onOpenChange }: ChangePasswordDialogProps) {
  const { profile } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setCurrent("");
    setNext("");
    setConfirm("");
    setError(null);
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!profile?.email) {
      toast.error("Não foi possível identificar seu e-mail");
      return;
    }
    if (next.length < MIN_PASSWORD) {
      setError(`A senha deve ter pelo menos ${MIN_PASSWORD} caracteres`);
      return;
    }
    if (next !== confirm) {
      setError("A nova senha e a confirmação não coincidem");
      return;
    }
    setError(null);
    setSaving(true);

    try {
      const supabase = createClient();
      // Same re-auth-to-verify pattern as password-form.tsx — Supabase
      // has no "check password" API that doesn't also refresh the
      // session, so signing in again both verifies `current` and
      // leaves the session valid for the updateUser call right after.
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: profile.email,
        password: current,
      });
      if (signInError) {
        toast.error("Senha atual incorreta");
        return;
      }

      const { error: updateError } = await supabase.auth.updateUser({ password: next });
      if (updateError) {
        toast.error(`Falha ao atualizar senha: ${updateError.message}`);
        return;
      }

      toast.success("Senha atualizada");
      handleOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro desconhecido");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Trocar senha</DialogTitle>
          <DialogDescription>
            Use pelo menos {MIN_PASSWORD} caracteres. Você continua conectado neste
            dispositivo depois de trocar.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="sidebar-current-password">Senha atual</Label>
            <Input
              id="sidebar-current-password"
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
              disabled={saving}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="sidebar-new-password">Nova senha</Label>
            <Input
              id="sidebar-new-password"
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              autoComplete="new-password"
              minLength={MIN_PASSWORD}
              disabled={saving}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="sidebar-confirm-password">Confirmar nova senha</Label>
            <Input
              id="sidebar-confirm-password"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              minLength={MIN_PASSWORD}
              disabled={saving}
              required
            />
          </div>

          {error && (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={saving}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={saving || !current || !next || !confirm}>
              {saving ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Atualizando…
                </>
              ) : (
                "Atualizar senha"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
