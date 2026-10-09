'use client';

// ============================================================
// QuickRepliesManager — respostas rápidas (/respostas-rapidas, migrations 142 e 301), no visual DDM: tabela + gaveta.
// Escrita direto pelo cliente Supabase; quem decide é a RLS:
//   · Pessoal: o próprio dono cria/edita/exclui (operador incluso) e só ele vê;
//   · Equipe e Conta: só quem tem inbox.quick_replies.manage (admin/proprietário); os demais veem em leitura.
// Usos (30 d): RPC quick_reply_usage_30d (só das respostas visíveis ao usuário). O registro do uso é feito pelo Inbox
// (POST /api/quick-replies/[id]/use).
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Plus, Search, Trash2, Zap } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { usePermission } from '@/hooks/use-permission';
import { invalidateQuickReplies } from '@/hooks/use-quick-replies';
import { normalizeForSearch } from '@/lib/utils';
import {
  QUICK_REPLY_CONTENT_MAX,
  QUICK_REPLY_SHORTCUT_MAX,
  QUICK_REPLY_TITLE_MAX,
  QUICK_REPLY_VARIABLES,
  QUICK_REPLY_VISIBILITY_LABEL,
  canEditQuickReply,
  isValidShortcut,
  normalizeShortcut,
  renderQuickReply,
  shortcutTaken,
  visibilityOf,
  visibilityOptions,
  type QuickReply,
  type QuickReplyVisibility,
} from '@/lib/quick-replies';
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
import { Textarea } from '@/components/ui/textarea';
import { PageBody, PageToolbar } from '@/components/ddm/page-toolbar';
import { Segmented } from '@/components/ddm/segmented';
import { StatusChip } from '@/components/ddm/status-chip';
import { CellMain, DenseTable, TableCard, Td, Th, Tr } from '@/components/ddm/table-card';
import { DetailDrawer } from '@/components/ddm/list-with-drawer';
import { EmptyState, ErrorState, Skeleton } from '@/components/ddm/states';

interface FormState {
  shortcut: string;
  title: string;
  content: string;
  visibility: QuickReplyVisibility;
  teamId: string;
}

type Seg = 'all' | 'mine' | 'team' | 'account';

const EMPTY_FORM: FormState = { shortcut: '', title: '', content: '', visibility: 'personal', teamId: '' };

const VISIBILITY_HINT: Record<QuickReplyVisibility, string> = {
  personal: 'Só você vê e usa.',
  team: 'Os membros da equipe escolhida veem e usam.',
  account: 'Todos os atendentes da conta veem e usam.',
};

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('pt-BR');
}

export function QuickRepliesManager() {
  const supabase = useMemo(() => createClient(), []);
  const { user, accountId, profile } = useAuth();
  const canManage = usePermission('inbox.quick_replies.manage');
  const canReply = usePermission('inbox.reply');
  const canCreate = canManage || canReply;
  const ctx = useMemo(() => ({ userId: user?.id, canManage }), [user?.id, canManage]);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [replies, setReplies] = useState<QuickReply[]>([]);
  const [teams, setTeams] = useState<Array<{ id: string; name: string }>>([]);
  // null = a RPC de usos não respondeu (migration 301 ainda não aplicada, por exemplo): a coluna mostra "—".
  const [usage, setUsage] = useState<Map<string, number> | null>(null);
  const [search, setSearch] = useState('');
  const [seg, setSeg] = useState<Seg>('all');

  // Gaveta: criar (editing = null) ou editar.
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
    const [repliesRes, teamsRes, usageRes] = await Promise.all([
      supabase
        .from('quick_replies')
        .select('*')
        .eq('account_id', accountId)
        .order('shortcut', { ascending: true })
        .range(0, 499),
      supabase.from('teams').select('id, name').eq('account_id', accountId).order('name', { ascending: true }),
      supabase.rpc('quick_reply_usage_30d'),
    ]);
    if (repliesRes.error) {
      console.error('[QuickRepliesManager] fetch error:', repliesRes.error);
      setLoadError(true);
    } else {
      setReplies((repliesRes.data ?? []) as QuickReply[]);
    }
    // Equipes e usos são complementos: sem eles a tela segue funcionando.
    if (!teamsRes.error) setTeams((teamsRes.data ?? []) as Array<{ id: string; name: string }>);
    if (usageRes.error) {
      setUsage(null);
    } else {
      const rows = (usageRes.data ?? []) as Array<{ quick_reply_id: string; uses: number | string }>;
      setUsage(new Map(rows.map((r) => [r.quick_reply_id, Number(r.uses)] as const)));
    }
    setLoading(false);
  }, [accountId, supabase]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const teamNameById = useMemo(() => new Map(teams.map((t) => [t.id, t.name] as const)), [teams]);

  const isMine = useCallback(
    (r: QuickReply) => visibilityOf(r) === 'personal' && !!user && r.created_by === user.id,
    [user],
  );

  const counts = useMemo(
    () => ({
      mine: replies.filter(isMine).length,
      team: replies.filter((r) => visibilityOf(r) === 'team').length,
      account: replies.filter((r) => visibilityOf(r) === 'account').length,
    }),
    [replies, isMine],
  );

  const filtered = useMemo(() => {
    const q = normalizeForSearch(search.trim());
    return replies.filter((r) => {
      if (seg === 'mine' && !isMine(r)) return false;
      if (seg === 'team' && visibilityOf(r) !== 'team') return false;
      if (seg === 'account' && visibilityOf(r) !== 'account') return false;
      if (!q) return true;
      return [r.shortcut, r.title, r.content].some((v) => normalizeForSearch(v).includes(q));
    });
  }, [replies, search, seg, isMine]);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormOpen(true);
  }

  function openEdit(reply: QuickReply) {
    setEditing(reply);
    setForm({
      shortcut: reply.shortcut,
      title: reply.title,
      content: reply.content,
      visibility: visibilityOf(reply),
      teamId: reply.team_id ?? '',
    });
    setFormOpen(true);
  }

  const editable = editing ? canEditQuickReply(editing, ctx) : canCreate;
  const options = visibilityOptions(canManage);
  const shortcut = normalizeShortcut(form.shortcut);
  const ownerId = editing && visibilityOf(editing) === 'personal' ? editing.created_by : user?.id;
  const duplicate = shortcutTaken(
    replies,
    { shortcut, visibility: form.visibility, teamId: form.visibility === 'team' ? form.teamId || null : null, ownerId },
    editing?.id,
  );

  function visibleFor(r: QuickReply): { tone: 'mute' | 'info' | 'brand'; label: string } {
    const v = visibilityOf(r);
    if (v === 'personal') return { tone: 'mute', label: isMine(r) ? 'Só eu' : 'Pessoal' };
    if (v === 'team') return { tone: 'info', label: `Equipe · ${teamNameById.get(r.team_id ?? '') ?? 'sem acesso ao nome'}` };
    return { tone: 'brand', label: 'Toda a conta' };
  }

  async function handleSave() {
    const title = form.title.trim();
    const content = form.content.trim();
    if (!isValidShortcut(shortcut)) {
      toast.error('Atalho inválido: use letras, números, "-" ou "_".');
      return;
    }
    if (duplicate) {
      toast.error(`Já existe uma resposta com o atalho /${shortcut} neste escopo.`);
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
    if (form.visibility === 'team' && !form.teamId) {
      toast.error('Escolha a equipe que vai ver esta resposta.');
      return;
    }
    if (!accountId || !user) return;

    setSaving(true);
    try {
      if (editing) {
        // Só quem tem manage muda a visibilidade; o dono de uma pessoal não a promove (a RLS também barra).
        const scope = canManage
          ? { visibility: form.visibility, team_id: form.visibility === 'team' ? form.teamId : null }
          : {};
        const { data: updated, error } = await supabase
          .from('quick_replies')
          .update({ shortcut, title, content, ...scope, updated_at: new Date().toISOString() })
          .eq('id', editing.id)
          .eq('account_id', accountId)
          .select('id');
        if (error) throw error;
        // RLS barrando devolve 0 linhas sem erro.
        if (!updated?.length) throw { code: '42501' };
        toast.success('Resposta rápida atualizada');
      } else {
        const { error } = await supabase.from('quick_replies').insert({
          account_id: accountId,
          shortcut,
          title,
          content,
          created_by: user.id,
          visibility: form.visibility,
          team_id: form.visibility === 'team' ? form.teamId : null,
        });
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
          ? `Já existe uma resposta com o atalho /${shortcut} neste escopo.`
          : code === '42501'
            ? 'Você não tem permissão para salvar esta resposta com essa visibilidade.'
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
      setFormOpen(false);
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
    <PageBody>
      <PageToolbar
        actions={
          canCreate ? (
            <Button onClick={openCreate}>
              <Plus className="size-4" aria-hidden="true" />
              Nova resposta
            </Button>
          ) : undefined
        }
      >
        <div className="relative w-full max-w-xs">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar atalho ou texto"
            className="h-8 pl-9"
            aria-label="Buscar respostas rápidas"
          />
        </div>
        <Segmented<Seg>
          ariaLabel="Filtrar respostas rápidas"
          size="lg"
          value={seg}
          onChange={setSeg}
          options={[
            { value: 'all', label: 'Todas', count: replies.length },
            { value: 'mine', label: 'Minhas', count: counts.mine },
            { value: 'team', label: 'Da equipe', count: counts.team },
            { value: 'account', label: 'Da conta', count: counts.account },
          ]}
        />
      </PageToolbar>

      <p className="m-0 max-w-3xl text-[12.5px] text-muted-foreground">
        Textos prontos para o Inbox: o atendente digita <span className="font-mono">/atalho</span> no campo de
        mensagem (ou clica no ⚡), o texto entra já com o nome do cliente e ele revisa antes de enviar. Se o mesmo
        atalho existir em mais de um lugar, vale a ordem pessoal, equipe, conta.
        {!canManage && ' Você cria e edita as suas (pessoais); as da equipe e da conta aparecem só para consulta.'}
      </p>

      <TableCard title="Respostas rápidas" hint="Só aparecem as que você pode usar.">
        {loading ? (
          <div className="flex flex-col gap-2 px-[18px] pb-4" aria-busy="true">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-11 w-full" />
            ))}
          </div>
        ) : loadError ? (
          <ErrorState
            className="m-4 mt-0"
            title="Não foi possível carregar as respostas rápidas"
            onRetry={() => void fetchData()}
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            className="m-4 mt-0"
            icon={Zap}
            title={replies.length === 0 ? 'Nenhuma resposta rápida ainda' : 'Nada encontrado'}
            hint={
              replies.length === 0
                ? canCreate
                  ? 'Crie a primeira para agilizar o atendimento no Inbox.'
                  : undefined
                : search.trim()
                  ? `Nenhum resultado para "${search}".`
                  : 'Nenhuma resposta neste filtro.'
            }
          />
        ) : (
          <DenseTable minWidth={760}>
            <thead>
              <tr>
                <Th>Atalho</Th>
                <Th>Texto</Th>
                <Th>Visível para</Th>
                <Th align="right">Usos (30 d)</Th>
                <Th className="hidden lg:table-cell">Atualizada em</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const vis = visibleFor(r);
                return (
                  <Tr
                    key={r.id}
                    className={editing?.id === r.id && formOpen ? 'cursor-pointer bg-selected' : 'cursor-pointer'}
                    onClick={() => openEdit(r)}
                  >
                    <Td>
                      <button
                        type="button"
                        className="block max-w-full text-left focus-visible:outline-2 focus-visible:outline-ring"
                        aria-label={`Abrir /${r.shortcut}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          openEdit(r);
                        }}
                      >
                        <CellMain title={<span className="font-mono text-primary-text">/{r.shortcut}</span>} sub={r.title} />
                      </button>
                    </Td>
                    <Td className="max-w-[24rem]">
                      <span className="line-clamp-2 whitespace-pre-line text-xs text-muted-foreground">{r.content}</span>
                    </Td>
                    <Td>
                      <StatusChip tone={vis.tone} dot={false}>
                        {vis.label}
                      </StatusChip>
                    </Td>
                    <Td align="right" className="text-foreground-2">
                      {usage ? (usage.get(r.id) ?? 0).toLocaleString('pt-BR') : '—'}
                    </Td>
                    <Td className="hidden whitespace-nowrap text-xs text-muted-foreground lg:table-cell">
                      {fmtDate(r.updated_at)}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </DenseTable>
        )}
      </TableCard>

      <DetailDrawer
        open={formOpen}
        onOpenChange={(open) => !saving && setFormOpen(open)}
        title={editing ? `/${editing.shortcut}` : 'Nova resposta rápida'}
        description={
          editing
            ? editable
              ? `Resposta rápida · ${QUICK_REPLY_VISIBILITY_LABEL[visibilityOf(editing)]}`
              : 'Resposta rápida (somente leitura).'
            : VISIBILITY_HINT[form.visibility]
        }
        footer={
          editable ? (
            <>
              {editing && (
                <Button
                  variant="ghost"
                  className="mr-auto text-muted-foreground hover:text-destructive"
                  onClick={() => setDeleteTarget(editing)}
                  disabled={saving}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                  Excluir
                </Button>
              )}
              <Button variant="outline" onClick={() => setFormOpen(false)} disabled={saving}>
                Cancelar
              </Button>
              <Button onClick={() => void handleSave()} disabled={saving || duplicate}>
                {saving ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    Salvando…
                  </>
                ) : editing ? (
                  'Salvar alterações'
                ) : (
                  'Criar resposta'
                )}
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => setFormOpen(false)}>
              Fechar
            </Button>
          )
        }
      >
        <div className="space-y-4">
          {/* Visibilidade: sem manage só existe "Pessoal"; quem não edita a resposta só lê. */}
          <div className="space-y-2">
            <Label>Visível para</Label>
            <Segmented<QuickReplyVisibility>
              ariaLabel="Visibilidade da resposta"
              size="lg"
              value={form.visibility}
              onChange={(v) => editable && canManage && setForm((f) => ({ ...f, visibility: v }))}
              options={(editable && canManage ? options : [form.visibility]).map((v) => ({
                value: v,
                label: QUICK_REPLY_VISIBILITY_LABEL[v],
              }))}
            />
            <p className="text-xs text-muted-foreground">{VISIBILITY_HINT[form.visibility]}</p>
            {form.visibility === 'team' && (
              <div className="space-y-1.5">
                <Label htmlFor="qr-team">Equipe</Label>
                <select
                  id="qr-team"
                  value={form.teamId}
                  disabled={saving || !editable || !canManage}
                  onChange={(e) => setForm((f) => ({ ...f, teamId: e.target.value }))}
                  className="h-9 w-full rounded-lg border border-input bg-background px-2.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                >
                  <option value="">Selecione a equipe…</option>
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                  {form.teamId && !teamNameById.has(form.teamId) && <option value={form.teamId}>Equipe atual</option>}
                </select>
                {teams.length === 0 && <p className="text-xs text-muted-foreground">Nenhuma equipe cadastrada.</p>}
              </div>
            )}
          </div>

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
                  disabled={saving || !editable}
                  aria-invalid={duplicate || undefined}
                />
              </div>
              {duplicate && <p className="text-xs text-destructive">Já existe /{shortcut} neste escopo.</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="qr-title">Título</Label>
              <Input
                id="qr-title"
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                placeholder="Segunda via do boleto"
                maxLength={QUICK_REPLY_TITLE_MAX}
                disabled={saving || !editable}
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
              rows={6}
              maxLength={QUICK_REPLY_CONTENT_MAX}
              disabled={saving || !editable}
            />
            {editable && (
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
            )}
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
      </DetailDrawer>

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && !deleting && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Excluir resposta rápida</DialogTitle>
            <DialogDescription>
              Excluir /{deleteTarget?.shortcut} — &quot;{deleteTarget?.title}&quot;?{' '}
              {deleteTarget && visibilityOf(deleteTarget) === 'personal'
                ? 'Ela some só para você.'
                : deleteTarget && visibilityOf(deleteTarget) === 'team'
                  ? 'Ela some do Inbox dos membros da equipe.'
                  : 'Ela some do Inbox de todos os atendentes.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              Cancelar
            </Button>
            <Button variant="destructive" onClick={() => void handleDelete()} disabled={deleting}>
              {deleting ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  Excluindo…
                </>
              ) : (
                'Excluir'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageBody>
  );
}
