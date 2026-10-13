'use client';

// Diálogo de criar/editar variável ou credencial. Usado em Configurações → Variáveis e credenciais e
// "inline" nos pontos que referenciam uma credencial ainda inexistente (aviso "Criar agora").
// Credencial é write-only: o valor vai cifrado pelo servidor e nunca volta nem é logado.

import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

import { apiFetch } from '@/lib/api-fetch';
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
import { Textarea } from '@/components/ui/textarea';

export interface SecretItem {
  id: string;
  name: string;
  kind: 'variable' | 'credential';
  value?: string;
  last4?: string | null;
  allowed_hosts: string[];
  description: string | null;
  updated_at: string;
}

function parseHosts(text: string): string[] {
  return text
    .split(/[s,;]+/)
    .map((h) => h.trim())
    .filter(Boolean);
}

export function SecretDialog({
  item,
  onClose,
  onSaved,
  presetName,
  presetKind,
}: {
  item: SecretItem | null;
  /** Criação inline: nome já definido pela referência (não editável). */
  presetName?: string;
  /** Criação inline: tipo fixo (sem o seletor Variável/Credencial). */
  presetKind?: SecretItem['kind'];
  onClose: () => void;
  onSaved: (saved: SecretItem) => void;
}) {
  const isNew = item === null;
  const [name, setName] = useState(item?.name ?? presetName ?? '');
  const [kind, setKind] = useState<'variable' | 'credential'>(item?.kind ?? presetKind ?? 'variable');
  // Variável: valor visível. Credencial: write-only — vazio ao editar mantém o atual.
  const [value, setValue] = useState(item?.kind === 'variable' ? (item.value ?? '') : '');
  const [replacing, setReplacing] = useState(isNew);
  const [hosts, setHosts] = useState((item?.allowed_hosts ?? []).join('\n'));
  const [description, setDescription] = useState(item?.description ?? '');
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const payload: Record<string, unknown> = { description };
      if (isNew) {
        payload.name = name.trim().toUpperCase();
        payload.kind = kind;
      }
      if (kind === 'credential') {
        payload.allowed_hosts = parseHosts(hosts);
        // Edição sem "Substituir": não manda valor (a API mantém o atual).
        if (isNew || replacing) payload.value = value;
      } else {
        payload.value = value;
      }
      const res = await apiFetch(isNew ? '/api/settings/secrets' : `/api/settings/secrets/${item.id}`, {
        method: isNew ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || 'Não foi possível salvar.');
        return;
      }
      toast.success(isNew ? 'Cadastrado' : 'Atualizado');
      onSaved((data as { secret: SecretItem }).secret);
    } catch {
      toast.error('Não foi possível falar com o servidor.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="border-border bg-popover sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isNew ? 'Nova variável ou credencial' : `Editar ${item.name}`}</DialogTitle>
          <DialogDescription>
            {kind === 'credential'
              ? 'O valor é cifrado no servidor e nunca mais aparece na tela.'
              : 'Variáveis são texto comum, visível para quem acessa esta seção.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {isNew && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="secret-name">Nome</Label>
                <Input
                  id="secret-name"
                  value={name}
                  onChange={(e) => setName(e.target.value.toUpperCase())}
                  placeholder="DDM_TOKEN"
                  disabled={saving || presetName !== undefined}
                />
                <p className="text-muted-foreground text-xs">MAIÚSCULAS e sublinhado. Não pode ser alterado depois.</p>
              </div>
              {presetKind === undefined && (
              <div className="flex gap-2">
                {(['variable', 'credential'] as const).map((k) => (
                  <Button
                    key={k}
                    type="button"
                    variant={kind === k ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setKind(k)}
                    disabled={saving}
                  >
                    {k === 'variable' ? 'Variável' : 'Credencial'}
                  </Button>
                ))}
              </div>
              )}
            </>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="secret-value">Valor</Label>
            {kind === 'credential' && !isNew && !replacing ? (
              <div className="flex items-center gap-2">
                <Input value={`••••${item?.last4 ?? ''}`} disabled readOnly />
                <Button type="button" variant="outline" onClick={() => setReplacing(true)} disabled={saving}>
                  Substituir
                </Button>
              </div>
            ) : (
              <Input
                id="secret-value"
                type={kind === 'credential' ? 'password' : 'text'}
                autoComplete="off"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={kind === 'credential' ? 'Cole o token/chave' : 'Valor'}
                disabled={saving}
              />
            )}
          </div>

          {kind === 'credential' && (
            <div className="space-y-1.5">
              <Label htmlFor="secret-hosts">Hosts permitidos</Label>
              <Textarea
                id="secret-hosts"
                value={hosts}
                onChange={(e) => setHosts(e.target.value)}
                placeholder={'api.exemplo.com\nddmacordos.com'}
                rows={3}
                disabled={saving}
              />
              <p className="text-muted-foreground text-xs">
                Um por linha. A credencial só é enviada para estes domínios (e subdomínios). Obrigatório.
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="secret-desc">Descrição (opcional)</Label>
            <Input
              id="secret-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={300}
              disabled={saving}
            />
          </div>

          <p className="text-muted-foreground bg-muted rounded-md p-2 text-xs">
            Uso nas ferramentas: <code>{kind === 'credential' ? '{{cred.' : '{{var.'}{name || 'NOME'}
              {'}}'}</code>{' '}
            na URL, nos headers ou no body.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
