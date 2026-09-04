"use client";

import { apiFetch } from "@/lib/api-fetch";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { 
  Plus, 
  Play, 
  Pause, 
  Copy, 
  Trash2, 
  Megaphone, 
  Clock, 
  Tag, 
  Smartphone, 
  MessageSquare,
  Sparkles,
  Layers,
  Calendar,
  X,
  FileText,
  ArrowLeft,
  Pencil
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import Link from "next/link";
import { uploadAccountMedia } from "@/lib/storage/upload-media";
import { getDisparadorScope } from "@/lib/disparador/scope";
import { TEMPLATE_VARS } from "@/lib/disparador/template-vars";
import { MessageTemplatePicker } from "@/components/disparador/message-template-picker";

interface Campaign {
  id: string;
  nome: string;
  descricao?: string;
  objetivo?: string;
  status: string;
  session_ids: string[];
  tags_filtro: string[];
  mensagens: any[];
  intervalo_min: number;
  intervalo_max: number;
  janela_inicio: string;
  janela_fim: string;
  created_at: string;
}

interface TagItem {
  id: string;
  name: string;
  color?: string;
}

interface WahaSession {
  id: string;
  name: string;
  phone_info?: { id: string };
  provider?: string;
  display_phone_number?: string;
}

interface CampaignMessage {
  tipo: "texto" | "ia" | "imagem" | "audio" | "ligacao";
  conteudo?: string;
  prompt?: string;
  url?: string;
  // Campos Meta template (populados pelo picker quando hasMeta = true)
  template_name?: string;       // ex: "cruzeiroclaude_1407_1"
  template_language?: string;   // ex: "pt_BR"
  // Mapeamento de variáveis posicionais {{1}}, {{2}}, {{3}}...
  // Cada entrada é ou um campo do contato ou um valor estático.
  template_variable_map?: Array<
    | { type: "contact_field"; field: "name" | "phone" | "company" }
    | { type: "static"; value: string }
  >;
}

const STATUS_COLORS: Record<string, string> = {
  rascunho: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  em_execucao: "bg-emerald-500/10 text-emerald-500 border border-emerald-500/20",
  pausada: "bg-amber-500/10 text-amber-500 border border-amber-500/20",
  encerrada: "bg-zinc-500/10 text-zinc-500 border border-zinc-500/20",
};

const STATUS_LABELS: Record<string, string> = {
  rascunho: "Rascunho",
  em_execucao: "Em Execução",
  pausada: "Pausada",
  encerrada: "Encerrada",
};

// Fixed single-slot key — a browser-local safety net against an
// accidentally closed creation modal, not a per-campaign or per-user
// store. Never touched by edit mode (see editingId guards below), so
// editing a real campaign can't clobber or be clobbered by this.
const DRAFT_STORAGE_KEY = "disparador:campaign-draft";

interface CampaignDraft {
  nome: string;
  descricao: string;
  objetivo: string;
  selectedSessions: string[];
  selectedTags: string[];
  intervaloMin: number;
  intervaloMax: number;
  janelaInicio: string;
  janelaFim: string;
  mensagens: CampaignMessage[];
}

function isDraftEmpty(draft: CampaignDraft): boolean {
  return (
    !draft.nome.trim() &&
    !draft.descricao.trim() &&
    !draft.objetivo.trim() &&
    draft.selectedSessions.length === 0 &&
    draft.selectedTags.length === 0 &&
    draft.mensagens.length <= 1 &&
    !draft.mensagens[0]?.conteudo?.trim() &&
    !draft.mensagens[0]?.prompt?.trim()
  );
}

export default function CampanhasPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [tags, setTags] = useState<TagItem[]>([]);
  const [sessions, setSessions] = useState<WahaSession[]>([]);

  // Form Modal States
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [nome, setNome] = useState("");
  const [descricao, setDescricao] = useState("");
  const [objetivo, setObjetivo] = useState("");
  const [selectedSessions, setSelectedSessions] = useState<string[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [intervaloMin, setIntervaloMin] = useState(30);
  const [intervaloMax, setIntervaloMax] = useState(60);
  const [janelaInicio, setJanelaInicio] = useState("08:00");
  const [janelaFim, setJanelaFim] = useState("18:00");
  const [mensagens, setMensagens] = useState<any[]>([{ tipo: "texto", conteudo: "" }]);
  const varFieldRefs = useRef<Record<string, HTMLTextAreaElement | HTMLInputElement | null>>({});
  // Index of the message ("conteudo") field waiting for a template
  // selection, or null when the picker is closed.
  const [templatePickerIndex, setTemplatePickerIndex] = useState<number | null>(null);

  // Inserts a {{variavel}} placeholder at the current cursor position of the
  // given field (rather than always appending), so the user can click a
  // variable button mid-sentence instead of copy/pasting it in manually.
  const insertTemplateVar = (key: string, i: number, field: "conteudo" | "prompt", variable: string) => {
    const el = varFieldRefs.current[key];
    const current: string = mensagens[i]?.[field] || "";
    const start = el?.selectionStart ?? current.length;
    const end = el?.selectionEnd ?? current.length;
    const updatedValue = current.slice(0, start) + variable + current.slice(end);
    const updated = [...mensagens];
    updated[i] = { ...updated[i], [field]: updatedValue };
    setMensagens(updated);
    const cursorPos = start + variable.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(cursorPos, cursorPos);
    });
  };

  // Draft found in localStorage when the creation modal was opened, still
  // awaiting the user's "Restaurar" / "Descartar" decision.
  const [pendingDraft, setPendingDraft] = useState<CampaignDraft | null>(null);

  // Campanha aguardando confirmação de início (modal de tier Meta)
  const [startConfirmId, setStartConfirmId] = useState<string | null>(null);
  const [campaignInfo, setCampaignInfo] = useState<{
    hasMeta: boolean;
    channels: Array<{
      id: string;
      provider: string;
      phone_number_id?: string;
      display_phone_number?: string;
      tier?: string;
      dailyLimit?: number | null;
      quality_rating?: string | null;
      error?: string;
    }>;
  } | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);

  // Auto-save the in-progress form to localStorage — creation mode only.
  // Skipped while a restore decision is pending so we don't overwrite the
  // saved draft with the blank fields the modal opened with.
  useEffect(() => {
    if (!showModal || editingId || pendingDraft) return;

    const draft: CampaignDraft = {
      nome,
      descricao,
      objetivo,
      selectedSessions,
      selectedTags,
      intervaloMin,
      intervaloMax,
      janelaInicio,
      janelaFim,
      mensagens,
    };

    if (isDraftEmpty(draft)) {
      localStorage.removeItem(DRAFT_STORAGE_KEY);
    } else {
      localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
    }
  }, [
    showModal,
    editingId,
    pendingDraft,
    nome,
    descricao,
    objetivo,
    selectedSessions,
    selectedTags,
    intervaloMin,
    intervaloMax,
    janelaInicio,
    janelaFim,
    mensagens,
  ]);

  // Load Data on Mount
  useEffect(() => {
    loadData();
  }, []);

  // Poll campaigns periodically if any campaign is in execution
  useEffect(() => {
    const hasActiveCampaign = campaigns.some((c) => c.status === "em_execucao");
    if (!hasActiveCampaign) return;

    const interval = setInterval(async () => {
      try {
        const supabase = createClient();
        // wacrm.campaigns has no account_id yet (migration 040 not
        // applied), so scope by the caller's account via created_by —
        // see getDisparadorScope.
        const { userIds } = await getDisparadorScope(supabase);
        const { data: campaignList } = await supabase
          .from("campaigns")
          .select("*")
          .in("created_by", userIds)
          .order("created_at", { ascending: false });
        if (campaignList) {
          setCampaigns(campaignList);
        }
      } catch (err) {
        console.error("Failed to auto-reload campaigns:", err);
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [campaigns]);

  const loadData = async () => {
    setLoading(true);
    try {
      const supabase = createClient();

      // wacrm.campaigns has no account_id yet (migration 040 not
      // applied), so scope by the caller's account via created_by —
      // see getDisparadorScope.
      const { userIds } = await getDisparadorScope(supabase);

      // Load Campaigns
      const { data: campaignList } = await supabase
        .from("campaigns")
        .select("*")
        .in("created_by", userIds)
        .order("created_at", { ascending: false });
      setCampaigns(campaignList ?? []);

      // Load Tags
      const { data: tagList } = await supabase.from("tags").select("id, name, color").order("name");
      setTags(tagList ?? []);

      // Load enabled WhatsApp channels (WAHA + Meta)
      const { data: configList } = await supabase
        .from("whatsapp_config")
        .select("id, waha_session, provider, display_phone_number")
        .eq("habilitado", true);

      const wahaSessions = (configList ?? []).map((c) => ({
        id: c.id,
        name: c.provider === "meta"
          ? `WhatsApp Oficial (Meta)${c.display_phone_number ? ` — ${c.display_phone_number}` : ""}`
          : (c.waha_session || "Sessão WAHA"),
        provider: c.provider,
        display_phone_number: c.display_phone_number,
      }));
      setSessions(wahaSessions);
    } catch (err) {
      console.error("Failed to load campaigns metadata:", err);
    } finally {
      setLoading(false);
    }
  };

  // Abre o modal e busca info do canal antes de confirmar
  const handleStartClick = async (id: string) => {
    setStartConfirmId(id);
    setCampaignInfo(null);
    setInfoLoading(true);
    try {
      const res = await apiFetch(`/api/disparador/campaigns/${id}/info`);
      if (res.ok) {
        const data = await res.json();
        setCampaignInfo(data);
      }
    } catch {
      // Se falhar a busca de info, abre o modal mesmo assim sem dados
    } finally {
      setInfoLoading(false);
    }
  };

  // Confirmação efetiva — chama o start real
  const handleStartConfirm = async () => {
    if (!startConfirmId) return;
    const id = startConfirmId;
    setStartConfirmId(null);
    setCampaignInfo(null);
    try {
      const res = await apiFetch(`/api/disparador/campaigns/${id}/start`, {
        method: "POST",
      });
      if (res.ok) {
        toast.success("Campanha iniciada e disparos agendados!");
        loadData();
      } else {
        const err = await res.json();
        throw new Error(err.error || "Erro ao iniciar campanha");
      }
    } catch (err: any) {
      toast.error(err.message);
    }
  };

  // Pause Campaign
  const handlePause = async (id: string) => {
    try {
      const res = await apiFetch(`/api/disparador/campaigns/${id}/stop?action=pause`, { method: "POST" });
      if (res.ok) {
        toast.success("Campanha pausada com sucesso.");
        loadData();
      }
    } catch (err: any) {
      toast.error("Erro ao pausar campanha.");
    }
  };

  // Stop/Close Campaign
  const handleStop = async (id: string) => {
    try {
      const res = await apiFetch(`/api/disparador/campaigns/${id}/stop?action=stop`, { method: "POST" });
      if (res.ok) {
        toast.success("Campanha encerrada e fila cancelada.");
        loadData();
      }
    } catch (err: any) {
      toast.error("Erro ao encerrar campanha.");
    }
  };

  // Open the modal pre-filled with an existing draft campaign's data.
  // Always sources from the real campaign row, never from the
  // localStorage creation-draft — clear any pending restore prompt so it
  // can't bleed into an edit session.
  const handleEditClick = (campaign: Campaign) => {
    setPendingDraft(null);
    setEditingId(campaign.id);
    setNome(campaign.nome);
    setDescricao(campaign.descricao || "");
    setObjetivo(campaign.objetivo || "");
    setSelectedSessions(campaign.session_ids || []);
    setSelectedTags(campaign.tags_filtro || []);
    setIntervaloMin(campaign.intervalo_min);
    setIntervaloMax(campaign.intervalo_max);
    setJanelaInicio(campaign.janela_inicio);
    setJanelaFim(campaign.janela_fim);
    setMensagens(
      campaign.mensagens && campaign.mensagens.length > 0
        ? campaign.mensagens
        : [{ tipo: "texto", conteudo: "" }]
    );
    setShowModal(true);
  };

  // Open the modal for a brand new campaign. If a draft was left behind
  // by an accidentally closed modal, surface it for the user to decide
  // on rather than restoring it silently.
  const openCreateModal = () => {
    setEditingId(null);
    resetForm();

    let draft: CampaignDraft | null = null;
    try {
      const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
      draft = raw ? JSON.parse(raw) : null;
    } catch {
      draft = null;
    }
    setPendingDraft(draft);

    setShowModal(true);
  };

  const restoreDraft = () => {
    if (!pendingDraft) return;
    setNome(pendingDraft.nome);
    setDescricao(pendingDraft.descricao);
    setObjetivo(pendingDraft.objetivo);
    setSelectedSessions(pendingDraft.selectedSessions);
    setSelectedTags(pendingDraft.selectedTags);
    setIntervaloMin(pendingDraft.intervaloMin);
    setIntervaloMax(pendingDraft.intervaloMax);
    setJanelaInicio(pendingDraft.janelaInicio);
    setJanelaFim(pendingDraft.janelaFim);
    setMensagens(pendingDraft.mensagens);
    setPendingDraft(null);
  };

  const discardDraft = () => {
    localStorage.removeItem(DRAFT_STORAGE_KEY);
    setPendingDraft(null);
  };

  const closeModal = () => {
    setShowModal(false);
    setEditingId(null);
    setPendingDraft(null);
  };

  // Delete Campaign
  const handleDelete = async (campaign: Campaign) => {
    // disp_message_queue.campaign_id is ON DELETE CASCADE, so deleting a
    // running campaign silently wipes its in-flight queue mid-send.
    // Require pausing/stopping first instead of deleting straight out of
    // em_execucao.
    if (campaign.status === "em_execucao") {
      toast.error(
        "Não é possível deletar uma campanha em execução. Pause ou encerre a campanha primeiro."
      );
      return;
    }
    if (!confirm("Tem certeza que deseja deletar esta campanha permanentemente?")) return;
    try {
      // Deletion is scoped server-side (ownership + status re-checked)
      // instead of a direct client delete, since wacrm.campaigns has no
      // RLS yet — see src/app/api/disparador/campaigns/[id]/route.ts.
      const res = await apiFetch(`/api/disparador/campaigns/${campaign.id}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Erro ao deletar campanha");
      }
      toast.success("Campanha deletada.");
      loadData();
    } catch (err: any) {
      toast.error(err.message || "Erro ao deletar campanha.");
    }
  };

  // Submit Form
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nome.trim()) {
      toast.error("Insira o nome da campanha.");
      return;
    }
    if (selectedSessions.length === 0) {
      toast.error("Selecione pelo menos uma sessão do WhatsApp.");
      return;
    }
    if (mensagens.some((m) => m.tipo === "texto" && !m.conteudo.trim())) {
      toast.error("Todas as mensagens de texto precisam de conteúdo.");
      return;
    }

    try {
      if (editingId) {
        // Editing goes through a server route so ownership + the
        // "rascunho" status lock are re-checked there (see
        // /api/disparador/campaigns/[id] PATCH) instead of trusting a
        // direct client-side update.
        const res = await apiFetch(`/api/disparador/campaigns/${editingId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            nome,
            descricao,
            objetivo,
            session_ids: selectedSessions,
            tags_filtro: selectedTags,
            mensagens,
            intervalo_min: intervaloMin,
            intervalo_max: intervaloMax,
            janela_inicio: janelaInicio,
            janela_fim: janelaFim,
          }),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || "Erro ao atualizar campanha");
        }
        toast.success("Campanha atualizada!");
      } else {
        const supabase = createClient();

        // created_by is required for the ownership check in the
        // start/stop routes (campaign.created_by !== user.id) — without
        // it, every campaign is unowned and that check always rejects.
        const {
          data: { session },
        } = await supabase.auth.getSession();
        const user = session?.user;
        if (!user) throw new Error("Não autenticado");

        const campaignData = {
          nome,
          descricao,
          objetivo,
          session_ids: selectedSessions,
          tags_filtro: selectedTags,
          mensagens,
          intervalo_min: intervaloMin,
          intervalo_max: intervaloMax,
          janela_inicio: janelaInicio,
          janela_fim: janelaFim,
          status: "rascunho",
          created_by: user.id,
        };

        const { error } = await supabase.from("campaigns").insert(campaignData);
        if (error) throw error;

        localStorage.removeItem(DRAFT_STORAGE_KEY);
        toast.success("Campanha criada!");
      }

      setShowModal(false);
      setEditingId(null);
      setPendingDraft(null);
      resetForm();
      loadData();
    } catch (err: any) {
      toast.error(err.message || "Erro ao salvar campanha");
    }
  };

  const resetForm = () => {
    setNome("");
    setDescricao("");
    setObjetivo("");
    setSelectedSessions([]);
    setSelectedTags([]);
    setMensagens([{ tipo: "texto", conteudo: "" }]);
    setIntervaloMin(30);
    setIntervaloMax(60);
  };

  // Meta channels can only send approved templates — the picker needs to
  // know this to show the Meta catalog instead of the account's own
  // editable disparador_message_templates list.
  const hasMeta = sessions
    .filter((s) => selectedSessions.includes(s.id))
    .some((s) => s.provider === "meta");

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col space-y-4 p-4 lg:p-6 overflow-hidden">
      {/* Header */}
      <div className="flex flex-col justify-between gap-4 border-b border-border/40 pb-4 sm:flex-row sm:items-center">
        <div>
          <div className="flex items-center gap-2">
            <Link
              href="/disparador"
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground transition-colors mr-1"
              title="Voltar para a Central"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Megaphone className="h-5 w-5" />
            </div>
            <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">
              Campanhas de Disparo
            </h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Gerencie disparos agendados em lote e acompanhe o processamento no servidor.
          </p>
        </div>
        <Button onClick={openCreateModal} className="gap-1.5 self-start">
          <Plus className="h-4 w-4" /> Nova Campanha
        </Button>
      </div>

      {/* Campaigns list */}
      <div className="flex-1 overflow-y-auto pr-2">
        {loading ? (
          <div className="flex h-48 items-center justify-center text-muted-foreground">
            Carregando campanhas...
          </div>
        ) : campaigns.length === 0 ? (
          <div className="flex h-48 flex-col items-center justify-center text-center text-muted-foreground border border-dashed border-border rounded-xl">
            <Megaphone className="h-10 w-10 opacity-20 mb-2" />
            <h4 className="font-semibold">Nenhuma campanha cadastrada</h4>
            <p className="text-xs max-w-xs mt-1">Crie a sua primeira campanha de disparos clicando no botão acima.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {campaigns.map((c) => (
              <div key={c.id} className="rounded-xl border border-border bg-card p-5 space-y-4 shadow-sm relative overflow-hidden">
                <header className="flex justify-between items-start">
                  <div>
                    <h3 className="font-bold text-foreground truncate max-w-[180px]">{c.nome}</h3>
                    <p className="text-xs text-muted-foreground">{c.objetivo || "Suporte/Envio Geral"}</p>
                  </div>
                  <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full capitalize ${STATUS_COLORS[c.status] || STATUS_COLORS.rascunho}`}>
                    {STATUS_LABELS[c.status] || c.status}
                  </span>
                </header>

                <p className="text-xs text-muted-foreground line-clamp-2 min-h-[32px]">{c.descricao || "Sem descrição fornecida."}</p>

                {/* Configurations Overview */}
                <div className="grid grid-cols-2 gap-2 pt-2 text-[11px] text-muted-foreground border-t border-border/40">
                  <div className="flex items-center gap-1.5 truncate">
                    <Clock className="h-3.5 w-3.5" /> Delay: {c.intervalo_min}s - {c.intervalo_max}s
                  </div>
                  <div className="flex items-center gap-1.5 truncate">
                    <Tag className="h-3.5 w-3.5" /> Filtro: {c.tags_filtro.length > 0 ? `${c.tags_filtro.length} tags` : "Todos"}
                  </div>
                  <div className="flex items-center gap-1.5 truncate">
                    <Smartphone className="h-3.5 w-3.5" /> Sessões: {c.session_ids.length} ativas
                  </div>
                  <div className="flex items-center gap-1.5 truncate">
                    <Calendar className="h-3.5 w-3.5" /> Janela: {c.janela_inicio} - {c.janela_fim}
                  </div>
                </div>

                {/* Actions row */}
                <div className="flex justify-between items-center pt-3 border-t border-border/40">
                  <div className="flex gap-1.5">
                    {c.status === "em_execucao" ? (
                      <Button size="sm" variant="outline" onClick={() => handlePause(c.id)} className="h-8 gap-1 text-xs">
                        <Pause className="h-3.5 w-3.5" /> Pausar
                      </Button>
                    ) : (
                      <Button size="sm" onClick={() => handleStartClick(c.id)} disabled={c.status === "encerrada"} className="h-8 gap-1 text-xs">
                        <Play className="h-3.5 w-3.5" /> Iniciar
                      </Button>
                    )}
                    {c.status === "em_execucao" || c.status === "pausada" ? (
                      <Button size="sm" variant="outline" onClick={() => handleStop(c.id)} className="h-8 text-xs">
                        Encerrar
                      </Button>
                    ) : null}
                  </div>
                  <div className="flex gap-1">
                    {c.status === "rascunho" && (
                      <Button size="icon" variant="ghost" onClick={() => handleEditClick(c)} className="h-8 w-8 text-muted-foreground hover:text-foreground">
                        <Pencil className="h-4 w-4" />
                      </Button>
                    )}
                    <Button size="icon" variant="ghost" onClick={() => handleDelete(c)} className="h-8 w-8 text-red-500 hover:text-red-600">
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Creation Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-card border border-border w-full max-w-2xl rounded-xl shadow-2xl flex flex-col max-h-[85vh] overflow-hidden">
            <header className="px-6 py-4 border-b border-border flex justify-between items-center bg-muted/20">
              <h3 className="font-bold text-foreground">
                {editingId ? "Editar Campanha" : "Nova Campanha de Disparo"}
              </h3>
              <Button size="icon" variant="ghost" onClick={closeModal} className="h-8 w-8 text-muted-foreground">
                <X className="h-5 w-5" />
              </Button>
            </header>

            {pendingDraft && !editingId && (
              <div className="mx-6 mt-4 flex items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-600 dark:text-amber-400">
                <span>Rascunho anterior encontrado.</span>
                <div className="flex gap-2 shrink-0">
                  <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={discardDraft}>
                    Descartar
                  </Button>
                  <Button type="button" size="sm" className="h-7 text-xs" onClick={restoreDraft}>
                    Restaurar
                  </Button>
                </div>
              </div>
            )}

            <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Nome da Campanha</label>
                  <input
                    type="text"
                    value={nome}
                    onChange={(e) => setNome(e.target.value)}
                    placeholder="Ex: Reativação Clientes Inativos"
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Objetivo</label>
                  <input
                    type="text"
                    value={objetivo}
                    onChange={(e) => setObjetivo(e.target.value)}
                    placeholder="Ex: Comercial / Suporte"
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Descrição</label>
                <textarea
                  value={descricao}
                  onChange={(e) => setDescricao(e.target.value)}
                  placeholder="Descreva brevemente a meta da campanha..."
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none resize-none h-16"
                />
              </div>

              {/* Sessions Selector */}
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Sessões de WhatsApp Utilizadas</label>
                <div className="flex flex-wrap gap-2 max-h-24 overflow-y-auto border border-border p-2 rounded-md">
                  {sessions.length === 0 ? (
                    <span className="text-xs text-muted-foreground">Nenhuma sessão WAHA conectada encontrada.</span>
                  ) : (
                    sessions.map((s) => (
                      <label key={s.id} className="flex items-center gap-1.5 bg-muted/50 border border-border rounded px-2.5 py-1 text-xs cursor-pointer hover:bg-muted text-foreground">
                        <input
                          type="checkbox"
                          checked={selectedSessions.includes(s.id)}
                          onChange={(e) => {
                            if (e.target.checked) setSelectedSessions([...selectedSessions, s.id]);
                            else setSelectedSessions(selectedSessions.filter((id) => id !== s.id));
                          }}
                        />
                        {s.name}
                      </label>
                    ))
                  )}
                </div>
              </div>

              {/* Filter tags */}
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Filtro de Contatos por Tags (Opcional - Vazio envia para todos)</label>
                <div className="flex flex-wrap gap-2 max-h-24 overflow-y-auto border border-border p-2 rounded-md">
                  {tags.map((t) => (
                    <label key={t.id} className="flex items-center gap-1.5 bg-muted/50 border border-border rounded px-2.5 py-1 text-xs cursor-pointer hover:bg-muted text-foreground">
                      <input
                        type="checkbox"
                        checked={selectedTags.includes(t.name)}
                        onChange={(e) => {
                          if (e.target.checked) setSelectedTags([...selectedTags, t.name]);
                          else setSelectedTags(selectedTags.filter((name) => name !== t.name));
                        }}
                      />
                      {t.name}
                    </label>
                  ))}
                </div>
              </div>

              {/* Delays and Windows */}
              <div className="grid grid-cols-2 gap-4">
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">Delay Min (seg)</label>
                    <input
                      type="number"
                      value={intervaloMin}
                      onChange={(e) => setIntervaloMin(Number(e.target.value))}
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">Delay Max (seg)</label>
                    <input
                      type="number"
                      value={intervaloMax}
                      onChange={(e) => setIntervaloMax(Number(e.target.value))}
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">Janela Início</label>
                    <input
                      type="text"
                      value={janelaInicio}
                      onChange={(e) => setJanelaInicio(e.target.value)}
                      placeholder="08:00"
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none text-center"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">Janela Fim</label>
                    <input
                      type="text"
                      value={janelaFim}
                      onChange={(e) => setJanelaFim(e.target.value)}
                      placeholder="18:00"
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none text-center"
                    />
                  </div>
                </div>
              </div>

              {/* Messages bubbles configuration */}
              <div className="space-y-2 border-t border-border/40 pt-4">
                <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                  <Layers className="h-3.5 w-3.5" /> Mensagens Sequenciais
                </h4>
                <p className="text-[11px] text-muted-foreground">
                  Clique em uma variável abaixo do campo de texto para inseri-la na posição do
                  cursor — elas são substituídas pelos dados do contato no momento do envio.
                </p>

                {mensagens.map((msg, i) => (
                  <div key={i} className="rounded-lg border border-border p-4 bg-muted/20 relative space-y-3">
                    <div className="flex justify-between items-center">
                      <span className="text-[10px] font-bold text-muted-foreground">Mensagem #{i + 1}</span>
                      {mensagens.length > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => setMensagens(mensagens.filter((_, idx) => idx !== i))}
                          className="h-6 w-6 text-red-500 hover:bg-red-500/10"
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      )}
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
                      <button
                        type="button"
                        onClick={() => {
                          const updated = [...mensagens];
                          updated[i].tipo = "texto";
                          setMensagens(updated);
                        }}
                        className={`py-1.5 border rounded-md font-medium ${msg.tipo === "texto" ? "bg-primary text-primary-foreground border-primary" : "bg-card text-muted-foreground border-border"}`}
                      >
                        Texto
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const updated = [...mensagens];
                          updated[i].tipo = "ia";
                          setMensagens(updated);
                        }}
                        className={`py-1.5 border rounded-md font-medium flex items-center justify-center gap-1 ${msg.tipo === "ia" ? "bg-primary text-primary-foreground border-primary" : "bg-card text-muted-foreground border-border"}`}
                      >
                        <Sparkles className="h-3 w-3" /> IA
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const updated = [...mensagens];
                          updated[i].tipo = "imagem";
                          setMensagens(updated);
                        }}
                        className={`py-1.5 border rounded-md font-medium ${msg.tipo === "imagem" ? "bg-primary text-primary-foreground border-primary" : "bg-card text-muted-foreground border-border"}`}
                      >
                        Imagem
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const updated = [...mensagens];
                          updated[i].tipo = "audio";
                          setMensagens(updated);
                        }}
                        className={`py-1.5 border rounded-md font-medium ${msg.tipo === "audio" ? "bg-primary text-primary-foreground border-primary" : "bg-card text-muted-foreground border-border"}`}
                      >
                        Áudio Chat
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const updated = [...mensagens];
                          updated[i].tipo = "ligacao";
                          setMensagens(updated);
                        }}
                        className={`py-1.5 border rounded-md font-medium ${msg.tipo === "ligacao" ? "bg-primary text-primary-foreground border-primary" : "bg-card text-muted-foreground border-border"}`}
                      >
                        Ligação
                      </button>
                    </div>

                    {msg.tipo === "texto" && (
                      <div className="space-y-1.5">
                        <textarea
                          ref={(el) => { varFieldRefs.current[`conteudo-${i}`] = el; }}
                          value={msg.conteudo}
                          onChange={(e) => {
                            const updated = [...mensagens];
                            updated[i].conteudo = e.target.value;
                            setMensagens(updated);
                          }}
                          placeholder="Escreva a mensagem..."
                          className="w-full min-h-[60px] rounded-md border border-input bg-background px-3 py-2 text-xs focus:outline-none resize-none"
                        />
                        <div className="flex flex-wrap items-center gap-1">
                          {TEMPLATE_VARS.map((v) => (
                            <button
                              key={v.value}
                              type="button"
                              onClick={() => insertTemplateVar(`conteudo-${i}`, i, "conteudo", v.value)}
                              className="px-2 py-0.5 rounded-full border border-border bg-card text-[10px] font-medium text-muted-foreground hover:bg-primary hover:text-primary-foreground hover:border-primary transition-colors"
                            >
                              {v.label}
                            </button>
                          ))}
                          <button
                            type="button"
                            onClick={() => setTemplatePickerIndex(i)}
                            className="ml-auto flex items-center gap-1 px-2 py-0.5 rounded-full border border-dashed border-border bg-card text-[10px] font-medium text-muted-foreground hover:border-primary hover:text-primary transition-colors"
                          >
                            <FileText className="h-3 w-3" />
                            Carregar de um Template
                          </button>
                        </div>

                        {msg.template_name && msg.template_variable_map && msg.template_variable_map.length > 0 && (
                          <div className="space-y-2 rounded-md border border-border bg-card p-3">
                            <p className="text-[10px] font-bold text-muted-foreground">
                              Variáveis do template &quot;{msg.template_name}&quot; ({msg.template_language})
                            </p>
                            {msg.template_variable_map.map((entry: any, varIdx: number) => (
                              <div key={varIdx} className="flex items-center gap-2">
                                <span className="w-10 shrink-0 font-mono text-[10px] text-muted-foreground">
                                  {`{{${varIdx + 1}}}`}
                                </span>
                                <Select
                                  value={entry.type === "contact_field" ? entry.field : "static"}
                                  onValueChange={(val) => {
                                    if (!val) return;
                                    const updated = [...mensagens];
                                    const map = [...(updated[i].template_variable_map || [])];
                                    map[varIdx] =
                                      val === "static"
                                        ? { type: "static", value: "" }
                                        : { type: "contact_field", field: val };
                                    updated[i] = { ...updated[i], template_variable_map: map };
                                    setMensagens(updated);
                                  }}
                                >
                                  <SelectTrigger className="h-7 w-40 border-border bg-background text-xs">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent className="border-border bg-popover">
                                    <SelectItem value="name">Nome do contato</SelectItem>
                                    <SelectItem value="phone">Telefone</SelectItem>
                                    <SelectItem value="company">Empresa</SelectItem>
                                    <SelectItem value="static">Valor fixo</SelectItem>
                                  </SelectContent>
                                </Select>
                                {entry.type === "static" && (
                                  <Input
                                    value={entry.value}
                                    onChange={(e) => {
                                      const updated = [...mensagens];
                                      const map = [...(updated[i].template_variable_map || [])];
                                      map[varIdx] = { type: "static", value: e.target.value };
                                      updated[i] = { ...updated[i], template_variable_map: map };
                                      setMensagens(updated);
                                    }}
                                    placeholder="Valor fixo..."
                                    className="h-7 flex-1 border-border bg-background text-xs"
                                  />
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {msg.tipo === "ia" && (
                      <div className="space-y-1.5">
                        <textarea
                          value={msg.prompt}
                          onChange={(e) => {
                            const updated = [...mensagens];
                            updated[i].prompt = e.target.value;
                            setMensagens(updated);
                          }}
                          placeholder="Escreva o prompt da IA... Ex: Peça para comprar o curso X com tom consultivo."
                          className="w-full min-h-[60px] rounded-md border border-input bg-background px-3 py-2 text-xs focus:outline-none resize-none"
                        />
                        <p className="text-[10px] text-muted-foreground">
                          O nome do contato já é enviado automaticamente para a IA — as variáveis
                          {" "}<code className="font-mono">{"{{ }}"}</code> não se aplicam aqui.
                        </p>
                      </div>
                    )}

                    {msg.tipo === "imagem" && (
                      <div className="space-y-2">
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={msg.url}
                            onChange={(e) => {
                              const updated = [...mensagens];
                              updated[i].url = e.target.value;
                              setMensagens(updated);
                            }}
                            placeholder="Link da imagem (URL)..."
                            className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-xs focus:outline-none"
                          />
                          <Button
                            type="button"
                            variant="secondary"
                            className="text-xs shrink-0"
                            onClick={() => {
                              const el = document.getElementById(`file-upload-${i}`);
                              if (el) el.click();
                            }}
                          >
                            Upload
                          </Button>
                          <input
                            id={`file-upload-${i}`}
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={async (e) => {
                              const file = e.target.files?.[0];
                              if (!file) return;
                              const toastId = toast.loading("Enviando imagem...");
                              try {
                                const res = await uploadAccountMedia("chat-media", file);
                                const updated = [...mensagens];
                                updated[i].url = res.publicUrl;
                                setMensagens(updated);
                                toast.success("Imagem enviada com sucesso!", { id: toastId });
                              } catch (err: any) {
                                toast.error(`Erro no upload: ${err.message}`, { id: toastId });
                              }
                            }}
                          />
                        </div>
                        <input
                          type="text"
                          ref={(el) => { varFieldRefs.current[`legenda-${i}`] = el; }}
                          value={msg.conteudo}
                          onChange={(e) => {
                            const updated = [...mensagens];
                            updated[i].conteudo = e.target.value;
                            setMensagens(updated);
                          }}
                          placeholder="Legenda da imagem (Opcional)..."
                          className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs focus:outline-none"
                        />
                        <div className="flex flex-wrap gap-1">
                          {TEMPLATE_VARS.map((v) => (
                            <button
                              key={v.value}
                              type="button"
                              onClick={() => insertTemplateVar(`legenda-${i}`, i, "conteudo", v.value)}
                              className="px-2 py-0.5 rounded-full border border-border bg-card text-[10px] font-medium text-muted-foreground hover:bg-primary hover:text-primary-foreground hover:border-primary transition-colors"
                            >
                              {v.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {(msg.tipo === "audio" || msg.tipo === "ligacao") && (
                      <div className="space-y-2">
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={msg.url || ""}
                            onChange={(e) => {
                              const updated = [...mensagens];
                              updated[i].url = e.target.value;
                              setMensagens(updated);
                            }}
                            placeholder={msg.tipo === "ligacao" ? "Link do áudio WAV/MP3 da ligação (16kHz mono)..." : "Link do áudio OGG/MP3 da mensagem..."}
                            className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-xs focus:outline-none"
                          />
                          <Button
                            type="button"
                            variant="secondary"
                            className="text-xs shrink-0"
                            onClick={() => {
                              const el = document.getElementById(`file-upload-${i}`);
                              if (el) el.click();
                            }}
                          >
                            Upload
                          </Button>
                          <input
                            id={`file-upload-${i}`}
                            type="file"
                            accept={msg.tipo === "ligacao" ? "audio/wav,audio/mpeg,audio/mp3" : "audio/ogg,audio/mpeg,audio/mp3,audio/wav"}
                            className="hidden"
                            onChange={async (e) => {
                              const file = e.target.files?.[0];
                              if (!file) return;
                              const toastId = toast.loading("Enviando áudio...");
                              try {
                                const res = await uploadAccountMedia("chat-media", file);
                                const updated = [...mensagens];
                                updated[i].url = res.publicUrl;
                                setMensagens(updated);
                                toast.success("Áudio enviado com sucesso!", { id: toastId });
                              } catch (err: any) {
                                toast.error(`Erro no upload: ${err.message}`, { id: toastId });
                              }
                            }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                ))}

                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setMensagens([...mensagens, { tipo: "texto", conteudo: "" }])}
                  className="w-full border-dashed border-border"
                >
                  <Plus className="h-4 w-4 mr-1" /> Adicionar Mensagem Sequencial
                </Button>
              </div>

              <footer className="pt-4 border-t border-border flex justify-end gap-3 bg-muted/10 p-4 rounded-b-xl -mx-6 -mb-6">
                <Button type="button" variant="outline" onClick={closeModal}>Cancelar</Button>
                <Button type="submit">{editingId ? "Salvar Alterações" : "Criar Campanha"}</Button>
              </footer>
            </form>
          </div>
        </div>
      )}

      <MessageTemplatePicker
        open={templatePickerIndex !== null}
        hasMeta={hasMeta}
        onOpenChange={(next) => {
          if (!next) setTemplatePickerIndex(null);
        }}
        onSelect={(template) => {
          if (templatePickerIndex === null) return;
          const updated = [...mensagens];
          const bodyText = template.conteudo || "";

          // Só popula os campos de template Meta quando o template veio
          // do catálogo aprovado da Meta (hasMeta) — o catálogo interno
          // (disparador_message_templates) não tem nomes reconhecidos
          // pela Cloud API, e como uma campanha pode misturar canais
          // WAHA/Meta (session_id sorteado em start/route.ts), marcar
          // um template interno como se fosse Meta faria o worker tentar
          // sendTemplateMessage com um nome que a Meta nunca aprovou.
          if (hasMeta) {
            // Detecta quantas variáveis posicionais existem no body do
            // template — ex: "Olá {{1}}, débito na {{2}}" → 2 variáveis.
            const varCount = (bodyText.match(/\{\{(\d+)\}\}/g) || []).length;

            // Mapeamento padrão: {{1}} → nome do contato, demais → estático vazio
            const defaultMap: CampaignMessage["template_variable_map"] = Array.from(
              { length: varCount },
              (_, idx) =>
                idx === 0
                  ? { type: "contact_field" as const, field: "name" as const }
                  : { type: "static" as const, value: "" }
            );

            updated[templatePickerIndex] = {
              ...updated[templatePickerIndex],
              conteudo: bodyText,
              template_name: template.nome,
              template_language: template.language || "pt_BR",
              template_variable_map: defaultMap,
            };
          } else {
            updated[templatePickerIndex] = {
              ...updated[templatePickerIndex],
              conteudo: bodyText,
              template_name: undefined,
              template_language: undefined,
              template_variable_map: undefined,
            };
          }
          setMensagens(updated);
          setTemplatePickerIndex(null);
        }}
      />

      <AlertDialog
        open={startConfirmId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setStartConfirmId(null);
            setCampaignInfo(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirmar início da campanha</AlertDialogTitle>
            <AlertDialogDescription render={<div />}>
              <div className="space-y-3">
                {infoLoading && (
                  <p className="text-sm text-muted-foreground">
                    Consultando limites do canal...
                  </p>
                )}

                {!infoLoading && campaignInfo && campaignInfo.hasMeta && (
                  <div className="space-y-2">
                    {campaignInfo.channels.map((ch) => (
                      <div
                        key={ch.id}
                        className="rounded-md border p-3 text-sm space-y-1"
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-medium">
                            {ch.display_phone_number || ch.phone_number_id}
                          </span>
                          {ch.quality_rating && (
                            <span
                              className={
                                ch.quality_rating === "GREEN"
                                  ? "text-green-600 font-medium"
                                  : ch.quality_rating === "YELLOW"
                                  ? "text-yellow-600 font-medium"
                                  : "text-red-600 font-medium"
                              }
                            >
                              {ch.quality_rating}
                            </span>
                          )}
                        </div>
                        <div className="text-muted-foreground">
                          Tier:{" "}
                          <span className="font-medium text-foreground">
                            {ch.tier ?? "TIER_1K (padrão)"}
                          </span>{" "}
                          — até{" "}
                          <span className="font-medium text-foreground">
                            {ch.dailyLimit === Infinity
                              ? "ilimitado"
                              : (ch.dailyLimit ?? 1000).toLocaleString("pt-BR")}
                          </span>{" "}
                          disparos/dia
                        </div>
                        {ch.error && (
                          <div className="text-xs text-yellow-600">
                            ⚠ {ch.error} — limite padrão aplicado
                          </div>
                        )}
                      </div>
                    ))}
                    <p className="text-xs text-muted-foreground">
                      Se o número de contatos exceder o limite diário, os
                      disparos restantes serão agendados para os dias
                      seguintes automaticamente.
                    </p>
                  </div>
                )}

                {!infoLoading && campaignInfo && !campaignInfo.hasMeta && (
                  <p className="text-sm text-muted-foreground">
                    Canal WAHA — sem limites de tier da Meta.
                  </p>
                )}

                {!infoLoading && !campaignInfo && (
                  <p className="text-sm text-muted-foreground">
                    Deseja iniciar esta campanha?
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleStartConfirm}
              disabled={infoLoading}
            >
              {infoLoading ? "Consultando..." : "Iniciar campanha"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}