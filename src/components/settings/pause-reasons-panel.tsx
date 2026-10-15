'use client';

// ============================================================
// PauseReasonsPanel — Configurações › Pausas de atendimento.
// A pausa é do sistema: existe sempre, para todas as contas. Aqui só se
// configuram os motivos (nome e tempo máximo) e, pelo cargo/permissões,
// quem pode pausar quem. Não há chave para ligar ou desligar o recurso.
// Rotas: /api/pausas/motivos (GET ?todos=1, POST, PATCH /{id}).
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Pencil, Plus } from 'lucide-react';

import { pausasApi } from '@/lib/pausas/client';
import { MAX_REASON_NAME_LEN, parseReasonForm, pauseErrorMessage, type PauseReason } from '@/lib/pausas/pause';
import { usePausePermissions } from '@/hooks/use-pauses';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ErrorState, ForbiddenState, Skeleton } from '@/components/ddm/states';
import { StatusChip } from '@/components/ddm/status-chip';
import { SettingsPanelHead } from './settings-panel-head';

export function PauseReasonsPanel() {
  const { canManageReasons } = usePausePermissions();
  const [reasons, setReasons] = useState<PauseReason[] | null>(null);
  const [error, setError] = useState(false);
  const [editing, setEditing] = useState<PauseReason | 'new' | null>(null);

  const load = useCallback(async () => {
    const res = await pausasApi.reasons(true);
    if (res.ok) {
      setReasons(res.data.reasons);
      setError(false);
    } else setError(true);
  }, []);

  useEffect(() => {
    if (canManageReasons) queueMicrotask(() => void load());
  }, [canManageReasons, load]);

  if (!canManageReasons) return <ForbiddenState />;
  if (error) return <ErrorState title="Não foi possível carregar os motivos" onRetry={() => void load()} />;
  if (!reasons) return <Skeleton className="h-64 w-full rounded-card" />;

  async function toggleActive(reason: PauseReason, active: boolean) {
    const res = await pausasApi.updateReason(reason.id, { active });
    if (!res.ok) {
      toast.error(pauseErrorMessage(res.error.code, res.error.message));
      return;
    }
    toast.success(active ? 'Motivo ativado' : 'Motivo desativado');
    void load();
  }

  return (
    <div>
      <SettingsPanelHead
        title="Pausas de atendimento"
        description="Motivos que o atendente escolhe ao pausar (almoço, banheiro, treinamento…). Quem está pausado não recebe conversas novas, mas mantém as que já tem."
        action={
          <Button onClick={() => setEditing('new')}>
            <Plus className="size-4" aria-hidden="true" />
            Novo motivo
          </Button>
        }
      />

      <ul className="divide-y divide-border overflow-hidden rounded-card border border-border bg-card">
        {reasons.length === 0 && <li className="px-4 py-6 text-sm text-muted-foreground">Nenhum motivo cadastrado.</li>}
        {reasons.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className={r.active ? 'text-sm font-semibold text-foreground' : 'text-sm font-semibold text-muted-foreground'}>
                {r.name}
              </p>
              <p className="text-xs text-muted-foreground">
                {r.max_minutes === null ? 'Sem tempo máximo' : `Tempo máximo: ${r.max_minutes} min`}
              </p>
            </div>
            {!r.active && <StatusChip tone="mute">Desativado</StatusChip>}
            <Switch
              checked={r.active}
              onCheckedChange={(v) => void toggleActive(r, v)}
              aria-label={r.active ? `Desativar o motivo ${r.name}` : `Ativar o motivo ${r.name}`}
            />
            <Button variant="outline" size="sm" onClick={() => setEditing(r)}>
              <Pencil className="size-3.5" aria-hidden="true" />
              Editar
            </Button>
          </li>
        ))}
      </ul>

      <div className="mt-4 space-y-1 text-[13px] text-muted-foreground">
        <p>
          Ao passar do tempo máximo, o atendente vê um aviso no topo do Inbox, o cartão dele fica destacado no
          Monitoramento e o supervisor da equipe é avisado. O limite só alerta: nunca retoma sozinho.
        </p>
        <p>
          Motivos usados não são apagados, só desativados: o histórico e o relatório continuam com o nome da época. Quem
          pode pausar a si mesmo, pausar outras pessoas ou editar motivos é definido em Cargos e permissões.
        </p>
      </div>

      <ReasonDialog
        target={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void load();
        }}
      />
    </div>
  );
}

function ReasonDialog({
  target,
  onClose,
  onSaved,
}: {
  target: PauseReason | 'new' | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [minutes, setMinutes] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (target === null) return;
    setName(target === 'new' ? '' : target.name);
    setMinutes(target === 'new' || target.max_minutes === null ? '' : String(target.max_minutes));
    setFormError(null);
  }, [target]);

  async function save() {
    if (target === null) return;
    const parsed = parseReasonForm(name, minutes);
    if (!parsed.ok) {
      setFormError(parsed.error);
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const res =
        target === 'new'
          ? await pausasApi.createReason(parsed.body)
          : await pausasApi.updateReason(target.id, parsed.body);
      if (!res.ok) {
        setFormError(pauseErrorMessage(res.error.code, res.error.message));
        return;
      }
      toast.success(target === 'new' ? 'Motivo criado' : 'Motivo atualizado');
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{target === 'new' ? 'Novo motivo de pausa' : 'Editar motivo'}</DialogTitle>
          <DialogDescription>
            Mudar o nome ou o tempo vale para as próximas pausas; as que já aconteceram não mudam.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="pause-reason-name">Nome</Label>
            <Input
              id="pause-reason-name"
              value={name}
              maxLength={MAX_REASON_NAME_LEN}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex.: Almoço"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pause-reason-minutes">Tempo máximo (minutos)</Label>
            <Input
              id="pause-reason-minutes"
              inputMode="numeric"
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
              placeholder="Vazio = sem limite"
            />
            <p className="text-xs text-muted-foreground">Passou do tempo, o atendente e o supervisor são avisados.</p>
          </div>
          {formError && (
            <p role="alert" className="text-sm text-danger">
              {formError}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
