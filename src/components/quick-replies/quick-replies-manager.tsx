'use client';

// ============================================================
// QuickRepliesManager — cadastro das respostas rápidas da conta
// (/respostas-rapidas, migration 142). Escrita direto pelo cliente
// Supabase: a RLS só deixa owner/admin gravar; todos os membros leem
// (o campo de mensagem do Inbox usa a mesma tabela).
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Pencil, Plus, Search, Trash2, Zap } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { invalidateQuickReplies } from '@/hooks/use-quick-replies';
import { normalizeForSearch } from '@/lib/utils';
import {
  QUICK_REPLY_CONTENT_MAX,
  QUICK_REPLY_SHORTCUT_MAX,
  QUICK_REPLY_TITLE_MAX,
  QUICK_REPLY_VARIABLES,
  isValidShortcut,
  normalizeShortcut,
  renderQuickReply,
  type QuickReply,
} from '@/lib/quick-replies';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import { Textarea } from '@/components/ui/textarea';
import { SettingsPanelHead } from '@/components/settings/settings-panel-head';

interface FormState {
  shortcut: string;
  title: string;
  content: string;
}

const EMPTY_FORM: FormState = { shortcut: '', title: '', content: '' };

export function QuickRepliesManager() {
  const supabase = useMemo(() => createClient(), []);
  const { user, accountId, profile } = useAuth();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [replies, setReplies] = useState<QuickReply[]>([]);
  const [search, setSearch] = useState('');

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<QuickReply | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<QuickReply | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchData = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    setLoadError(false);
    const { data, error } = await supabase
      .from('quick_replies')
      .select('*')
      .eq('account_id', accountId)
      .order('shortcut', { ascending: true })
      .range(0, 499);
    if (error) {
      console.error('[QuickRepliesManager] fetch error:', error);
      setLoadError(true);
    } else {
      setReplies((data ?? []) as QuickReply[]);
    }
    setLoading(false);
  }, [accountId, supabase]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const filtered = useMemo(() => {
    const q = normalizeForSearch(search.trim());
    if (!q) return replies;
    return replies.filter((r) =>
      [r.shortcut, r.title, r.content].some((v) => normalizeForSearch(v).includes(q)),
    );
  }, [replies, search]);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormOpen(true);
  }

  function openEdit(reply: QuickReply) {
    setEditing(reply);
    setForm({ shortcut: reply.shortcut, title: reply.title, content: reply.content });
    setFormOpen(true);
  }

  const shortcut = normalizeShortcut(form.shortcut);
  const duplicate = replies.some((r) => r.shortcut === shortcut && r.id !== editing?.id);

  async function handleSave() {
    const title = form.title.trim();
    const content = form.content.trim();
    if (!isValidShortcut(shortcut)) {
      toast.error('Atalho inválido: use letras, números, "-" ou "_".');
      return;
    }
    if (duplicate) {
      toast.error(`Já existe uma resposta com o atalho /${shortcut}.`);
      return;
    }
    if (!title) {
      toast.error('Informe um título.');
      return;
    }
    if (!content) {
      toast.error('Escreva o texto da resposta.');
      return;
    }
    if (!accountId || !user) return;

    setSaving(true);
    try {
      if (editing) {
        const { data: updated, error } = await supabase
          .from('quick_replies')
          .update({ shortcut, title, content, updated_at: new Date().toISOString() })
          .eq('id', editing.id)
          .eq('account_id', accountId)
          .select('id');
        if (error) throw error;
        // RLS barrando devolve 0 linhas sem erro.
        if (!updated?.length) throw { code: '42501' };
        toast.success('Resposta rápida atualizada');
      } else {
        const { error } = await supabase
          .from('quick_replies')
          .insert({ account_id: accountId, shortcut, title, content, created_by: user.id });
        if (error) throw error;
        toast.success('Resposta rápida criada');
      }
      setFormOpen(false);
      invalidateQuickReplies();
      await fetchData();
    } catch (err) {
      console.error('[QuickRepliesManager] save error:', err);
      const code = (err as { code?: string })?.code;
      toast.error(
        code === '23505'
          ? `Já existe uma resposta com o atalho /${shortcut}.`
          : code === '42501'
            ? 'Só administradores podem cadastrar respostas rápidas.'
            : 'Falha ao salvar a resposta rápida',
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget || !accountId) return;
    setDeleting(true);
    try {
      const { data: removed, error } = await supabase
        .from('quick_replies')
        .delete()
        .eq('id', deleteTarget.id)
        .eq('account_id', accountId)
        .select('id');
      if (error) throw error;
      if (!removed?.length) throw new Error('Sem permissão para excluir');
      toast.success('Resposta rápida excluída');
      setDeleteTarget(null);
      invalidateQuickReplies();
      await fetchData();
    } catch (err) {
      console.error('[QuickRepliesManager] delete error:', err);
      toast.error('Falha ao excluir a resposta rápida');
    } finally {
      setDeleting(false);
    }
  }

  function insertVariable(key: string) {
    setForm((f) => ({ ...f, content: `${f.content}${f.content && !/\s$/.test(f.content) ? ' ' : ''}${key}` }));
  }

  const preview = renderQuickReply(form.content, {
    contactName: 'Maria da Silva',
    agentName: profile?.full_name ?? 'Atendente',
  });

  return (
    <section>
      <SettingsPanelHead
        title="Respostas rápidas"
        description={
          <>
            Textos prontos para o Inbox: o atendente digita <span className="font-mono">/atalho</span> no
            campo de mensagem (ou clica no ⚡), o texto entra no campo já com o nome do cliente e ele
            revisa antes de enviar.
          </>
        }
        action={
          <Button onClick={openCreate}>
            <Plus className="size-4" />
            Nova resposta
          </Button>
        }
      />

      <div className="relative mb-4 max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por atalho, título ou texto"
          className="pl-9"
          aria-label="Buscar respostas rápidas"
        />
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Carregando…
        </div>
      ) : loadError ? (
        <Card>
          <CardContent className="flex flex-col items-start gap-3 py-6 text-sm">
            <p className="text-muted-foreground">
              Não foi possível carregar as respostas rápidas.
            </p>
            <Button variant="outline" size="sm" onClick={() => void fetchData()}>
              Tentar novamente
            </Button>
          </CardContent>
        </Card>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
            <Zap className="size-6 text-primary" />
            {replies.length === 0 ? (
              <>
                <p>Nenhuma resposta rápida ainda.</p>
                <Button variant="outline" size="sm" onClick={openCreate}>
                  Criar a primeira
                </Button>
              </>
            ) : (
              <p>Nada encontrado para &quot;{search}&quot;.</p>
            )}
          </CardContent>
        </Card>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-card">
          {filtered.map((r) => (
            <li key={r.id} className="flex items-start gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-mono text-sm text-primary">/{r.shortcut}</span>
                  <span className="text-sm font-medium text-foreground">{r.title}</span>
                </div>
                <p className="mt-1 line-clamp-2 whitespace-pre-line text-xs text-muted-foreground">
                  {r.content}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button variant="ghost" size="icon" aria-label={`Editar /${r.shortcut}`} onClick={() => openEdit(r)}>
                  <Pencil className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Excluir /${r.shortcut}`}
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => setDeleteTarget(r)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={formOpen} onOpenChange={(open) => !saving && setFormOpen(open)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? 'Editar resposta rápida' : 'Nova resposta rápida'}</DialogTitle>
            <DialogDescription>
              Disponível para todos os atendentes da conta.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
              <div className="space-y-2">
                <Label htmlFor="qr-shortcut">Atalho</Label>
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-sm text-muted-foreground">
                    /
                  </span>
                  <Input
                    id="qr-shortcut"
                    value={form.shortcut}
                    onChange={(e) => setForm((f) => ({ ...f, shortcut: e.target.value }))}
                    onBlur={() => setForm((f) => ({ ...f, shortcut: normalizeShortcut(f.shortcut) }))}
                    placeholder="boleto"
                    maxLength={QUICK_REPLY_SHORTCUT_MAX + 5}
                    className="pl-6 font-mono"
                    disabled={saving}
                    aria-invalid={duplicate || undefined}
                  />
                </div>
                {duplicate && (
                  <p className="text-xs text-destructive">Já existe /{shortcut}.</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="qr-title">Título</Label>
                <Input
                  id="qr-title"
                  value={form.title}
                  onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                  placeholder="Segunda via do boleto"
                  maxLength={QUICK_REPLY_TITLE_MAX}
                  disabled={saving}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="qr-content">Texto</Label>
              <Textarea
                id="qr-content"
                value={form.content}
                onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
                placeholder="Olá, {primeiro_nome}! Segue a segunda via do seu boleto…"
                rows={5}
                maxLength={QUICK_REPLY_CONTENT_MAX}
                disabled={saving}
              />
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <span>Inserir:</span>
                {QUICK_REPLY_VARIABLES.map((v) => (
                  <button
                    key={v.key}
                    type="button"
                    onClick={() => insertVariable(v.key)}
                    title={v.label}
                    className="rounded border border-border px-1.5 py-0.5 font-mono hover:bg-muted hover:text-foreground"
                    disabled={saving}
                  >
                    {v.key}
                  </button>
                ))}
              </div>
            </div>
            {form.content.trim() && (
              <div className="rounded-lg border border-border bg-muted/50 p-3">
                <p className="mb-1 text-[11px] uppercase tracking-wider text-muted-foreground">
                  Prévia (contato &quot;Maria da Silva&quot;)
                </p>
                <p className="whitespace-pre-line text-sm text-foreground">{preview}</p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)} disabled={saving}>
              Cancelar
            </Button>
            <Button onClick={handleSave} disabled={saving || duplicate}>
              {saving ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Salvando…
                </>
              ) : editing ? (
                'Salvar alterações'
              ) : (
                'Criar resposta'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && !deleting && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Excluir resposta rápida</DialogTitle>
            <DialogDescription>
              Excluir /{deleteTarget?.shortcut} — &quot;{deleteTarget?.title}&quot;? Ela some do Inbox de
              todos os atendentes.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              Cancelar
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Excluindo…
                </>
              ) : (
                'Excluir'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
