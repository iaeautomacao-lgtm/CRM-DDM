'use client';

// ============================================================
// InviteMemberDialog
//
// Direct-create form: Nome / E-mail / Cargo → POST creates the account
// member immediately (via the bulk-invite endpoint with a single-row
// payload), no separate signup step. NÃO existe senha padrão: a resposta
// traz um LINK de definição de senha para a pessoa, mostrado UMA vez
// (fechar o diálogo o descarta). Sem link (null), a pessoa usa
// "Esqueci minha senha" no login.
// ============================================================

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Check, Copy, Loader2, UserPlus } from 'lucide-react';

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
import { INVITE_LINKS_WARNING, parseInviteLinks, type InviteLink } from '@/lib/members/invite-links';
import { assignableRoles, myLevel, roleErrorMessage } from '@/lib/roles/editor';

interface InviteMemberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful create so the parent re-fetches the roster. */
  onCreated: () => void;
}

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
  const [submitting, setSubmitting] = useState(false);
  // Resultado: quem foi criado e o link dela (só existe nesta tela, uma vez).
  const [created, setCreated] = useState<InviteLink | null>(null);
  const [copied, setCopied] = useState(false);

  function reset() {
    setName('');
    setEmail('');
    setRoleId(null);
    setSubmitting(false);
    setCreated(null);
    setCopied(false);
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

    setSubmitting(true);
    try {
      const res = await fetch('/api/account/members/bulk-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          members: [{ name: trimmedName, email: trimmedEmail, role: chosen?.key, role_id: chosen?.id }],
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
        const link = parseInviteLinks(payload.links).find((l) => l.email.toLowerCase() === trimmedEmail.toLowerCase());
        setCreated(link ?? { name: trimmedName, email: trimmedEmail, link: null });
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

  async function copyLink() {
    if (!created?.link) return;
    try {
      await navigator.clipboard.writeText(created.link);
      setCopied(true);
      toast.success('Link copiado');
    } catch {
      toast.error('Não foi possível copiar. Selecione o link e copie à mão.');
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
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-popover-foreground">
                <Check className="size-4 text-success" />
                {created.name || created.email} foi adicionado
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                Não existe senha padrão: a pessoa define a própria senha pelo link abaixo.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3 py-2" role="status">
              {created.link ? (
                <div className="space-y-2">
                  <Label htmlFor="invite-member-link" className="text-muted-foreground">Link para definir a senha</Label>
                  <div className="flex gap-2">
                    <Input id="invite-member-link" readOnly value={created.link} onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" />
                    <Button type="button" variant="outline" onClick={() => void copyLink()}>
                      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                      {copied ? 'Copiado' : 'Copiar link'}
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="rounded-[10px] border border-warning-border bg-warning-soft px-3 py-2 text-[13px] text-foreground">
                  Não foi possível gerar o link. Peça para a pessoa usar Esqueci minha senha na tela de login.
                </p>
              )}
              <p className="text-xs text-muted-foreground">{INVITE_LINKS_WARNING}</p>
            </div>

            <DialogFooter className="bg-popover border-border">
              <Button
                onClick={() => {
                  reset();
                  onOpenChange(false);
                }}
              >
                Fechar
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-popover-foreground">
                <UserPlus className="size-4 text-primary" />
                Convidar membro
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                Crie o acesso do novo membro diretamente. Você recebe um link para a pessoa definir a própria senha.
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
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
