'use client';

// Sessões por dispositivo (PRD 24, item 7; tela da TASK2) sobre GET /api/me/sessions: aparelhos logados do PRÓPRIO
// usuário, com "Este dispositivo", encerrar um (DELETE /api/me/sessions/{id}) e "sair dos outros"
// (POST /api/me/sessions/revoke-others). "Sair de todos" continua pelo signOut global do Supabase.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Laptop, Loader2, LogOut, Smartphone } from 'lucide-react';

import { apiFetch } from '@/lib/api-fetch';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { StatusChip } from '@/components/ddm/status-chip';
import { Skeleton } from '@/components/ddm/states';

export interface SessionItem {
  id: string;
  current: boolean;
  device: string;
  user_agent: string | null;
  ip: string | null;
  created_at: string;
  last_active_at: string;
  aal: string | null;
  expires_at: string | null;
}

function fmt(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

/** Celular x computador pelo texto do aparelho (só para o ícone). */
export function isMobileDevice(s: Pick<SessionItem, 'device' | 'user_agent'>): boolean {
  return /android|iphone|ipad|mobile/i.test(`${s.device} ${s.user_agent ?? ''}`);
}

/** Atual primeiro, depois a mais recente. */
export function sortSessions(list: SessionItem[]): SessionItem[] {
  return [...list].sort((a, b) => Number(b.current) - Number(a.current) || b.last_active_at.localeCompare(a.last_active_at));
}

export function SessionsCard() {
  const supabase = createClient();
  const [sessions, setSessions] = useState<SessionItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/me/sessions', { cache: 'no-store' });
      const body = (await res.json().catch(() => ({}))) as { sessions?: SessionItem[]; error?: string };
      if (!res.ok || !body.sessions) {
        setError(body.error ?? 'Não foi possível carregar os dispositivos.');
        setSessions([]);
        return;
      }
      setError(null);
      setSessions(sortSessions(body.sessions));
    } catch {
      setError('Não foi possível falar com o servidor.');
      setSessions([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(s: SessionItem) {
    if (s.current && !window.confirm('Encerrar esta sessão? Você sai deste dispositivo agora.')) return;
    setBusy(s.id);
    try {
      const res = await apiFetch(`/api/me/sessions/${s.id}`, { method: 'DELETE' });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(body.error ?? 'Não foi possível encerrar a sessão.');
        return;
      }
      if (s.current) {
        window.location.href = '/login';
        return;
      }
      toast.success(`Sessão encerrada: ${s.device}.`);
      setSessions((prev) => prev?.filter((x) => x.id !== s.id) ?? prev);
    } finally {
      setBusy(null);
    }
  }

  async function revokeOthers() {
    setBusy('others');
    try {
      const res = await apiFetch('/api/me/sessions/revoke-others', { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as { revoked?: number; error?: string };
      if (!res.ok) {
        toast.error(body.error ?? 'Não foi possível encerrar as outras sessões.');
        return;
      }
      toast.success(body.revoked ? `${body.revoked} sessão(ões) encerrada(s).` : 'Não havia outros dispositivos.');
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function signOutAll() {
    setBusy('all');
    try {
      const { error: err } = await supabase.auth.signOut({ scope: 'global' });
      if (err) {
        toast.error(`Falha ao sair: ${err.message}`);
        return;
      }
      window.location.href = '/login';
    } finally {
      setBusy(null);
    }
  }

  const others = sessions?.filter((s) => !s.current).length ?? 0;

  return (
    <section className="overflow-hidden rounded-[10px] border bg-card" aria-labelledby="sessions-title">
      <div className="flex flex-wrap items-start justify-between gap-2 border-b px-4 py-3">
        <div className="min-w-0">
          <h3 id="sessions-title" className="text-[14px] font-semibold text-foreground">
            Dispositivos conectados
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Onde sua conta está aberta agora. Encerrar um dispositivo pede login de novo nele.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => void revokeOthers()} disabled={!!busy || others === 0}>
            {busy === 'others' && <Loader2 className="size-3.5 animate-spin" />}
            Sair dos outros dispositivos
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirmAll(true)} disabled={!!busy}>
            <LogOut className="size-3.5" />
            Sair de todos
          </Button>
        </div>
      </div>

      {error ? (
        <p className="px-4 py-4 text-sm text-destructive">{error}</p>
      ) : sessions === null ? (
        <div className="flex flex-col gap-2 p-4" aria-busy>
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-12 rounded-lg" />
          ))}
        </div>
      ) : sessions.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted-foreground">Nenhum dispositivo listado.</p>
      ) : (
        <ul aria-label="Dispositivos conectados">
          {sessions.map((s, i) => {
            const Icon = isMobileDevice(s) ? Smartphone : Laptop;
            return (
              <li
                key={s.id}
                className="animate-ddm-row flex flex-wrap items-center gap-3 border-t px-4 py-3 first:border-t-0"
                style={{ animationDelay: `${Math.min(i, 12) * 30}ms` }}
              >
                <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-3 text-muted-foreground">
                  <Icon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-[13px] font-medium text-foreground">{s.device}</span>
                    {s.current && <StatusChip tone="ok">Este dispositivo</StatusChip>}
                    {s.aal === 'aal2' && (
                      <StatusChip tone="info" dot={false}>
                        Com 2FA
                      </StatusChip>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    Ativo em {fmt(s.last_active_at)} · entrou em {fmt(s.created_at)}
                    {s.ip ? ` · IP ${s.ip}` : ''}
                  </div>
                </div>
                <Button variant="outline" size="sm" onClick={() => void revoke(s)} disabled={!!busy}>
                  {busy === s.id && <Loader2 className="size-3.5 animate-spin" />}
                  {s.current ? 'Sair' : 'Encerrar'}
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <Dialog open={confirmAll} onOpenChange={setConfirmAll}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Sair de todos os dispositivos?</DialogTitle>
            <DialogDescription>
              Todos os dispositivos conectados a esta conta serão desconectados, incluindo este, e precisarão fazer login
              novamente.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setConfirmAll(false)} disabled={busy === 'all'}>
              Cancelar
            </Button>
            <Button type="button" onClick={() => void signOutAll()} disabled={busy === 'all'}>
              {busy === 'all' && <Loader2 className="size-4 animate-spin" />}
              Sair de todos os dispositivos
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
