'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import { toast } from 'sonner';
import { cn, normalizeForSearch } from '@/lib/utils';
import type { Contact, Tag, ContactTag } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Search,
  Plus,
  Upload,
  MoreHorizontal,
  Pencil,
  Trash2,
  Loader2,
  Users,
  ChevronLeft,
  ChevronRight,
  SlidersHorizontal,
  Filter,
  X,
} from 'lucide-react';
import { ContactForm } from '@/components/contacts/contact-form';
import { ContactDetailView } from '@/components/contacts/contact-detail-view';
import { ImportModal } from '@/components/contacts/import-modal';
import { CustomFieldsManager } from '@/components/contacts/custom-fields-manager';
import { usePermission } from '@/hooks/use-permission';
import { GatedButton } from '@/components/ui/gated-button';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { CountUp } from '@/components/motion/count-up';

const PAGE_SIZE = 25;

interface ContactWithTags extends Contact {
  tags?: Tag[];
}

export default function ContactsPage() {
  const supabase = createClient();
  const canEdit = usePermission('contacts.edit');
  const canEditSettings = usePermission('tags.manage');

  const [contacts, setContacts] = useState<ContactWithTags[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  // Tag filter — contacts shown must have ANY of these tags (OR).
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [tagFilterQuery, setTagFilterQuery] = useState('');

  // Modals
  const [formOpen, setFormOpen] = useState(false);
  const [editContact, setEditContact] = useState<Contact | null>(null);
  const [editContactTags, setEditContactTags] = useState<ContactTag[]>([]);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailContactId, setDetailContactId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [customFieldsOpen, setCustomFieldsOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Contact | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Bulk selection (page-scoped — only the loaded rows are selectable)
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  // All tags for display
  const [tagsMap, setTagsMap] = useState<Record<string, Tag>>({});

  // Guards against out-of-order fetch responses: each fetchContacts run
  // claims a sequence number and only the latest is allowed to commit its
  // results. Without this, rapidly toggling tag filters could let a slower
  // earlier request resolve last and render stale rows.
  const fetchSeq = useRef(0);

  const fetchTags = useCallback(async () => {
    const { data } = await supabase.from('tags').select('*');
    if (data) {
      const map: Record<string, Tag> = {};
      data.forEach((t) => (map[t.id] = t));
      setTagsMap(map);
      // Drop any filter selections whose tag no longer exists (e.g. a tag
      // deleted elsewhere) so it can't linger invisibly in the query.
      setSelectedTagIds((prev) => {
        const pruned = prev.filter((id) => map[id]);
        return pruned.length === prev.length ? prev : pruned;
      });
    }
  }, [supabase]);

  const fetchContacts = useCallback(async () => {
    const seq = ++fetchSeq.current;
    setLoading(true);
    // The visible rows are about to change — drop any selection that
    // referred to the old page/search results so the bulk bar can't
    // act on rows the user can no longer see.
    setSelected(new Set());

    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    const term = search.trim();

    let contactRows: Contact[];
    let count: number;

    if (selectedTagIds.length > 0) {
      // Tag filter active — resolve it server-side (join + distinct +
      // windowed total count + pagination) so a tag covering many
      // contacts can't silently truncate the result or overflow an IN
      // clause. See migration 025_filter_contacts_by_tags.
      const { data, error } = await supabase.rpc('filter_contacts_by_tags', {
        p_tag_ids: selectedTagIds,
        p_search: term || null,
        p_limit: PAGE_SIZE,
        p_offset: from,
      });
      if (seq !== fetchSeq.current) return; // superseded by a newer fetch
      if (error) {
        toast.error('Falha ao carregar contatos');
        setLoading(false);
        return;
      }
      const rows = (data ?? []) as { contact: Contact; total_count: number }[];
      contactRows = rows.map((r) => r.contact);
      count = rows.length > 0 ? Number(rows[0].total_count) : 0;
    } else {
      let query = supabase
        .from('contacts')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(from, to);

      if (term) {
        // PostgREST's .or() filter string treats "," "(" ")" as syntax
        // delimiters, so a raw search term could break out of the intended
        // ilike clauses and inject extra filter conditions. Wrapping the
        // value in double quotes (PostgREST's quoted-value syntax) makes
        // those characters literal — only a `"` or `\` inside the term
        // needs escaping first.
        const escaped = term.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const like = `%${escaped}%`;
        query = query.or(`name.ilike."${like}",phone.ilike."${like}",email.ilike."${like}"`);
      }

      const { data, count: exactCount, error } = await query;
      if (seq !== fetchSeq.current) return; // superseded by a newer fetch
      if (error) {
        toast.error('Falha ao carregar contatos');
        setLoading(false);
        return;
      }
      contactRows = data ?? [];
      count = exactCount ?? 0;
    }

    setTotalCount(count);

    if (contactRows.length === 0) {
      setContacts([]);
      setLoading(false);
      return;
    }

    // Fetch tags for these contacts
    const contactIds = contactRows.map((c) => c.id);
    const { data: contactTags } = await supabase
      .from('contact_tags')
      .select('contact_id, tag_id')
      .in('contact_id', contactIds);
    if (seq !== fetchSeq.current) return; // superseded by a newer fetch

    const tagsByContact: Record<string, string[]> = {};
    contactTags?.forEach((ct) => {
      if (!tagsByContact[ct.contact_id]) tagsByContact[ct.contact_id] = [];
      tagsByContact[ct.contact_id].push(ct.tag_id);
    });

    const enriched: ContactWithTags[] = contactRows.map((c) => ({
      ...c,
      tags: (tagsByContact[c.id] ?? [])
        .map((tid) => tagsMap[tid])
        .filter(Boolean),
    }));

    setContacts(enriched);
    setLoading(false);
  }, [supabase, page, search, selectedTagIds, tagsMap]);

  // Load-once-on-mount-ish data fetches. Each setter inside runs
  // inside an async promise completion (Supabase await), not
  // synchronously in the effect body, so the cascade the lint rule
  // warns about doesn't apply here.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchTags();
  }, [fetchTags]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchContacts();
  }, [fetchContacts]);

  function openAddForm() {
    setEditContact(null);
    setEditContactTags([]);
    setFormOpen(true);
  }

  async function openEditForm(contact: Contact) {
    const { data } = await supabase
      .from('contact_tags')
      .select('*')
      .eq('contact_id', contact.id);
    setEditContact(contact);
    setEditContactTags(data ?? []);
    setFormOpen(true);
  }

  function openDetail(contactId: string) {
    setDetailContactId(contactId);
    setDetailOpen(true);
  }

  function confirmDelete(contact: Contact) {
    setDeleteTarget(contact);
    setDeleteConfirmOpen(true);
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);

    const { error } = await supabase
      .from('contacts')
      .delete()
      .eq('id', deleteTarget.id);

    if (error) {
      toast.error('Falha ao excluir contato');
    } else {
      toast.success('Contato excluído');
      fetchContacts();
    }

    setDeleting(false);
    setDeleteConfirmOpen(false);
    setDeleteTarget(null);
  }

  const allOnPageSelected =
    contacts.length > 0 && contacts.every((c) => selected.has(c.id));
  const someOnPageSelected = contacts.some((c) => selected.has(c.id));

  function toggleSelectAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) {
        contacts.forEach((c) => next.delete(c.id));
      } else {
        contacts.forEach((c) => next.add(c.id));
      }
      return next;
    });
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleBulkDelete() {
    const ids = [...selected];
    if (ids.length === 0) return;
    setDeleting(true);

    const { error } = await supabase.from('contacts').delete().in('id', ids);

    if (error) {
      toast.error('Falha ao excluir contatos');
    } else {
      toast.success(`${ids.length} contato${ids.length === 1 ? '' : 's'} excluído${ids.length === 1 ? '' : 's'}`);
      setSelected(new Set());
      fetchContacts();
    }

    setDeleting(false);
    setBulkDeleteOpen(false);
  }

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const hasNext = page < totalPages - 1;
  const hasPrev = page > 0;

  // Tag filter helpers. Every change resets to page 0 — the result set
  // shrinks/grows so page N may no longer be valid (mirrors the search box).
  const allTags = Object.values(tagsMap).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  const filteredAllTags = useMemo(() => {
    const q = normalizeForSearch(tagFilterQuery.trim());
    if (!q) return allTags;
    return allTags.filter((tag) => normalizeForSearch(tag.name).includes(q));
  }, [allTags, tagFilterQuery]);
  const hasActiveFilters = search.trim().length > 0 || selectedTagIds.length > 0;

  function toggleTagFilter(tagId: string) {
    setSelectedTagIds((prev) =>
      prev.includes(tagId)
        ? prev.filter((id) => id !== tagId)
        : [...prev, tagId]
    );
    setPage(0);
  }

  function clearTagFilters() {
    setSelectedTagIds([]);
    setPage(0);
  }

  return (
    <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-3.5">
      {/* Cabeçalho da página (redesenho DDM): título em Poppins + resumo. */}
      <div className="flex flex-col gap-1.5 pt-1">
        <h2 className="font-heading text-[28px] font-semibold leading-tight tracking-[-0.025em] text-foreground">Contatos</h2>
        <p className="max-w-[620px] text-sm leading-relaxed text-muted-foreground">
          Gerencie sua lista de contatos.{' '}
          {totalCount > 0 && (
            <>
              <CountUp value={totalCount} className="font-medium text-foreground-2" /> contatos no total.
            </>
          )}
        </p>
      </div>

      {/* Barra: busca, etiquetas e ações */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative flex min-w-0 flex-[1_1_280px] items-center sm:max-w-[420px]">
          <Search className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground" aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              // Reset pagination when the query changes — the result
              // set shrinks/grows, page N may no longer be valid.
              setPage(0);
            }}
            placeholder="Buscar por nome, telefone ou e-mail"
            aria-label="Buscar contatos"
            className="h-[34px] w-full rounded-md border border-border bg-card pl-[34px] pr-2.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary focus:shadow-[0_0_0_3px_var(--primary-soft-2)]"
          />
        </label>

        <Popover onOpenChange={(next) => { if (!next) setTagFilterQuery(''); }}>
          <PopoverTrigger
            render={
              <button
                type="button"
                className={cn(
                  'flex h-8 shrink-0 items-center gap-1.5 rounded-md border bg-card px-3 text-[12.5px] font-medium hover:bg-surface-hover',
                  selectedTagIds.length > 0 ? 'border-primary-soft-2 text-primary-text' : 'border-border text-foreground',
                )}
              />
            }
          >
            <Filter className="size-3.5" aria-hidden="true" />
            Etiquetas
            {selectedTagIds.length > 0 && (
              <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10.5px] font-bold text-primary-foreground">
                {selectedTagIds.length}
              </span>
            )}
          </PopoverTrigger>
          <PopoverContent align="start" className="w-64 gap-0 p-0">
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <span className="text-[13px] font-semibold text-popover-foreground">Filtrar por etiquetas</span>
              {selectedTagIds.length > 0 && (
                <button onClick={clearTagFilters} className="text-xs font-semibold text-primary-text hover:underline">
                  Limpar
                </button>
              )}
            </div>
            {allTags.length === 0 ? (
              <p className="px-3 py-4 text-center text-sm text-muted-foreground">Nenhuma etiqueta ainda.</p>
            ) : (
              <>
                <div className="border-b border-border p-2">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={tagFilterQuery}
                      onChange={(e) => setTagFilterQuery(e.target.value)}
                      autoFocus
                      placeholder="Buscar etiquetas..."
                      aria-label="Buscar etiquetas"
                      className="h-8 pl-8 text-sm"
                    />
                  </div>
                </div>
                <div className="max-h-64 overflow-y-auto p-1.5">
                  {filteredAllTags.length === 0 ? (
                    <p className="px-3 py-4 text-center text-sm text-muted-foreground">Nenhuma etiqueta encontrada</p>
                  ) : (
                    filteredAllTags.map((tag) => (
                      <label
                        key={tag.id}
                        className="flex h-8 cursor-pointer items-center gap-2.5 rounded-md px-2 hover:bg-surface-hover"
                      >
                        <Checkbox
                          checked={selectedTagIds.includes(tag.id)}
                          onCheckedChange={() => toggleTagFilter(tag.id)}
                          aria-label={`Filtrar por ${tag.name}`}
                        />
                        <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: tag.color }} />
                        <span className="truncate text-[12.5px] text-popover-foreground">{tag.name}</span>
                      </label>
                    ))
                  )}
                </div>
              </>
            )}
          </PopoverContent>
        </Popover>

        <span className="hidden flex-1 sm:block" />

        {canEditSettings && (
          <Button variant="outline" onClick={() => setCustomFieldsOpen(true)} className="hidden sm:inline-flex">
            <SlidersHorizontal className="size-3.5" />
            Campos personalizados
          </Button>
        )}
        <GatedButton
          variant="outline"
          canAct={canEdit}
          gateReason="adicionar ou importar contatos"
          onClick={() => setImportOpen(true)}
        >
          <Upload className="size-3.5" />
          Importar
        </GatedButton>
        <GatedButton canAct={canEdit} gateReason="adicionar ou importar contatos" onClick={openAddForm}>
          <Plus className="size-3.5" />
          Adicionar contato
        </GatedButton>
      </div>

      {/* Etiquetas ativas */}
      {selectedTagIds.length > 0 && (
        <div className="flex animate-ddm-fade flex-wrap items-center gap-1.5">
          {selectedTagIds.map((id) => {
            const tag = tagsMap[id];
            if (!tag) return null;
            return (
              <button
                key={id}
                type="button"
                onClick={() => toggleTagFilter(id)}
                aria-label={`Remover filtro ${tag.name}`}
                className="inline-flex h-6 items-center gap-1.5 rounded-full border border-border bg-card pl-[9px] pr-1.5 text-xs text-foreground hover:bg-surface-hover"
              >
                <span className="size-[7px] rounded-full" style={{ backgroundColor: tag.color }} aria-hidden="true" />
                {tag.name}
                <X className="size-3 text-muted-foreground" aria-hidden="true" />
              </button>
            );
          })}
          <button onClick={clearTagFilters} className="px-1 text-xs font-semibold text-primary-text hover:underline">
            Limpar
          </button>
        </div>
      )}

      {/* Barra de seleção em massa (contraste invertido, como no protótipo) */}
      {selected.size > 0 && (
        <div className="flex animate-ddm-up flex-wrap items-center gap-2.5 rounded-[10px] bg-foreground py-2 pl-4 pr-2.5 text-background">
          <span className="text-[13px] font-semibold">
            {selected.size} {selected.size === 1 ? 'contato selecionado' : 'contatos selecionados'}
          </span>
          <span className="flex-1" />
          <GatedButton
            variant="destructive"
            size="sm"
            canAct={canEdit}
            gateReason="excluir contatos"
            onClick={() => setBulkDeleteOpen(true)}
            className="bg-[#d8362f] text-white hover:bg-[#c42b24]"
          >
            <Trash2 className="size-3.5" />
            Excluir
          </GatedButton>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="h-[30px] rounded-md px-2.5 text-[12.5px] opacity-80 hover:opacity-100"
          >
            Limpar
          </button>
        </div>
      )}

      {/* Tabela */}
      <section className="overflow-hidden rounded-[10px] border border-border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="bg-card-2">
                <th className="w-11 border-b border-border pl-4">
                  <Checkbox
                    checked={allOnPageSelected}
                    indeterminate={!allOnPageSelected && someOnPageSelected}
                    onCheckedChange={toggleSelectAll}
                    disabled={contacts.length === 0}
                    aria-label="Selecionar todos os contatos desta página"
                  />
                </th>
                <th className="border-b border-border px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">Nome</th>
                <th className="hidden border-b border-border px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground sm:table-cell">Telefone</th>
                <th className="hidden border-b border-border px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground lg:table-cell">E-mail</th>
                <th className="hidden border-b border-border px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground xl:table-cell">Instituição</th>
                <th className="hidden border-b border-border px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground md:table-cell">Etiquetas</th>
                <th className="hidden border-b border-border px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground xl:table-cell">Criado em</th>
                <th className="w-11 border-b border-border" />
              </tr>
            </thead>
            <tbody className={loading ? undefined : 'ddm-stagger'}>
              {loading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i} aria-hidden="true">
                    <td className="border-b border-border py-3 pl-4"><Skeleton className="size-[18px] rounded-[5px]" /></td>
                    <td className="border-b border-border px-3 py-2.5">
                      <span className="flex items-center gap-2.5">
                        <Skeleton className="size-[30px] rounded-full" />
                        <Skeleton className="h-3 w-40" />
                      </span>
                    </td>
                    <td className="hidden border-b border-border px-3 sm:table-cell"><Skeleton className="h-3 w-28" /></td>
                    <td className="hidden border-b border-border px-3 lg:table-cell"><Skeleton className="h-3 w-36" /></td>
                    <td className="hidden border-b border-border px-3 xl:table-cell"><Skeleton className="h-3 w-24" /></td>
                    <td className="hidden border-b border-border px-3 md:table-cell"><Skeleton className="h-4 w-20 rounded-full" /></td>
                    <td className="hidden border-b border-border px-3 xl:table-cell"><Skeleton className="h-3 w-20" /></td>
                    <td className="border-b border-border" />
                  </tr>
                ))
              ) : contacts.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-12">
                    <div className="flex animate-ddm-fade flex-col items-center gap-1.5 text-center">
                      <Users className="size-5 text-muted-foreground" aria-hidden="true" />
                      <p className="text-[13.5px] font-semibold text-foreground">
                        {hasActiveFilters ? 'Nenhum contato encontrado' : 'Nenhum contato ainda'}
                      </p>
                      <p className="text-[12.5px] text-muted-foreground">
                        {hasActiveFilters ? 'Ajuste a busca ou limpe os filtros.' : 'Adicione um contato ou importe uma planilha.'}
                      </p>
                      {!hasActiveFilters && canEdit && (
                        <Button variant="outline" size="sm" onClick={openAddForm} className="mt-1.5">
                          <Plus className="size-3.5" />
                          Adicionar o primeiro contato
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ) : (
                contacts.map((contact) => {
                  const on = selected.has(contact.id);
                  const name = contact.name || contact.phone || 'Sem nome';
                  return (
                    <tr
                      key={contact.id}
                      onClick={() => openDetail(contact.id)}
                      className={cn(
                        'group cursor-pointer hover:bg-surface-hover hover:shadow-[inset_2px_0_0_var(--primary)]',
                        on && 'bg-selected',
                      )}
                    >
                      <td className="border-b border-border pl-4" onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={on}
                          onCheckedChange={() => toggleSelect(contact.id)}
                          aria-label={`Selecionar ${name}`}
                        />
                      </td>
                      <td className="border-b border-border px-3 py-2.5">
                        <span className="flex min-w-0 items-center gap-2.5">
                          <span
                            className="flex size-[30px] shrink-0 items-center justify-center rounded-full bg-card-2 text-[11.5px] font-semibold text-foreground-2"
                            aria-hidden="true"
                          >
                            {contactInitials(name)}
                          </span>
                          <span className="flex min-w-0 flex-col">
                            <span className={cn('truncate font-semibold', contact.name ? 'text-foreground' : 'italic text-muted-foreground')}>
                              {contact.name || 'Sem nome'}
                            </span>
                            <span className="truncate text-xs tabular-nums text-muted-foreground sm:hidden">{contact.phone}</span>
                          </span>
                        </span>
                      </td>
                      <td className="hidden whitespace-nowrap border-b border-border px-3 py-2.5 tabular-nums text-foreground sm:table-cell">
                        {contact.phone}
                      </td>
                      <td className="hidden max-w-[240px] truncate border-b border-border px-3 py-2.5 text-foreground-2 lg:table-cell">
                        {contact.email || <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="hidden whitespace-nowrap border-b border-border px-3 py-2.5 text-foreground xl:table-cell">
                        {contact.instituicao || contact.company || <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="hidden border-b border-border px-3 py-2.5 md:table-cell">
                        <span className="flex flex-nowrap items-center gap-1">
                          {contact.tags && contact.tags.length > 0 ? (
                            contact.tags.slice(0, 2).map((tag) => (
                              <span
                                key={tag.id}
                                className="inline-flex h-[22px] max-w-[140px] items-center gap-[5px] rounded-full bg-card-2 px-2 text-[11.5px] text-foreground"
                              >
                                <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: tag.color }} aria-hidden="true" />
                                <span className="truncate">{tag.name}</span>
                              </span>
                            ))
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                          {contact.tags && contact.tags.length > 2 && (
                            <span className="text-[11px] text-muted-foreground">+{contact.tags.length - 2}</span>
                          )}
                        </span>
                      </td>
                      <td className="hidden whitespace-nowrap border-b border-border px-3 py-2.5 tabular-nums text-muted-foreground xl:table-cell">
                        {new Date(contact.created_at).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' })}
                      </td>
                      <td className="border-b border-border pr-2 text-right" onClick={(e) => e.stopPropagation()}>
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                className="text-muted-foreground hover:text-foreground"
                                aria-label={`Ações de ${name}`}
                              />
                            }
                          >
                            <MoreHorizontal className="size-4" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => openDetail(contact.id)}>
                              <ChevronRight className="size-4" />
                              Abrir
                            </DropdownMenuItem>
                            {canEdit && (
                              <>
                                <DropdownMenuItem onClick={() => openEditForm(contact)}>
                                  <Pencil className="size-4" />
                                  Editar
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem variant="destructive" onClick={() => confirmDelete(contact)}>
                                  <Trash2 className="size-4" />
                                  Excluir
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Rodapé com a paginação (sempre visível quando há contatos) */}
        {!loading && totalCount > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2.5 border-t border-border px-4 py-2.5 text-[12.5px] text-foreground-2">
            <span className="tabular-nums">
              {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, totalCount)} de {totalCount.toLocaleString('pt-BR')}
            </span>
            {totalPages > 1 && (
              <div className="flex items-center gap-1.5">
                <Button variant="outline" size="sm" disabled={!hasPrev} onClick={() => setPage((p) => p - 1)}>
                  <ChevronLeft className="size-3.5" />
                  Anterior
                </Button>
                <span className="px-1 tabular-nums text-muted-foreground">
                  {page + 1}/{totalPages}
                </span>
                <Button variant="outline" size="sm" disabled={!hasNext} onClick={() => setPage((p) => p + 1)}>
                  Próxima
                  <ChevronRight className="size-3.5" />
                </Button>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Contact Form Dialog */}
      <ContactForm
        open={formOpen}
        onOpenChange={setFormOpen}
        contact={editContact}
        contactTags={editContactTags}
        onSaved={() => {
          fetchContacts();
          fetchTags();
        }}
        onViewExisting={(id) => {
          setFormOpen(false);
          openDetail(id);
        }}
      />

      {/* Contact Detail Sheet */}
      {/* key força remount completo ao trocar de contato — zera todo o
          state (tabs, fetches em voo) em vez de reaproveitar a mesma
          instância, que é o que permitia dados do contato anterior
          vazarem por cima do novo numa troca rápida. */}
      <ContactDetailView
        key={detailContactId ?? 'none'}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        contactId={detailContactId}
        onUpdated={fetchContacts}
      />

      {/* Import Modal */}
      <ImportModal
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={fetchContacts}
      />

      {/* Custom Fields Manager (admin+) */}
      {canEditSettings && (
        <CustomFieldsManager
          open={customFieldsOpen}
          onOpenChange={setCustomFieldsOpen}
        />
      )}

      {/* Delete Confirmation */}
      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">Excluir Contato</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Tem certeza que deseja excluir{' '}
              <span className="text-popover-foreground font-medium">
                {deleteTarget?.name || deleteTarget?.phone}
              </span>
              ? Esta ação não pode ser desfeita.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setDeleteConfirmOpen(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              Cancelar
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting && <Loader2 className="size-4 animate-spin" />}
              Excluir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Delete Confirmation */}
      <Dialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              Excluir {selected.size} {selected.size === 1 ? 'Contato' : 'Contatos'}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Tem certeza que deseja excluir{' '}
              <span className="text-popover-foreground font-medium">
                {selected.size} {selected.size === 1 ? 'contato' : 'contatos'}
              </span>
              ? Esta ação não pode ser desfeita.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setBulkDeleteOpen(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              Cancelar
            </Button>
            <Button
              variant="destructive"
              onClick={handleBulkDelete}
              disabled={deleting}
            >
              {deleting && <Loader2 className="size-4 animate-spin" />}
              Excluir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Iniciais do avatar da lista (primeiro + último nome), como no protótipo. */
function contactInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? '' : '';
  return ((parts[0][0] ?? '') + last).toUpperCase();
}
