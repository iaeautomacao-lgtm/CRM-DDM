'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { formatDistanceToNow, format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Bot,
  Briefcase,
  ChevronRight,
  Loader2,
  StickyNote,
  UserRoundCog,
  Activity,
} from 'lucide-react';

import { apiFetch } from '@/lib/api-fetch';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Segmented } from '@/components/ddm/segmented';
import { StatusChip, type StatusTone } from '@/components/ddm/status-chip';
import { ErrorState } from '@/components/dashboard/error-state';

// Contrato TASK36 (Âncora): GET /api/contacts/{id}/activity e
// GET /api/contacts/{id}/campaigns — paginação por cursor opaco
// (next_cursor=null = fim), permissão contacts.view, escopo da conta.

type ActivityType = 'message' | 'event' | 'note' | 'deal' | 'assignment';

interface ActivityItem {
  key: string;
  type: ActivityType;
  at: string;
  title: string;
  detail: string | null;
  actor: { name: string } | null;
  conversation_id: string | null;
  direction: 'in' | 'out' | null;
  sender?: 'customer' | 'agent' | 'bot' | null;
}

type CampaignSendStatus =
  | 'pendente'
  | 'agendado'
  | 'enviando'
  | 'enviado'
  | 'entregue'
  | 'lido'
  | 'erro'
  | 'bloqueado'
  | 'pausado'
  | 'cancelado';

interface CampaignItem {
  id: string;
  campaign_id: string;
  campaign_name: string;
  campaign_status: string;
  status: CampaignSendStatus | string;
  scheduled_at: string | null;
  sent_at: string | null;
  replied_at: string | null;
  error: string | null;
  template_name: string | null;
}

interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

const PAGE_SIZE = 30;

/** Lista paginada por cursor; `reset` recomeça do zero (filtro/retry). */
function useCursorList<T>(baseUrl: string) {
  const [items, setItems] = useState<T[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const fetchPage = useCallback(
    async (after: string | null) => {
      const sep = baseUrl.includes('?') ? '&' : '?';
      const url = `${baseUrl}${sep}limit=${PAGE_SIZE}${after ? `&cursor=${encodeURIComponent(after)}` : ''}`;
      const res = await apiFetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as Page<T>;
    },
    [baseUrl],
  );

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    setError(false);
    fetchPage(null)
      .then((page) => {
        if (cancelled) return;
        setItems(page.items ?? []);
        setCursor(page.next_cursor);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchPage, reloadKey]);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await fetchPage(cursor);
      setItems((prev) => [...(prev ?? []), ...(page.items ?? [])]);
      setCursor(page.next_cursor);
    } catch {
      setError(true);
    } finally {
      setLoadingMore(false);
    }
  }

  return { items, hasMore: cursor !== null, loadingMore, error, loadMore, retry: () => setReloadKey((k) => k + 1) };
}

function relative(iso: string) {
  return formatDistanceToNow(new Date(iso), { addSuffix: true, locale: ptBR });
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-busy="true">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-14 w-full rounded-lg" />
      ))}
    </div>
  );
}

function Empty({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex animate-ddm-fade flex-col items-center gap-1.5 px-4 py-10 text-center">
      <p className="text-[13.5px] font-semibold text-foreground">{title}</p>
      <p className="text-[12.5px] text-muted-foreground">{hint}</p>
    </div>
  );
}

function LoadMore({ show, loading, onClick }: { show: boolean; loading: boolean; onClick: () => void }) {
  if (!show) return null;
  return (
    <div className="flex justify-center pt-3">
      <Button variant="outline" size="sm" onClick={onClick} disabled={loading}>
        {loading && <Loader2 className="size-3.5 animate-spin" />}
        Carregar mais
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------- Atividade

const ACTIVITY_FILTERS: Array<{ value: 'all' | ActivityType; label: string }> = [
  { value: 'all', label: 'Tudo' },
  { value: 'message', label: 'Mensagens' },
  { value: 'event', label: 'Eventos' },
  { value: 'note', label: 'Notas' },
  { value: 'deal', label: 'Negócios' },
  { value: 'assignment', label: 'Atribuições' },
];

function activityIcon(item: ActivityItem) {
  switch (item.type) {
    case 'message':
      if (item.sender === 'bot') return Bot;
      return item.direction === 'in' ? ArrowDownLeft : ArrowUpRight;
    case 'note':
      return StickyNote;
    case 'deal':
      return Briefcase;
    case 'assignment':
      return UserRoundCog;
    default:
      return Activity;
  }
}

function activityIconClass(item: ActivityItem) {
  if (item.type === 'message' && item.direction === 'in') return 'bg-primary-soft text-primary-text';
  if (item.type === 'deal') return 'bg-success-soft text-success';
  return 'bg-surface-3 text-foreground-2';
}

export function ContactActivityFeed({ contactId }: { contactId: string }) {
  const [filter, setFilter] = useState<'all' | ActivityType>('all');
  const base = `/api/contacts/${contactId}/activity${filter === 'all' ? '' : `?types=${filter}`}`;
  const { items, hasMore, loadingMore, error, loadMore, retry } = useCursorList<ActivityItem>(base);

  return (
    <div className="flex flex-col gap-3">
      <div className="-mx-1 overflow-x-auto px-1">
        <Segmented ariaLabel="Filtrar atividade" value={filter} onChange={setFilter} options={ACTIVITY_FILTERS} />
      </div>
      {error && !items ? (
        <ErrorState title="Não foi possível carregar a atividade" hint="Verifique a conexão e tente de novo." onRetry={retry} />
      ) : items === null ? (
        <ListSkeleton />
      ) : items.length === 0 ? (
        <Empty
          title="Nenhuma atividade"
          hint={filter === 'all' ? 'Mensagens, notas e eventos deste contato aparecem aqui.' : 'Nada deste tipo para este contato.'}
        />
      ) : (
        <>
          <ol className="ddm-stagger flex flex-col">
            {items.map((item, i) => {
              const Icon = activityIcon(item);
              const last = i === items.length - 1;
              return (
                <li key={item.key} className="relative flex gap-3 pb-4">
                  {!last && <span aria-hidden="true" className="absolute left-[13px] top-7 bottom-0 w-px bg-border" />}
                  <span
                    className={`relative flex size-[27px] shrink-0 items-center justify-center rounded-full ${activityIconClass(item)}`}
                    aria-hidden="true"
                  >
                    <Icon className="size-3.5" />
                  </span>
                  <div className="min-w-0 flex-1 pt-0.5">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                      <p className="text-[13px] text-foreground">
                        {item.actor && <span className="font-semibold">{item.actor.name} · </span>}
                        {item.title}
                      </p>
                      <time
                        dateTime={item.at}
                        title={format(new Date(item.at), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}
                        className="shrink-0 whitespace-nowrap text-[11.5px] text-muted-foreground"
                      >
                        {relative(item.at)}
                      </time>
                    </div>
                    {item.detail && (
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{item.detail}</p>
                    )}
                    {item.conversation_id && (
                      <Link
                        href={`/inbox?c=${item.conversation_id}`}
                        className="mt-1 inline-flex items-center gap-0.5 text-[11.5px] font-semibold text-primary-text hover:underline"
                      >
                        Ver conversa
                        <ChevronRight className="size-3" aria-hidden="true" />
                      </Link>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
          {error && <p className="text-center text-xs text-danger">Falha ao carregar mais itens.</p>}
          <LoadMore show={hasMore} loading={loadingMore} onClick={loadMore} />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Campanhas

const SEND_STATUS: Record<CampaignSendStatus, { label: string; tone: StatusTone }> = {
  pendente: { label: 'Pendente', tone: 'mute' },
  agendado: { label: 'Agendado', tone: 'info' },
  enviando: { label: 'Enviando', tone: 'info' },
  enviado: { label: 'Enviado', tone: 'mute' },
  entregue: { label: 'Entregue', tone: 'ok' },
  lido: { label: 'Lido', tone: 'ok' },
  erro: { label: 'Erro', tone: 'bad' },
  bloqueado: { label: 'Bloqueado', tone: 'bad' },
  pausado: { label: 'Pausado', tone: 'warn' },
  cancelado: { label: 'Cancelado', tone: 'mute' },
};

export function ContactCampaignsList({ contactId }: { contactId: string }) {
  const { items, hasMore, loadingMore, error, loadMore, retry } = useCursorList<CampaignItem>(
    `/api/contacts/${contactId}/campaigns`,
  );

  if (error && !items) {
    return <ErrorState title="Não foi possível carregar as campanhas" hint="Verifique a conexão e tente de novo." onRetry={retry} />;
  }
  if (items === null) return <ListSkeleton />;
  if (items.length === 0) {
    return <Empty title="Nenhuma campanha" hint="Envios do Disparador para este contato aparecem aqui." />;
  }

  return (
    <div className="flex flex-col">
      <ul className="ddm-stagger flex flex-col divide-y divide-border">
        {items.map((c) => {
          const st = SEND_STATUS[c.status as CampaignSendStatus];
          const when = c.sent_at ?? c.scheduled_at;
          return (
            <li key={c.id} className="flex items-start gap-3 py-3 first:pt-0">
              <div className="min-w-0 flex-1">
                <Link
                  href={`/disparador/campanhas/${c.campaign_id}`}
                  className="block truncate text-[13px] font-semibold text-foreground hover:text-primary-text"
                >
                  {c.campaign_name}
                </Link>
                <p className="truncate text-xs text-muted-foreground">
                  {c.template_name ? `Template ${c.template_name}` : 'Sem template'}
                  {when && ` · ${format(new Date(when), 'dd/MM/yyyy HH:mm', { locale: ptBR })}`}
                  {c.replied_at && ` · respondeu ${relative(c.replied_at)}`}
                </p>
                {c.error && <p className="mt-1 rounded-md bg-danger-soft px-2 py-1 text-[11.5px] text-danger">{c.error}</p>}
              </div>
              <StatusChip tone={st?.tone ?? 'mute'}>{st?.label ?? c.status}</StatusChip>
            </li>
          );
        })}
      </ul>
      {error && <p className="pt-2 text-center text-xs text-danger">Falha ao carregar mais itens.</p>}
      <LoadMore show={hasMore} loading={loadingMore} onClick={loadMore} />
    </div>
  );
}
