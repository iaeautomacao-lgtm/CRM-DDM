'use client';

// SLA de primeira resposta padrão da conta (Configurações › Organização). Vale para a equipe que não definiu o dela e
// para conversa sem equipe. Chave first_response_sla_min do registro de account-config:
//   PUT /api/settings/account-config/first_response_sla_min { value: 1..1440 } · DELETE volta ao padrão (15 min).
// Edita só quem tem settings.account (o servidor barra; aqui só some o botão).

import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

import { apiFetch } from '@/lib/api-fetch';
import { useSwrInvalidate } from '@/lib/swr';
import { parseSlaMinutes, SLA_FALLBACK_MINUTES, SLA_RANGE_MESSAGE } from '@/lib/sla/client-config';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusChip } from '@/components/ddm/status-chip';

const SETTING_PATH = '/api/settings/account-config/first_response_sla_min';

async function readError(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  return (body && typeof body.error === 'string' && body.error) || SLA_RANGE_MESSAGE;
}

export function SlaDefaultCard({
  value,
  source,
  canEdit,
  onSaved,
}: {
  /** Valor gravado na conta (null = usa o padrão de 15 min). */
  value: number | null;
  source: 'account' | 'default';
  canEdit: boolean;
  onSaved: (value: number | null) => void;
}) {
  const invalidateSwr = useSwrInvalidate();
  const [draft, setDraft] = useState(value != null ? String(value) : '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const saved = value != null ? String(value) : '';
  const effective = value ?? SLA_FALLBACK_MINUTES;

  async function save(raw: string) {
    if (!canEdit || saving) return;
    const parsed = parseSlaMinutes(raw);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res =
        parsed.value === null
          ? await apiFetch(SETTING_PATH, { method: 'DELETE' })
          : await apiFetch(SETTING_PATH, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ value: parsed.value }),
            });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      setDraft(parsed.value != null ? String(parsed.value) : '');
      onSaved(parsed.value);
      void invalidateSwr('GET');
      toast.success(parsed.value != null ? `SLA padrão da conta: ${parsed.value} min` : `SLA padrão restaurado (${SLA_FALLBACK_MINUTES} min)`);
    } catch (err) {
      console.error('[SlaDefaultCard] falha ao salvar:', err);
      setError('Não foi possível conectar ao servidor');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-card border border-border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-[18px] py-3.5">
        <div className="min-w-[200px] flex-1">
          <h3 className="m-0 text-sm font-semibold text-foreground">SLA de primeira resposta</h3>
          <p className="m-0 mt-0.5 text-[12.5px] text-muted-foreground">
            Padrão da conta. Cada equipe pode ter o seu na tela da equipe; conversa sem equipe usa este.
          </p>
        </div>
        <StatusChip tone={source === 'account' ? 'brand' : 'mute'} dot={false}>
          {source === 'account' ? 'Definido pela conta' : `Padrão do sistema (${SLA_FALLBACK_MINUTES} min)`}
        </StatusChip>
      </div>
      <div className="space-y-2 px-[18px] py-4">
        <Label htmlFor="account-first-response-sla">SLA de primeira resposta (min)</Label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="account-first-response-sla"
            inputMode="numeric"
            autoComplete="off"
            maxLength={4}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save(draft);
            }}
            disabled={!canEdit || saving}
            placeholder={`${SLA_FALLBACK_MINUTES}`}
            aria-invalid={error ? true : undefined}
            aria-describedby="account-first-response-sla-hint"
            className="w-40"
          />
          {canEdit && (
            <>
              <Button onClick={() => void save(draft)} disabled={saving || draft.trim() === saved}>
                {saving ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
                Salvar SLA
              </Button>
              {value != null && (
                <Button variant="outline" onClick={() => void save('')} disabled={saving}>
                  Usar padrão ({SLA_FALLBACK_MINUTES} min)
                </Button>
              )}
            </>
          )}
        </div>
        <p
          id="account-first-response-sla-hint"
          role={error ? 'alert' : undefined}
          className={error ? 'text-xs font-medium text-danger' : 'text-xs text-muted-foreground'}
        >
          {error ?? `Em uso: ${effective} min. De 1 a 1440 minutos.`}
        </p>
      </div>
    </div>
  );
}
