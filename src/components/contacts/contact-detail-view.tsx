'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { formatCurrency } from '@/lib/currency';
import { toast } from 'sonner';
import type { Contact, Tag, ContactTag, ContactNote, CustomField, ContactCustomValue, Deal, MessageTemplate } from '@/types';
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
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
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
  { label: string; className: string }
> = {
  ativo: { label: 'Ativo', className: 'bg-muted text-muted-foreground' },
  invalido: { label: 'Inválido', className: 'bg-red-500/10 text-red-400' },
  respondeu: { label: 'Respondeu', className: 'bg-primary/10 text-primary' },
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
}: ContactDetailViewProps) {
  const supabase = createClient();
  const router = useRouter();
  const { accountId, defaultCurrency, user } = useAuth();

  const [contact, setContact] = useState<Contact | null>(null);
  const [loading, setLoading] = useState(false);
  const [copiedPhone, setCopiedPhone] = useState(false);

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

  const fetchContact = useCallback(async () => {
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

  const fetchTags = useCallback(async () => {
    if (!contactId) return;

    const [tagsRes, contactTagsRes] = await Promise.all([
      supabase.from('tags').select('*').order('name'),
      supabase.from('contact_tags').select('tag_id').eq('contact_id', contactId),
    ]);

    if (tagsRes.data) setAllTags(tagsRes.data);
    if (contactTagsRes.data) {
      setContactTagIds(contactTagsRes.data.map((ct) => ct.tag_id));
    }
  }, [contactId, supabase]);

  const fetchNotes = useCallback(async () => {
    if (!contactId) return;
    setLoadingNotes(true);

    const { data } = await supabase
      .from('contact_notes')
      .select('*')
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false });

    if (data) setNotes(data);
    setLoadingNotes(false);
  }, [contactId, supabase]);

  const fetchCustomFields = useCallback(async () => {
    if (!contactId) return;
    setLoadingCustom(true);

    const [fieldsRes, valuesRes] = await Promise.all([
      supabase.from('custom_fields').select('*').order('field_name'),
      supabase
        .from('contact_custom_values')
        .select('*')
        .eq('contact_id', contactId),
    ]);

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

  const fetchDeals = useCallback(async () => {
    if (!contactId) return;
    setLoadingDeals(true);
    const { data } = await supabase
      .from('deals')
      .select('*, stage:pipeline_stages(*)')
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false });
    setDeals((data ?? []) as Deal[]);
    setLoadingDeals(false);
  }, [contactId, supabase]);

  const fetchPhones = useCallback(async () => {
    if (!contactId) return;
    setLoadingPhones(true);
    const { data } = await supabase
      .from('contact_phones')
      .select('*')
      .eq('contact_id', contactId)
      .order('ordem', { ascending: true });
    setPhones((data ?? []) as ContactPhone[]);
    setLoadingPhones(false);
  }, [contactId, supabase]);

  useEffect(() => {
    if (open && contactId) {
      fetchContact();
      fetchTags();
      fetchNotes();
      fetchCustomFields();
      fetchDeals();
      fetchPhones();
      setTagQuery('');
    }
  }, [open, contactId, fetchContact, fetchTags, fetchNotes, fetchCustomFields, fetchDeals, fetchPhones]);

  async function copyPhone() {
    if (!contact) return;
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
            <SheetHeader className="p-4 border-b border-border/50">
              <div className="flex items-center gap-3">
                <Avatar className="size-12 bg-muted border border-border">
                  <AvatarFallback className="bg-primary/10 text-primary text-sm font-medium">
                    {getInitials(contact.name)}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <SheetTitle className="text-popover-foreground truncate">
                    {contact.name || 'Desconhecido'}
                  </SheetTitle>
                  <SheetDescription className="text-muted-foreground text-xs mt-0.5">
                    Detalhes do contato
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
              <div className="mt-3 flex items-center gap-2">
                <Button
                  size="sm"
                  onClick={() => setTemplatePickerOpen(true)}
                  disabled={sendingTemplate || loadingChat}
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  {sendingTemplate ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <LayoutTemplate className="size-4" />
                  )}
                  Enviar template
                </Button>

                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleGoToChat}
                  disabled={sendingTemplate || loadingChat}
                  className="border-border text-foreground hover:bg-muted"
                >
                  {loadingChat ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <MessageSquare className="size-4" />
                  )}
                  Ir para o chat
                </Button>
              </div>
            </SheetHeader>

            {/* Tabs */}
            <Tabs defaultValue="details" className="flex-1 flex flex-col min-h-0">
              <TabsList className="bg-muted/50 border-b border-border mx-4 mt-3">
                <TabsTrigger
                  value="details"
                  className="data-active:bg-muted data-active:text-primary text-muted-foreground"
                >
                  Detalhes
                </TabsTrigger>
                <TabsTrigger
                  value="phones"
                  className="data-active:bg-muted data-active:text-primary text-muted-foreground"
                >
                  Telefones
                </TabsTrigger>
                <TabsTrigger
                  value="tags"
                  className="data-active:bg-muted data-active:text-primary text-muted-foreground"
                >
                  Etiquetas
                </TabsTrigger>
                <TabsTrigger
                  value="notes"
                  className="data-active:bg-muted data-active:text-primary text-muted-foreground"
                >
                  Notas
                </TabsTrigger>
                <TabsTrigger
                  value="custom"
                  className="data-active:bg-muted data-active:text-primary text-muted-foreground"
                >
                  Campos Personalizados
                </TabsTrigger>
                <TabsTrigger
                  value="deals"
                  className="data-active:bg-muted data-active:text-primary text-muted-foreground"
                >
                  Negócios
                </TabsTrigger>
              </TabsList>

              {/* Details Tab */}
              <TabsContent value="details" className="flex-1 overflow-y-auto px-4 py-3">
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">Nome</Label>
                    <Input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="bg-muted border-border text-foreground h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">
                      Telefone <span className="text-red-400">*</span>
                    </Label>
                    <Input
                      value={editPhone}
                      onChange={(e) => setEditPhone(e.target.value)}
                      className="bg-muted border-border text-foreground h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">CPF</Label>
                    <Input
                      value={formatCpf(editCpf)}
                      onChange={(e) => setEditCpf(onlyDigits(e.target.value).slice(0, CPF_DIGITS_LENGTH))}
                      placeholder="000.000.000-00"
                      inputMode="numeric"
                      className="bg-muted border-border text-foreground h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">Instituição</Label>
                    <Input
                      value={editInstituicao}
                      onChange={(e) => setEditInstituicao(e.target.value)}
                      className="bg-muted border-border text-foreground h-8 text-sm"
                    />
                  </div>

                  <div className="space-y-1.5 pt-2 border-t border-border/50">
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
                        className="bg-muted/50 border-border text-muted-foreground h-8 text-sm"
                      />
                    </div>
                  ))}

                  <Button
                    onClick={saveDetails}
                    disabled={savingDetails}
                    className="bg-primary hover:bg-primary/90 text-primary-foreground w-full"
                    size="sm"
                  >
                    {savingDetails ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Save className="size-3.5" />
                    )}
                    Salvar Alterações
                  </Button>
                </div>
              </TabsContent>

              {/* Phones Tab */}
              <TabsContent value="phones" className="flex-1 overflow-y-auto px-4 py-3">
                <div className="space-y-4">
                  {/* Seção 1 — telefone principal (contacts.phone / TELEFONE1) */}
                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">Telefone principal</Label>
                    <div className="flex items-center gap-2 rounded-lg bg-muted/50 border border-border/50 px-3 py-2">
                      <span className="text-sm text-foreground flex-1">{contact.phone}</span>
                      <span className="rounded-full bg-primary/10 text-primary px-2 py-0.5 text-[10px] font-medium shrink-0">
                        Principal
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Editável na aba Detalhes.
                    </p>
                  </div>

                  {/* Seção 2 — telefones alternativos (contact_phones) */}
                  <div className="space-y-1.5 pt-2 border-t border-border/50">
                    <Label className="text-muted-foreground text-xs">Telefones alternativos</Label>

                    {loadingPhones ? (
                      <div className="flex items-center justify-center py-6">
                        <Loader2 className="size-5 animate-spin text-muted-foreground" />
                      </div>
                    ) : phones.length === 0 ? (
                      <p className="text-sm text-muted-foreground py-2">
                        Nenhum telefone alternativo cadastrado.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {phones.map((phone) => {
                          const badge = PHONE_STATUS_BADGE[phone.status];
                          const isEditing = editingPhoneId === phone.id;
                          return (
                            <div
                              key={phone.id}
                              className="rounded-lg bg-muted/50 border border-border/50 p-3 group"
                            >
                              {isEditing ? (
                                <div className="space-y-2">
                                  <Input
                                    value={editPhoneNumber}
                                    onChange={(e) => setEditPhoneNumber(e.target.value)}
                                    placeholder="Número"
                                    className="bg-muted border-border text-foreground h-8 text-sm"
                                  />
                                  <Input
                                    value={editPhoneLabel}
                                    onChange={(e) => setEditPhoneLabel(e.target.value)}
                                    placeholder="Rótulo (opcional)"
                                    className="bg-muted border-border text-foreground h-8 text-sm"
                                  />
                                  <div className="flex items-center gap-2">
                                    <Button
                                      onClick={saveEditPhone}
                                      disabled={savingPhoneEdit || !editPhoneNumber.trim()}
                                      size="sm"
                                      className="bg-primary hover:bg-primary/90 text-primary-foreground"
                                    >
                                      {savingPhoneEdit ? (
                                        <Loader2 className="size-3.5 animate-spin" />
                                      ) : (
                                        <Save className="size-3.5" />
                                      )}
                                      Salvar
                                    </Button>
                                    <Button
                                      onClick={cancelEditPhone}
                                      disabled={savingPhoneEdit}
                                      size="sm"
                                      variant="outline"
                                      className="border-border text-foreground hover:bg-muted"
                                    >
                                      <X className="size-3.5" />
                                      Cancelar
                                    </Button>
                                  </div>
                                </div>
                              ) : (
                                <div className="flex items-start justify-between gap-2">
                                  <div className="flex-1 min-w-0 space-y-1">
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <span className="text-sm text-foreground">{phone.phone}</span>
                                      <span
                                        className={`rounded-full px-2 py-0.5 text-[10px] font-medium shrink-0 ${badge.className}`}
                                      >
                                        {badge.label}
                                      </span>
                                    </div>
                                    {phone.label && (
                                      <p className="text-xs text-muted-foreground">{phone.label}</p>
                                    )}
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
                                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all shrink-0">
                                    <button
                                      onClick={() => startEditPhone(phone)}
                                      className="text-muted-foreground hover:text-primary transition-colors cursor-pointer p-1"
                                    >
                                      <Pencil className="size-3.5" />
                                    </button>
                                    <button
                                      onClick={() => {
                                        if (window.confirm('Remover este telefone?')) {
                                          deletePhone(phone.id);
                                        }
                                      }}
                                      disabled={deletingPhoneId === phone.id}
                                      className="text-muted-foreground hover:text-red-400 transition-colors cursor-pointer p-1"
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
                  <div className="space-y-2 pt-2 border-t border-border/50">
                    <Input
                      value={newPhoneNumber}
                      onChange={(e) => setNewPhoneNumber(e.target.value)}
                      placeholder="Novo número"
                      className="bg-muted border-border text-foreground h-8 text-sm placeholder:text-muted-foreground"
                    />
                    <Input
                      value={newPhoneLabel}
                      onChange={(e) => setNewPhoneLabel(e.target.value)}
                      placeholder="Rótulo (opcional)"
                      className="bg-muted border-border text-foreground h-8 text-sm placeholder:text-muted-foreground"
                    />
                    <Button
                      onClick={addPhone}
                      disabled={!newPhoneNumber.trim() || addingPhone}
                      className="bg-primary hover:bg-primary/90 text-primary-foreground w-full"
                      size="sm"
                    >
                      {addingPhone ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Plus className="size-3.5" />
                      )}
                      Adicionar telefone
                    </Button>
                  </div>
                </div>
              </TabsContent>

              {/* Tags Tab */}
              <TabsContent value="tags" className="flex-1 overflow-y-auto px-4 py-3">
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
                              selected
                                ? 'ring-2 ring-primary ring-offset-1 ring-offset-border'
                                : 'opacity-50 hover:opacity-80'
                            }`}
                            style={{
                              backgroundColor: tag.color + '20',
                              color: tag.color,
                            }}
                          >
                            {selected && <Check className="size-3 mr-1" />}
                            {tag.name}
                          </button>
                        );
                      })}
                    </TagPickerBox>
                  )}
                </div>
              </TabsContent>

              {/* Notes Tab */}
              <TabsContent value="notes" className="flex-1 flex flex-col min-h-0 px-4 py-3">
                <div className="space-y-2 mb-3">
                  <Textarea
                    value={newNote}
                    onChange={(e) => setNewNote(e.target.value)}
                    placeholder="Escreva uma nota..."
                    className="bg-muted border-border text-foreground placeholder:text-muted-foreground min-h-[60px] text-sm resize-none"
                  />
                  <Button
                    onClick={addNote}
                    disabled={!newNote.trim() || savingNote}
                    className="bg-primary hover:bg-primary/90 text-primary-foreground"
                    size="sm"
                  >
                    {savingNote ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Plus className="size-3.5" />
                    )}
                    Adicionar Nota
                  </Button>
                </div>

                <div className="flex-1 overflow-y-auto space-y-2">
                  {loadingNotes ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="size-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : notes.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-8">
                      Nenhuma nota ainda.
                    </p>
                  ) : (
                    notes.map((note) => (
                      <div
                        key={note.id}
                        className="rounded-lg bg-muted/50 border border-border/50 p-3 group"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-sm text-muted-foreground whitespace-pre-wrap flex-1">
                            {note.note_text}
                          </p>
                          <button
                            onClick={() => deleteNote(note.id)}
                            className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-400 transition-all cursor-pointer shrink-0"
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
              </TabsContent>

              {/* Custom Fields Tab */}
              <TabsContent value="custom" className="flex-1 overflow-y-auto px-4 py-3">
                {loadingCustom ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="size-5 animate-spin text-muted-foreground" />
                  </div>
                ) : customFields.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">
                    Nenhum campo personalizado definido. Crie-os nas Configurações.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {customFields.map((field) => (
                      <div key={field.id} className="space-y-1.5">
                        <Label className="text-muted-foreground text-xs capitalize">
                          {field.field_name}
                        </Label>
                        <Input
                          value={customValues[field.id] ?? ''}
                          onChange={(e) =>
                            setCustomValues((prev) => ({
                              ...prev,
                              [field.id]: e.target.value,
                            }))
                          }
                          placeholder={`Insira ${field.field_name}...`}
                          className="bg-muted border-border text-foreground h-8 text-sm placeholder:text-muted-foreground"
                        />
                      </div>
                    ))}
                    <Button
                      onClick={saveCustomFields}
                      disabled={savingCustom}
                      className="bg-primary hover:bg-primary/90 text-primary-foreground w-full"
                      size="sm"
                    >
                      {savingCustom ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Save className="size-3.5" />
                      )}
                      Salvar Campos Personalizados
                    </Button>
                  </div>
                )}
              </TabsContent>

              {/* Deals Tab */}
              <TabsContent value="deals" className="flex-1 overflow-y-auto px-4 py-3">
                {loadingDeals ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="size-5 animate-spin text-primary" />
                  </div>
                ) : deals.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Nenhum negócio ainda</p>
                ) : (
                  <div className="space-y-2">
                    {deals.map((deal) => (
                      <div
                        key={deal.id}
                        className="rounded-lg border border-border bg-muted/50 p-3"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-sm font-medium text-foreground">
                            {deal.title}
                          </p>
                          {deal.stage && (
                            <span
                              className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
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
                          <span className="flex items-center gap-1">
                            <DollarSign className="size-3" />
                            {formatCurrency(
                              deal.value ?? 0,
                              deal.currency || defaultCurrency,
                            )}
                          </span>
                          {deal.status && deal.status !== 'open' && (
                            <span
                              className={
                                deal.status === 'won'
                                  ? 'text-primary'
                                  : 'text-red-400'
                              }
                            >
                              {deal.status}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </div>
        )}
      </SheetContent>
    </Sheet>
    <TemplatePicker
      open={templatePickerOpen}
      onOpenChange={setTemplatePickerOpen}
      onSelect={handleSendTemplate}
    />
    </>
  );
}
