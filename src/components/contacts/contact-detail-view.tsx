'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Skeleton } from '@/components/ui/skeleton';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { PageBody } from '@/components/ddm/page-toolbar';
import { Segmented } from '@/components/ddm/segmented';
import { StatusChip, type StatusTone } from '@/components/ddm/status-chip';
import { ContactActivityFeed, ContactCampaignsList } from '@/components/contacts/contact-history-tabs';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { formatCurrency } from '@/lib/currency';
import { toast } from 'sonner';
import type { Contact, Tag, ContactNote, CustomField, Deal, MessageTemplate } from '@/types';
import {
  TemplatePicker,
  type TemplateSendValues,
} from '@/components/inbox/template-picker';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  Phone,
  Mail,
  Building2,
  Copy,
  Check,
  Loader2,
  Plus,
  Trash2,
  Save,
  X,
  Pencil,
  DollarSign,
  LayoutTemplate,
  MessageSquare,
  ArrowLeft,
  ChevronRight,
} from 'lucide-react';
import { normalizeForSearch } from '@/lib/utils';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';
import {
  TagPickerBox,
  useTagButtonRefs,
  focusFirstTagButton,
  makeTagButtonKeyDownHandler,
} from '@/components/contacts/tag-picker-box';

interface ContactDetailViewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contactId: string | null;
  onUpdated: () => void;
  /** 'sheet' (padrão) = gaveta da lista; 'page' = tela /contacts/[id]. */
  variant?: 'sheet' | 'page';
}

// wacrm.contact_phones (migrations 077/086) — TELEFONE2/3+ de um contato.
// TELEFONE1 é sempre contacts.phone e nunca aparece nesta tabela.
interface ContactPhone {
  id: string;
  contact_id: string;
  phone: string;
  phone_normalized: string;
  ordem: number;
  status: 'ativo' | 'invalido' | 'respondeu';
  last_attempt_at: string | null;
  label: string | null;
  created_at: string;
}

const PHONE_STATUS_BADGE: Record<
  ContactPhone['status'],
  { label: string; tone: StatusTone }
> = {
  ativo: { label: 'Ativo', tone: 'mute' },
  invalido: { label: 'Inválido', tone: 'bad' },
  respondeu: { label: 'Respondeu', tone: 'ok' },
};

// Mesmo padrão de src/app/api/disparador/contacts/import/route.ts:
// remove tudo que não é dígito e prefixa 55 se o número não trouxer
// código de país — mantém contact_phones.phone no mesmo formato usado
// pelo import/envio em massa.
function formatBrazilianPhone(raw: string): string {
  const cleaned = raw.replace(/\D/g, '');
  if (!cleaned) return '';
  if (cleaned.startsWith('55')) return `+${cleaned}`;
  return `+55${cleaned}`;
}

const CPF_DIGITS_LENGTH = 11;

function onlyDigits(value: string): string {
  return value.replace(/\D/g, '');
}

// Mascara progressiva 000.000.000-00 — não usa regex de substituição única
// pra não depender do CPF estar completo (funciona enquanto o usuário digita).
function formatCpf(value: string): string {
  const d = onlyDigits(value).slice(0, CPF_DIGITS_LENGTH);
  let out = d.slice(0, 3);
  if (d.length > 3) out += `.${d.slice(3, 6)}`;
  if (d.length > 6) out += `.${d.slice(6, 9)}`;
  if (d.length > 9) out += `-${d.slice(9, 11)}`;
  return out;
}

// var_index em wacrm.contact_import_variables (migration 079):
// 0 = VAR1, 1 = VAR2, 2 = VAR3. Rótulos fixos do domínio DDM (cobrança
// educacional) — somente leitura no painel, nunca editados aqui.
const CSV_VAR_LABELS: Record<number, string> = {
  0: 'Nome do Devedor',
  1: 'Instituição de Ensino',
  2: 'Link de Acordo',
};
const CSV_VAR_INDICES = [0, 1, 2];

export function ContactDetailView({
  open,
  onOpenChange,
  contactId,
  onUpdated,
  variant = 'sheet',
}: ContactDetailViewProps) {
  const supabase = createClient();
  const router = useRouter();
  const { accountId, defaultCurrency, user } = useAuth();

  const [contact, setContact] = useState<Contact | null>(null);
  // Começa carregando: a página não pode piscar "não encontrado" antes do
  // primeiro fetch (a gaveta já mostra spinner enquanto não há contato).
  const [loading, setLoading] = useState(true);
  const [pageTab, setPageTab] = useState<'activity' | 'deals' | 'campaigns' | 'notes'>('activity');
  const [copiedPhone, setCopiedPhone] = useState(false);
  const [phoneToRemove, setPhoneToRemove] = useState<string | null>(null);

  // Send template — lets the business initiate (or re-open) a conversation
  // with this contact by sending an approved template. The send route
  // find-or-creates the conversation, so no inbound message is required.
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [sendingTemplate, setSendingTemplate] = useState(false);
  const [loadingChat, setLoadingChat] = useState(false);

  const handleGoToChat = async () => {
    if (!contact || !accountId) return;
    setLoadingChat(true);
    try {
      // 1. Check if a conversation already exists
      const { data: existing, error: fetchErr } = await supabase
        .from('conversations')
        .select('id')
        .eq('account_id', accountId)
        .eq('contact_id', contact.id)
        .maybeSingle();

      if (fetchErr) throw fetchErr;

      if (existing) {
        router.push(`/inbox?c=${existing.id}`);
        onOpenChange(false);
        return;
      }

      // 2. If it does not exist, check if there is an active WAHA session configured
      const { data: configs } = await supabase
        .from('whatsapp_config')
        .select('provider, waha_session')
        .eq('account_id', accountId);

      const wahaConfig = configs?.find((c) => c.provider === 'waha');

      // 3. Create a new conversation
      const insertData: Record<string, any> = {
        account_id: accountId,
        contact_id: contact.id,
        status: 'open',
        unread_count: 0,
        user_id: user?.id || null,
      };

      if (wahaConfig?.waha_session) {
        insertData.waha_session = wahaConfig.waha_session;
      }

      const { data: created, error: createErr } = await supabase
        .from('conversations')
        .insert(insertData)
        .select('id')
        .single();

      if (createErr) throw createErr;

      if (created) {
        router.push(`/inbox?c=${created.id}`);
        onOpenChange(false);
      }
    } catch (err: any) {
      console.error('Error going to chat:', err);
      toast.error('Erro ao abrir conversa: ' + (err.message || err));
    } finally {
      setLoadingChat(false);
    }
  };

  // Details tab
  const [editName, setEditName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editCompany, setEditCompany] = useState('');
  // editCpf guarda só dígitos — a máscara 000.000.000-00 é aplicada na
  // exibição (formatCpf), nunca persistida no state.
  const [editCpf, setEditCpf] = useState('');
  const [editInstituicao, setEditInstituicao] = useState('');
  const [savingDetails, setSavingDetails] = useState(false);
  // VAR1/VAR2/VAR3 do CSV importado (wacrm.contact_import_variables) —
  // somente leitura, carregadas junto com o contato em fetchContact().
  const [csvVars, setCsvVars] = useState<Record<number, string>>({});
  const [loadingCsvVars, setLoadingCsvVars] = useState(false);

  // Tags tab
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [contactTagIds, setContactTagIds] = useState<string[]>([]);
  const [savingTags, setSavingTags] = useState(false);
  const [tagQuery, setTagQuery] = useState('');
  const tagSearchRef = useRef<HTMLInputElement>(null);
  const tagButtonRefs = useTagButtonRefs();
  const filteredTags = useMemo(() => {
    const q = normalizeForSearch(tagQuery.trim());
    if (!q) return allTags;
    return allTags.filter((tag) => normalizeForSearch(tag.name).includes(q));
  }, [allTags, tagQuery]);

  // Notes tab
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [newNote, setNewNote] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [loadingNotes, setLoadingNotes] = useState(false);

  // Custom fields tab
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [customValues, setCustomValues] = useState<Record<string, string>>({});
  const [savingCustom, setSavingCustom] = useState(false);
  const [loadingCustom, setLoadingCustom] = useState(false);

  // Deals tab
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loadingDeals, setLoadingDeals] = useState(false);

  // Phones tab (TELEFONE2/3+ — wacrm.contact_phones)
  const [phones, setPhones] = useState<ContactPhone[]>([]);
  const [loadingPhones, setLoadingPhones] = useState(false);
  const [newPhoneNumber, setNewPhoneNumber] = useState('');
  const [newPhoneLabel, setNewPhoneLabel] = useState('');
  const [addingPhone, setAddingPhone] = useState(false);
  const [editingPhoneId, setEditingPhoneId] = useState<string | null>(null);
  const [editPhoneNumber, setEditPhoneNumber] = useState('');
  const [editPhoneLabel, setEditPhoneLabel] = useState('');
  const [savingPhoneEdit, setSavingPhoneEdit] = useState(false);
  const [deletingPhoneId, setDeletingPhoneId] = useState<string | null>(null);

  const fetchContact = useCallback(async (isCancelled: () => boolean = () => false) => {
    if (!contactId) return;
    setLoading(true);
    setLoadingCsvVars(true);

    const [{ data }, { data: csvVarRows }] = await Promise.all([
      supabase.from('contacts').select('*').eq('id', contactId).single(),
      supabase
        .from('contact_import_variables')
        .select('var_index, value, created_at')
        .eq('contact_id', contactId)
        .order('created_at', { ascending: false }),
    ]);

    if (isCancelled()) return;

    if (data) {
      setContact(data);
      setEditName(data.name ?? '');
      setEditPhone(data.phone);
      setEditEmail(data.email ?? '');
      setEditCompany(data.company ?? '');
      setEditCpf(onlyDigits(data.cpf ?? ''));
      setEditInstituicao(data.instituicao ?? '');
    }

    // Um contato pode ter mais de uma linha por var_index — a constraint
    // única é por (contact_id, campaign_id, var_index) ou (contact_id,
    // draft_id, var_index), não global (migration 079), então o mesmo
    // contato importado em campanhas diferentes gera linhas diferentes.
    // Já veio ordenado por created_at desc, então a primeira ocorrência de
    // cada var_index é a mais recente.
    const latestByIndex: Record<number, string> = {};
    for (const row of csvVarRows ?? []) {
      if (!(row.var_index in latestByIndex)) {
        latestByIndex[row.var_index] = row.value;
      }
    }
    setCsvVars(latestByIndex);

    setLoading(false);
    setLoadingCsvVars(false);
  }, [contactId, supabase]);

  const fetchTags = useCallback(async (isCancelled: () => boolean = () => false) => {
    if (!contactId) return;

    const [tagsRes, contactTagsRes] = await Promise.all([
      supabase.from('tags').select('*').order('name'),
      supabase.from('contact_tags').select('tag_id').eq('contact_id', contactId),
    ]);

    if (isCancelled()) return;

    if (tagsRes.data) setAllTags(tagsRes.data);
    if (contactTagsRes.data) {
      setContactTagIds(contactTagsRes.data.map((ct) => ct.tag_id));
    }
  }, [contactId, supabase]);

  const fetchNotes = useCallback(async (isCancelled: () => boolean = () => false) => {
    if (!contactId) return;
    setLoadingNotes(true);

    const { data } = await supabase
      .from('contact_notes')
      .select('*')
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false });

    if (isCancelled()) return;

    if (data) setNotes(data);
    setLoadingNotes(false);
  }, [contactId, supabase]);

  const fetchCustomFields = useCallback(async (isCancelled: () => boolean = () => false) => {
    if (!contactId) return;
    setLoadingCustom(true);

    const [fieldsRes, valuesRes] = await Promise.all([
      supabase.from('custom_fields').select('*').order('field_name'),
      supabase
        .from('contact_custom_values')
        .select('*')
        .eq('contact_id', contactId),
    ]);

    if (isCancelled()) return;

    if (fieldsRes.data) setCustomFields(fieldsRes.data);
    if (valuesRes.data) {
      const map: Record<string, string> = {};
      valuesRes.data.forEach((v) => {
        map[v.custom_field_id] = v.value ?? '';
      });
      setCustomValues(map);
    }
    setLoadingCustom(false);
  }, [contactId, supabase]);

  const fetchDeals = useCallback(async (isCancelled: () => boolean = () => false) => {
    if (!contactId) return;
    setLoadingDeals(true);
    const { data } = await supabase
      .from('deals')
      .select('*, stage:pipeline_stages(*)')
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false });

    if (isCancelled()) return;

    setDeals((data ?? []) as Deal[]);
    setLoadingDeals(false);
  }, [contactId, supabase]);

  const fetchPhones = useCallback(async (isCancelled: () => boolean = () => false) => {
    if (!contactId) return;
    setLoadingPhones(true);
    const { data } = await supabase
      .from('contact_phones')
      .select('*')
      .eq('contact_id', contactId)
      .order('ordem', { ascending: true });

    if (isCancelled()) return;

    setPhones((data ?? []) as ContactPhone[]);
    setLoadingPhones(false);
  }, [contactId, supabase]);

  // Guard defensivo contra a troca rápida de contato: o remount via
  // key={contactId} no pai (contacts/page.tsx) já é a correção
  // principal (zera o state inteiro), mas entre o clique em outro
  // contato e o React efetivamente desmontar essa instância ainda cabe
  // um setState de um fetch em voo do contato anterior. `cancelled`
  // fecha essa janela: nenhum dos 6 fetches aplica seu resultado depois
  // que este efeito for limpo (troca de contactId/open, ou unmount).
  // Mesmo padrão de src/components/inbox/message-thread.tsx:363-397.
  useEffect(() => {
    if (open && contactId) {
      let cancelled = false;
      const isCancelled = () => cancelled;

      fetchContact(isCancelled);
      fetchTags(isCancelled);
      fetchNotes(isCancelled);
      fetchCustomFields(isCancelled);
      fetchDeals(isCancelled);
      fetchPhones(isCancelled);
      setTagQuery('');

      return () => {
        cancelled = true;
      };
    }
  }, [open, contactId, fetchContact, fetchTags, fetchNotes, fetchCustomFields, fetchDeals, fetchPhones]);

  async function copyPhone() {
    if (!contact?.phone) return;
    await navigator.clipboard.writeText(contact.phone);
    setCopiedPhone(true);
    setTimeout(() => setCopiedPhone(false), 2000);
  }

  async function saveDetails() {
    if (!contactId || !editPhone.trim()) {
      toast.error('Número de telefone é obrigatório');
      return;
    }

    setSavingDetails(true);
    const { error } = await supabase
      .from('contacts')
      .update({
        name: editName.trim() || null,
        phone: editPhone.trim(),
        // email/company não têm mais input nesta aba, mas seguem no
        // UPDATE com o valor carregado de fetchContact — não pode zerar
        // dado de contato que já tinha isso preenchido antes desta mudança.
        email: editEmail.trim() || null,
        company: editCompany.trim() || null,
        cpf: onlyDigits(editCpf) || null,
        instituicao: editInstituicao.trim() || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', contactId);

    if (error) {
      toast.error('Falha ao atualizar contato');
    } else {
      toast.success('Contato atualizado');
      fetchContact();
      onUpdated();
    }
    setSavingDetails(false);
  }

  async function addPhone() {
    if (!contactId || !newPhoneNumber.trim()) return;
    const formatted = formatBrazilianPhone(newPhoneNumber);
    const normalized = normalizePhone(formatted);
    if (!normalized) {
      toast.error('Número de telefone inválido');
      return;
    }

    setAddingPhone(true);
    // Próxima ordem: MAX(ordem)+1 entre os telefones alternativos já
    // cadastrados, com piso 2 (ordem 1 é sempre contacts.phone, nunca
    // gravado em contact_phones).
    const nextOrdem =
      phones.length > 0 ? Math.max(...phones.map((p) => p.ordem)) + 1 : 2;

    const { error } = await supabase.from('contact_phones').insert({
      contact_id: contactId,
      phone: formatted,
      phone_normalized: normalized,
      ordem: nextOrdem,
      label: newPhoneLabel.trim() || null,
    });

    if (error) {
      toast.error('Falha ao adicionar telefone');
    } else {
      toast.success('Telefone adicionado');
      setNewPhoneNumber('');
      setNewPhoneLabel('');
      fetchPhones();
    }
    setAddingPhone(false);
  }

  function startEditPhone(phone: ContactPhone) {
    setEditingPhoneId(phone.id);
    setEditPhoneNumber(phone.phone);
    setEditPhoneLabel(phone.label ?? '');
  }

  function cancelEditPhone() {
    setEditingPhoneId(null);
    setEditPhoneNumber('');
    setEditPhoneLabel('');
  }

  async function saveEditPhone() {
    if (!editingPhoneId || !editPhoneNumber.trim()) return;
    const formatted = formatBrazilianPhone(editPhoneNumber);
    const normalized = normalizePhone(formatted);
    if (!normalized) {
      toast.error('Número de telefone inválido');
      return;
    }

    setSavingPhoneEdit(true);
    const { error } = await supabase
      .from('contact_phones')
      .update({
        phone: formatted,
        phone_normalized: normalized,
        label: editPhoneLabel.trim() || null,
      })
      .eq('id', editingPhoneId);

    if (error) {
      toast.error('Falha ao atualizar telefone');
    } else {
      toast.success('Telefone atualizado');
      cancelEditPhone();
      fetchPhones();
    }
    setSavingPhoneEdit(false);
  }

  async function deletePhone(phoneId: string) {
    setDeletingPhoneId(phoneId);
    const { error } = await supabase
      .from('contact_phones')
      .delete()
      .eq('id', phoneId);

    if (error) {
      toast.error('Falha ao remover telefone');
    } else {
      setPhones((prev) => prev.filter((p) => p.id !== phoneId));
      toast.success('Telefone removido');
    }
    setDeletingPhoneId(null);
  }

  async function toggleTag(tagId: string) {
    if (!contactId) return;
    setSavingTags(true);

    const isSelected = contactTagIds.includes(tagId);

    if (isSelected) {
      const { error } = await supabase
        .from('contact_tags')
        .delete()
        .eq('contact_id', contactId)
        .eq('tag_id', tagId);
      if (!error) {
        setContactTagIds((prev) => prev.filter((id) => id !== tagId));
        onUpdated();
      }
    } else {
      const { error } = await supabase
        .from('contact_tags')
        .insert({ contact_id: contactId, tag_id: tagId });
      if (!error) {
        setContactTagIds((prev) => [...prev, tagId]);
        onUpdated();
      }
    }
    setSavingTags(false);
  }

  async function addNote() {
    if (!contactId || !newNote.trim()) return;
    setSavingNote(true);

    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user || !accountId) {
      toast.error('Não autenticado');
      setSavingNote(false);
      return;
    }

    const { error } = await supabase.from('contact_notes').insert({
      contact_id: contactId,
      account_id: accountId,
      user_id: user.id,
      note_text: newNote.trim(),
    });

    if (error) {
      toast.error('Falha ao adicionar nota');
    } else {
      setNewNote('');
      fetchNotes();
      toast.success('Nota adicionada');
    }
    setSavingNote(false);
  }

  async function deleteNote(noteId: string) {
    const { error } = await supabase
      .from('contact_notes')
      .delete()
      .eq('id', noteId);

    if (error) {
      toast.error('Falha ao excluir nota');
    } else {
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
      toast.success('Nota excluída');
    }
  }

  async function saveCustomFields() {
    if (!contactId) return;
    setSavingCustom(true);

    try {
      // Delete existing values and re-insert
      await supabase
        .from('contact_custom_values')
        .delete()
        .eq('contact_id', contactId);

      const rows = Object.entries(customValues)
        .filter(([, val]) => val.trim())
        .map(([fieldId, val]) => ({
          contact_id: contactId,
          custom_field_id: fieldId,
          value: val.trim(),
        }));

      if (rows.length > 0) {
        const { error } = await supabase
          .from('contact_custom_values')
          .insert(rows);
        if (error) throw error;
      }

      toast.success('Campos personalizados salvos');
    } catch {
      toast.error('Falha ao salvar campos personalizados');
    }
    setSavingCustom(false);
  }

  async function handleSendTemplate(
    template: MessageTemplate,
    values: TemplateSendValues,
  ) {
    if (!contactId) return;
    setSendingTemplate(true);
    try {
      const res = await fetch('/api/whatsapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // No conversation_id — the route find-or-creates one for this
          // contact, mirroring the inbox template-send payload otherwise.
          contact_id: contactId,
          message_type: 'template',
          template_name: template.name,
          template_language: template.language,
          template_message_params: {
            body: values.body,
            headerText: values.headerText,
            buttonParams: values.buttonParams,
          },
          template_params: values.body,
        }),
      });

      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        const reason = payload?.error || `HTTP ${res.status}`;
        toast.error(`Falha ao enviar template: ${reason}`);
        return;
      }

      toast.success(`Template "${template.name}" enviado`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'erro de rede';
      toast.error(`Falha ao enviar template: ${reason}`);
    } finally {
      setSendingTemplate(false);
    }
  }

  function getInitials(name?: string | null) {
    if (!name) return '?';
    return name
      .split(' ')
      .map((w) => w[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  }

  // ---- Seções (reaproveitadas pela gaveta e pela página /contacts/[id]) ----
  // Só são chamadas com `contact` carregado.

  const fieldInput = 'bg-card border-border text-foreground h-8 text-sm placeholder:text-muted-foreground';

  const renderDetails = () => (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label className="text-muted-foreground text-xs">Nome</Label>
        <Input value={editName} onChange={(e) => setEditName(e.target.value)} className={fieldInput} />
      </div>
      <div className="space-y-1.5">
        <Label className="text-muted-foreground text-xs">
          Telefone <span className="text-danger">*</span>
        </Label>
        <Input value={editPhone} onChange={(e) => setEditPhone(e.target.value)} className={fieldInput} />
      </div>
      <div className="space-y-1.5">
        <Label className="text-muted-foreground text-xs">CPF</Label>
        <Input
          value={formatCpf(editCpf)}
          onChange={(e) => setEditCpf(onlyDigits(e.target.value).slice(0, CPF_DIGITS_LENGTH))}
          placeholder="000.000.000-00"
          inputMode="numeric"
          className={fieldInput}
        />
      </div>
      <div className="space-y-1.5">
        <Label className="text-muted-foreground text-xs">Instituição</Label>
        <Input value={editInstituicao} onChange={(e) => setEditInstituicao(e.target.value)} className={fieldInput} />
      </div>

      <div className="space-y-1.5 pt-2 border-t border-border">
        <Label className="text-muted-foreground text-xs">Dados do CSV importado</Label>
      </div>
      {CSV_VAR_INDICES.map((idx) => (
        <div key={idx} className="space-y-1.5">
          <Label className="text-muted-foreground text-xs">{CSV_VAR_LABELS[idx]}</Label>
          <Input
            value={loadingCsvVars ? '' : csvVars[idx] ?? ''}
            readOnly
            disabled
            placeholder={loadingCsvVars ? 'Carregando...' : '—'}
            className="bg-surface-3 border-border text-muted-foreground h-8 text-sm"
          />
        </div>
      ))}

      <Button onClick={saveDetails} disabled={savingDetails} className="w-full" size="sm">
        {savingDetails ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
        Salvar Alterações
      </Button>
    </div>
  );

  const renderPhones = (c: Contact) => (
    <div className="space-y-4">
      {/* Seção 1 — telefone principal (contacts.phone / TELEFONE1) */}
      <div className="space-y-1.5">
        <Label className="text-muted-foreground text-xs">Telefone principal</Label>
        <div className="flex items-center gap-2 rounded-lg bg-surface-3 border border-border px-3 py-2">
          <span className="text-sm text-foreground flex-1 tabular-nums">{c.phone}</span>
          <StatusChip tone="brand" dot={false}>Principal</StatusChip>
        </div>
        <p className="text-xs text-muted-foreground">
          {variant === 'page' ? 'Editável em Dados.' : 'Editável na aba Detalhes.'}
        </p>
      </div>

      {/* Seção 2 — telefones alternativos (contact_phones) */}
      <div className="space-y-1.5 pt-2 border-t border-border">
        <Label className="text-muted-foreground text-xs">Telefones alternativos</Label>

        {loadingPhones ? (
          <div className="space-y-2" aria-busy="true">
            <Skeleton className="h-12 w-full rounded-lg" />
          </div>
        ) : phones.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">Nenhum telefone alternativo cadastrado.</p>
        ) : (
          <div className="space-y-2">
            {phones.map((phone) => {
              const badge = PHONE_STATUS_BADGE[phone.status];
              const isEditing = editingPhoneId === phone.id;
              return (
                <div key={phone.id} className="rounded-lg bg-surface-3 border border-border p-3 group">
                  {isEditing ? (
                    <div className="space-y-2">
                      <Input
                        value={editPhoneNumber}
                        onChange={(e) => setEditPhoneNumber(e.target.value)}
                        placeholder="Número"
                        className={fieldInput}
                      />
                      <Input
                        value={editPhoneLabel}
                        onChange={(e) => setEditPhoneLabel(e.target.value)}
                        placeholder="Rótulo (opcional)"
                        className={fieldInput}
                      />
                      <div className="flex items-center gap-2">
                        <Button onClick={saveEditPhone} disabled={savingPhoneEdit || !editPhoneNumber.trim()} size="sm">
                          {savingPhoneEdit ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                          Salvar
                        </Button>
                        <Button onClick={cancelEditPhone} disabled={savingPhoneEdit} size="sm" variant="outline">
                          <X className="size-3.5" />
                          Cancelar
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0 space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm text-foreground tabular-nums">{phone.phone}</span>
                          <StatusChip tone={badge.tone}>{badge.label}</StatusChip>
                        </div>
                        {phone.label && <p className="text-xs text-muted-foreground">{phone.label}</p>}
                        {phone.last_attempt_at && (
                          <p className="text-xs text-muted-foreground">
                            Última tentativa:{' '}
                            {new Date(phone.last_attempt_at).toLocaleDateString('pt-BR', {
                              month: 'short',
                              day: 'numeric',
                              year: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-all shrink-0">
                        <button
                          type="button"
                          onClick={() => startEditPhone(phone)}
                          aria-label={`Editar ${phone.phone}`}
                          className="text-muted-foreground hover:text-primary-text transition-colors cursor-pointer p-1"
                        >
                          <Pencil className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setPhoneToRemove(phone.id)}
                          disabled={deletingPhoneId === phone.id}
                          aria-label={`Remover ${phone.phone}`}
                          className="text-muted-foreground hover:text-danger transition-colors cursor-pointer p-1"
                        >
                          {deletingPhoneId === phone.id ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="size-3.5" />
                          )}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Adicionar telefone */}
      <div className="space-y-2 pt-2 border-t border-border">
        <Input
          value={newPhoneNumber}
          onChange={(e) => setNewPhoneNumber(e.target.value)}
          placeholder="Novo número"
          className={fieldInput}
        />
        <Input
          value={newPhoneLabel}
          onChange={(e) => setNewPhoneLabel(e.target.value)}
          placeholder="Rótulo (opcional)"
          className={fieldInput}
        />
        <Button onClick={addPhone} disabled={!newPhoneNumber.trim() || addingPhone} variant="outline" className="w-full" size="sm">
          {addingPhone ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
          Adicionar telefone
        </Button>
      </div>

      <AlertDialog open={phoneToRemove !== null} onOpenChange={(open) => !open && setPhoneToRemove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover este telefone?</AlertDialogTitle>
            <AlertDialogDescription>O telefone deixa de fazer parte deste contato.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const id = phoneToRemove;
                setPhoneToRemove(null);
                if (id) void deletePhone(id);
              }}
            >
              Remover
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );

  const renderTags = () => (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Clique em uma etiqueta para adicioná-la ou removê-la deste contato.
      </p>
      {allTags.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nenhuma etiqueta disponível. Crie etiquetas nas Configurações.
        </p>
      ) : (
        <TagPickerBox
          searchRef={tagSearchRef}
          query={tagQuery}
          onQueryChange={setTagQuery}
          onSearchArrowDown={() => focusFirstTagButton(tagButtonRefs)}
          autoFocus
          searchLabel="Buscar etiquetas"
          isEmpty={filteredTags.length === 0}
        >
          {filteredTags.map((tag, index) => {
            const selected = contactTagIds.includes(tag.id);
            return (
              <button
                key={tag.id}
                ref={(el) => {
                  tagButtonRefs.current[index] = el;
                }}
                type="button"
                onClick={() => toggleTag(tag.id)}
                onKeyDown={makeTagButtonKeyDownHandler(index, tagButtonRefs, tagSearchRef)}
                disabled={savingTags}
                aria-pressed={selected}
                className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium transition-all cursor-pointer ${
                  selected ? 'ring-2 ring-primary ring-offset-1 ring-offset-border' : 'opacity-50 hover:opacity-80'
                }`}
                style={{ backgroundColor: tag.color + '20', color: tag.color }}
              >
                {selected && <Check className="size-3 mr-1" />}
                {tag.name}
              </button>
            );
          })}
        </TagPickerBox>
      )}
    </div>
  );

  const renderNotes = () => (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-2 mb-3">
        <Textarea
          value={newNote}
          onChange={(e) => setNewNote(e.target.value)}
          placeholder="Escreva uma nota..."
          className="bg-card border-border text-foreground placeholder:text-muted-foreground min-h-[60px] text-sm resize-none"
        />
        <Button onClick={addNote} disabled={!newNote.trim() || savingNote} size="sm">
          {savingNote ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
          Adicionar Nota
        </Button>
      </div>

      <div className="ddm-stagger flex-1 overflow-y-auto space-y-2">
        {loadingNotes ? (
          <div className="space-y-2" aria-busy="true">
            <Skeleton className="h-16 w-full rounded-lg" />
            <Skeleton className="h-16 w-full rounded-lg" />
          </div>
        ) : notes.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">Nenhuma nota ainda.</p>
        ) : (
          notes.map((note) => (
            <div key={note.id} className="rounded-lg bg-surface-3 border border-border p-3 group">
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm text-foreground-2 whitespace-pre-wrap flex-1">{note.note_text}</p>
                <button
                  type="button"
                  onClick={() => deleteNote(note.id)}
                  aria-label="Excluir nota"
                  className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-muted-foreground hover:text-danger transition-all cursor-pointer shrink-0"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
              <p className="text-xs text-muted-foreground mt-1.5">
                {new Date(note.created_at).toLocaleDateString('pt-BR', {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </p>
            </div>
          ))
        )}
      </div>
    </div>
  );

  const renderCustom = () =>
    loadingCustom ? (
      <div className="space-y-2" aria-busy="true">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    ) : customFields.length === 0 ? (
      <p className="text-sm text-muted-foreground text-center py-6">
        Nenhum campo personalizado definido. Crie-os nas Configurações.
      </p>
    ) : (
      <div className="space-y-3">
        {customFields.map((field) => (
          <div key={field.id} className="space-y-1.5">
            <Label className="text-muted-foreground text-xs capitalize">{field.field_name}</Label>
            <Input
              value={customValues[field.id] ?? ''}
              onChange={(e) =>
                setCustomValues((prev) => ({
                  ...prev,
                  [field.id]: e.target.value,
                }))
              }
              placeholder={`Insira ${field.field_name}...`}
              className={fieldInput}
            />
          </div>
        ))}
        <Button onClick={saveCustomFields} disabled={savingCustom} className="w-full" size="sm">
          {savingCustom ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
          Salvar Campos Personalizados
        </Button>
      </div>
    );

  const renderDeals = () =>
    loadingDeals ? (
      <div className="space-y-2" aria-busy="true">
        <Skeleton className="h-16 w-full rounded-lg" />
      </div>
    ) : deals.length === 0 ? (
      <p className="text-sm text-muted-foreground text-center py-8">Nenhum negócio ainda</p>
    ) : (
      <div className="ddm-stagger space-y-2">
        {deals.map((deal) => (
          <div key={deal.id} className="rounded-lg border border-border bg-surface-3 p-3">
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-semibold text-foreground">{deal.title}</p>
              {deal.stage && (
                <span
                  className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold"
                  style={{
                    backgroundColor: `${deal.stage.color}20`,
                    color: deal.stage.color,
                  }}
                >
                  {deal.stage.name}
                </span>
              )}
            </div>
            <div className="mt-1.5 flex items-center justify-between text-xs text-muted-foreground">
              <span className="flex items-center gap-1 tabular-nums">
                <DollarSign className="size-3" />
                {formatCurrency(deal.value ?? 0, deal.currency || defaultCurrency)}
              </span>
              {deal.status && deal.status !== 'open' && (
                <span className={deal.status === 'won' ? 'text-success' : 'text-danger'}>{deal.status}</span>
              )}
            </div>
          </div>
        ))}
      </div>
    );

  const actionButtons = (
    <>
      <Button
        size="sm"
        variant={variant === 'page' ? 'outline' : 'default'}
        onClick={() => setTemplatePickerOpen(true)}
        disabled={sendingTemplate || loadingChat}
      >
        {sendingTemplate ? <Loader2 className="size-4 animate-spin" /> : <LayoutTemplate className="size-4" />}
        Enviar template
      </Button>
      <Button
        size="sm"
        variant={variant === 'page' ? 'default' : 'outline'}
        onClick={handleGoToChat}
        disabled={sendingTemplate || loadingChat}
      >
        {loadingChat ? <Loader2 className="size-4 animate-spin" /> : <MessageSquare className="size-4" />}
        {variant === 'page' ? 'Abrir conversa' : 'Ir para o chat'}
      </Button>
    </>
  );

  const templatePicker = (
    <TemplatePicker
      open={templatePickerOpen}
      onOpenChange={setTemplatePickerOpen}
      onSelect={handleSendTemplate}
      contact={contact}
    />
  );

  if (variant === 'page') {
    if (loading && !contact) {
      return (
        <PageBody>
          <div className="flex items-center gap-4 pt-1" aria-busy="true">
            <Skeleton className="size-14 rounded-full" />
            <div className="flex flex-col gap-2">
              <Skeleton className="h-6 w-56" />
              <Skeleton className="h-3 w-40" />
            </div>
          </div>
          <div className="grid gap-3.5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]" aria-hidden="true">
            <Skeleton className="h-80 rounded-[10px]" />
            <Skeleton className="h-80 rounded-[10px]" />
          </div>
        </PageBody>
      );
    }
    if (!contact) {
      return (
        <PageBody>
          <Link href="/contacts" className="inline-flex w-fit items-center gap-1 pt-1 text-xs text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-3" />
            Contatos
          </Link>
          <div className="flex animate-ddm-fade flex-col items-center gap-1.5 rounded-[10px] border border-dashed border-border bg-card px-6 py-12 text-center">
            <p className="text-[13.5px] font-semibold text-foreground">Contato não encontrado</p>
            <p className="text-[12.5px] text-muted-foreground">Ele pode ter sido excluído ou você não tem acesso.</p>
          </div>
        </PageBody>
      );
    }

    const appliedTags = allTags.filter((t) => contactTagIds.includes(t.id));

    return (
      <PageBody>
        <nav aria-label="Trilha" className="flex items-center gap-1 pt-1 text-xs text-muted-foreground">
          <Link href="/contacts" className="hover:text-foreground">
            Contatos
          </Link>
          <ChevronRight className="size-3" aria-hidden="true" />
          <span className="truncate text-foreground-2">{contact.name || 'Desconhecido'}</span>
        </nav>

        {/* Cabeçalho do contato */}
        <section className="flex animate-ddm-up flex-col gap-4 rounded-[10px] border border-border bg-card p-5 md:flex-row md:items-start">
          <span className="flex size-14 shrink-0 items-center justify-center rounded-full bg-primary-soft font-heading text-lg font-semibold text-primary-text" aria-hidden="true">
            {getInitials(contact.name)}
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <h2 className="font-heading text-[24px] font-semibold leading-tight tracking-[-0.02em] text-foreground">
              {contact.name || 'Desconhecido'}
            </h2>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
              <button
                type="button"
                onClick={copyPhone}
                title="Copiar telefone"
                className="flex items-center gap-1.5 tabular-nums hover:text-primary-text transition-colors"
              >
                <Phone className="size-3.5" />
                {contact.phone}
                {copiedPhone ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
              </button>
              {contact.email && (
                <span className="flex items-center gap-1.5">
                  <Mail className="size-3.5" />
                  {contact.email}
                </span>
              )}
              {contact.company && (
                <span className="flex items-center gap-1.5">
                  <Building2 className="size-3.5" />
                  {contact.company}
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {appliedTags.map((tag) => (
                <span
                  key={tag.id}
                  className="inline-flex h-[22px] items-center gap-1 rounded-full pl-2 pr-1 text-[11.5px] font-semibold"
                  style={{ backgroundColor: tag.color + '20', color: tag.color }}
                >
                  {tag.name}
                  <button
                    type="button"
                    onClick={() => toggleTag(tag.id)}
                    disabled={savingTags}
                    aria-label={`Remover etiqueta ${tag.name}`}
                    className="flex size-4 items-center justify-center rounded-full hover:bg-black/10"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
              <Popover>
                <PopoverTrigger className="inline-flex h-[22px] items-center gap-1 rounded-full border border-dashed border-border-strong px-2 text-[11.5px] font-semibold text-muted-foreground hover:border-primary hover:text-primary-text">
                  <Plus className="size-3" />
                  Etiqueta
                </PopoverTrigger>
                <PopoverContent align="start" className="w-80">
                  {renderTags()}
                </PopoverContent>
              </Popover>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">{actionButtons}</div>
        </section>

        <div className="grid items-start gap-3.5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
          <div className="ddm-stagger flex flex-col gap-3.5">
            <section className="rounded-[10px] border border-border bg-card p-[18px]">
              <h3 className="mb-3 text-[13.5px] font-semibold text-foreground">Dados</h3>
              {renderDetails()}
            </section>
            <section className="rounded-[10px] border border-border bg-card p-[18px]">
              <h3 className="mb-3 text-[13.5px] font-semibold text-foreground">Telefones</h3>
              {renderPhones(contact)}
            </section>
            <section className="rounded-[10px] border border-border bg-card p-[18px]">
              <h3 className="mb-3 text-[13.5px] font-semibold text-foreground">Campos personalizados</h3>
              {renderCustom()}
            </section>
          </div>

          <section className="flex min-h-[420px] flex-col rounded-[10px] border border-border bg-card">
            <div className="border-b border-border px-[18px] py-3">
              <Segmented
                ariaLabel="Seções do contato"
                value={pageTab}
                onChange={setPageTab}
                options={[
                  { value: 'activity', label: 'Atividade' },
                  { value: 'deals', label: 'Negócios', count: loadingDeals ? undefined : deals.length },
                  { value: 'campaigns', label: 'Campanhas' },
                  { value: 'notes', label: 'Notas', count: loadingNotes ? undefined : notes.length },
                ]}
              />
            </div>
            <div key={pageTab} className="flex flex-1 animate-ddm-fade flex-col p-[18px]">
              {pageTab === 'activity' && <ContactActivityFeed contactId={contact.id} />}
              {pageTab === 'deals' && renderDeals()}
              {pageTab === 'campaigns' && <ContactCampaignsList contactId={contact.id} />}
              {pageTab === 'notes' && renderNotes()}
            </div>
          </section>
        </div>
        {templatePicker}
      </PageBody>
    );
  }

  return (
    <>
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="bg-popover border-border text-popover-foreground sm:max-w-lg w-full p-0"
      >
        {loading || !contact ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="size-6 animate-spin text-primary" />
          </div>
        ) : (
          <div className="flex flex-col h-full">
            {/* Header */}
            <SheetHeader className="p-4 border-b border-border">
              <div className="flex items-center gap-3">
                <Avatar className="size-12 bg-muted border border-border">
                  <AvatarFallback className="bg-primary-soft text-primary-text text-sm font-medium">
                    {getInitials(contact.name)}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <SheetTitle className="text-popover-foreground truncate">
                    {contact.name || 'Desconhecido'}
                  </SheetTitle>
                  <SheetDescription className="text-muted-foreground text-xs mt-0.5">
                    Detalhes do contato ·{' '}
                    <Link href={`/contacts/${contact.id}`} className="text-primary-text hover:underline">
                      Abrir página completa
                    </Link>
                  </SheetDescription>
                  <div className="flex flex-wrap items-center gap-3 mt-1.5 text-xs text-muted-foreground">
                    <button
                      onClick={copyPhone}
                      className="flex items-center gap-1 hover:text-primary transition-colors cursor-pointer"
                    >
                      <Phone className="size-3" />
                      {contact.phone}
                      {copiedPhone ? (
                        <Check className="size-3 text-primary" />
                      ) : (
                        <Copy className="size-3" />
                      )}
                    </button>
                    {contact.email && (
                      <span className="flex items-center gap-1">
                        <Mail className="size-3" />
                        {contact.email}
                      </span>
                    )}
                    {contact.company && (
                      <span className="flex items-center gap-1">
                        <Building2 className="size-3" />
                        {contact.company}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div className="mt-3 flex items-center gap-2">{actionButtons}</div>
            </SheetHeader>

            {/* Tabs */}
            <Tabs defaultValue="details" className="flex-1 flex flex-col min-h-0">
              <TabsList className="bg-muted/50 border-b border-border mx-4 mt-3">
                <TabsTrigger value="details" className="data-active:bg-muted data-active:text-primary text-muted-foreground">
                  Detalhes
                </TabsTrigger>
                <TabsTrigger value="phones" className="data-active:bg-muted data-active:text-primary text-muted-foreground">
                  Telefones
                </TabsTrigger>
                <TabsTrigger value="tags" className="data-active:bg-muted data-active:text-primary text-muted-foreground">
                  Etiquetas
                </TabsTrigger>
                <TabsTrigger value="notes" className="data-active:bg-muted data-active:text-primary text-muted-foreground">
                  Notas
                </TabsTrigger>
                <TabsTrigger value="custom" className="data-active:bg-muted data-active:text-primary text-muted-foreground">
                  Campos Personalizados
                </TabsTrigger>
                <TabsTrigger value="deals" className="data-active:bg-muted data-active:text-primary text-muted-foreground">
                  Negócios
                </TabsTrigger>
              </TabsList>

              <TabsContent value="details" className="flex-1 overflow-y-auto px-4 py-3">
                {renderDetails()}
              </TabsContent>
              <TabsContent value="phones" className="flex-1 overflow-y-auto px-4 py-3">
                {renderPhones(contact)}
              </TabsContent>
              <TabsContent value="tags" className="flex-1 overflow-y-auto px-4 py-3">
                {renderTags()}
              </TabsContent>
              <TabsContent value="notes" className="flex-1 flex flex-col min-h-0 px-4 py-3">
                {renderNotes()}
              </TabsContent>
              <TabsContent value="custom" className="flex-1 overflow-y-auto px-4 py-3">
                {renderCustom()}
              </TabsContent>
              <TabsContent value="deals" className="flex-1 overflow-y-auto px-4 py-3">
                {renderDeals()}
              </TabsContent>
            </Tabs>
          </div>
        )}
      </SheetContent>
    </Sheet>
    {templatePicker}
    </>
  );
}
