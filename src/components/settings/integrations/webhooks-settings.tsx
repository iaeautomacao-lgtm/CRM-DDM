'use client';

// Integrações → Webhooks de saída (PRD 15, 15.14; tela da TASK2). Lista + gaveta do redesenho DDM sobre
// /api/settings/webhooks (sessão, api_keys.manage). O segredo `whsec_…` aparece UMA vez (criação e troca) e nunca
// volta em leitura. Entregas com filtro por estado, paginação por cursor e reenvio das que esgotaram as tentativas.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, Copy, KeyRound, Loader2, Plus, RefreshCw, Send, Trash2, Webhook } from 'lucide-react';

import { apiFetch } from '@/lib/api-fetch';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { Switch } from '@/components/ui/switch';
import { DetailDrawer, ListCard, ListRow } from '@/components/ddm/list-with-drawer';
import { Segmented } from '@/components/ddm/segmented';
import { StatusChip, type StatusTone } from '@/components/ddm/status-chip';
import { EmptyState, ErrorState, Skeleton } from '@/components/ddm/states';

export interface WebhookEndpoint {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  status: 'active' | 'paused';
  consecutive_failures: number;
  last_success_at: string | null;
  last_failure_at: string | null;
  created_at: string;
}

export interface WebhookDelivery {
  id: string;
  event: string;
  event_id: string;
  state: 'pending' | 'sending' | 'delivered' | 'dead';
  attempts: number;
  next_attempt_at: string;
  last_status: number | null;
  last_error: string | null;
  created_at: string;
  delivered_at: string | null;
}

interface EventOption {
  id: string;
  description: string;
}

type DeliveryFilter = 'all' | WebhookDelivery['state'];

const DELIVERY_STATE: Record<WebhookDelivery['state'], { label: string; tone: StatusTone }> = {
  pending: { label: 'Na fila', tone: 'info' },
  sending: { label: 'Enviando', tone: 'info' },
  delivered: { label: 'Entregue', tone: 'ok' },
  dead: { label: 'Falhou', tone: 'bad' },
};

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

/** Situação mostrada na lista: pausado, falhando (falhas seguidas) ou ativo — sempre com texto, não só cor. */
export function endpointHealth(e: Pick<WebhookEndpoint, 'status' | 'consecutive_failures'>): { label: string; tone: StatusTone } {
  if (e.status === 'paused') return { label: 'Pausado', tone: 'mute' };
  if (e.consecutive_failures > 0) {
    return { label: `${e.consecutive_failures} falha${e.consecutive_failures === 1 ? '' : 's'} seguida${e.consecutive_failures === 1 ? '' : 's'}`, tone: 'warn' };
  }
  return { label: 'Ativo', tone: 'ok' };
}

/** host + caminho, sem query (a query pode carregar token de quem integra). */
export function displayUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return url;
  }
}

async function readJson<T>(res: Response): Promise<T & { error?: string }> {
  return (await res.json().catch(() => ({}))) as T & { error?: string };
}

export function WebhooksSettings() {
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[] | null>(null);
  const [events, setEvents] = useState<EventOption[]>([]);
  const [max, setMax] = useState(10);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ title: string; value: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch('/api/settings/webhooks', { cache: 'no-store' });
        const body = await readJson<{ endpoints: WebhookEndpoint[]; events: EventOption[]; max_endpoints: number }>(res);
        if (cancelled) return;
        if (!res.ok) {
          setError(body.error ?? 'Não foi possível carregar os webhooks.');
          setEndpoints([]);
          return;
        }
        setEndpoints(body.endpoints);
        setEvents(body.events);
        setMax(body.max_endpoints);
      } catch {
        if (!cancelled) {
          setError('Não foi possível falar com o servidor.');
          setEndpoints([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reload]);

  const opened = useMemo(() => endpoints?.find((e) => e.id === openId) ?? null, [endpoints, openId]);
  const replace = (next: WebhookEndpoint) => setEndpoints((prev) => prev?.map((e) => (e.id === next.id ? next : e)) ?? prev);

  async function setStatus(e: WebhookEndpoint, status: WebhookEndpoint['status']) {
    replace({ ...e, status });
    const res = await apiFetch(`/api/settings/webhooks/${e.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    const body = await readJson<WebhookEndpoint>(res);
    if (!res.ok) {
      replace(e);
      toast.error(body.error ?? 'Não foi possível alterar o webhook.');
      return;
    }
    replace(body);
    toast.success(status === 'paused' ? 'Webhook pausado: os eventos deixam de ser enviados.' : 'Webhook ativado.');
  }

  const loading = endpoints === null;
  const full = (endpoints?.length ?? 0) >= max;

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold text-foreground">Webhooks de saída</h3>
          <p className="mt-1 max-w-[70ch] text-[13px] text-foreground-2">
            O CRM avisa outro sistema quando algo acontece (mensagem recebida, status de envio, conversa encerrada,
            acordo, opt-out). Cada envio é assinado com o segredo do webhook no cabeçalho{' '}
            <code className="text-xs">X-CRM-Signature</code> e é repetido se o destino falhar.
          </p>
        </div>
        <Button onClick={() => setCreating(true)} disabled={loading || full} className="shrink-0" title={full ? `Limite de ${max} webhooks` : undefined}>
          <Plus className="size-4" />
          Novo webhook
        </Button>
      </div>

      {error ? (
        <ErrorState
          title="Não foi possível carregar os webhooks"
          hint={error}
          onRetry={() => {
            setError(null);
            setEndpoints(null);
            setReload((n) => n + 1);
          }}
        />
      ) : loading ? (
        <div className="flex flex-col gap-2" aria-busy>
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-16 rounded-[10px]" />
          ))}
        </div>
      ) : endpoints.length === 0 ? (
        <EmptyState icon={Webhook} title="Nenhum webhook cadastrado" hint="Crie um em “Novo webhook” e escolha os eventos." />
      ) : (
        <ListCard aria-label="Webhooks de saída">
          {endpoints.map((e, i) => {
            const health = endpointHealth(e);
            return (
              <ListRow key={e.id} index={i} label={displayUrl(e.url)} selected={e.id === openId} onSelect={() => setOpenId(e.id)}>
                <span
                  aria-hidden
                  className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-3 text-muted-foreground"
                >
                  <Webhook className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-mono text-[12.5px] text-foreground">{displayUrl(e.url)}</span>
                    <StatusChip tone={health.tone}>{health.label}</StatusChip>
                  </div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {e.description ? `${e.description} · ` : ''}
                    {e.events.length} evento{e.events.length === 1 ? '' : 's'} · última entrega {fmtDate(e.last_success_at)}
                  </div>
                </div>
                <Switch
                  checked={e.status === 'active'}
                  onCheckedChange={(on) => void setStatus(e, on ? 'active' : 'paused')}
                  aria-label={`${e.status === 'active' ? 'Pausar' : 'Ativar'} webhook ${displayUrl(e.url)}`}
                />
              </ListRow>
            );
          })}
        </ListCard>
      )}

      {full && !loading && (
        <p className="text-xs text-muted-foreground">Limite de {max} webhooks por conta atingido. Remova um para cadastrar outro.</p>
      )}

      {creating && (
        <CreateWebhookDialog
          events={events}
          onClose={() => setCreating(false)}
          onCreated={(created, value) => {
            setCreating(false);
            setEndpoints((prev) => [created, ...(prev ?? [])]);
            setSecret({ title: 'Webhook criado', value });
          }}
        />
      )}

      <DetailDrawer
        open={!!opened}
        onOpenChange={(o) => !o && setOpenId(null)}
        title={opened ? displayUrl(opened.url) : ''}
        description={opened ? `Criado em ${fmtDate(opened.created_at)}` : undefined}
        headerExtra={opened ? <StatusChip tone={endpointHealth(opened).tone}>{endpointHealth(opened).label}</StatusChip> : null}
        size="xl"
      >
        {opened && (
          <WebhookDetail
            key={opened.id}
            endpoint={opened}
            events={events}
            onSaved={replace}
            onDeleted={() => {
              setEndpoints((prev) => prev?.filter((e) => e.id !== opened.id) ?? prev);
              setOpenId(null);
            }}
            onSecret={(value) => setSecret({ title: 'Segredo trocado', value })}
          />
        )}
      </DetailDrawer>

      <SecretDialog secret={secret} onClose={() => setSecret(null)} />
    </div>
  );
}

function EventPicker({
  events,
  value,
  onChange,
  disabled,
}: {
  events: EventOption[];
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="overflow-hidden rounded-lg border" disabled={disabled}>
      <legend className="sr-only">Eventos</legend>
      {events.map((ev) => {
        const on = value.includes(ev.id);
        return (
          <label key={ev.id} className="flex cursor-pointer items-start gap-2.5 border-b px-3 py-2.5 last:border-b-0 hover:bg-surface-hover">
            <Checkbox
              checked={on}
              onCheckedChange={(v) => onChange(v === true ? [...value, ev.id] : value.filter((x) => x !== ev.id))}
              className="mt-0.5"
            />
            <span className="min-w-0">
              <code className="block text-[12.5px] text-foreground">{ev.id}</code>
              <span className="text-xs text-muted-foreground">{ev.description}</span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

function CreateWebhookDialog({
  events,
  onClose,
  onCreated,
}: {
  events: EventOption[];
  onClose: () => void;
  onCreated: (endpoint: WebhookEndpoint, secret: string) => void;
}) {
  const [url, setUrl] = useState('https://');
  const [description, setDescription] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch('/api/settings/webhooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), events: chosen, description: description.trim() || undefined }),
      });
      const body = await readJson<WebhookEndpoint & { secret: string }>(res);
      if (!res.ok) {
        setError(body.error ?? 'Não foi possível criar o webhook.');
        return;
      }
      const { secret, ...endpoint } = body;
      onCreated(endpoint as WebhookEndpoint, secret);
    } catch {
      setError('Não foi possível falar com o servidor.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !saving && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Novo webhook</DialogTitle>
          <DialogDescription>Endereço público com https. O segredo de assinatura aparece uma vez, ao criar.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3.5">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="wh-url">URL</Label>
            <Input id="wh-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://seu-sistema.com/webhooks/crm" disabled={saving} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="wh-desc">Descrição (opcional)</Label>
            <Input id="wh-desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} disabled={saving} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Eventos</Label>
            <EventPicker events={events} value={chosen} onChange={setChosen} disabled={saving} />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button onClick={() => void save()} disabled={saving || chosen.length === 0 || !url.trim()}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            Criar webhook
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SecretDialog({ secret, onClose }: { secret: { title: string; value: string } | null; onClose: () => void }) {
  async function copy() {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret.value);
      toast.success('Segredo copiado.');
    } catch {
      toast.error('Não foi possível copiar. Selecione e copie manualmente.');
    }
  }
  return (
    <Dialog open={!!secret} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{secret?.title}</DialogTitle>
          <DialogDescription>Use este segredo para validar a assinatura X-CRM-Signature dos envios.</DialogDescription>
        </DialogHeader>
        <p role="note" className="flex items-start gap-2 rounded-lg border border-warning-border bg-warning-soft px-3 py-2 text-[12.5px] text-foreground">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          Copie agora. Por segurança, o segredo não será exibido de novo.
        </p>
        <div className="flex gap-1.5">
          <Input readOnly value={secret?.value ?? ''} aria-label="Segredo do webhook" className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
          <Button variant="outline" onClick={() => void copy()}>
            <Copy className="size-4" />
            Copiar
          </Button>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Concluir</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function WebhookDetail({
  endpoint,
  events,
  onSaved,
  onDeleted,
  onSecret,
}: {
  endpoint: WebhookEndpoint;
  events: EventOption[];
  onSaved: (e: WebhookEndpoint) => void;
  onDeleted: () => void;
  onSecret: (value: string) => void;
}) {
  const [url, setUrl] = useState(endpoint.url);
  const [description, setDescription] = useState(endpoint.description ?? '');
  const [chosen, setChosen] = useState<string[]>(endpoint.events);
  const [busy, setBusy] = useState<null | 'save' | 'rotate' | 'test' | 'delete'>(null);

  const dirty =
    url.trim() !== endpoint.url ||
    description.trim() !== (endpoint.description ?? '') ||
    chosen.slice().sort().join(',') !== endpoint.events.slice().sort().join(',');

  async function call<T>(path: string, init: RequestInit, kind: NonNullable<typeof busy>): Promise<(T & { error?: string }) | null> {
    setBusy(kind);
    try {
      const res = await apiFetch(path, init);
      const body = await readJson<T>(res);
      if (!res.ok) {
        toast.error(body.error ?? 'Não foi possível concluir.');
        return null;
      }
      return body;
    } catch {
      toast.error('Não foi possível falar com o servidor.');
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    const patch: Record<string, unknown> = {};
    if (url.trim() !== endpoint.url) patch.url = url.trim();
    if (description.trim() !== (endpoint.description ?? '')) patch.description = description.trim();
    if (chosen.slice().sort().join(',') !== endpoint.events.slice().sort().join(',')) patch.events = chosen;
    const body = await call<WebhookEndpoint>(
      `/api/settings/webhooks/${endpoint.id}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) },
      'save',
    );
    if (body) {
      onSaved(body);
      toast.success('Webhook atualizado.');
    }
  }

  async function rotate() {
    if (!window.confirm('Trocar o segredo? O atual deixa de valer na hora: atualize o sistema que recebe.')) return;
    const body = await call<{ secret: string }>(`/api/settings/webhooks/${endpoint.id}/rotate-secret`, { method: 'POST' }, 'rotate');
    if (body?.secret) onSecret(body.secret);
  }

  async function test() {
    const body = await call<{ delivery_id: string }>(`/api/settings/webhooks/${endpoint.id}/test`, { method: 'POST' }, 'test');
    if (body) toast.success('Teste enfileirado: o resultado aparece nas entregas em instantes.');
  }

  async function remove() {
    if (!window.confirm(`Remover o webhook ${displayUrl(endpoint.url)}? Os eventos deixam de ser enviados.`)) return;
    const body = await call<{ deleted: boolean }>(`/api/settings/webhooks/${endpoint.id}`, { method: 'DELETE' }, 'delete');
    if (body) {
      toast.success('Webhook removido.');
      onDeleted();
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3.5" aria-labelledby="wh-config">
        <h4 id="wh-config" className="text-[13px] font-semibold text-foreground">
          Configuração
        </h4>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="wh-edit-url">URL</Label>
          <Input id="wh-edit-url" value={url} onChange={(e) => setUrl(e.target.value)} disabled={!!busy} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="wh-edit-desc">Descrição</Label>
          <Input id="wh-edit-desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} disabled={!!busy} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Eventos</Label>
          <EventPicker events={events} value={chosen} onChange={setChosen} disabled={!!busy} />
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={() => void save()} disabled={!dirty || chosen.length === 0 || !!busy}>
            {busy === 'save' && <Loader2 className="size-4 animate-spin" />}
            Salvar alterações
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-2 border-t pt-5" aria-labelledby="wh-actions">
        <h4 id="wh-actions" className="text-[13px] font-semibold text-foreground">
          Segredo e teste
        </h4>
        <p className="text-xs text-muted-foreground">
          O segredo nunca é exibido de novo. Ao trocar, o novo aparece uma vez e o anterior deixa de valer. O teste envia um
          evento <code>webhook.test</code> só para este endereço.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void rotate()} disabled={!!busy}>
            {busy === 'rotate' ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
            Trocar segredo
          </Button>
          <Button variant="outline" onClick={() => void test()} disabled={!!busy || endpoint.status === 'paused'}>
            {busy === 'test' ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            Enviar teste
          </Button>
          <Button variant="ghost" onClick={() => void remove()} disabled={!!busy} className="text-destructive hover:text-destructive">
            {busy === 'delete' ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            Remover
          </Button>
        </div>
        {endpoint.status === 'paused' && <p className="text-xs text-muted-foreground">Ative o webhook para enviar teste.</p>}
      </section>

      <DeliveriesSection endpointId={endpoint.id} />
    </div>
  );
}

function DeliveriesSection({ endpointId }: { endpointId: string }) {
  const [filter, setFilter] = useState<DeliveryFilter>('all');
  const [items, setItems] = useState<WebhookDelivery[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [replaying, setReplaying] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const fetchPage = useCallback(
    async (after: string | null) => {
      const qs = new URLSearchParams({ limit: '20' });
      if (filter !== 'all') qs.set('state', filter);
      if (after) qs.set('cursor', after);
      const res = await apiFetch(`/api/settings/webhooks/${endpointId}/deliveries?${qs.toString()}`, { cache: 'no-store' });
      const body = await readJson<{ items: WebhookDelivery[]; next_cursor: string | null }>(res);
      if (!res.ok) throw new Error(body.error ?? 'Não foi possível carregar as entregas.');
      return body;
    },
    [endpointId, filter],
  );

  useEffect(() => {
    let cancelled = false;
    fetchPage(null).then(
      (body) => {
        if (cancelled) return;
        setItems(body.items);
        setCursor(body.next_cursor);
      },
      (err: Error) => {
        if (cancelled) return;
        setError(err.message);
        setItems([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [fetchPage, reload]);

  function refresh() {
    setError(null);
    setItems(null);
    setCursor(null);
    setReload((n) => n + 1);
  }

  async function more() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const body = await fetchPage(cursor);
      setItems((prev) => [...(prev ?? []), ...body.items]);
      setCursor(body.next_cursor);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível carregar mais.');
    } finally {
      setLoadingMore(false);
    }
  }

  async function replay(d: WebhookDelivery) {
    setReplaying(d.id);
    try {
      const res = await apiFetch(`/api/settings/webhooks/${endpointId}/deliveries/${d.id}/replay`, { method: 'POST' });
      const body = await readJson<{ replayed: boolean }>(res);
      if (!res.ok) {
        toast.error(body.error ?? 'Não foi possível reenviar.');
        return;
      }
      toast.success('Entrega colocada de novo na fila.');
      setItems((prev) => prev?.map((x) => (x.id === d.id ? { ...x, state: 'pending' } : x)) ?? prev);
    } finally {
      setReplaying(null);
    }
  }

  return (
    <section className="flex flex-col gap-3 border-t pt-5" aria-labelledby="wh-deliveries">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id="wh-deliveries" className="text-[13px] font-semibold text-foreground">
          Entregas
        </h4>
        <div className="flex items-center gap-2">
          <Segmented<DeliveryFilter>
            ariaLabel="Filtrar entregas"
            size="sm"
            value={filter}
            onChange={(v) => {
              setFilter(v);
              setItems(null);
              setCursor(null);
              setError(null);
            }}
            options={[
              { value: 'all', label: 'Todas' },
              { value: 'delivered', label: 'Entregues' },
              { value: 'pending', label: 'Na fila' },
              { value: 'dead', label: 'Falharam' },
            ]}
          />
          <Button variant="ghost" size="icon-sm" onClick={refresh} aria-label="Atualizar entregas" title="Atualizar">
            <RefreshCw className="size-4" />
          </Button>
        </div>
      </div>

      {error ? (
        <ErrorState title="Não foi possível carregar as entregas" hint={error} onRetry={refresh} />
      ) : items === null ? (
        <div className="flex flex-col gap-2" aria-busy>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 rounded-lg" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
          Nenhuma entrega {filter === 'all' ? 'ainda' : 'com esse filtro'}.
        </p>
      ) : (
        <ul className="overflow-hidden rounded-lg border" aria-label="Entregas do webhook">
          {items.map((d) => {
            const st = DELIVERY_STATE[d.state];
            return (
              <li key={d.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 border-b px-3 py-2.5 text-xs last:border-b-0">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="text-[12px] text-foreground">{d.event}</code>
                    <StatusChip tone={st.tone}>{st.label}</StatusChip>
                    {d.last_status !== null && <span className="tabular-nums text-muted-foreground">HTTP {d.last_status}</span>}
                  </div>
                  <div className="mt-0.5 text-muted-foreground">
                    {fmtDate(d.created_at)} · {d.attempts} tentativa{d.attempts === 1 ? '' : 's'}
                    {d.state === 'pending' && d.attempts > 0 ? ` · próxima ${fmtDate(d.next_attempt_at)}` : ''}
                  </div>
                  {d.last_error && <p className="mt-1 break-words text-destructive">{d.last_error}</p>}
                </div>
                {d.state === 'dead' && (
                  <Button variant="outline" size="sm" onClick={() => void replay(d)} disabled={replaying === d.id}>
                    {replaying === d.id ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                    Reenviar
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {cursor && (
        <Button variant="outline" size="sm" onClick={() => void more()} disabled={loadingMore} className="self-center">
          {loadingMore && <Loader2 className="size-3.5 animate-spin" />}
          Carregar mais
        </Button>
      )}
    </section>
  );
}
