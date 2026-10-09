'use client';

// "Saúde do sistema" (PRD 24, item 5; tela da TASK2): cartão em Logs sobre GET /api/ops/status (audit.view). Só dados que
// já existem: migrations aplicadas × exigidas, idade do último tick do cron do disparador e fila de mensagens recebidas.
// Cada bloco degrada sozinho ("indisponível" com o motivo) e o estado vem sempre com texto, não só cor.

import { useCallback, useEffect, useState } from 'react';
import { Activity, Database, Inbox, Loader2, RefreshCw, Timer } from 'lucide-react';

import { apiFetch } from '@/lib/api-fetch';
import { Button } from '@/components/ui/button';
import { StatusChip, type StatusTone } from '@/components/ddm/status-chip';
import { Skeleton } from '@/components/ddm/states';

type Level = 'ok' | 'atrasado' | 'parado' | 'indisponivel';

export interface SystemHealthView {
  generated_at: string;
  migrations:
    | { available: true; total: number; applied: number; missing: string[]; invalid_indexes: string[]; ok: boolean }
    | { available: false; reason: string };
  crons: Array<{ job: string; last_ok_at: string | null; age_s: number | null; status: Level }>;
  inbox:
    | { available: true; pending: number; oldest_pending_s: number | null; dead: number; shadow_missing: number; ok: boolean }
    | { available: false; reason: string };
  ok: boolean;
}

const LEVEL: Record<Level, { label: string; tone: StatusTone }> = {
  ok: { label: 'Em dia', tone: 'ok' },
  atrasado: { label: 'Atrasado', tone: 'warn' },
  parado: { label: 'Parado', tone: 'bad' },
  indisponivel: { label: 'Indisponível', tone: 'mute' },
};

/** "há 45 s", "há 4 min", "há 2 h 5 min". */
export function formatAge(seconds: number | null): string {
  if (seconds === null) return 'sem registro';
  if (seconds < 60) return `há ${seconds} s`;
  const min = Math.floor(seconds / 60);
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `há ${h} h ${rest} min` : `há ${h} h`;
}

function Block({ icon: Icon, title, chip, children }: { icon: typeof Activity; title: string; chip: { label: string; tone: StatusTone }; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-lg border bg-card-2 p-3">
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-muted-foreground" aria-hidden />
        <span className="text-[13px] font-semibold text-foreground">{title}</span>
        <StatusChip tone={chip.tone} className="ml-auto">
          {chip.label}
        </StatusChip>
      </div>
      <div className="text-xs text-foreground-2">{children}</div>
    </div>
  );
}

export function SystemHealthCard({ className }: { className?: string }) {
  const [health, setHealth] = useState<SystemHealthView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/ops/status', { cache: 'no-store' });
      const body = (await res.json().catch(() => ({}))) as { data?: SystemHealthView; error?: string };
      if (!res.ok || !body.data) {
        setError(res.status === 403 ? 'Sem permissão para ver a saúde do sistema.' : (body.error ?? 'Não foi possível ler a saúde do sistema.'));
        return;
      }
      setHealth(body.data);
      setError(null);
    } catch {
      setError('Não foi possível falar com o servidor.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Leitura inicial do servidor ao montar o cartão.
    void load();
  }, [load]);

  const m = health?.migrations;
  const inbox = health?.inbox;
  const cron = health?.crons[0];

  return (
    <section aria-labelledby="system-health-title" className={className}>
      <div className="flex flex-col gap-3 rounded-[10px] border bg-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Activity className="size-4 text-primary" aria-hidden />
          <h2 id="system-health-title" className="text-[14px] font-semibold text-foreground">
            Saúde do sistema
          </h2>
          {health && (
            <StatusChip tone={health.ok ? 'ok' : 'warn'}>{health.ok ? 'Tudo em dia' : 'Precisa de atenção'}</StatusChip>
          )}
          <span className="ml-auto text-xs text-muted-foreground">
            {health ? `Lido às ${new Date(health.generated_at).toLocaleTimeString('pt-BR')}` : null}
          </span>
          <Button variant="ghost" size="icon-sm" onClick={() => void load()} disabled={loading} aria-label="Atualizar saúde do sistema">
            {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          </Button>
        </div>

        {error ? (
          <p className="text-xs text-destructive">{error}</p>
        ) : !health ? (
          <div className="grid gap-2 md:grid-cols-3" aria-busy>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-20 rounded-lg" />
            ))}
          </div>
        ) : (
          <div className="grid gap-2 md:grid-cols-3">
            <Block
              icon={Database}
              title="Migrations"
              chip={!m || !m.available ? LEVEL.indisponivel : m.ok ? { label: 'Em dia', tone: 'ok' } : { label: 'Pendentes', tone: 'warn' }}
            >
              {m && m.available ? (
                <>
                  <span className="tabular-nums">
                    {m.applied} de {m.total} aplicadas
                  </span>
                  {m.missing.length > 0 && (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-warning">{m.missing.length} faltando</summary>
                      <ul className="mt-1 max-h-32 overflow-y-auto font-mono text-[11px]">
                        {m.missing.map((v) => (
                          <li key={v}>{v}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {m.invalid_indexes.length > 0 && (
                    <p className="mt-1 text-warning">Índice inválido: {m.invalid_indexes.join(', ')}</p>
                  )}
                </>
              ) : (
                <span>{m && !m.available ? m.reason : '—'}</span>
              )}
            </Block>
            <Block icon={Timer} title="Cron do disparador" chip={cron ? LEVEL[cron.status] : LEVEL.indisponivel}>
              {cron ? (
                <span>
                  Último ciclo {formatAge(cron.age_s)}
                  {cron.last_ok_at ? ` (${new Date(cron.last_ok_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })})` : ''}
                </span>
              ) : (
                <span>—</span>
              )}
            </Block>
            <Block
              icon={Inbox}
              title="Mensagens recebidas"
              chip={!inbox || !inbox.available ? LEVEL.indisponivel : inbox.ok ? { label: 'Em dia', tone: 'ok' } : { label: 'Atenção', tone: 'warn' }}
            >
              {inbox && inbox.available ? (
                <span className="tabular-nums">
                  {inbox.pending} na fila · mais antiga {formatAge(inbox.oldest_pending_s)} · {inbox.dead} com falha
                </span>
              ) : (
                <span>{inbox && !inbox.available ? inbox.reason : '—'}</span>
              )}
            </Block>
          </div>
        )}
      </div>
    </section>
  );
}
