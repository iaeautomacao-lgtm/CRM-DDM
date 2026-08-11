'use client';

// ============================================================
// RedeemInviteCodeCard — "I have an invite code."
//
// Counterpart to /join/[token] for the short-code invite path: the
// invitee has ALREADY signed up normally and is logged in (unlike the
// link flow, a code is never carried through signup — see
// invite-member-dialog.tsx). This card just posts the code to
// /api/invitations/redeem-by-code, which hashes it and hands off to
// the exact same `redeem_invitation` RPC the link flow uses.
//
// The 409 (already-has-data / already-in-a-shared-account) conflict
// gets a small dialog with a "sign out and use a different email"
// escape hatch — a bare toast isn't actionable enough here, same
// reasoning as the equivalent dialog in /join/[token]/page.tsx. Kept
// as a separate, smaller copy rather than extracting a shared
// component — this card doesn't know the target account's name (no
// peek-by-code step), so the copy is intentionally more generic.
// ============================================================

import { useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, Loader2, Ticket } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { createClient } from '@/lib/supabase/client';

/** Uppercases as you type and re-inserts the display hyphen at
 *  position 4 — purely cosmetic, mirrors the "A3F9-K2XQ" shape shown
 *  at creation time. The server re-normalizes regardless, so a user
 *  who pastes "a3f9k2xq" or "a3f9 k2xq" without a dash still works. */
function formatCodeInput(raw: string): string {
  const alnum = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return alnum.length > 4 ? `${alnum.slice(0, 4)}-${alnum.slice(4)}` : alnum;
}

export function RedeemInviteCodeCard() {
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) return;

    setSubmitting(true);
    try {
      const res = await fetch('/api/invitations/redeem-by-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: trimmed }),
      });

      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        if (res.status === 409) {
          setConflictMessage(
            payload.error ||
              'You are already in another account. Sign in with a different email to use this code.',
          );
        } else if (res.status === 429) {
          toast.error(
            payload.error || 'Too many attempts — wait a few minutes and try again',
          );
        } else {
          toast.error(payload.error || 'Invalid or expired code');
        }
        setSubmitting(false);
        return;
      }

      toast.success('Welcome to the team');
      // Full reload (not router.push) so AuthProvider re-fetches the
      // profile with the new account_id and account_role — same
      // reasoning as /join/[token]/page.tsx's handleAccept.
      window.location.href = '/dashboard';
    } catch (err) {
      console.error('[RedeemInviteCodeCard] redeem error:', err);
      toast.error('Could not reach the server. Try again?');
      setSubmitting(false);
    }
  }

  async function handleSignOutAndRetry() {
    setSigningOut(true);
    try {
      await createClient().auth.signOut();
      // Their very next step has to be "sign up with a different
      // email" — send them straight there instead of /login.
      window.location.href = '/signup';
    } catch (err) {
      console.error('[RedeemInviteCodeCard] sign-out error:', err);
      toast.error('Could not sign out. Try refreshing the page.');
      setSigningOut(false);
    }
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <Ticket className="size-4 text-primary" />
            I have an invite code
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            Someone invited you to their team with a short code instead of a
            link? Enter it below to join. This moves your login into their
            account — your empty personal account is cleaned up.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={handleSubmit}
            className="flex flex-col gap-3 sm:flex-row sm:items-end"
          >
            <div className="flex-1 space-y-2">
              <Label htmlFor="invite-code" className="text-muted-foreground">
                Invite code
              </Label>
              <Input
                id="invite-code"
                placeholder="A3F9-K2XQ"
                value={code}
                onChange={(e) => setCode(formatCodeInput(e.target.value))}
                disabled={submitting}
                className="bg-muted border-border font-mono text-foreground tracking-widest placeholder:text-muted-foreground"
              />
            </div>
            <Button type="submit" disabled={submitting || !code.trim()}>
              {submitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Checking…
                </>
              ) : (
                'Redeem code'
              )}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Dialog
        open={conflictMessage !== null}
        onOpenChange={(open) => {
          if (!open) setConflictMessage(null);
        }}
      >
        <DialogContent className="bg-popover border-border sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-popover-foreground">
              <AlertTriangle className="size-4 text-amber-400" />
              Can&apos;t redeem this code
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {conflictMessage}
            </DialogDescription>
          </DialogHeader>
          <div className="py-2 text-xs text-muted-foreground">
            To use this code, sign out and sign up again with a different
            email address. The code stays valid as long as it hasn&apos;t
            expired.
          </div>
          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setConflictMessage(null)}
              className="border-border text-popover-foreground hover:bg-muted"
            >
              Stay signed in
            </Button>
            <Button
              onClick={handleSignOutAndRetry}
              disabled={signingOut}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {signingOut ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Signing out…
                </>
              ) : (
                'Sign out & use a different email'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
