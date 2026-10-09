'use client';

import { apiFetch } from "@/lib/api-fetch";

// ============================================================
// /join/[token] — invitation redemption landing page.
//
// Four UI states driven by:
//   - the peek result (server-validated invite payload), and
//   - whether the visitor is currently authenticated.
//
//   ┌──────────────────────┬───────────────┬─────────────────────────┐
//   │ peek                 │ auth          │ render                   │
//   ├──────────────────────┼───────────────┼─────────────────────────┤
//   │ loading              │ —             │ spinner                  │
//   │ ok:false (any reason)│ —             │ friendly error + signup  │
//   │ ok:true              │ signed out    │ "Sign up" + "Sign in"    │
//   │ ok:true              │ signed in     │ "Accept" button → redeem │
//   └──────────────────────┴───────────────┴─────────────────────────┘
//
// We deliberately do NOT redeem automatically on page load — the
// invitee should confirm what account/role they're accepting.
// Auto-redeem would also race with the signup flow returning to
// this page after email verification.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';
import {
  AlertTriangle,
  CheckCircle,
  Loader2,
  MailX,
  ShieldCheck,
  UsersRound,
} from 'lucide-react';

import { Button, buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { AUTH_SUBMIT_CLASS, AuthShell } from '@/components/auth/auth-shell';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { createClient } from '@/lib/supabase/client';

interface PeekOk {
  ok: true;
  account_name: string;
  role: 'admin' | 'supervisor' | 'agent' | 'viewer';
  expires_at: string;
}
interface PeekFail {
  ok: false;
  reason: 'not_found' | 'used' | 'expired' | 'server_error';
}
type PeekResult = PeekOk | PeekFail;

// PT-BR labels, matching the canonical mapping in role-meta.ts
// (admin=Administrador, supervisor=Supervisor, agent=Operador,
// viewer=Visualizador) —
// this page has no AuthProvider to pull role-meta.ts's icon-bearing
// ROLE_META from, so the non-owner labels are duplicated here.
const ROLE_LABEL: Record<PeekOk['role'], string> = {
  admin: 'Administrador',
  supervisor: 'Supervisor',
  agent: 'Operador',
  viewer: 'Visualizador',
};

const FAIL_COPY: Record<PeekFail['reason'], { title: string; body: string }> = {
  not_found: {
    title: 'Convite não encontrado',
    body: 'Este link não corresponde a um convite válido. Confira o endereço ou peça a quem convidou para enviar um novo.',
  },
  used: {
    title: 'Convite já usado',
    body: 'Este convite já foi aceito. Se não foi você, peça ao administrador da organização para enviar um novo link.',
  },
  expired: {
    title: 'Convite expirado',
    body: 'Este convite expirou. Peça ao administrador da organização para enviar um novo.',
  },
  server_error: {
    title: 'Algo deu errado',
    body: 'Não foi possível verificar o convite agora. Tente de novo em instantes.',
  },
};

/** Erro ao aceitar o convite, por status da rota /redeem (o corpo traz o texto do RPC em inglês). */function redeemErrorMessage(status: number): string {  if (status === 400) return 'Este convite não é mais válido: expirou ou já foi usado. Peça um novo ao administrador.';  if (status === 401) return 'Sua sessão expirou. Entre de novo para aceitar o convite.';  if (status === 429) return 'Muitas tentativas seguidas. Aguarde um minuto e tente de novo.';  return 'Não foi possível aceitar o convite. Tente de novo em instantes.';}
export default function JoinPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token;

  const [peek, setPeek] = useState<PeekResult | null>(null);
  // Local auth probe — the AuthProvider lives inside the (dashboard)
  // route group, so it doesn't reach this page. We hit Supabase
  // directly the same way `/login` and `/signup` do.
  const [authedUserId, setAuthedUserId] = useState<string | null | undefined>(
    undefined, // undefined = unknown / still loading; null = signed out
  );
  const [accepting, setAccepting] = useState(false);
  // `redeem_invitation` returns 409 when the caller's current account
  // has domain data, or they're already a member of a shared account.
  // A transient toast wasn't enough — the user has no actionable next
  // step. Surface a blocking modal that walks them through it.
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  // Extracted so the "Try again" button on the server_error card
  // can re-run the same logic without remounting the component.
  const loadPeekAndAuth = useCallback(async () => {
    if (!token) return;
    setPeek(null);
    setAuthedUserId(undefined);
    try {
      const [peekRes, authRes] = await Promise.all([
        apiFetch(`/api/invitations/${encodeURIComponent(token)}/peek`, {
          cache: 'no-store',
        }),
        createClient().auth.getUser(),
      ]);
      const peekBody = (await peekRes.json()) as PeekResult;
      setPeek(peekBody);
      setAuthedUserId(authRes.data.user?.id ?? null);
    } catch (err) {
      console.error('[join] peek error:', err);
      setPeek({ ok: false, reason: 'server_error' });
      setAuthedUserId(null);
    }
  }, [token]);

  // Fetch peek + auth state on mount. The peek endpoint is
  // rate-limited per-IP (30/min) so double-mounting in React 19
  // strict mode dev is harmless. We also use the `cancelled` flag
  // to drop setState calls if the component unmounts mid-fetch.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const [peekRes, authRes] = await Promise.all([
          apiFetch(`/api/invitations/${encodeURIComponent(token)}/peek`, {
            cache: 'no-store',
          }),
          createClient().auth.getUser(),
        ]);
        const peekBody = (await peekRes.json()) as PeekResult;
        if (cancelled) return;
        setPeek(peekBody);
        setAuthedUserId(authRes.data.user?.id ?? null);
      } catch (err) {
        console.error('[join] peek error:', err);
        if (cancelled) return;
        setPeek({ ok: false, reason: 'server_error' });
        setAuthedUserId(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleAccept = useCallback(async () => {
    if (!token) return;
    setAccepting(true);
    try {
      const res = await apiFetch(`/api/invitations/${encodeURIComponent(token)}/redeem`,
        { method: 'POST' },
      );
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        // 409 = caller already has data / is in another shared
        // account. The redeem RPC's error message is descriptive
        // enough to show directly; we open a modal so the user has
        // a clear next-action (sign out → use different email)
        // rather than a 3-second toast.
        // O texto do RPC vem em inglês (e cita um cadastro que não existe): mostra a mensagem pelo status.
        void payload;
        if (res.status === 409) {
          setConflictMessage('Você já está em outra organização. Entre com outro e-mail para participar desta.');
        } else {
          toast.error(redeemErrorMessage(res.status));
        }
        setAccepting(false);
        return;
      }
      toast.success('Boas-vindas à equipe!');
      // Full reload (not router.push) so AuthProvider re-fetches
      // the profile with the new account_id and account_role.
      window.location.href = '/dashboard';
    } catch (err) {
      console.error('[join] redeem error:', err);
      toast.error('Não foi possível falar com o servidor.');
      setAccepting(false);
    }
  }, [token]);

  const handleSignOutAndRetry = useCallback(async () => {
    setSigningOut(true);
    try {
      await createClient().auth.signOut();
      // Hard reload so the new auth state propagates everywhere
      // (middleware, AuthProvider). Preserves the invite token in
      // the URL so the rebuilt page renders the signed-out CTA path.
      window.location.reload();
    } catch (err) {
      console.error('[join] sign-out error:', err);
      toast.error('Não foi possível sair. Atualize a página e tente de novo.');
      setSigningOut(false);
    }
  }, []);

  // ----- Carregando (convite ou sessão ainda sem resposta) -----
  if (peek === null || authedUserId === undefined) {
    return (
      <AuthShell title="Convite" description="Verificando o convite…">
        <div role="status" aria-busy="true" className="flex flex-col gap-3">
          <Skeleton className="h-14 w-full rounded-lg" />
          <Skeleton className="h-11 w-full rounded-lg" />
        </div>
      </AuthShell>
    );
  }

  // ----- Convite inválido -----
  if (!peek.ok) {
    const copy = FAIL_COPY[peek.reason];
    return (
      <AuthShell
        icon={
          <span className="flex size-10 items-center justify-center rounded-full bg-danger-soft text-danger">
            <MailX className="size-5" aria-hidden="true" />
          </span>
        }
        title={<span role="alert">{copy.title}</span>}
        description={copy.body}
      >
        {/* server_error é passageiro: "Tentar de novo" é a ação principal. Os demais motivos encerram este link. */}
        {peek.reason === "server_error" ? (
          <Button onClick={loadPeekAndAuth} className={AUTH_SUBMIT_CLASS}>
            Tentar de novo
          </Button>
        ) : (
          <Link href="/login" className={cn(buttonVariants(), AUTH_SUBMIT_CLASS)}>
            Entrar
          </Link>
        )}
      </AuthShell>
    );
  }

  // ----- Convite válido -----
  const inviteIcon = (
    <span className="flex size-10 items-center justify-center rounded-full bg-primary-soft text-primary-text">
      <UsersRound className="size-5" aria-hidden="true" />
    </span>
  );
  const inviteTitle = (
    <>
      Você foi convidado para <span className="text-primary-text">{peek.account_name}</span>
    </>
  );
  const inviteDetails = (
    <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-lg bg-surface-3 px-3.5 py-3 text-[13px]">
      <dt className="text-foreground-2">Papel</dt>
      <dd className="m-0 inline-flex items-center gap-1.5 font-semibold text-foreground">
        <ShieldCheck className="size-3.5 text-primary-text" aria-hidden="true" />
        {ROLE_LABEL[peek.role]}
      </dd>
      <dt className="text-foreground-2">Válido até</dt>
      <dd className="m-0 font-semibold tabular-nums text-foreground">
        {new Date(peek.expires_at).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" })}
      </dd>
    </dl>
  );

  // ----- Com sessão: aceitar -----
  if (authedUserId) {
    return (
      <>
        <AuthShell icon={inviteIcon} title={inviteTitle} description="Confira os dados e aceite para entrar na organização.">
          {inviteDetails}
          <div className="flex flex-col gap-2.5">
            <Button onClick={handleAccept} disabled={accepting} className={AUTH_SUBMIT_CLASS}>
              {accepting ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  Aceitando…
                </>
              ) : (
                <>
                  <CheckCircle className="size-4" aria-hidden="true" />
                  Aceitar convite
                </>
              )}
            </Button>
            <p className="m-0 text-center text-xs text-muted-foreground">
              Ao aceitar, seu login passa para <span className="font-semibold text-foreground-2">{peek.account_name}</span>. A
              conta pessoal vazia criada no cadastro é removida.
            </p>
          </div>
        </AuthShell>

        {/* Conflito (409): o usuário já está em outra organização ou tem dados. Bloqueia até escolher o que fazer. */}
        <Dialog
          open={conflictMessage !== null}
          onOpenChange={(open) => {
            if (!open) setConflictMessage(null);
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <AlertTriangle className="size-4 text-warning" aria-hidden="true" />
                Não dá para entrar em {peek.account_name} com esta conta
              </DialogTitle>
              <DialogDescription>{conflictMessage}</DialogDescription>
            </DialogHeader>
            <p className="m-0 text-xs text-muted-foreground">
              Para entrar em <span className="font-semibold text-foreground">{peek.account_name}</span>, saia e entre com outro
              e-mail. O link do convite continua valendo enquanto não expirar.
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConflictMessage(null)}>
                Continuar conectado
              </Button>
              <Button onClick={handleSignOutAndRetry} disabled={signingOut}>
                {signingOut ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    Saindo…
                  </>
                ) : (
                  "Sair e usar outro e-mail"
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  // ----- Sem sessão: entrar para aceitar -----
  return (
    <AuthShell
      icon={inviteIcon}
      title={inviteTitle}
      description="Entre com o seu usuário para aceitar o convite."
      // Sem cadastro público: quem ainda não tem usuário pede ao admin.
      footer="Ainda não tem usuário? Peça ao administrador para criá-lo."
    >
      {inviteDetails}
      <Link href={`/login?invite=${encodeURIComponent(token!)}`} className={cn(buttonVariants(), AUTH_SUBMIT_CLASS)}>
        Entrar para aceitar o convite
      </Link>
    </AuthShell>
  );
}
