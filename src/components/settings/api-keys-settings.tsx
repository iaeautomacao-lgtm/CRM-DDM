'use client';

import { apiFetch } from "@/lib/api-fetch";

// ============================================================
// ApiKeysSettings — Settings → API keys
//
// Manage the credentials that authenticate the public REST API
// (`/api/v1/*`). Any member sees the roster (read-only); admin+ can
// mint and revoke (gated by <RequireRole min="admin"> here and the
// admin-only API routes + RLS on the server).
//
// One-time reveal: a freshly-minted key's plaintext is shown ONCE in
// the creation dialog. After it closes, only the prefix remains —
// the server stores just the hash. The UI states this explicitly so
// the absence of a "copy again" button reads as intentional, not a
// bug (same lesson as the invite-link flow).
//
// `personal` (PRD-04 Fase 3): modo "Minhas chaves de API" usado no
// /inteligencia — lista só as chaves pessoais do usuário (?mine=1), cria
// só a chave "Inteligência (leitura)" (MCP) e deixa o dono revogá-las.
// Supervisor chega aqui; /settings continua owner/admin.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { Copy, KeyRound, Loader2, Plus, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import { RequireRole } from '@/components/auth/require-role';
import { useAuth } from '@/hooks/use-auth';
import {
  API_SCOPES,
  SCOPE_DESCRIPTIONS,
  type ApiScope,
} from '@/lib/api-keys/scopes';
import { SettingsPanelHead } from './settings-panel-head';

interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  /** Dono da chave pessoal; null = chave da conta. */
  user_id: string | null;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function keyStatus(k: ApiKey): 'active' | 'revoked' | 'expired' {
  if (k.revoked_at) return 'revoked';
  if (k.expires_at && new Date(k.expires_at).getTime() <= Date.now())
    return 'expired';
  return 'active';
}

const INTELLIGENCE_SCOPE: ApiScope = 'intelligence:read';

const SCOPE_DESCRIPTIONS_PT: Partial<Record<ApiScope, string>> = {
  'messages:send': 'Enviar mensagens no WhatsApp',
  'messages:read': 'Ler mensagens e status de entrega',
  'contacts:read': 'Listar e ler contatos',
  'contacts:write': 'Criar e atualizar contatos',
  'conversations:read': 'Listar e ler conversas',
  'campaigns:write': 'Criar e enfileirar campanhas do Disparador',
  'campaigns:read': 'Ler status e métricas de campanhas do Disparador',
  'intelligence:read': SCOPE_DESCRIPTIONS['intelligence:read'],
};

export function ApiKeysSettings({ personal = false }: { personal?: boolean }) {
  const { canEditSettings } = useAuth();

  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(
        personal ? '/api/account/api-keys?mine=1' : '/api/account/api-keys',
        { cache: 'no-store' }
      );
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || 'Erro ao carregar chaves de API');
        return;
      }
      const data = (await res.json()) as { keys: ApiKey[] };
      setKeys(data.keys);
    } catch (err) {
      console.error('[ApiKeysSettings] load error:', err);
      toast.error('Não foi possível conectar ao servidor');
    } finally {
      setLoading(false);
    }
  }, [personal]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleRevoke(key: ApiKey) {
    setRevoking(key.id);
    try {
      const res = await apiFetch(`/api/account/api-keys/${key.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || 'Erro ao revogar chave');
        return;
      }
      toast.success(`Chave "${key.name}" revogada`);
      // Reflect the revoke locally without a refetch.
      setKeys((prev) =>
        prev.map((k) =>
          k.id === key.id ? { ...k, revoked_at: new Date().toISOString() } : k
        )
      );
    } catch (err) {
      console.error('[ApiKeysSettings] revoke error:', err);
      toast.error('Não foi possível conectar ao servidor');
    } finally {
      setRevoking(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="text-primary size-6 animate-spin" />
      </div>
    );
  }

  return (
    <section className="animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead
        title={personal ? 'Minhas chaves de API' : 'Chaves de API'}
        description={
          personal ? (
            <>
              Chaves pessoais para conectar assistentes externos (Claude
              Desktop/Code, n8n) ao DDM Intelligence pelo MCP (
              <code className="text-xs">/api/mcp</code>). A chave age como
              você: vê só os dados que você vê no CRM, e deixa de funcionar
              se for revogada ou se o seu acesso mudar.
            </>
          ) : (
            <>
              As chaves autenticam a REST API pública (
              <code className="text-xs">/api/v1</code>) para que você possa criar suas
              próprias automações. Envie-as no cabeçalho como{' '}
              <code className="text-xs">Authorization: Bearer &lt;chave&gt;</code>.{' '}
              <Link href="/docs/api" target="_blank" className="underline">
                Ver documentação da API
              </Link>
            </>
          )
        }
        action={
          <RequireRole min={personal ? 'supervisor' : 'admin'}>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" />
              {personal ? 'Nova chave' : 'Nova chave de API'}
            </Button>
          </RequireRole>
        }
      />

      {keys.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-10 text-center">
            <KeyRound className="text-muted-foreground size-6" />
            <p className="text-muted-foreground mt-2 text-sm">
              {personal ? 'Você ainda não tem chave pessoal.' : 'Nenhuma chave de API ainda.'}
            </p>
            {personal ? null : canEditSettings ? (
              <p className="text-muted-foreground mt-1 text-xs">
                Clique em <span className="text-foreground">Nova chave de API</span> para
                criar uma.
              </p>
            ) : (
              <p className="text-muted-foreground mt-1 text-xs">
                Peça a um proprietário ou supervisor para criar uma.
              </p>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-border divide-y">
              {keys.map((k) => {
                const status = keyStatus(k);
                const inactive = status !== 'active';
                return (
                  <li
                    key={k.id}
                    className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:gap-4"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={`truncate text-sm font-medium ${
                            inactive
                              ? 'text-muted-foreground line-through'
                              : 'text-foreground'
                          }`}
                        >
                          {k.name}
                        </span>
                        {status === 'revoked' && (
                          <Badge className="border-border bg-muted text-muted-foreground text-[10px] tracking-wide uppercase">
                            Revogada
                          </Badge>
                        )}
                        {status === 'expired' && (
                          <Badge className="border-border bg-muted text-muted-foreground text-[10px] tracking-wide uppercase">
                            Expirada
                          </Badge>
                        )}
                        {k.user_id && !personal && (
                          <Badge className="border-border bg-muted text-muted-foreground text-[10px] tracking-wide uppercase">
                            Pessoal
                          </Badge>
                        )}
                      </div>
                      <p className="text-muted-foreground mt-0.5 font-mono text-xs">
                        {k.key_prefix}…
                      </p>
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {k.scopes.length === 0 ? (
                          <span className="text-muted-foreground text-xs">
                            Sem escopos
                          </span>
                        ) : (
                          k.scopes.map((s) => (
                            <Badge
                              key={s}
                              className="border-border bg-muted text-muted-foreground text-[10px]"
                            >
                              {s}
                            </Badge>
                          ))
                        )}
                      </div>
                      <p className="text-muted-foreground mt-1.5 text-xs">
                        Criada em {fmtDate(k.created_at)}
                        {' · '}
                        {k.last_used_at
                          ? `último uso em ${fmtDate(k.last_used_at)}`
                          : 'nunca usada'}
                        {k.expires_at && status !== 'expired'
                          ? ` · expira em ${fmtDate(k.expires_at)}`
                          : ''}
                      </p>
                    </div>

                    {status === 'active' && (
                      // Modo pessoal: a lista só tem chaves do próprio
                      // usuário, que pode revogá-las (supervisor incluso).
                      <RequireRole min={personal ? 'supervisor' : 'admin'}>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleRevoke(k)}
                          disabled={revoking === k.id}
                          className="self-start border-red-500/40 bg-red-500/10 text-red-300 hover:border-red-500/60 hover:bg-red-500/20 hover:text-red-200 sm:self-auto"
                        >
                          {revoking === k.id ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Trash2 className="size-4" />
                          )}
                          Revogar
                        </Button>
                      </RequireRole>
                    )}
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}

      <CreateKeyDialog
        personal={personal}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={load}
      />
    </section>
  );
}

// ------------------------------------------------------------
// Create dialog — form → one-time plaintext reveal.
// ------------------------------------------------------------

function CreateKeyDialog({
  personal,
  open,
  onOpenChange,
  onCreated,
}: {
  personal: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [selectedScopes, setScopes] = useState<ApiScope[]>([]);
  // Modo pessoal: só existe a chave de Inteligência.
  const scopes = personal ? [INTELLIGENCE_SCOPE] : selectedScopes;
  // A chave de Inteligência é pessoal e exclusiva (o servidor recusa
  // combinar com escopos da conta).
  const intelligenceOnly = scopes.includes(INTELLIGENCE_SCOPE);
  const [submitting, setSubmitting] = useState(false);
  // Once set, we switch from the form to the reveal view.
  const [createdKey, setCreatedKey] = useState<string | null>(null);

  function reset() {
    setName('');
    setScopes([]);
    setSubmitting(false);
    setCreatedKey(null);
  }

  function toggleScope(scope: ApiScope, checked: boolean) {
    if (scope === INTELLIGENCE_SCOPE) {
      setScopes(checked ? [INTELLIGENCE_SCOPE] : []);
      return;
    }
    setScopes((prev) =>
      checked ? [...prev, scope] : prev.filter((s) => s !== scope)
    );
  }

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error('Dê um nome para a chave');
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiFetch('/api/account/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed, scopes }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || 'Erro ao criar chave');
        return;
      }
      setCreatedKey(payload.plaintext as string);
      onCreated();
    } catch (err) {
      console.error('[CreateKeyDialog] create error:', err);
      toast.error('Não foi possível conectar ao servidor');
    } finally {
      setSubmitting(false);
    }
  }

  async function copyKey() {
    if (!createdKey) return;
    try {
      await navigator.clipboard.writeText(createdKey);
      toast.success('Chave de API copiada');
    } catch {
      toast.error('Falha ao copiar — selecione e copie manualmente');
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="border-border bg-popover sm:max-w-md">
        {createdKey ? (
          <>
            <DialogHeader>
              <DialogTitle className="text-popover-foreground">
                Copie sua chave de API
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                Esta é a única vez em que a chave completa é exibida. Guarde-a em um local
                seguro — se perdê-la, revogue-a e crie uma nova.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-1.5">
              <Label className="text-muted-foreground">Chave de API</Label>
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={createdKey}
                  className="font-mono text-xs"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button type="button" variant="outline" onClick={copyKey}>
                  <Copy className="size-4" />
                  Copiar
                </Button>
              </div>
            </div>

            <DialogFooter>
              <Button
                onClick={() => {
                  reset();
                  onOpenChange(false);
                }}
              >
                Concluído
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="text-popover-foreground">
                Nova chave de API
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                Dê um nome relacionado à integração que a usará e conceda apenas
                os escopos necessários.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="api-key-name" className="text-muted-foreground">
                  Nome
                </Label>
                <Input
                  id="api-key-name"
                  value={name}
                  maxLength={80}
                  placeholder="ex.: Automação Zapier"
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              {personal ? (
                <p className="text-muted-foreground text-xs">
                  Escopo: <span className="text-foreground">Inteligência (leitura)</span>.{' '}
                  {SCOPE_DESCRIPTIONS[INTELLIGENCE_SCOPE]}
                </p>
              ) : (
                <div className="space-y-2">
                  <Label className="text-muted-foreground">Escopos</Label>
                  <div className="border-border space-y-2 rounded-md border p-3">
                    {API_SCOPES.map((scope) => (
                      <label
                        key={scope}
                        className="flex cursor-pointer items-start gap-2.5"
                      >
                        <Checkbox
                          checked={scopes.includes(scope)}
                          disabled={intelligenceOnly && scope !== INTELLIGENCE_SCOPE}
                          onCheckedChange={(checked) =>
                            toggleScope(scope, checked === true)
                          }
                          className="mt-0.5"
                        />
                        <span className="min-w-0">
                          <span className="text-foreground block font-mono text-xs">
                            {scope === INTELLIGENCE_SCOPE
                              ? 'Inteligência (leitura)'
                              : scope}
                          </span>
                          <span className="text-muted-foreground block text-xs">
                            {SCOPE_DESCRIPTIONS_PT[scope] ?? SCOPE_DESCRIPTIONS[scope]}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {intelligenceOnly
                      ? 'Chave pessoal: fica ligada a você, usa o seu papel e as suas equipes, e não pode ser combinada com outros escopos.'
                      : (
                        <>
                          Uma chave sem escopos ainda pode chamar{' '}
                          <code className="text-[11px]">GET /api/v1/me</code> para
                          verificar o funcionamento.
                        </>
                      )}
                  </p>
                </div>
              )}
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  reset();
                  onOpenChange(false);
                }}
                className="border-border text-muted-foreground hover:bg-muted"
              >
                Cancelar
              </Button>
              <Button onClick={handleCreate} disabled={submitting}>
                {submitting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Criando…
                  </>
                ) : (
                  'Criar chave'
                )}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
