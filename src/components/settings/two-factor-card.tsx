'use client';

// Verificação em duas etapas (TOTP) do PRÓPRIO usuário (PRD 24, item 7; tela da TASK2). Status por GET /api/me/mfa
// (nunca devolve segredo); cadastro, verificação e remoção pelo supabase.auth.mfa.* com a sessão do usuário — o
// segredo/QR só existe no navegador durante o cadastro. Requer MFA habilitado no projeto Supabase.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Copy, Loader2, ShieldCheck } from 'lucide-react';

import { apiFetch } from '@/lib/api-fetch';
import { normalizeTotpCode } from '@/lib/auth/mfa';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusChip } from '@/components/ddm/status-chip';
import { Skeleton } from '@/components/ddm/states';

interface MfaFactor {
  id: string;
  type: string;
  name: string | null;
  status: string;
  created_at: string;
}

interface Enrollment {
  factorId: string;
  qr: string;
  secret: string;
}

/** Erros do Supabase Auth em mensagem legível (o texto original vem em inglês). */
export function mfaErrorMessage(message: string | undefined): string {
  const m = (message ?? '').toLowerCase();
  if (m.includes('aal2')) return 'Para desativar, entre de novo usando o código do aplicativo autenticador e tente outra vez.';
  if (m.includes('invalid') && m.includes('code')) return 'Código inválido. Confira o horário do celular e tente o código atual.';
  if (m.includes('mfa') && (m.includes('disabled') || m.includes('not enabled'))) return 'A verificação em duas etapas não está habilitada neste ambiente.';
  return 'Não foi possível concluir. Tente de novo.';
}

export function TwoFactorCard() {
  const supabase = createClient();
  const [status, setStatus] = useState<{ enabled: boolean; factors: MfaFactor[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [enrolling, setEnrolling] = useState<Enrollment | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<null | 'start' | 'verify' | 'remove'>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/me/mfa', { cache: 'no-store' });
      const body = (await res.json().catch(() => ({}))) as { enabled?: boolean; factors?: MfaFactor[]; error?: string };
      if (!res.ok) {
        setError(body.error ?? 'Não foi possível ler o status da verificação em duas etapas.');
        return;
      }
      setError(null);
      setStatus({ enabled: !!body.enabled, factors: body.factors ?? [] });
    } catch {
      setError('Não foi possível falar com o servidor.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const verified = status?.factors.filter((f) => f.type === 'totp' && f.status === 'verified') ?? [];

  async function start() {
    setBusy('start');
    try {
      // Cadastro anterior não concluído atrapalha um novo: remove os não verificados.
      for (const f of status?.factors ?? []) {
        if (f.type === 'totp' && f.status !== 'verified') await supabase.auth.mfa.unenroll({ factorId: f.id });
      }
      const { data, error: err } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: `CRM ${new Date().toISOString().slice(0, 10)}` });
      if (err || !data) {
        toast.error(mfaErrorMessage(err?.message));
        return;
      }
      setCode('');
      setEnrolling({ factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
    } finally {
      setBusy(null);
    }
  }

  async function verify() {
    if (!enrolling || code.length !== 6) return;
    setBusy('verify');
    try {
      const { error: err } = await supabase.auth.mfa.challengeAndVerify({ factorId: enrolling.factorId, code });
      if (err) {
        toast.error(mfaErrorMessage(err.message));
        return;
      }
      toast.success('Verificação em duas etapas ativada.');
      setEnrolling(null);
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function cancelEnrollment() {
    const pending = enrolling;
    setEnrolling(null);
    if (pending) await supabase.auth.mfa.unenroll({ factorId: pending.factorId });
  }

  async function remove(f: MfaFactor) {
    if (!window.confirm('Desativar a verificação em duas etapas? Sua conta fica protegida só pela senha.')) return;
    setBusy('remove');
    try {
      const { error: err } = await supabase.auth.mfa.unenroll({ factorId: f.id });
      if (err) {
        toast.error(mfaErrorMessage(err.message));
        return;
      }
      toast.success('Verificação em duas etapas desativada.');
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function copySecret() {
    if (!enrolling) return;
    try {
      await navigator.clipboard.writeText(enrolling.secret);
      toast.success('Chave copiada.');
    } catch {
      toast.error('Não foi possível copiar.');
    }
  }

  return (
    <section className="overflow-hidden rounded-[10px] border bg-card" aria-labelledby="mfa-title">
      <div className="flex flex-wrap items-start justify-between gap-2 border-b px-4 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id="mfa-title" className="text-[14px] font-semibold text-foreground">
              Verificação em duas etapas
            </h3>
            {status && (verified.length > 0 ? <StatusChip tone="ok">Ativada</StatusChip> : <StatusChip tone="mute">Desativada</StatusChip>)}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Além da senha, o login pede um código de 6 dígitos de um aplicativo autenticador (Google Authenticator,
            Microsoft Authenticator, 1Password…).
          </p>
        </div>
        {status && verified.length === 0 && (
          <Button size="sm" onClick={() => void start()} disabled={!!busy}>
            {busy === 'start' ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
            Ativar
          </Button>
        )}
      </div>

      {error ? (
        <p className="px-4 py-4 text-sm text-destructive">{error}</p>
      ) : !status ? (
        <div className="p-4" aria-busy>
          <Skeleton className="h-10 rounded-lg" />
        </div>
      ) : verified.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted-foreground">Sua conta entra só com a senha.</p>
      ) : (
        <ul aria-label="Autenticadores">
          {verified.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center gap-3 border-t px-4 py-3 first:border-t-0">
              <ShieldCheck className="size-4 text-success" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-foreground">{f.name || 'Aplicativo autenticador'}</div>
                <div className="text-xs text-muted-foreground">
                  Ativado em {new Date(f.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={() => void remove(f)} disabled={!!busy}>
                {busy === 'remove' && <Loader2 className="size-3.5 animate-spin" />}
                Desativar
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={!!enrolling} onOpenChange={(o) => !o && busy !== 'verify' && void cancelEnrollment()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Ativar verificação em duas etapas</DialogTitle>
            <DialogDescription>Escaneie o QR code no aplicativo autenticador e digite o código de 6 dígitos que ele mostrar.</DialogDescription>
          </DialogHeader>
          {enrolling && (
            <div className="flex flex-col items-center gap-3">
              {/* QR gerado pelo Supabase (data URI SVG), só neste navegador. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={enrolling.qr} alt="QR code para o aplicativo autenticador" className="size-44 rounded-lg border bg-white p-2" />
              <div className="flex w-full items-center gap-1.5">
                <Input readOnly value={enrolling.secret} aria-label="Chave para digitar no aplicativo" className="font-mono text-xs" />
                <Button variant="outline" size="sm" onClick={() => void copySecret()}>
                  <Copy className="size-3.5" />
                  Copiar
                </Button>
              </div>
              <div className="flex w-full flex-col gap-1.5">
                <Label htmlFor="mfa-code">Código do aplicativo</Label>
                <Input
                  id="mfa-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(normalizeTotpCode(e.target.value))}
                  placeholder="000000"
                  className="text-center font-mono text-lg tracking-[0.4em]"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void verify();
                  }}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => void cancelEnrollment()} disabled={busy === 'verify'}>
              Cancelar
            </Button>
            <Button onClick={() => void verify()} disabled={busy === 'verify' || code.length !== 6}>
              {busy === 'verify' && <Loader2 className="size-4 animate-spin" />}
              Ativar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
