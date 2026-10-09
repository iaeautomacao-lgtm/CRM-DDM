'use client';

// ============================================================
// OrganizationPanel — Configurações › Organização (redesenho DDM).
// Só o que o backend tem:
//   · nome da organização: GET/PATCH /api/account (settings.account, admin+);
//   · fuso e horário de atendimento: /api/settings/account-config (migration 231).
// Fuso e horário ainda NÃO são aplicados em envios e automações — a tela diz isso.
// Não entram: exigir 2FA, tema/densidade padrão e notificações (sem backend).
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Plus, Trash2 } from 'lucide-react';

import { apiFetch } from '@/lib/api-fetch';
import { usePermission } from '@/hooks/use-permission';
import { validateBusinessHours } from '@/lib/settings/account-config';
import {
  MAX_INTERVALS_PER_DAY,
  WEEKDAYS,
  emptyHoursForm,
  formToHours,
  hoursFormEqual,
  hoursToForm,
  type HoursForm,
  type WeekdayKey,
} from '@/lib/settings/business-hours-form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { ErrorState, ForbiddenState, Skeleton } from '@/components/ddm/states';
import { StatusChip } from '@/components/ddm/status-chip';
import { SettingsPanelHead } from './settings-panel-head';

const MAX_NAME_LEN = 80;
const NOT_APPLIED_NOTE = 'Ainda não é aplicado em envios e automações.';
const DEFAULT_TIMEZONE = 'America/Sao_Paulo';

// Fusos IANA do Brasil (nomes de exibição em português). O valor gravado é o identificador IANA.
const BR_TIMEZONES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'America/Sao_Paulo', label: 'Brasília (America/Sao_Paulo)' },
  { value: 'America/Manaus', label: 'Manaus (America/Manaus)' },
  { value: 'America/Cuiaba', label: 'Cuiabá (America/Cuiaba)' },
  { value: 'America/Campo_Grande', label: 'Campo Grande (America/Campo_Grande)' },
  { value: 'America/Rio_Branco', label: 'Rio Branco (America/Rio_Branco)' },
  { value: 'America/Noronha', label: 'Fernando de Noronha (America/Noronha)' },
];

interface SettingView {
  key: string;
  value: unknown;
  source: 'account' | 'default';
  editable: boolean;
}

async function readError(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  return (body && typeof body.error === 'string' && body.error) || `Erro HTTP ${res.status}`;
}

const sectionCard = 'rounded-[10px] border border-border bg-card';

export function OrganizationPanel() {
  const canEdit = usePermission('settings.account');

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  // Nome
  const [savedName, setSavedName] = useState('');
  const [name, setName] = useState('');
  const [savingName, setSavingName] = useState(false);

  // Fuso
  const [savedTz, setSavedTz] = useState(DEFAULT_TIMEZONE);
  const [tz, setTz] = useState(DEFAULT_TIMEZONE);
  const [tzSource, setTzSource] = useState<'account' | 'default'>('default');
  const [savingTz, setSavingTz] = useState(false);

  // Horário
  const [savedHours, setSavedHours] = useState<HoursForm>(emptyHoursForm());
  const [hours, setHours] = useState<HoursForm>(emptyHoursForm());
  const [hoursSource, setHoursSource] = useState<'account' | 'default'>('default');
  const [savingHours, setSavingHours] = useState(false);
  const [hoursError, setHoursError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [accRes, cfgRes] = await Promise.all([apiFetch('/api/account'), apiFetch('/api/settings/account-config')]);
      if (accRes.status === 403 || cfgRes.status === 403) {
        setForbidden(true);
        return;
      }
      if (!accRes.ok) throw new Error(await readError(accRes));
      if (!cfgRes.ok) throw new Error(await readError(cfgRes));
      const acc = await accRes.json();
      const cfg = await cfgRes.json();
      const accName = String(acc?.account?.name ?? '');
      setSavedName(accName);
      setName(accName);
      for (const s of (cfg?.settings ?? []) as SettingView[]) {
        if (s.key === 'timezone' && typeof s.value === 'string') {
          setSavedTz(s.value);
          setTz(s.value);
          setTzSource(s.source);
        } else if (s.key === 'business_hours') {
          const f = hoursToForm(s.value);
          setSavedHours(f);
          setHours(f);
          setHoursSource(s.source);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao carregar as configurações');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const tzOptions = useMemo(
    () => (BR_TIMEZONES.some((t) => t.value === tz) ? BR_TIMEZONES : [...BR_TIMEZONES, { value: tz, label: tz }]),
    [tz],
  );

  async function saveName() {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error('Informe o nome da organização.');
      return;
    }
    setSavingName(true);
    try {
      const res = await apiFetch('/api/account', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) throw new Error(await readError(res));
      setSavedName(trimmed);
      setName(trimmed);
      toast.success('Nome da organização atualizado');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao salvar o nome');
    } finally {
      setSavingName(false);
    }
  }

  async function putSetting(key: string, value: unknown): Promise<boolean> {
    const res = await apiFetch(`/api/settings/account-config/${key}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    });
    if (!res.ok) {
      toast.error(await readError(res));
      return false;
    }
    return true;
  }

  async function resetSetting(key: string): Promise<boolean> {
    const res = await apiFetch(`/api/settings/account-config/${key}`, { method: 'DELETE' });
    if (!res.ok) {
      toast.error(await readError(res));
      return false;
    }
    return true;
  }

  async function saveTz() {
    setSavingTz(true);
    try {
      if (await putSetting('timezone', tz)) {
        setSavedTz(tz);
        setTzSource('account');
        toast.success('Fuso horário atualizado');
      }
    } finally {
      setSavingTz(false);
    }
  }

  async function resetTz() {
    setSavingTz(true);
    try {
      if (await resetSetting('timezone')) {
        setSavedTz(DEFAULT_TIMEZONE);
        setTz(DEFAULT_TIMEZONE);
        setTzSource('default');
        toast.success('Fuso horário voltou ao padrão');
      }
    } finally {
      setSavingTz(false);
    }
  }

  function setDay(day: WeekdayKey, next: HoursForm[WeekdayKey]) {
    setHoursError(null);
    setHours((h) => ({ ...h, [day]: next }));
  }

  async function saveHours() {
    const payload = formToHours(hours);
    const checked = validateBusinessHours(payload);
    if (!checked.ok) {
      setHoursError(checked.error);
      return;
    }
    setSavingHours(true);
    try {
      if (await putSetting('business_hours', checked.value)) {
        setSavedHours(hours);
        setHoursSource('account');
        toast.success('Horário de atendimento atualizado');
      }
    } finally {
      setSavingHours(false);
    }
  }

  async function resetHours() {
    setSavingHours(true);
    try {
      if (await resetSetting('business_hours')) {
        const empty = emptyHoursForm();
        setSavedHours(empty);
        setHours(empty);
        setHoursSource('default');
        setHoursError(null);
        toast.success('Horário de atendimento removido');
      }
    } finally {
      setSavingHours(false);
    }
  }

  if (loading) {
    return (
      <section className="max-w-3xl space-y-3" aria-busy="true">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </section>
    );
  }
  if (forbidden) return <ForbiddenState title="Você não tem permissão para ver as configurações da organização" />;
  if (error) return <ErrorState title={error} onRetry={() => void load()} />;

  const nameDirty = name.trim() !== savedName;
  const tzDirty = tz !== savedTz;
  const hoursDirty = !hoursFormEqual(hours, savedHours);

  return (
    <section className="max-w-3xl animate-in fade-in-50 space-y-4 duration-200">
      <SettingsPanelHead
        title="Organização"
        description={
          canEdit
            ? 'Dados da organização e padrões gerais para todos os usuários.'
            : 'Dados da organização. Apenas administradores e proprietários podem alterar.'
        }
      />

      {/* Nome */}
      <div className={sectionCard}>
        <div className="border-b border-border px-[18px] py-3.5">
          <h3 className="m-0 text-sm font-semibold text-foreground">Nome da organização</h3>
          <p className="m-0 mt-0.5 text-[12.5px] text-muted-foreground">Exibido para a equipe e nos relatórios.</p>
        </div>
        <div className="flex flex-wrap items-end gap-3 px-[18px] py-4">
          <div className="min-w-[220px] flex-1 space-y-1.5">
            <Label htmlFor="org-name">Nome</Label>
            <Input
              id="org-name"
              value={name}
              maxLength={MAX_NAME_LEN}
              disabled={!canEdit || savingName}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          {canEdit && (
            <Button onClick={() => void saveName()} disabled={savingName || !nameDirty || !name.trim()}>
              {savingName ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
              Salvar nome
            </Button>
          )}
        </div>
      </div>

      {/* Fuso */}
      <div className={sectionCard}>
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-[18px] py-3.5">
          <div className="min-w-[200px] flex-1">
            <h3 className="m-0 text-sm font-semibold text-foreground">Fuso horário</h3>
            <p className="m-0 mt-0.5 text-[12.5px] text-muted-foreground">{NOT_APPLIED_NOTE}</p>
          </div>
          <StatusChip tone={tzSource === 'account' ? 'brand' : 'mute'} dot={false}>
            {tzSource === 'account' ? 'Definido pela conta' : 'Padrão do sistema'}
          </StatusChip>
        </div>
        <div className="flex flex-wrap items-end gap-3 px-[18px] py-4">
          <div className="min-w-[220px] flex-1 space-y-1.5">
            <Label htmlFor="org-tz">Fuso da conta</Label>
            <select
              id="org-tz"
              value={tz}
              disabled={!canEdit || savingTz}
              onChange={(e) => setTz(e.target.value)}
              className="h-9 w-full rounded-lg border border-input bg-background px-2.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            >
              {tzOptions.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          {canEdit && (
            <div className="flex gap-2">
              {tzSource === 'account' && (
                <Button variant="outline" onClick={() => void resetTz()} disabled={savingTz}>
                  Voltar ao padrão
                </Button>
              )}
              <Button onClick={() => void saveTz()} disabled={savingTz || !tzDirty}>
                {savingTz ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
                Salvar fuso
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Horário de atendimento */}
      <div className={sectionCard}>
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-[18px] py-3.5">
          <div className="min-w-[200px] flex-1">
            <h3 className="m-0 text-sm font-semibold text-foreground">Horário de atendimento</h3>
            <p className="m-0 mt-0.5 text-[12.5px] text-muted-foreground">
              Dias e intervalos em que a equipe atende. {NOT_APPLIED_NOTE}
            </p>
          </div>
          <StatusChip tone={hoursSource === 'account' ? 'brand' : 'mute'} dot={false}>
            {hoursSource === 'account' ? 'Definido pela conta' : 'Sem horário definido'}
          </StatusChip>
        </div>
        <ul className="m-0 list-none divide-y divide-border p-0">
          {WEEKDAYS.map(({ key, label }) => {
            const intervals = hours[key];
            const on = intervals.length > 0;
            return (
              <li key={key} className="flex flex-wrap items-start gap-3 px-[18px] py-3">
                <div className="flex w-44 shrink-0 items-center gap-2.5 pt-1.5">
                  <Switch
                    checked={on}
                    disabled={!canEdit || savingHours}
                    onCheckedChange={(checked) => setDay(key, checked ? [{ start: '08:00', end: '18:00' }] : [])}
                    aria-label={`Atender ${label}`}
                  />
                  <span className="text-sm font-medium text-foreground">{label}</span>
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  {!on ? (
                    <span className="pt-1.5 text-[12.5px] text-muted-foreground">Sem atendimento</span>
                  ) : (
                    intervals.map((iv, idx) => (
                      <div key={idx} className="flex flex-wrap items-center gap-2">
                        <Input
                          type="time"
                          value={iv.start}
                          disabled={!canEdit || savingHours}
                          aria-label={`${label}: início do intervalo ${idx + 1}`}
                          className="h-8 w-28"
                          onChange={(e) =>
                            setDay(key, intervals.map((x, i) => (i === idx ? { ...x, start: e.target.value } : x)))
                          }
                        />
                        <span className="text-xs text-muted-foreground">às</span>
                        <Input
                          type="time"
                          value={iv.end}
                          disabled={!canEdit || savingHours}
                          aria-label={`${label}: fim do intervalo ${idx + 1}`}
                          className="h-8 w-28"
                          onChange={(e) =>
                            setDay(key, intervals.map((x, i) => (i === idx ? { ...x, end: e.target.value } : x)))
                          }
                        />
                        {canEdit && (
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label={`${label}: remover intervalo ${idx + 1}`}
                            className="text-muted-foreground hover:text-destructive"
                            disabled={savingHours}
                            onClick={() => setDay(key, intervals.filter((_, i) => i !== idx))}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        )}
                      </div>
                    ))
                  )}
                  {canEdit && on && intervals.length < MAX_INTERVALS_PER_DAY && (
                    <Button
                      variant="ghost"
                      size="xs"
                      className="w-fit"
                      disabled={savingHours}
                      onClick={() => setDay(key, [...intervals, { start: '', end: '' }])}
                    >
                      <Plus className="size-3.5" aria-hidden="true" />
                      Adicionar intervalo
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {hoursError && (
          <p role="alert" className="m-0 border-t border-border px-[18px] py-2.5 text-xs font-medium text-danger">
            {hoursError}
          </p>
        )}
        {canEdit && (
          <div className="flex flex-wrap justify-end gap-2 border-t border-border px-[18px] py-3">
            {hoursSource === 'account' && (
              <Button variant="outline" onClick={() => void resetHours()} disabled={savingHours}>
                Remover horário
              </Button>
            )}
            <Button onClick={() => void saveHours()} disabled={savingHours || !hoursDirty}>
              {savingHours ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
              Salvar horário
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
