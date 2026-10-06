'use client';

// ============================================================
// TabulacoesManager — /tabulacoes' dedicated CRUD for outcome tags.
//
// Scope: kind='outcome' tags only (real tabulações) — kind='contact'
// tags (regular contact labels) stay on TagManager, rendered alongside
// this on the same page. team_outcome_tags (migration 107) is the N:N
// junction between a tabulação and every team that uses it; this
// component reads it read-only for the team filter + "Equipes
// vinculadas" column — linking/unlinking a specific team stays on
// /equipes/[id]'s own Tabulações tab, which already owns that flow.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Pencil, Plus, Search, Tag as TagIcon, Trash2 } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { normalizeForSearch } from '@/lib/utils';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SettingsPanelHead } from '@/components/settings/settings-panel-head';
import type { Tag, Team } from '@/types';
import { codigoInUseBy, parseCodigoTabulacao } from '@/lib/tabulacoes/codigo';
import { AiOutcomeMapSection } from './ai-outcome-map-table';

export { AiOutcomeMapSection } from './ai-outcome-map-table';

const TABULACAO_COLORS = [
  { name: 'Red', value: '#ef4444' },
  { name: 'Orange', value: '#f97316' },
  { name: 'Amber', value: '#f59e0b' },
  { name: 'Emerald', value: '#10b981' },
  { name: 'Blue', value: '#3b82f6' },
  { name: 'Violet', value: '#8b5cf6' },
];

// Sentinel for Base UI Select, which needs a real string value — same
// pattern as NO_OVERFLOW in team-form-dialog.tsx.
const ALL_TEAMS = '__all__';

interface TabulacaoFormState {
  name: string;
  color: string;
  /** codigo_tabulacao como digitado ('' = sem código). */
  codigo: string;
}

const EMPTY_FORM: TabulacaoFormState = { name: '', color: TABULACAO_COLORS[0].value, codigo: '' };

export function TabulacoesManager() {
  const supabase = createClient();
  const { user, accountId } = useAuth();

  const [loading, setLoading] = useState(true);
  const [tabulacoes, setTabulacoes] = useState<Tag[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  // tag_id -> team_id[], derived from every team_outcome_tags row this
  // account's RLS lets us see (see header comment — no explicit
  // account_id filter needed on that table).
  const [teamIdsByTag, setTeamIdsByTag] = useState<Map<string, string[]>>(new Map());

  const [search, setSearch] = useState('');
  const [teamFilter, setTeamFilter] = useState(ALL_TEAMS);

  const [formOpen, setFormOpen] = useState(false);
  const [editingTag, setEditingTag] = useState<Tag | null>(null);
  const [form, setForm] = useState<TabulacaoFormState>(EMPTY_FORM);
  // Create mode only — lets a new tabulação start out already linked to
  // one or more teams (one insert into team_outcome_tags per team,
  // right after the tag itself is created). Edit mode never touches
  // this: per-team linkage stays owned by /equipes/[id]'s own
  // Tabulações tab, same as before.
  const [selectedTeamIds, setSelectedTeamIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<Tag | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchData = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    try {
      const [tagsRes, teamsRes, assignmentsRes] = await Promise.all([
        supabase
          .from('tags')
          .select('*')
          .eq('account_id', accountId)
          .eq('kind', 'outcome')
          .order('name', { ascending: true }),
        supabase
          .from('teams')
          .select('*')
          .eq('account_id', accountId)
          .order('name', { ascending: true }),
        supabase.from('team_outcome_tags').select('team_id, tag_id'),
      ]);
      if (tagsRes.error) throw tagsRes.error;
      setTabulacoes((tagsRes.data ?? []) as Tag[]);

      if (!teamsRes.error) setTeams((teamsRes.data ?? []) as Team[]);

      if (!assignmentsRes.error) {
        const byTag = new Map<string, string[]>();
        for (const row of assignmentsRes.data ?? []) {
          const list = byTag.get(row.tag_id) ?? [];
          list.push(row.team_id);
          byTag.set(row.tag_id, list);
        }
        setTeamIdsByTag(byTag);
      }
    } catch (err) {
      console.error('[TabulacoesManager] fetch error:', err);
      toast.error('Falha ao carregar tabulações');
    } finally {
      setLoading(false);
    }
  }, [accountId, supabase]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const teamNameById = useMemo(
    () => new Map(teams.map((t) => [t.id, t.name] as const)),
    [teams],
  );

  // Search is client-side over the already-loaded kind='outcome' list —
  // same "no server round-trip per keystroke" call as members-tab.tsx.
  const filtered = useMemo(() => {
    const normalizedSearch = normalizeForSearch(search.trim());
    return tabulacoes.filter((tag) => {
      if (normalizedSearch && !normalizeForSearch(tag.name).includes(normalizedSearch)) {
        return false;
      }
      if (teamFilter !== ALL_TEAMS) {
        const teamIds = teamIdsByTag.get(tag.id) ?? [];
        if (!teamIds.includes(teamFilter)) return false;
      }
      return true;
    });
  }, [tabulacoes, search, teamFilter, teamIdsByTag]);

  function openCreate() {
    setEditingTag(null);
    setForm(EMPTY_FORM);
    setSelectedTeamIds(new Set());
    setFormOpen(true);
  }

  function openEdit(tag: Tag) {
    setEditingTag(tag);
    setForm({
      name: tag.name,
      color: tag.color,
      codigo: tag.codigo_tabulacao !== undefined && tag.codigo_tabulacao !== null ? String(tag.codigo_tabulacao) : '',
    });
    setFormOpen(true);
  }

  function toggleTeamSelection(teamId: string, checked: boolean) {
    setSelectedTeamIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(teamId);
      else next.delete(teamId);
      return next;
    });
  }

  async function handleSave() {
    const trimmed = form.name.trim();
    if (!trimmed) {
      toast.error('Nome da tabulação é obrigatório');
      return;
    }
    const codigo = parseCodigoTabulacao(form.codigo);
    if (!codigo.ok) {
      toast.error(codigo.error);
      return;
    }
    const usedBy = codigoInUseBy(tabulacoes, codigo.value, editingTag?.id);
    if (usedBy) {
      toast.error(`O código ${codigo.value} já é usado pela tabulação "${usedBy}"`);
      return;
    }
    if (!accountId || !user) return;

    setSaving(true);
    try {
      if (editingTag) {
        const { error } = await supabase
          .from('tags')
          .update({ name: trimmed, color: form.color, codigo_tabulacao: codigo.value })
          .eq('id', editingTag.id);
        if (error) throw error;
        toast.success('Tabulação atualizada');
      } else {
        const { data: created, error } = await supabase
          .from('tags')
          .insert({
            account_id: accountId,
            user_id: user.id,
            name: trimmed,
            color: form.color,
            kind: 'outcome',
            codigo_tabulacao: codigo.value,
          })
          .select('id')
          .single();
        if (error) throw error;

        if (selectedTeamIds.size > 0) {
          const rows = Array.from(selectedTeamIds).map((teamId) => ({
            team_id: teamId,
            tag_id: created.id,
          }));
          const { error: linkError } = await supabase.from('team_outcome_tags').insert(rows);
          if (linkError) throw linkError;
        }

        toast.success(
          selectedTeamIds.size > 0
            ? `Tabulação criada e vinculada a ${selectedTeamIds.size} equipe${selectedTeamIds.size === 1 ? '' : 's'}`
            : 'Tabulação criada',
        );
      }
      setFormOpen(false);
      await fetchData();
    } catch (err) {
      console.error('[TabulacoesManager] save error:', err);
      toast.error(editingTag ? 'Falha ao atualizar tabulação' : 'Falha ao criar tabulação');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const { error } = await supabase.from('tags').delete().eq('id', deleteTarget.id);
      if (error) throw error;
      toast.success('Tabulação excluída');
      setTabulacoes((prev) => prev.filter((t) => t.id !== deleteTarget.id));
      setTeamIdsByTag((prev) => {
        const next = new Map(prev);
        next.delete(deleteTarget.id);
        return next;
      });
      setDeleteTarget(null);
    } catch (err) {
      console.error('[TabulacoesManager] delete error:', err);
      toast.error('Falha ao excluir tabulação');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <SettingsPanelHead
        title="Tabulações"
        description="Tags de encerramento de conversa (kind=&quot;outcome&quot;) usadas para classificar o motivo do fechamento. O vínculo com uma equipe específica é feito na tela de cada equipe."
        action={
          <Button onClick={openCreate}>
            <Plus className="size-4" />
            Nova tabulação
          </Button>
        }
      />

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar tabulação..."
            className="pl-8"
          />
        </div>
        <Select value={teamFilter} onValueChange={(v) => v && setTeamFilter(v)}>
          <SelectTrigger className="w-full sm:w-56">
            <SelectValue>
              {(v: string) => (v === ALL_TEAMS ? 'Todas as equipes' : (teamNameById.get(v) ?? v))}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_TEAMS}>Todas as equipes</SelectItem>
            {teams.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
            <TagIcon className="size-6 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              {tabulacoes.length === 0
                ? 'Nenhuma tabulação ainda — crie a primeira acima.'
                : 'Nenhuma tabulação encontrada para esse filtro.'}
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-y divide-border">
              {filtered.map((tag) => {
                const teamIds = teamIdsByTag.get(tag.id) ?? [];
                return (
                  <li key={tag.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <span
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: tag.color }}
                    />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                      {tag.name}
                    </span>
                    {tag.codigo_tabulacao !== undefined && tag.codigo_tabulacao !== null && (
                      <span className="shrink-0 font-mono text-xs text-muted-foreground" title="Código da tabulação">
                        Cód. {tag.codigo_tabulacao}
                      </span>
                    )}
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      {teamIds.length === 0 ? (
                        <span className="text-xs text-muted-foreground">
                          Nenhuma equipe vinculada
                        </span>
                      ) : (
                        teamIds.map((teamId) => (
                          <Badge
                            key={teamId}
                            className="border border-border bg-muted text-xs text-muted-foreground"
                          >
                            {teamNameById.get(teamId) ?? 'Equipe removida'}
                          </Badge>
                        ))
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => openEdit(tag)}
                        title="Editar tabulação"
                        aria-label="Editar tabulação"
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => setDeleteTarget(tag)}
                        title="Excluir tabulação"
                        aria-label="Excluir tabulação"
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Create / edit */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{editingTag ? 'Editar tabulação' : 'Nova tabulação'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="tabulacao-name">Nome</Label>
              <Input
                id="tabulacao-name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="ex.: Resolvido"
                maxLength={40}
                disabled={saving}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="tabulacao-codigo">
                Código{' '}
                <span className="text-xs text-muted-foreground">(opcional)</span>
              </Label>
              <Input
                id="tabulacao-codigo"
                value={form.codigo}
                onChange={(e) => setForm((f) => ({ ...f, codigo: e.target.value }))}
                placeholder="ex.: 142"
                inputMode="numeric"
                maxLength={5}
                disabled={saving}
              />
              <p className="text-xs text-muted-foreground">
                Código de negócio da tabulação. A IA usa este código para sugerir a tabulação
                a partir das tags de saída do fluxo.
              </p>
            </div>
            <div className="space-y-2">
              <Label>Cor</Label>
              <div className="flex items-center gap-1.5">
                {TABULACAO_COLORS.map((color) => (
                  <button
                    key={color.value}
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, color: color.value }))}
                    aria-label={`Usar ${color.name}`}
                    aria-pressed={form.color === color.value}
                    className={`size-6 rounded-full border-2 transition-transform ${
                      form.color === color.value
                        ? 'scale-110 border-foreground'
                        : 'border-transparent'
                    }`}
                    style={{ backgroundColor: color.value }}
                    title={color.name}
                  />
                ))}
              </div>
            </div>

            {/* Create mode only — edit mode's team linkage stays owned
                by /equipes/[id]'s own Tabulações tab. */}
            {!editingTag && (
              <div className="space-y-2">
                <Label>
                  Vincular a equipes{' '}
                  <span className="text-xs text-muted-foreground">(opcional)</span>
                </Label>
                {teams.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Nenhuma equipe criada ainda.
                  </p>
                ) : (
                  <div className="max-h-40 space-y-0.5 overflow-y-auto rounded-lg border border-border p-1.5">
                    {teams.map((team) => {
                      const checked = selectedTeamIds.has(team.id);
                      return (
                        <label
                          key={team.id}
                          className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted"
                        >
                          <Checkbox
                            checked={checked}
                            onCheckedChange={(next) =>
                              toggleTeamSelection(team.id, next === true)
                            }
                          />
                          <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                            {team.name}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)} disabled={saving}>
              Cancelar
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Salvando…
                </>
              ) : editingTag ? (
                'Salvar alterações'
              ) : (
                'Criar tabulação'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Excluir tabulação</DialogTitle>
            <DialogDescription>
              Excluir &quot;{deleteTarget?.name}&quot;? Isso a remove de todas as{' '}
              {(teamIdsByTag.get(deleteTarget?.id ?? '') ?? []).length} equipe(s) vinculada(s) —
              não pode ser desfeito.
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
                  Excluindo...
                </>
              ) : (
                'Excluir tabulação'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>

      {/* Seção: Tabulação automática pela IA */}
      <AiOutcomeMapSection tabulacoes={tabulacoes} />
    </div>
  );
}
