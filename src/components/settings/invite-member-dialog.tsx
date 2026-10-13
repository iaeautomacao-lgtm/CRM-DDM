'use client';

// ============================================================
// InviteMemberDialog
//
// Direct-create form: Nome / E-mail / Papel / Senha → POST creates
// the account member immediately (via the bulk-invite endpoint with
// a single-row payload), no separate signup step. Replaces the old
// share-a-link flow — there's no intermediate "pending invitation"
// state for members created here.
// ============================================================

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Eye, EyeOff, Loader2, UserPlus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RoleSelect } from '@/components/usuarios/role-select';
import { useRoles } from '@/hooks/use-roles';
import { usePermissions } from '@/hooks/use-permission';
import { assignableRoles, myLevel, roleErrorMessage } from '@/lib/roles/editor';

interface InviteMemberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful create so the parent re-fetches the roster. */
  onCreated: () => void;
}

const MIN_PASSWORD_LENGTH = 6;

export function InviteMemberDialog({
  open,
  onOpenChange,
  onCreated,
}: InviteMemberDialogProps) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState<string | null>(null);
  // Só cargos abaixo de quem convida (assignable, vindo do servidor).
  const { roles, loading: rolesLoading } = useRoles(open);
  const { me } = usePermissions();
  const options = assignableRoles(roles, myLevel(me));
  const chosen = options.find((r) => r.id === roleId) ?? null;
  useEffect(() => {
    if (roleId === null && options.length > 0) setRoleId((options.find((r) => r.kind === 'system' && r.key === 'agent') ?? options[0]).id);
  }, [roleId, options]);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setName('');
    setEmail('');
    setRoleId(null);
    setPassword('');
    setShowPassword(false);
    setSubmitting(false);
  }

  async function handleCreate() {
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();

    if (!trimmedName) {
      toast.error('Informe o nome do membro');
      return;
    }
    if (!chosen) {
      toast.error('Escolha o cargo do membro');
      return;
    }
    if (!trimmedEmail) {
      toast.error('Informe o e-mail do membro');
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      toast.error(`A senha deve ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres`);
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/account/members/bulk-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          members: [{ name: trimmedName, email: trimmedEmail, role: chosen?.key, role_id: chosen?.id }],
          password,
        }),
      });

      const payload = await res.json().catch(() => ({}));

      if (!res.ok) {
        toast.error(roleErrorMessage(payload, payload.error || 'Falha ao convidar membro'));
        return;
      }

      const errors = (payload.errors ?? []) as { email: string; reason: string }[];
      const imported = payload.imported ?? 0;

      if (imported > 0) {
        toast.success(`${trimmedName} foi adicionado à conta`);
        onCreated();
        reset();
        onOpenChange(false);
        return;
      }

      toast.error(errors[0]?.reason || 'Falha ao convidar membro');
    } catch (err) {
      console.error('[InviteMemberDialog] create error:', err);
      toast.error('Não foi possível conectar ao servidor. Tentar novamente?');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="bg-popover border-border sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-popover-foreground">
            <UserPlus className="size-4 text-primary" />
            Convidar membro
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Crie o acesso do novo membro diretamente. A pessoa poderá entrar
            usando o e-mail e a senha definidos aqui.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="invite-member-name" className="text-muted-foreground">Nome</Label>
            <Input
              id="invite-member-name"
              autoComplete="off"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ex: Sara Almeida"
              className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="invite-member-email" className="text-muted-foreground">E-mail</Label>
            <Input
              id="invite-member-email"
              type="email"
              inputMode="email"
              autoComplete="off"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="sara@empresa.com"
              className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="invite-member-role" className="text-muted-foreground">Cargo</Label>
            <RoleSelect id="invite-member-role" value={roleId} roles={options} onChange={(r) => setRoleId(r.id)} disabled={rolesLoading} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="invite-member-password" className="text-muted-foreground">Senha</Label>
            <div className="relative">
              <Input
                id="invite-member-password"
                autoComplete="new-password"
                aria-describedby="invite-member-password-hint"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={`Mínimo ${MIN_PASSWORD_LENGTH} caracteres`}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground pr-9"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
              >
                {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
            <p id="invite-member-password-hint" className="text-xs text-muted-foreground">
              A senha precisa ter pelo menos {MIN_PASSWORD_LENGTH} caracteres.
            </p>
          </div>
        </div>

        <DialogFooter className="bg-popover border-border">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            Cancelar
          </Button>
          <Button
            onClick={handleCreate}
            disabled={submitting}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Convidando...
              </>
            ) : (
              'Convidar'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
