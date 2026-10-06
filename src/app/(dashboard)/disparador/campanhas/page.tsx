"use client";

import { apiFetch } from "@/lib/api-fetch";

import { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import {
  Plus,
  Play,
  Pause,
  Trash2,
  Megaphone,
  Clock,
  Tag,
  Smartphone,
  Layers,
  Calendar,
  X,
  Pencil,
  Loader2,
  BarChart2,
  Search,
  Download,
  ListChecks,
  Activity,
  AlertTriangle,
  Info,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  CalendarX2,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import Link from "next/link";
import { getDisparadorScope } from "@/lib/disparador/scope";
import { trackAction } from "@/hooks/use-telemetry";
import { useAuth } from "@/hooks/use-auth";
import { useDialogA11y } from "@/hooks/use-dialog-a11y";
import { formatBrasilia, WEEKDAY_LABELS } from "@/lib/disparador/send-window";
import { messagesPerContact, parseTemplateMode } from "@/lib/disparador/campaign-validation";
import { forecastFromCampaign } from "@/lib/disparador/dispatch-forecast";
import { CampaignWizard, type EditableCampaign } from "@/components/disparador/nova-campanha/campaign-wizard";
import { formatShortBrasilia } from "@/components/disparador/nova-campanha/forecast-summary";
import type { NamedChannel } from "@/components/disparador/nova-campanha/step-origem";

interface Campaign {
  id: string;
  nome: string;
  descricao?: string;
  status: string;
  session_ids: string[];
  tags_filtro: string[];
  mensagens: any[];
  intervalo_min: number;
  intervalo_max: number;
  janela_inicio: string;
  janela_fim: string;
  /** 0=dom…6=sáb; vazio/null = todos os dias (migration 144). */
  dias_envio?: number[] | null;
  agendamento?: string | null;
  // Migration 162 — data/hora final escolhida no assistente (referência).
  agendamento_fim?: string | null;
  created_at: string;
  updated_at?: string | null;
  // Migration 078 — disparo em lote (ver worker.ts)
  batch_size?: number;
  batch_pause_seconds?: number;
  // Teto de envios/hora, enforced ao vivo por worker.ts/cron/route.ts —
  // usado pela previsão de término (dispatch-forecast.ts).
  limite_por_hora?: number;
  // Reaproveitada para template_mode — ver parseTemplateMode. Tipo bruto
  // porque linhas antigas ainda têm o array-default [1,2,3,4,5,6].
  dias_permitidos?: unknown;
  // Migration 114 — modo de disparo "Segmentado". Não nulo só quando esse
  // modo foi escolhido; resolvido para um batch_size absoluto em
  // startCampaign.ts no momento real do início (ver comentário lá).
  batch_percent?: number | null;
  // Migration 127 — "Ao responder, enviar para o Webchat".
  webchat_enabled?: boolean;
  webchat_flow_id?: string | null;
  webchat_message?: string | null;
  webchat_button_text?: string | null;
  // Migration 132 — origem do público ("csv" | "tags" | "account"; null em
  // campanhas antigas). Só lido na edição (passo Público).
  audience_mode?: string | null;
  import_draft_id?: string | null;
  // Migration 160 — por que o último início falhou (a campanha voltou para
  // rascunho). Limpo ao editar ou ao iniciar com sucesso.
  motivo_falha_inicio?: string | null;
}

interface TagItem {
  id: string;
  name: string;
  color?: string;
}

interface Team {
  id: string;
  name: string;
}

interface WahaSession {
  id: string;
  name: string;
  phone_info?: { id: string };
  provider?: string;
  display_phone_number?: string;
  waba_id?: string;
  // whatsapp_config.team_id (migration 103) — usado só pelo filtro de
  // equipe do assistente (passo Origem), nunca enviado de volta ao servidor.
  team_id?: string | null;
  // Canal desabilitado não recebe envio: só aparece na lista se já estiver
  // selecionado (campanha antiga), para poder ser desmarcado.
  habilitado?: boolean;
}

type CampaignStatus =
  | "rascunho"
  | "agendado"
  | "preparando"
  | "em_execucao"
  | "pausada"
  | "encerrada"
  | "erro"
  | "bloqueada_por_risco";

const STATUS_COLORS: Record<CampaignStatus, string> = {
  rascunho: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  agendado: "bg-blue-500/10 text-blue-500 border border-blue-500/20",
  em_execucao: "bg-emerald-500/10 text-emerald-500 border border-emerald-500/20",
  pausada: "bg-amber-500/10 text-amber-500 border border-amber-500/20",
  encerrada: "bg-zinc-500/10 text-zinc-500 border border-zinc-500/20",
  preparando: "bg-blue-500/10 text-blue-600 border border-blue-500/20 dark:text-blue-400",
  erro: "bg-red-500/10 text-red-600 border border-red-500/20 dark:text-red-400",
  bloqueada_por_risco: "bg-red-500/10 text-red-600 border border-red-500/20 dark:text-red-400",
};

const STATUS_LABELS: Record<CampaignStatus, string> = {
  rascunho: "Rascunho",
  agendado: "Agendado",
  em_execucao: "Em Execução",
  pausada: "Pausada",
  encerrada: "Encerrada",
  preparando: "Preparando envio",
  erro: "Erro",
  bloqueada_por_risco: "Bloqueada por risco",
};

function statusKey(status: string): CampaignStatus {
  return (status in STATUS_LABELS ? status : "rascunho") as CampaignStatus;
}

/** "Seg–Sex" quando dias_envio = dias úteis; senão a lista; vazio = todos. */
function diasLabel(dias: number[] | null | undefined): string {
  if (!dias || dias.length === 0 || dias.length === 7) return "Todos os dias";
  const sorted = [...dias].sort((a, b) => a - b);
  if (sorted.join(",") === "1,2,3,4,5") return "Seg–Sex";
  return sorted.map((d) => WEEKDAY_LABELS[d]).join(", ");
}

/** Janela "08:00:00" (coluna time) → "08:00". */
function hhmm(value: string | null | undefined): string {
  return (value ?? "").slice(0, 5);
}

/**
 * Previsão de término do card (mesma função do assistente,
 * dispatch-forecast.ts): a partir do agendamento (ou de agora), na janela
 * e nos dias da campanha. Faixa otimista–conservadora.
 */
function cardForecastLabel(c: Campaign, contacts: number): string {
  const start = c.status === "agendado" && c.agendamento ? new Date(c.agendamento) : new Date();
  const mpc = messagesPerContact(parseTemplateMode(c.dias_permitidos), Array.isArray(c.mensagens) ? c.mensagens.length : 1);
  const f = forecastFromCampaign(c, contacts, mpc, start);
  const a = formatShortBrasilia(f.otimista.end);
  const b = formatShortBrasilia(f.conservador.end);
  return a === b ? a : `${a} – ${b}`;
}

// Formata tempo_medio_resposta (segundos) para a unidade mais legível —
// minutos abaixo de 1h, horas+minutos abaixo de 1 dia, dias+horas acima
// disso — em vez de sempre minutos, que fica ilegível para respostas que
// demoram dias (ex: 4320min em vez de 3d).
function formatResponseTime(seconds: number): string {
  if (seconds <= 0) return "—";
  const totalMin = Math.round(seconds / 60);
  if (totalMin < 60) return `${totalMin}min`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours < 24) return mins > 0 ? `${hours}h ${mins}min` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainHours = hours % 24;
  return remainHours > 0 ? `${days}d ${remainHours}h` : `${days}d`;
}

function getCampaignDurationSeconds(campaign?: Campaign | null): number | null {
  if (!campaign?.agendamento) return null;

  const startedAt = Date.parse(campaign.agendamento);
  if (!Number.isFinite(startedAt)) return null;

  const usesStoredEnd = ["encerrada", "erro", "bloqueada_por_risco", "pausada"].includes(
    campaign.status
  );
  const endedAt =
    usesStoredEnd && campaign.updated_at
      ? Date.parse(campaign.updated_at)
      : Date.now();

  if (!Number.isFinite(endedAt) || endedAt < startedAt) return null;
  return Math.max(0, Math.round((endedAt - startedAt) / 1000));
}

function formatCampaignDuration(seconds: number | null): string {
  if (seconds === null) return "—";

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (days > 0) {
    return hours > 0
      ? `${days}d ${hours}h ${minutes}min`
      : `${days}d ${minutes}min`;
  }
  if (hours > 0) {
    return minutes > 0
      ? `${hours}h ${minutes}min ${secs}s`
      : `${hours}h ${secs}s`;
  }
  if (minutes > 0) return `${minutes}min ${secs}s`;
  return `${secs}s`;
}

function campaignDurationLabel(campaign?: Campaign | null): string {
  return formatCampaignDuration(getCampaignDurationSeconds(campaign));
}

interface CampaignMetrics {
  total_contatos: number;
  total_enviados: number;
  total_entregues: number;
  total_lidos: number;
  total_respostas: number;
  total_blacklist: number;
  total_erros: number;
  tempo_medio_resposta: number;
  updated_at: string;
}

// Chaves de métrica clicável no modal de métricas — mapeiam 1:1 para
// os status aceitos por /api/disparador/campaigns/[id]/queue-details
// (ver STATUS_FILTERS naquela rota). "respondido" = enviados com
// replied_at (migration 126), a mesma contagem do card "Respostas".
type QueueDetailStatusKey = "total" | "agendado" | "enviado" | "entregue" | "lido" | "erro" | "bloqueado" | "respondido";

interface QueueDetailRow {
  id: string;
  contact_name: string | null;
  phone: string | null;
  status: string;
  mensagem_final: string | null;
  erro: string | null;
  tipo_erro: string | null;
  contact_id?: string | null;
  /** Conversa do contato no inbox (link do nome). */
  conversation_id?: string | null;
  data_hora: string | null;
}

// Nomes de tier da Meta traduzidos para PT-BR, exibidos no modal de
// confirmação de início de campanha.
const TIER_LABELS: Record<string, string> = {
  TIER_50: "Nível inicial",
  TIER_1K: "Nível 1",
  TIER_10K: "Nível 2",
  TIER_100K: "Nível 3",
  UNLIMITED: "Ilimitado",
};

function tierLabel(tier: string | null | undefined): string {
  if (!tier) return "Nível 1 (padrão)";
  return TIER_LABELS[tier] ?? tier;
}

// Qualidade do número (Meta) traduzida — usada só para exibição, nunca
// para bloquear o início da campanha (ver AlertDialog de confirmação).
const QUALITY_LABELS: Record<string, string> = {
  GREEN: "VERDE",
  YELLOW: "AMARELA",
  RED: "VERMELHA",
};

function qualityLabel(rating: string | null | undefined): string {
  if (!rating) return "";
  return QUALITY_LABELS[rating] ?? rating;
}

export default function CampanhasPage() {
  const { canManageMembers } = useAuth();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [recalculatingMetrics, setRecalculatingMetrics] = useState(false);
  const [tags, setTags] = useState<TagItem[]>([]);
  const [sessions, setSessions] = useState<WahaSession[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  // Resolvida uma vez em loadData() — escopo das consultas e do rascunho
  // local do assistente.
  const [accountId, setAccountId] = useState<string | null>(null);

  // Assistente "Nova campanha" (src/components/disparador/nova-campanha).
  // editingCampaign = campanha em rascunho ou agendada sendo editada.
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editingCampaign, setEditingCampaign] = useState<EditableCampaign | null>(null);
  // "Iniciar agora" numa campanha agendada (fila começa agora, não no horário).
  const [startNow, setStartNow] = useState(false);
  const [unscheduleTarget, setUnscheduleTarget] = useState<Campaign | null>(null);

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
  // Público real da campanha no modal de início (PRD-01) — mesma resolução
  // do startCampaign (GET .../audience).
  const [audienceInfo, setAudienceInfo] = useState<
    | { ok: true; total: number; blacklisted: number; eligible: number; source: string; source_label: string; tags: string[]; already_sent: number }
    | { ok: false; error: string }
    | null
  >(null);
  const [starting, setStarting] = useState(false);
  const [stopConfirm, setStopConfirm] = useState<{ id: string; nome: string } | null>(null);
  // Campanha cujo público está sendo calculado (descarta resposta atrasada).
  const audienceForRef = useRef<string | null>(null);

  // Modal de métricas por campanha
  const [metricsModal, setMetricsModal] = useState<{
    campaignId: string;
    nome: string;
  } | null>(null);
  const [metricsData, setMetricsData] = useState<CampaignMetrics | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(false);
  // Alimentado por fetchMetrics (inicial + refresh de 15s do modal) —
  // usado pelos cards da listagem pra mostrar tempo estimado sem
  // disparar uma query por campanha (evita N+1 na listagem, ver Passo 3).
  // Só tem dado pra campanhas cujo modal de métricas já foi aberto
  // nesta sessão.
  const [metricsMap, setMetricsMap] = useState<Record<string, CampaignMetrics>>({});
  // Contagem do card "A enviar" — não vem de campaign_metrics. A rota
  // queue-details agrega trabalho ainda não concluído:
  // agendado + pendente + pausado + enviando.
  const [agendadosCount, setAgendadosCount] = useState<number | null>(null);

  // Drilldown por contato de uma métrica do modal acima (segundo modal,
  // empilhado). `label` é só pro título ("Enviados — 668 mensagens").
  const [queueDetailModal, setQueueDetailModal] = useState<{
    status: QueueDetailStatusKey;
    label: string;
  } | null>(null);
  const [queueDetailRows, setQueueDetailRows] = useState<QueueDetailRow[]>([]);
  const [queueDetailTotal, setQueueDetailTotal] = useState(0);
  const [queueDetailPage, setQueueDetailPage] = useState(1);
  const [queueDetailSearchInput, setQueueDetailSearchInput] = useState("");
  const [queueDetailSearch, setQueueDetailSearch] = useState("");
  const [queueDetailLoading, setQueueDetailLoading] = useState(false);
  const [queueDetailExporting, setQueueDetailExporting] = useState(false);
  // Itens por página do detalhamento (seletor no rodapé do modal).
  const QUEUE_DETAIL_PAGE_SIZES = [20, 50, 100, 200] as const;
  const [queueDetailPageSize, setQueueDetailPageSize] = useState<number>(20);

  const [utmMetrics, setUtmMetrics] = useState<{
    total_cliques: number;
    total_cliques_unicos: number;
    total_entraram_ddmpay: number;
    total_acordos: number;
    total_pagaram: number;
    valor_total: number;
  } | null>(null);
  const [utmMetricsLoading, setUtmMetricsLoading] = useState(false);
  const metricsRefreshRef = useRef<NodeJS.Timeout | null>(null);

  // Load Data on Mount
  useEffect(() => {
    loadData();
  }, []);

  // Garante que o auto-refresh de métricas pare se o componente
  // desmontar com o modal ainda aberto (ex: navegação para outra rota).
  useEffect(() => {
    return () => {
      if (metricsRefreshRef.current) clearInterval(metricsRefreshRef.current);
    };
  }, []);

  // Atualiza a lista enquanto houver campanha em andamento ou agendada (a
  // passagem agendado → preparando → em execução acontece no cron). As
  // linhas novas são mescladas nas antigas: o poll lê menos colunas.
  useEffect(() => {
    const hasLiveCampaign = campaigns.some((c) =>
      ["em_execucao", "agendado", "preparando"].includes(c.status)
    );
    if (!hasLiveCampaign) return;

    const interval = setInterval(async () => {
      try {
        const supabase = createClient();
        const { accountId: scopedAccountId } = await getDisparadorScope(supabase);
        const { data: campaignList } = await supabase
          .from("campaigns")
          .select("id, nome, descricao, status, session_ids, tags_filtro, mensagens, intervalo_min, intervalo_max, janela_inicio, janela_fim, agendamento, updated_at, created_by, batch_size, batch_pause_seconds, batch_percent, limite_por_hora, dias_permitidos, webchat_enabled, webchat_flow_id, webchat_message, webchat_button_text, audience_mode, import_draft_id, dias_envio, motivo_falha_inicio")
          .eq("account_id", scopedAccountId)
          .order("created_at", { ascending: false });
        if (campaignList) {
          setCampaigns((prev) => {
            const byId = new Map(prev.map((c) => [c.id, c]));
            return (campaignList as unknown as Campaign[]).map((c) => ({ ...byId.get(c.id), ...c }));
          });
        }
      } catch (err) {
        console.error("Failed to auto-reload campaigns:", err);
      }
    }, 30000);

    return () => clearInterval(interval);
  }, [campaigns]);

  // Tabulações (tags com kind='outcome') — só essas fazem sentido como
  // filtro de "contato já teve este desfecho de atendimento"; tags de
  // contato genéricas (kind='contact') não entram aqui, mesmo padrão de
  // filtro usado em tabulacoes-manager.tsx.
  const loadTags = async () => {
    const supabase = createClient();
    const { data: tagList } = await supabase
      .from("tags")
      .select("id, name, color")
      .eq("kind", "outcome")
      .order("name");
    setTags(tagList ?? []);
  };

  const loadData = async () => {
    setLoading(true);
    try {
      const supabase = createClient();

      const { accountId: scopedAccountId } = await getDisparadorScope(supabase);
      setAccountId(scopedAccountId);

      // Load Campaigns
      const { data: campaignList } = await supabase
        .from("campaigns")
        .select("*")
        .eq("account_id", scopedAccountId)
        .order("created_at", { ascending: false });
      setCampaigns(campaignList ?? []);

      // Métricas resumidas por campanha — buscadas junto (1 query pra
      // todas, não N+1) para que os cards já mostrem
      // enviados/entregues/lidos/respostas sem precisar abrir "Ver
      // métricas" primeiro. metricsMap também alimenta a previsão de
      // término dos cards (dispatch-forecast.ts).
      const campaignIds = (campaignList ?? []).map((c) => c.id);
      if (campaignIds.length > 0) {
        const { data: metricsList } = await supabase
          .from("campaign_metrics")
          .select("*")
          .in("campaign_id", campaignIds);
        if (metricsList) {
          setMetricsMap((prev) => {
            const next = { ...prev };
            for (const m of metricsList) next[m.campaign_id] = m;
            return next;
          });
        }
      }

      // Load Tags
      await loadTags();

      // Equipes da conta — só para o filtro "Equipe" do passo Público (ver
      // filteredSessions); mesmo padrão de fetch usado em /canais e
      // /equipes.
      const { data: teamList } = await supabase
        .from("teams")
        .select("id, name")
        .eq("account_id", scopedAccountId)
        .order("name", { ascending: true });
      setTeams((teamList ?? []) as Team[]);

      // Canais de WhatsApp (WAHA + Meta). Os desabilitados também vêm, só
      // para identificar (e deixar desmarcar) um canal desabilitado que já
      // estava numa campanha em edição — a lista oferece só os habilitados
      // e selecionar um desabilitado é erro (campaign-validation.ts).
      const { data: configList } = await supabase
        .from("whatsapp_config")
        .select("id, waha_session, provider, display_phone_number, waba_id, team_id, habilitado")
        .eq("account_id", scopedAccountId);

      const wahaSessions = (configList ?? []).map((c) => ({
        id: c.id,
        name: (c.provider === "meta"
          ? `WhatsApp Oficial (Meta)${c.display_phone_number ? ` — ${c.display_phone_number}` : ""}`
          : (c.waha_session || "Sessão WAHA")) + (c.habilitado === false ? " (desabilitado)" : ""),
        provider: c.provider,
        display_phone_number: c.display_phone_number,
        waba_id: c.waba_id,
        team_id: c.team_id,
        habilitado: c.habilitado !== false,
      }));
      setSessions(wahaSessions);
    } catch (err) {
      console.error("Failed to load campaigns metadata:", err);
    } finally {
      setLoading(false);
    }
  };

  // Abre o modal e busca info do canal antes de confirmar. `now` = "Iniciar
  // agora" numa agendada (a fila começa agora, não no horário agendado).
  const handleStartClick = async (id: string, now = false) => {
    setStartNow(now);
    setStartConfirmId(id);
    setCampaignInfo(null);
    setAudienceInfo(null);
    setInfoLoading(true);
    audienceForRef.current = id;
    // Retomar campanha pausada não recalcula o público (startCampaign retoma
    // a fila existente) — só campanhas que ainda vão montar a fila.
    const isResume = campaigns.find((c) => c.id === id)?.status === "pausada";
    if (isResume) {
      setAudienceInfo({ ok: true, total: -1, blacklisted: 0, eligible: -1, source: "resume", source_label: "", tags: [], already_sent: 0 });
    } else {
      apiFetch(`/api/disparador/campaigns/${id}/audience`)
        .then((r) => r.json())
        .then((data) => {
          if (audienceForRef.current !== id) return;
          setAudienceInfo(
            data?.ok === true || data?.ok === false
              ? data
              : { ok: false, error: data?.error ?? "Não foi possível calcular o público" },
          );
        })
        .catch(() => {
          if (audienceForRef.current === id) setAudienceInfo({ ok: false, error: "Não foi possível calcular o público" });
        });
    }
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
    if (!startConfirmId || starting) return;
    const id = startConfirmId;
    setStarting(true);
    try {
      const res = await apiFetch(`/api/disparador/campaigns/${id}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agora: startNow }),
      });
      if (res.ok) {
        toast.success("Campanha iniciada e disparos agendados!");
        trackAction("campaign_started", { campaign_id: id });
        setStartConfirmId(null);
        setCampaignInfo(null);
        setAudienceInfo(null);
        loadData();
      } else {
        const err = await res.json().catch(() => ({}));
        // A campanha voltou para rascunho com o motivo no card (migration 160).
        loadData();
        throw new Error(err.error || "Erro ao iniciar campanha");
      }
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setStarting(false);
    }
  };

  // Recalcula campaign_metrics a partir de disp_message_queue para todas
  // as campanhas elegíveis da conta — corrige drift acumulado por
  // caminhos de escrita que esqueceram de chamar increment_campaign_metric
  // (ver migration 112). Owner/admin only — gated na renderização do botão.
  const handleRecalculateMetrics = async () => {
    setRecalculatingMetrics(true);
    try {
      const res = await apiFetch("/api/disparador/campaigns/recalculate-metrics");
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Erro ao recalcular métricas");
      }
      const { total, success, failed } = data as {
        total: number;
        success: number;
        failed: number;
        errors: string[];
      };
      if (failed > 0) {
        toast.warning(
          `Recalculado ${success}/${total} — ${failed} falha${failed === 1 ? "" : "s"}.`
        );
      } else {
        toast.success(`Métricas recalculadas: ${success}/${total} campanhas.`);
      }
    } catch (err: any) {
      toast.error(err.message || "Erro ao recalcular métricas");
    } finally {
      setRecalculatingMetrics(false);
    }
  };

  // Pause Campaign
  const handlePause = async (id: string) => {
    try {
      const res = await apiFetch(`/api/disparador/campaigns/${id}/stop?action=pause`, { method: "POST" });
      if (res.ok) {
        toast.success("Campanha pausada com sucesso.");
        loadData();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Erro ao pausar campanha.");
      }
    } catch (err: any) {
      toast.error("Erro ao pausar campanha.");
    }
  };

  // Stop/Close Campaign
  const handleStop = async (id: string) => {
    setStopConfirm(null);
    try {
      const res = await apiFetch(`/api/disparador/campaigns/${id}/stop?action=stop`, { method: "POST" });
      if (res.ok) {
        toast.success("Campanha encerrada e fila cancelada.");
        loadData();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Erro ao encerrar campanha.");
      }
    } catch (err: any) {
      toast.error("Erro ao encerrar campanha.");
    }
  };

  // Editar: rascunho ou agendada (a fila ainda não existe). Os dados vêm
  // sempre da linha real da campanha, nunca do rascunho local.
  const handleEditClick = (campaign: Campaign) => {
    setEditingCampaign(campaign as unknown as EditableCampaign);
    setWizardOpen(true);
  };

  const openCreateModal = () => {
    setEditingCampaign(null);
    setWizardOpen(true);
  };

  const closeWizard = () => {
    setWizardOpen(false);
    setEditingCampaign(null);
  };

  // Desagendar: agendada → rascunho (sem agendamento), no servidor.
  const handleUnschedule = async (campaign: Campaign) => {
    setUnscheduleTarget(null);
    try {
      const res = await apiFetch(`/api/disparador/campaigns/${campaign.id}/unschedule`, { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Erro ao desagendar a campanha.");
      toast.success("Campanha desagendada. Ela voltou para rascunho.");
      loadData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao desagendar a campanha.");
    }
  };

  // Canais no formato do assistente (equipe, WABA, habilitado).
  const wizardChannels: NamedChannel[] = useMemo(
    () =>
      sessions.map((s) => ({
        id: s.id,
        name: s.name,
        provider: s.provider ?? null,
        waba_id: s.waba_id ?? null,
        habilitado: s.habilitado,
        team_id: s.team_id ?? null,
        label: s.name,
      })),
    [sessions]
  );

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

  // Busca métricas de campanha + UTM. `silent` evita o toast de erro nos
  // refreshes automáticos (handleMetricsClick já mostra o toast na busca
  // inicial) para não empilhar notificações a cada 15s de falha.
  const fetchMetrics = async (
    campaignId: string,
    campaignNome: string,
    silent = false
  ) => {
    try {
      const supabase = createClient();
      const { data } = await supabase
        .from("campaign_metrics")
        .select("*")
        .eq("campaign_id", campaignId)
        .maybeSingle();
      setMetricsData(data ?? null);
      if (data) {
        setMetricsMap((prev) => ({ ...prev, [campaignId]: data }));
      }
    } catch {
      if (!silent) toast.error("Erro ao carregar métricas");
    }

    // "A enviar" não vem de campaign_metrics. O status lógico "agendado"
    // da rota agrega agendado + pendente + pausado + enviando; assim a
    // contagem não zera só porque a campanha foi pausada.
    try {
      const res = await apiFetch(
        `/api/disparador/campaigns/${campaignId}/queue-details?status=agendado&page=1`
      );
      if (res.ok) {
        const data = await res.json();
        setAgendadosCount(data.total ?? 0);
      }
    } catch {
      // silencioso — mesmo padrão do UTM abaixo, não é crítico pro modal
    }

    setUtmMetricsLoading(true);
    try {
      const utmRes = await fetch(
        `/api/disparador/utm/metricas?campanha=${encodeURIComponent(campaignNome)}&canal=whatsapp`
      );
      if (utmRes.ok) {
        const utmData = await utmRes.json();
        setUtmMetrics(utmData.metricas ?? null);
      } else if (!silent) {
        // UTM é opcional, mas falha de serviço/chave precisa aparecer.
        console.warn("[UTM] métricas indisponíveis:", utmRes.status);
        toast.warning(`Métricas de UTM indisponíveis (HTTP ${utmRes.status})`);
      }
    } catch {
      // rede — silencioso, UTM é opcional
    } finally {
      setUtmMetricsLoading(false);
    }
  };

  const handleMetricsClick = async (campaign: typeof campaigns[0]) => {
    setMetricsModal({ campaignId: campaign.id, nome: campaign.nome });
    setMetricsData(null);
    setAgendadosCount(null);
    setMetricsLoading(true);
    await fetchMetrics(campaign.id, campaign.nome);
    setMetricsLoading(false);

    // Auto-refresh a cada 15 segundos enquanto o modal estiver aberto.
    if (metricsRefreshRef.current) clearInterval(metricsRefreshRef.current);
    metricsRefreshRef.current = setInterval(() => {
      fetchMetrics(campaign.id, campaign.nome, true);
    }, 15000);
  };

  // Abre o drilldown por contato de uma métrica clicada (segundo modal,
  // empilhado sobre o de métricas). A busca de fato acontece no efeito
  // logo abaixo, disparado pela mudança de queueDetailModal/page/search.
  const openQueueDetail = (status: QueueDetailStatusKey, label: string) => {
    setQueueDetailModal({ status, label });
    setQueueDetailRows([]);
    setQueueDetailTotal(0);
    setQueueDetailPage(1);
    setQueueDetailSearchInput("");
    setQueueDetailSearch("");
  };

  // Debounce da busca do drilldown — evita uma chamada por tecla digitada.
  useEffect(() => {
    const handle = setTimeout(() => {
      setQueueDetailSearch(queueDetailSearchInput);
      setQueueDetailPage(1);
    }, 400);
    return () => clearTimeout(handle);
  }, [queueDetailSearchInput]);

  useEffect(() => {
    if (!queueDetailModal || !metricsModal) return;
    let cancelled = false;
    setQueueDetailLoading(true);
    (async () => {
      try {
        const qs = new URLSearchParams({
          status: queueDetailModal.status,
          page: String(queueDetailPage),
          pageSize: String(queueDetailPageSize),
        });
        if (queueDetailSearch) qs.set("search", queueDetailSearch);
        const res = await apiFetch(
          `/api/disparador/campaigns/${metricsModal.campaignId}/queue-details?${qs.toString()}`
        );
        if (!res.ok) throw new Error("Erro ao carregar detalhamento");
        const data = await res.json();
        if (cancelled) return;
        setQueueDetailRows(data.rows ?? []);
        setQueueDetailTotal(data.total ?? 0);
      } catch (err: any) {
        if (!cancelled) toast.error(err.message || "Erro ao carregar detalhamento");
      } finally {
        if (!cancelled) setQueueDetailLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [queueDetailModal, queueDetailPage, queueDetailSearch, metricsModal, queueDetailPageSize]);

  const handleExportQueueDetailXlsx = async () => {
    if (!queueDetailModal || !metricsModal) return;
    setQueueDetailExporting(true);
    try {
      const qs = new URLSearchParams({
        status: queueDetailModal.status,
        export: "xlsx",
      });
      if (queueDetailSearch) qs.set("search", queueDetailSearch);
      const res = await apiFetch(
        `/api/disparador/campaigns/${metricsModal.campaignId}/queue-details?${qs.toString()}`
      );
      if (!res.ok) throw new Error("Erro ao exportar XLSX");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `campanha_${queueDetailModal.status}_${metricsModal.campaignId}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      toast.error(err.message || "Erro ao exportar XLSX");
    } finally {
      setQueueDetailExporting(false);
    }
  };

  const closeMetricsModal = () => {
    if (metricsRefreshRef.current) {
      clearInterval(metricsRefreshRef.current);
      metricsRefreshRef.current = null;
    }
    setMetricsModal(null);
    setMetricsData(null);
    setUtmMetrics(null);
    setQueueDetailModal(null);
  };


  // Modais feitos à mão: foco entra no modal ao abrir e volta ao botão de
  // origem ao fechar. Métricas e drilldown fecham com Esc.
  const metricsA11y = useDialogA11y(!!metricsModal, closeMetricsModal);
  const queueDetailA11y = useDialogA11y(!!(queueDetailModal && metricsModal), () => setQueueDetailModal(null));

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col space-y-4 p-4 lg:p-6 overflow-hidden">
      {/* Header */}
      <div className="flex flex-col justify-between gap-4 border-b border-border/40 pb-4 sm:flex-row sm:items-center">
        <div>
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden="true">
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
        <div className="flex flex-wrap gap-2 self-start">
          {canManageMembers && (
            <Button
              variant="outline"
              className="gap-1.5 text-xs h-9"
              onClick={handleRecalculateMetrics}
              disabled={recalculatingMetrics}
            >
              <RefreshCw aria-hidden="true" className={cn("h-4 w-4", recalculatingMetrics && "animate-spin")} />
              Recalcular métricas
            </Button>
          )}
          <Link
            href="/disparador/monitor"
            className={cn(buttonVariants({ variant: "outline" }), "gap-1.5 text-xs h-9")}
          >
            <Activity className="h-4 w-4 text-primary" aria-hidden="true" /> Monitor em tempo real
          </Link>
          <Button onClick={openCreateModal} className="gap-1.5 h-9 text-xs">
            <Plus className="h-4 w-4" aria-hidden="true" /> Nova Campanha
          </Button>
        </div>
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
                <header className="flex justify-between items-start gap-2">
                  <h3 className="min-w-0 font-bold text-foreground truncate" title={c.nome}>{c.nome}</h3>
                  <span className={`shrink-0 text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_COLORS[statusKey(c.status)]}`}>
                    {STATUS_LABELS[statusKey(c.status)]}
                  </span>
                </header>

                <p className="text-xs text-muted-foreground line-clamp-2 min-h-[32px]">{c.descricao || "Sem descrição fornecida."}</p>

                {c.status === "agendado" && c.agendamento && (
                  <p className="flex items-center gap-1.5 rounded-md bg-blue-500/10 px-3 py-2 text-xs text-blue-700 dark:text-blue-300">
                    <Calendar className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    Começa {formatShortBrasilia(new Date(c.agendamento))} (Brasília)
                  </p>
                )}

                {/* Migration 160: o início falhou (ex.: agendada com template
                    inválido) e a campanha voltou para rascunho — nunca em
                    silêncio. */}
                {c.status === "rascunho" && c.motivo_falha_inicio && (
                  <p
                    role="alert"
                    className="flex items-start gap-1.5 rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-[11px] font-medium text-red-600 dark:text-red-400"
                  >
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>{c.motivo_falha_inicio}</span>
                  </p>
                )}

                {/* Configurations Overview */}
                <div className="grid grid-cols-2 gap-2 pt-2 text-xs text-muted-foreground border-t border-border/40">
                  <div className="flex items-center gap-1.5 truncate">
                    <Layers className="h-3.5 w-3.5" aria-hidden="true" />{" "}
                    {c.batch_percent != null
                      ? `Segmentado ${c.batch_percent}% / ${Math.round((c.batch_pause_seconds ?? 0) / 60)} min`
                      : (c.batch_size ?? 1) > 1 && (c.batch_pause_seconds ?? 0) === 0
                        ? "Imediato"
                        : `Modo antigo (${c.intervalo_min}–${c.intervalo_max}s)`}
                  </div>
                  <div className="flex items-center gap-1.5 truncate">
                    <Tag className="h-3.5 w-3.5" aria-hidden="true" /> Tabulação:{" "}
                    {c.tags_filtro.length === 0
                      ? "Todos"
                      : c.tags_filtro.length === 1
                        ? c.tags_filtro[0]
                        : `${c.tags_filtro[0]} +${c.tags_filtro.length - 1}`}
                  </div>
                  <div className="flex items-center gap-1.5 truncate">
                    <Smartphone className="h-3.5 w-3.5" aria-hidden="true" /> Canais: {c.session_ids.length}
                  </div>
                  <div className="flex items-center gap-1.5 truncate">
                    <Clock className="h-3.5 w-3.5" aria-hidden="true" /> {diasLabel(c.dias_envio)} {hhmm(c.janela_inicio)}–{hhmm(c.janela_fim)}
                  </div>
                </div>

                {/* Métricas resumidas — vêm de metricsMap, pré-carregado pra
                    TODAS as campanhas em loadData() (1 query, não N+1); só
                    aparece quando a campanha já tem uma linha em
                    campaign_metrics (isto é, o envio já começou pelo menos
                    uma vez). "Ver métricas" abre o modal com o detalhe
                    completo (taxas, UTM, etc). */}
                {metricsMap[c.id] && (
                  <div className="grid grid-cols-4 gap-2 pt-2 text-center text-[11px] border-t border-border/40">
                    <div>
                      <p className="font-semibold text-foreground">{metricsMap[c.id].total_enviados}</p>
                      <p className="text-muted-foreground">Enviados</p>
                    </div>
                    <div>
                      <p className="font-semibold text-foreground">{metricsMap[c.id].total_entregues}</p>
                      <p className="text-muted-foreground">Entregues</p>
                    </div>
                    <div>
                      <p className="font-semibold text-foreground">{metricsMap[c.id].total_lidos}</p>
                      <p className="text-muted-foreground">Lidos</p>
                    </div>
                    <div>
                      <p className="font-semibold text-foreground">{metricsMap[c.id].total_respostas}</p>
                      <p className="text-muted-foreground">Respostas</p>
                    </div>
                  </div>
                )}

                {/* Tempo real para campanhas que já começaram. Encerradas
                    mostram o total efetivo início→fim; enquanto executam,
                    mostramos o decorrido. Antes do primeiro início seguimos
                    exibindo a estimativa calculada pela configuração. */}
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  {c.status === "encerrada" && campaignDurationLabel(c) !== "—" ? (
                    <>{campaignDurationLabel(c)} total</>
                  ) : c.status === "em_execucao" && campaignDurationLabel(c) !== "—" ? (
                    <>{campaignDurationLabel(c)} em execução</>
                  ) : c.status === "pausada" && campaignDurationLabel(c) !== "—" ? (
                    <>{campaignDurationLabel(c)} até a pausa</>
                  ) : metricsMap[c.id]?.total_contatos ? (
                    <>Término previsto: {cardForecastLabel(c, metricsMap[c.id].total_contatos)}</>
                  ) : (
                    "—"
                  )}
                </div>

                {/* Actions row */}
                <div className="flex flex-wrap justify-between items-center gap-2 pt-3 border-t border-border/40">
                  <div className="flex gap-1.5">
                    {c.status === "em_execucao" ? (
                      <Button size="sm" variant="outline" onClick={() => handlePause(c.id)} className="h-9 gap-1 text-xs">
                        <Pause className="h-3.5 w-3.5" aria-hidden="true" /> Pausar
                      </Button>
                    ) : c.status === "agendado" ? (
                      <>
                        <Button size="sm" onClick={() => handleStartClick(c.id, true)} className="h-9 gap-1 text-xs">
                          <Play className="h-3.5 w-3.5" aria-hidden="true" /> Iniciar agora
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setUnscheduleTarget(c)} className="h-9 gap-1 text-xs">
                          <CalendarX2 className="h-3.5 w-3.5" aria-hidden="true" /> Desagendar
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        onClick={() => handleStartClick(c.id)}
                        disabled={!["rascunho", "pausada"].includes(c.status)}
                        className="h-9 gap-1 text-xs"
                      >
                        <Play className="h-3.5 w-3.5" aria-hidden="true" /> {c.status === "pausada" ? "Retomar" : "Iniciar"}
                      </Button>
                    )}
                    {c.status === "em_execucao" || c.status === "pausada" ? (
                      <Button size="sm" variant="outline" onClick={() => setStopConfirm({ id: c.id, nome: c.nome })} className="h-9 text-xs">
                        Encerrar
                      </Button>
                    ) : null}
                  </div>
                  {/* Ações só com ícone: aria-label com o nome da campanha
                      (leitor de tela) e alvo de 36px (toque no celular). */}
                  <div className="flex gap-1">
                    <Link
                      href={`/disparador/campanhas/${c.id}`}
                      className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "h-9 w-9 text-muted-foreground hover:text-foreground")}
                      title="Ver por contato"
                      aria-label={`Ver envios por contato — ${c.nome}`}
                    >
                      <ListChecks className="h-4 w-4" aria-hidden="true" />
                    </Link>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => handleMetricsClick(c)}
                      className="h-9 w-9 text-muted-foreground hover:text-foreground"
                      title="Ver métricas"
                      aria-label={`Ver métricas — ${c.nome}`}
                    >
                      <BarChart2 className="h-4 w-4" aria-hidden="true" />
                    </Button>
                    {(c.status === "rascunho" || c.status === "agendado") && (
                      <Button size="icon" variant="ghost" onClick={() => handleEditClick(c)} title="Editar campanha" aria-label={`Editar campanha — ${c.nome}`} className="h-9 w-9 text-muted-foreground hover:text-foreground">
                        <Pencil className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    )}
                    <Button size="icon" variant="ghost" onClick={() => handleDelete(c)} title="Excluir campanha" aria-label={`Excluir campanha — ${c.nome}`} className="h-9 w-9 text-red-500 hover:text-red-600">
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Assistente "Nova campanha" — Origem, Configurações, Conteúdo e Revisão. */}
      <CampaignWizard
        open={wizardOpen}
        editing={editingCampaign}
        accountId={accountId}
        channels={wizardChannels}
        teams={teams}
        tags={tags}
        onClose={closeWizard}
        onSaved={loadData}
      />

      {/* Desagendar: confirmação. */}
      <AlertDialog open={unscheduleTarget !== null} onOpenChange={(open) => !open && setUnscheduleTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Desagendar campanha?</AlertDialogTitle>
            <AlertDialogDescription>
              &quot;{unscheduleTarget?.nome}&quot; não vai começar sozinha
              {unscheduleTarget?.agendamento ? ` em ${formatBrasilia(unscheduleTarget.agendamento)} (Brasília)` : ""}. Ela volta para
              rascunho: dá para editar e agendar de novo, ou iniciar à mão.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Voltar</AlertDialogCancel>
            <Button onClick={() => unscheduleTarget && handleUnschedule(unscheduleTarget)}>Desagendar</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
            <AlertDialogTitle>{startNow ? "Iniciar agora a campanha agendada?" : "Confirmar início da campanha"}</AlertDialogTitle>
            <AlertDialogDescription render={<div />}>
              <div className="space-y-3">
                {startNow && (
                  <p className="text-sm text-muted-foreground">
                    O agendamento é ignorado: a fila começa agora, dentro do horário de envio da campanha.
                  </p>
                )}
                {/* Público real (PRD-01): quantos e de onde, antes de enviar. */}
                {audienceInfo === null ? (
                  <p className="text-sm text-muted-foreground">Calculando público…</p>
                ) : audienceInfo.ok && audienceInfo.source === "resume" ? (
                  <p className="text-sm text-muted-foreground">
                    A campanha está pausada: os envios que ficaram na fila serão retomados.
                  </p>
                ) : audienceInfo.ok ? (
                  <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm">
                    <p className="text-foreground">
                      Enviar para{" "}
                      <span className="text-base font-semibold">{audienceInfo.total.toLocaleString("pt-BR")}</span>{" "}
                      {audienceInfo.source_label}
                      {audienceInfo.tags.length > 0 && <> ({audienceInfo.tags.join(", ")})</>}.
                    </p>
                    {audienceInfo.blacklisted > 0 ? (
                      <div className="mt-2 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-800 dark:text-amber-300">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>
                          De <strong>{audienceInfo.total.toLocaleString("pt-BR")}</strong> contatos válidos,{" "}
                          <strong>{audienceInfo.blacklisted.toLocaleString("pt-BR")}</strong>{" "}
                          {audienceInfo.blacklisted === 1 ? "está" : "estão"} na Blacklist e{" "}
                          {audienceInfo.blacklisted === 1 ? "será removido" : "serão removidos"} automaticamente.
                          A campanha seguirá com <strong>{audienceInfo.eligible.toLocaleString("pt-BR")}</strong>{" "}
                          {audienceInfo.eligible === 1 ? "contato elegível" : "contatos elegíveis"}.
                        </span>
                      </div>
                    ) : (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Nenhum contato deste público está na Blacklist.
                      </p>
                    )}
                    {audienceInfo.already_sent > 0 && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {audienceInfo.already_sent.toLocaleString("pt-BR")} já receberam nesta campanha e também serão pulados.
                      </p>
                    )}
                    {audienceInfo.source === "account" && (
                      <p className="mt-2 flex items-start gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        Sem CSV e sem tabulação: a campanha vai para a conta inteira.
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="flex items-start gap-2 rounded-md border border-red-500/50 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-400">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{audienceInfo.error}</span>
                  </div>
                )}
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
                              {qualityLabel(ch.quality_rating)}
                            </span>
                          )}
                        </div>
                        <div className="text-muted-foreground">
                          Nível:{" "}
                          <span className="font-medium text-foreground">
                            {tierLabel(ch.tier)}
                          </span>{" "}
                          — até{" "}
                          <span className="font-medium text-foreground">
                            {ch.dailyLimit === Infinity
                              ? "ilimitado"
                              : (ch.dailyLimit ?? 1000).toLocaleString("pt-BR")}
                          </span>{" "}
                          disparos/dia
                        </div>

                        {ch.quality_rating === "RED" && (
                          <div className="flex items-start gap-2 rounded-md border border-red-500 bg-red-500/10 p-2 text-red-700 dark:text-red-400">
                            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                            <span className="font-medium">
                              Qualidade VERMELHA — este número está em risco de
                              restrição pela Meta. Avalie o conteúdo das
                              mensagens antes de prosseguir.
                            </span>
                          </div>
                        )}

                        {ch.quality_rating === "YELLOW" && (
                          <div className="flex items-start gap-1.5 text-xs text-muted-foreground">
                            <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                            <span>
                              Qualidade AMARELA — número em observação pela
                              Meta, acompanhe o desempenho dos disparos.
                            </span>
                          </div>
                        )}

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
                    Canal WAHA — sem limite de nível da Meta.
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
            <Button
              onClick={handleStartConfirm}
              disabled={infoLoading || starting || !audienceInfo || !audienceInfo.ok}
            >
              {starting ? "Iniciando…" : infoLoading ? "Consultando..." : "Iniciar campanha"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Encerrar cancela a fila: confirmação com o nome da campanha. */}
      <AlertDialog open={stopConfirm !== null} onOpenChange={(open) => !open && setStopConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Encerrar campanha?</AlertDialogTitle>
            <AlertDialogDescription>
              &quot;{stopConfirm?.nome}&quot; será encerrada e os envios que ainda estão na fila serão cancelados. Não
              dá para retomar depois.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Voltar</AlertDialogCancel>
            <Button variant="destructive" onClick={() => stopConfirm && handleStop(stopConfirm.id)}>
              Encerrar campanha
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {metricsModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div
            ref={metricsA11y.ref}
            tabIndex={-1}
            onKeyDown={metricsA11y.onKeyDown}
            role="dialog"
            aria-modal="true"
            aria-labelledby="campaign-metrics-title"
            className="bg-card border border-border w-full max-w-md rounded-xl shadow-2xl flex flex-col max-h-[calc(100dvh-2rem)] outline-none"
          >
            <header className="px-4 py-3 sm:px-6 sm:py-4 border-b border-border flex justify-between items-center gap-2">
              <div className="min-w-0">
                <h3 id="campaign-metrics-title" className="font-bold text-foreground">Métricas da Campanha</h3>
                <p className="text-xs text-muted-foreground truncate">
                  {metricsModal.nome}
                </p>
              </div>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Fechar"
                className="h-9 w-9 shrink-0"
                onClick={closeMetricsModal}
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </Button>
            </header>

            <div className="p-4 sm:p-6 overflow-y-auto sm:max-h-[70vh]">
              {metricsLoading && (
                <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin" />
                  <span className="text-sm">Carregando métricas...</span>
                </div>
              )}

              {!metricsLoading && !metricsData && (
                <div className="text-center py-8 text-sm text-muted-foreground">
                  Nenhuma métrica disponível para esta campanha.
                </div>
              )}

              {!metricsLoading && metricsData && (
                <div className="space-y-4">
                  {/* Grid de KPIs — métricas com `status` abrem o drilldown por
                      contato (ver queueDetailModal). Total de Contatos usa o
                      status lógico `total`, que lista toda a fila da campanha. */}
                  <div className="grid grid-cols-2 gap-3">
                    {[
                      { label: "Total de Contatos", value: metricsData.total_contatos, color: "text-foreground", status: "total" as const },
                      { label: "A enviar", value: agendadosCount ?? 0, color: "text-cyan-500", status: "agendado" as const },
                      { label: "Enviados", value: metricsData.total_enviados, color: "text-blue-500", status: "enviado" as const },
                      { label: "Entregues", value: metricsData.total_entregues, color: "text-green-500", status: "entregue" as const },
                      { label: "Lidos", value: metricsData.total_lidos, color: "text-purple-500", status: "lido" as const },
                      { label: "Respostas", value: metricsData.total_respostas, color: "text-orange-500", status: "respondido" as const },
                      { label: "Blacklist", value: metricsData.total_blacklist, color: "text-yellow-500", status: "bloqueado" as const },
                      { label: "Erros", value: metricsData.total_erros, color: "text-red-500", status: "erro" as const },
                      {
                        label: "Tempo Médio Resposta",
                        value: formatResponseTime(metricsData.tempo_medio_resposta),
                        color: "text-foreground",
                        status: null,
                      },
                      {
                        label: "Tempo Total Campanha",
                        value: campaignDurationLabel(
                          campaigns.find((campaign) => campaign.id === metricsModal.campaignId)
                        ),
                        color: "text-foreground",
                        status: null,
                      },
                    ].map(({ label, value, color, status }) => {
                      const content = (
                        <>
                          <p className={`text-xl font-bold ${color}`}>{value}</p>
                          <p className="text-[11px] text-muted-foreground mt-0.5">{label}</p>
                        </>
                      );
                      return status ? (
                        <button
                          key={label}
                          type="button"
                          onClick={() => openQueueDetail(status, label)}
                          className="rounded-lg border border-border bg-muted/20 p-3 text-center transition-colors hover:border-primary/50 hover:bg-muted/40 cursor-pointer"
                        >
                          {content}
                        </button>
                      ) : (
                        <div
                          key={label}
                          className="rounded-lg border border-border bg-muted/20 p-3 text-center"
                        >
                          {content}
                        </div>
                      );
                    })}
                  </div>

                  {/* Taxas */}
                  {metricsData.total_enviados > 0 && (
                    <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-2">
                      <p className="text-xs font-medium text-foreground">Taxas</p>
                      {[
                        {
                          label: "Taxa de Entrega",
                          value: ((metricsData.total_entregues / metricsData.total_enviados) * 100).toFixed(1),
                          color: "bg-green-500",
                        },
                        {
                          label: "Taxa de Leitura",
                          value: ((metricsData.total_lidos / metricsData.total_enviados) * 100).toFixed(1),
                          color: "bg-purple-500",
                        },
                        {
                          label: "Taxa de Resposta",
                          value: ((metricsData.total_respostas / metricsData.total_enviados) * 100).toFixed(1),
                          color: "bg-orange-500",
                        },
                      ].map(({ label, value, color }) => (
                        <div key={label} className="space-y-1">
                          <div className="flex justify-between text-xs">
                            <span className="text-muted-foreground">{label}</span>
                            <span className="font-medium">{value}%</span>
                          </div>
                          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                            <div
                              className={`h-full ${color} rounded-full`}
                              style={{ width: `${Math.min(parseFloat(value), 100)}%` }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Seção UTM */}
                  {(utmMetricsLoading || utmMetrics) && (
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-foreground border-t border-border pt-3">
                        Rastreamento UTM
                      </p>
                      {utmMetricsLoading && (
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          Carregando métricas UTM...
                        </div>
                      )}
                      {!utmMetricsLoading && utmMetrics && (
                        <>
                          <div className="grid grid-cols-2 gap-2">
                            {[
                              { label: "Cliques", value: utmMetrics.total_cliques, color: "text-blue-500" },
                              { label: "Cliques Únicos", value: utmMetrics.total_cliques_unicos, color: "text-blue-400" },
                              { label: "Entraram no Portal", value: utmMetrics.total_entraram_ddmpay, color: "text-purple-500" },
                              { label: "Acordos", value: utmMetrics.total_acordos, color: "text-orange-500" },
                              { label: "Pagaram", value: utmMetrics.total_pagaram, color: "text-green-500" },
                              {
                                label: "Valor Total",
                                value: utmMetrics.valor_total > 0
                                  ? utmMetrics.valor_total.toLocaleString("pt-BR", {
                                      style: "currency",
                                      currency: "BRL",
                                    })
                                  : "R$ 0,00",
                                color: "text-green-600",
                              },
                            ].map(({ label, value, color }) => (
                              <div
                                key={label}
                                className="rounded-lg border border-border bg-muted/20 p-2 text-center"
                              >
                                <p className={`text-lg font-bold ${color}`}>{value}</p>
                                <p className="text-[10px] text-muted-foreground mt-0.5">{label}</p>
                              </div>
                            ))}
                          </div>

                          {/* Funil de conversão */}
                          {utmMetrics.total_cliques > 0 && (
                            <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-2">
                              <p className="text-xs font-medium text-foreground">Funil</p>
                              {[
                                {
                                  label: "Clique → Portal",
                                  value: ((utmMetrics.total_entraram_ddmpay / utmMetrics.total_cliques) * 100).toFixed(1),
                                  color: "bg-purple-500",
                                },
                                {
                                  label: "Portal → Acordo",
                                  value: utmMetrics.total_entraram_ddmpay > 0
                                    ? ((utmMetrics.total_acordos / utmMetrics.total_entraram_ddmpay) * 100).toFixed(1)
                                    : "0.0",
                                  color: "bg-orange-500",
                                },
                                {
                                  label: "Acordo → Pagamento",
                                  value: utmMetrics.total_acordos > 0
                                    ? ((utmMetrics.total_pagaram / utmMetrics.total_acordos) * 100).toFixed(1)
                                    : "0.0",
                                  color: "bg-green-500",
                                },
                              ].map(({ label, value, color }) => (
                                <div key={label} className="space-y-1">
                                  <div className="flex justify-between text-xs">
                                    <span className="text-muted-foreground">{label}</span>
                                    <span className="font-medium">{value}%</span>
                                  </div>
                                  <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                                    <div
                                      className={`h-full ${color} rounded-full`}
                                      style={{ width: `${Math.min(parseFloat(value), 100)}%` }}
                                    />
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}

                  {/* Atualizado em */}
                  {metricsData.updated_at && (
                    <p className="text-center text-[10px] text-muted-foreground">
                      Atualizado em{" "}
                      {new Date(metricsData.updated_at).toLocaleString("pt-BR", {
                        timeZone: "America/Sao_Paulo",
                      })}
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Drilldown por contato de uma métrica clicada — empilhado sobre o
          modal de métricas (z-index maior), ver openQueueDetail. */}
      {queueDetailModal && metricsModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
          <div
            ref={queueDetailA11y.ref}
            tabIndex={-1}
            onKeyDown={queueDetailA11y.onKeyDown}
            role="dialog"
            aria-modal="true"
            aria-labelledby="campaign-queue-detail-title"
            className="bg-card border border-border w-full max-w-4xl rounded-xl shadow-2xl flex flex-col max-h-[calc(100dvh-2rem)] sm:max-h-[85vh] outline-none"
          >
            <header className="px-4 py-3 sm:px-6 sm:py-4 border-b border-border flex justify-between items-center gap-4">
              <div className="min-w-0">
                <h3 id="campaign-queue-detail-title" className="font-bold text-foreground truncate">
                  {queueDetailModal.label} — {queueDetailTotal.toLocaleString("pt-BR")}{" "}
                  mensagem{queueDetailTotal === 1 ? "" : "s"}
                </h3>
                <p className="text-xs text-muted-foreground truncate max-w-[400px]">
                  {metricsModal.nome}
                </p>
              </div>
              <Button size="icon" variant="ghost" onClick={() => setQueueDetailModal(null)} aria-label="Fechar" className="h-9 w-9 shrink-0">
                <X className="h-5 w-5" aria-hidden="true" />
              </Button>
            </header>

            <div className="px-4 sm:px-6 py-3 border-b border-border flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
              <div className="relative w-full sm:max-w-xs">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <Input
                  type="search"
                  aria-label="Buscar por nome ou telefone"
                  value={queueDetailSearchInput}
                  onChange={(e) => setQueueDetailSearchInput(e.target.value)}
                  placeholder="Buscar por nome ou telefone..."
                  className="pl-8 h-9 text-xs"
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 text-xs h-9"
                onClick={handleExportQueueDetailXlsx}
                disabled={queueDetailExporting || queueDetailTotal === 0}
              >
                {queueDetailExporting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                Baixar XLSX
              </Button>
            </div>

            {queueDetailModal.status === "respondido" &&
              !queueDetailLoading &&
              metricsData &&
              queueDetailTotal < metricsData.total_respostas && (
                <p className="mx-4 sm:mx-6 mt-2 rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                  O card conta {metricsData.total_respostas} respostas; {metricsData.total_respostas - queueDetailTotal}{" "}
                  foram registradas antes do rastreio por envio e não aparecem nesta lista.
                </p>
              )}
            <div className="flex-1 overflow-y-auto">
              {queueDetailLoading ? (
                <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin" />
                  <span className="text-sm">Carregando...</span>
                </div>
              ) : queueDetailRows.length === 0 ? (
                <div className="text-center py-12 text-sm text-muted-foreground">
                  Nenhum registro encontrado.
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Contato</TableHead>
                      <TableHead>Telefone</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Mensagem Final</TableHead>
                      {queueDetailModal.status === "erro" && <TableHead>Tipo de Erro</TableHead>}
                      <TableHead>Data/Hora</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {queueDetailRows.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell>
                          {row.conversation_id ? (
                            <Link
                              href={`/inbox?c=${row.conversation_id}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="font-medium text-primary hover:underline"
                              title="Abrir a conversa no inbox"
                            >
                              {row.contact_name || row.phone || "Abrir conversa"}
                            </Link>
                          ) : (
                            row.contact_name || "-"
                          )}
                        </TableCell>
                        <TableCell>{row.phone || "-"}</TableCell>
                        <TableCell className="capitalize">{row.status}</TableCell>
                        <TableCell className="max-w-xs truncate" title={row.mensagem_final || ""}>
                          {(row.mensagem_final || "").slice(0, 60)}
                          {(row.mensagem_final?.length ?? 0) > 60 ? "…" : ""}
                        </TableCell>
                        {queueDetailModal.status === "erro" && (
                          <TableCell>{row.tipo_erro || "Outro"}</TableCell>
                        )}
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                          {row.data_hora
                            ? new Date(row.data_hora).toLocaleString("pt-BR", {
                                timeZone: "America/Sao_Paulo",
                              })
                            : "-"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>

            {queueDetailTotal > QUEUE_DETAIL_PAGE_SIZES[0] && (
              <footer className="px-4 sm:px-6 py-3 border-t border-border flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-3">
                  <p className="text-xs text-muted-foreground">
                    Página {queueDetailPage} de{" "}
                    {Math.max(1, Math.ceil(queueDetailTotal / queueDetailPageSize))}
                  </p>
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    Itens por página
                    <select
                      value={queueDetailPageSize}
                      onChange={(e) => {
                        setQueueDetailPageSize(Number(e.target.value));
                        setQueueDetailPage(1);
                      }}
                      disabled={queueDetailLoading}
                      className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground"
                    >
                      {QUEUE_DETAIL_PAGE_SIZES.map((size) => (
                        <option key={size} value={size}>
                          {size}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 gap-1 text-xs"
                    disabled={queueDetailPage <= 1 || queueDetailLoading}
                    onClick={() => setQueueDetailPage((p) => Math.max(1, p - 1))}
                  >
                    <ChevronLeft className="h-3.5 w-3.5" /> Anterior
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 gap-1 text-xs"
                    disabled={
                      queueDetailPage >= Math.ceil(queueDetailTotal / queueDetailPageSize) ||
                      queueDetailLoading
                    }
                    onClick={() => setQueueDetailPage((p) => p + 1)}
                  >
                    Próxima <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </footer>
            )}
          </div>
        </div>
      )}
    </div>
  );

}
