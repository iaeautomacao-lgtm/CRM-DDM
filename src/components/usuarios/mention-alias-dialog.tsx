'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { AtSign } from 'lucide-react';

import { apiFetch } from '@/lib/api-fetch';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { mentionAliasErrorMessage, parseMentionAlias } from '@/lib/members/mention-alias';

export interface MentionAliasMember {
  user_id: string;
  full_name: string;
  mention_alias?: string | null;
}

/**
 * Apelido @operador (migration 376) na tela de Usuários: mesma validação do servidor
 * (PATCH /api/account/members/:userId, campo mention_alias); 409 = apelido em uso por outro operador.
 * Só abre para quem tem members.manage (quem chama decide).
 */
export function MentionAliasDialog({
  member,
  onClose,
  onSaved,
}: {
  member: MentionAliasMember | null;
  onClose: () => void;
  onSaved: (userId: string, alias: string | null) => void;
}) {
  // Remonta o conteúdo a cada operador: o rascunho e o erro começam do valor salvo.
  return (
    <Dialog open={member !== null} onOpenChange={(open) => !open && onClose()}>
      {member ? <MentionAliasForm key={member.user_id} member={member} onClose={onClose} onSaved={onSaved} /> : null}
    </Dialog>
  );
}

function MentionAliasForm({
  member,
  onClose,
  onSaved,
}: {
  member: MentionAliasMember;
  onClose: () => void;
  onSaved: (userId: string, alias: string | null) => void;
}) {
  const [draft, setDraft] = useState(member.mention_alias ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (saving) return;
    const parsed = parseMentionAlias(draft);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    const alias = parsed.alias;
    if (alias === (member.mention_alias ?? null)) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/account/members/${member.user_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mention_alias: alias }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        setError(mentionAliasErrorMessage(res.status, payload.error));
        return;
      }
      onSaved(member.user_id, alias);
      toast.success(alias ? `Apelido @${alias} salvo` : 'Apelido removido');
      onClose();
    } catch (err) {
      console.error('[UsuariosView] failed to save mention alias:', err);
      setError('Não foi possível conectar ao servidor');
    } finally {
      setSaving(false);
    }
  }

  return (
    <DialogContent className="bg-popover border-border sm:max-w-sm">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2 text-popover-foreground">
          <AtSign className="size-4 text-primary" />
          Apelido de atendimento
        </DialogTitle>
        <DialogDescription className="text-muted-foreground">
          Defina um apelido exclusivo para {member.full_name || 'o operador'}. Quando o cliente enviar @apelido no início da
          mensagem, a IA deixa de atender e a conversa entra na fila de espera deste operador.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-2">
        <Label htmlFor="member-mention-alias">Apelido</Label>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">@</span>
          <Input
            id="member-mention-alias"
            autoComplete="off"
            maxLength={33}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void save();
            }}
            placeholder="adriana"
            aria-invalid={error ? true : undefined}
            aria-describedby="member-mention-hint"
            disabled={saving}
          />
        </div>
        <p
          id="member-mention-hint"
          role={error ? 'alert' : undefined}
          className={error ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}
        >
          {error ?? 'Letras sem acento, números e _. De 2 a 32 caracteres. Deixe vazio para remover o apelido.'}
        </p>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={saving}>
          Cancelar
        </Button>
        <Button onClick={() => void save()} disabled={saving}>
          {saving ? 'Salvando...' : 'Salvar apelido'}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
