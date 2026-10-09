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
  Gauge,
  Clock,
  Calendar,
  Pencil,
  Loader2,
  Search,
  Download,
  AlertTriangle,
  Info,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  CalendarX2,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ddm/segmented";
import { StatusChip, type StatusTone } from "@/components/ddm/status-chip";
import { PageBody, PageToolbar } from "@/components/ddm/page-toolbar";
import { DenseTable, Td, Th, Tr } from "@/components/ddm/table-card";
import { DetailDrawer } from "@/components/ddm/list-with-drawer";
import { EmptyState, Skeleton } from "@/components/ddm/states";
import { ExportJobButton } from "@/components/disparador/export/campaign-exports";
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
import { usePermissions } from "@/hooks/use-permission";
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

const STATUS_TONE: Record<CampaignStatus, StatusTone> = {
  rascunho: "mute",
  agendado: "info",
  em_execucao: "ok",
  pausada: "warn",
  encerrada: "mute",
  preparando: "info",
  erro: "bad",
  bloqueada_por_risco: "bad",
};

// Filtro segmentado da lista (protótipo): agrupa os status reais.
type CampaignFilter = "todas" | "ativas" | "agendadas" | "rascunhos" | "pausadas" | "encerradas";
const FILTERS: ReadonlyArray<{ value: CampaignFilter; label: string }> = [
  { value: "todas", label: "Todas" },
  { value: "ativas", label: "Em execução" },
  { value: "agendadas", label: "Agendadas" },
  { value: "rascunhos", label: "Rascunhos" },
  { value: "pausadas", label: "Pausadas" },
  { value: "encerradas", label: "Encerradas" },
];

function filterOf(status: string): Exclude<CampaignFilter, "todas"> {
  switch (status) {
    case "em_execucao":
    case "preparando":
      return "ativas";
    case "agendado":
      return "agendadas";
    case "pausada":
      return "pausadas";
    case "encerrada":
    case "erro":
    case "bloqueada_por_risco":
      return "encerradas";
    default:
      return "rascunhos";
  }
}

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

/** Linha de configuração do cartão: modo de envio · tabulação · canais · janela. */
function configLine(c: Campaign): string {
  const modo =
    c.batch_percent != null
      ? `Segmentado ${c.batch_percent}% / ${Math.round((c.batch_pause_seconds ?? 0) / 60)} min`
      : (c.batch_size ?? 1) > 1 && (c.batch_pause_seconds ?? 0) === 0
        ? "Imediato"
        : `Modo antigo (${c.intervalo_min}–${c.intervalo_max}s)`;
  const tab =
    c.tags_filtro.length === 0
      ? "Todos"
      : c.tags_filtro.length === 1
        ? c.tags_filtro[0]
        : `${c.tags_filtro[0]} +${c.tags_filtro.length - 1}`;
  const canais = `${c.session_ids.length} ${c.session_ids.length === 1 ? "canal" : "canais"}`;
  return `${modo} · Tabulação: ${tab} · ${canais} · ${diasLabel(c.dias_envio)} ${hhmm(c.janela_inicio)}–${hhmm(c.janela_fim)}`;
}

/**
 * Previsão de término do card (mesma função do assistente,
 * dispatch-forecast.ts): a partir do agendamento (ou de agora), na janela
 * e nos dias da campanha. Faixa otimista–conservadora.
 */
function campaignMessagesPerContact(c: Campaign): number {
  return messagesPerContact(
    parseTemplateMode(c.dias_permitidos),
    Array.isArray(c.mensagens) ? Math.max(1, c.mensagens.length) : 1
  );
}

function campaignForecast(c: Campaign, contacts: number, startOverride?: Date) {
  const start =
    startOverride ??
    (c.status === "agendado" && c.agendamento
      ? new Date(c.agendamento)
      : new Date());
  return forecastFromCampaign(c, contacts, campaignMessagesPerContact(c), start);
}

function plannedDispatchCount(c: Campaign | undefined, contacts: number): number {
  if (!c) return 0;
  return Math.max(0, contacts) * campaignMessagesPerContact(c);
}

function cardForecastLabel(c: Campaign, contacts: number): string {
  const f = campaignForecast(c, contacts);
  const a = formatShortBrasilia(f.otimista.end);
  const b = formatShortBrasilia(f.conservador.end);
  return a === b ? a : `${a} – ${b}`;
}

function campaignForecastDurationLabel(c: Campaign, contacts: number): string {
  const f = campaignForecast(c, contacts);
  const minSeconds = Math.max(
    0,
    Math.round((f.otimista.end.getTime() - f.firstSendAt.getTime()) / 1000)
  );
  const maxSeconds = Math.max(
    0,
    Math.round((f.conservador.end.getTime() - f.firstSendAt.getTime()) / 1000)
  );
  const a = formatCampaignDuration(minSeconds);
  const b = formatCampaignDuration(maxSeconds);
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

interface CampaignTiming {
  started_at: string | null;
  ended_at: string | null;
  active_seconds: number | null;
  paused_seconds: number | null;
  wall_clock_seconds: number | null;
  pause_count: number;
  history_complete: boolean;
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
type QueueDetailStatusKey = "total" | "agendado" | "enviado" | "entregue" | "lido" | "erro" | "bloqueado" | "respondido" | "aguardando_confirmacao";

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
  // Pelas permissões do servidor: recalcular = campaigns.manage; iniciar em
  // número vermelho = campaigns.red_quality_override (só proprietário).
  const { can } = usePermissions();
  const canRecalculate = can("campaigns.manage");
  const canOverrideRed = can("campaigns.red_quality_override");
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
  // Número em qualidade vermelha: só o owner inicia, confirmando e dando o motivo (TASK23).
  const [redConfirmed, setRedConfirmed] = useState(false);
  const [redReason, setRedReason] = useState("");
  const [unscheduleTarget, setUnscheduleTarget] = useState<Campaign | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Campaign | null>(null);
  const [filter, setFilter] = useState<CampaignFilter>("todas");
  const [search, setSearch] = useState("");

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
  const hasRedChannel = !!campaignInfo?.channels.some((ch) => ch.quality_rating === "RED");
  const redReady = !hasRedChannel || (canOverrideRed && redConfirmed && redReason.trim().length >= 3);
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
  const [timingData, setTimingData] = useState<CampaignTiming | null>(null);
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
  // Resultado ainda não definitivo: aceite externo com confirmação local
  // pendente ou Meta 131026 aguardando delivered/read antes de virar erro.
  const [aguardandoConfirmacaoCount, setAguardandoConfirmacaoCount] = useState<number | null>(null);

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
        let { data: metricsList } = await supabase
          .from("campaign_metrics_live")
          .select("*")
          .in("campaign_id", campaignIds);

        // Campanhas antigas em rascunho/agendadas podem não ter a linha de
        // volume planejado. O servidor faz um backfill limitado e a tela
        // relê as métricas uma única vez.
        const haveMetrics = new Set((metricsList ?? []).map((m) => m.campaign_id));
        const needsPlanned = (campaignList ?? []).some(
          (c) => ["rascunho", "agendado"].includes(c.status) && !haveMetrics.has(c.id)
        );
        if (needsPlanned) {
          try {
            const planned = await apiFetch("/api/disparador/campaigns/planned-metrics", {
              method: "POST",
            });
            if (planned.ok) {
              const refreshed = await supabase
                .from("campaign_metrics_live")
                .select("*")
                .in("campaign_id", campaignIds);
              metricsList = refreshed.data ?? metricsList;
            }
          } catch {
            // Prévia é melhor esforço; não bloqueia a listagem.
          }
        }

        if (metricsList) {
          const next: Record<string, CampaignMetrics> = {};
          for (const m of metricsList) next[m.campaign_id] = m;
          setMetricsMap(next);
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
        body: JSON.stringify({
          agora: startNow,
          ...(hasRedChannel && canOverrideRed && redConfirmed
            ? { confirm_red_quality: true, red_quality_reason: redReason.trim() }
            : {}),
        }),
      });
      if (res.ok) {
        toast.success("Campanha iniciada e disparos agendados!");
        trackAction("campaign_started", { campaign_id: id });
        setStartConfirmId(null);
        setCampaignInfo(null);
        setAudienceInfo(null);
        setRedConfirmed(false);
        setRedReason("");
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
  // disp_message_queue.campaign_id is ON DELETE CASCADE, so deleting a
  // running campaign silently wipes its in-flight queue mid-send.
  // Require pausing/stopping first instead of deleting straight out of
  // em_execucao. A confirmação é um AlertDialog (antes, confirm()).
  const askDelete = (campaign: Campaign) => {
    if (campaign.status === "em_execucao") {
      toast.error(
        "Não é possível deletar uma campanha em execução. Pause ou encerre a campanha primeiro."
      );
      return;
    }
    setDeleteTarget(campaign);
  };

  const handleDelete = async (campaign: Campaign) => {
    setDeleteTarget(null);
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
        .from("campaign_metrics_live")
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

    try {
      const timingRes = await apiFetch(
        `/api/disparador/campaigns/${campaignId}/timing`
      );
      if (timingRes.ok) {
        const timing = await timingRes.json();
        setTimingData(timing.data ?? null);
      } else {
        setTimingData(null);
      }
    } catch {
      setTimingData(null);
    }

    // Contagens operacionais derivadas diretamente da fila. pageSize=1
    // evita trazer linhas desnecessárias: só usamos o count exato da rota.
    try {
      const [scheduledRes, pendingRes] = await Promise.all([
        apiFetch(
          `/api/disparador/campaigns/${campaignId}/queue-details?status=agendado&page=1&pageSize=1`
        ),
        apiFetch(
          `/api/disparador/campaigns/${campaignId}/queue-details?status=aguardando_confirmacao&page=1&pageSize=1`
        ),
      ]);
      if (scheduledRes.ok) {
        const scheduled = await scheduledRes.json();
        setAgendadosCount(scheduled.total ?? 0);
      }
      if (pendingRes.ok) {
        const pending = await pendingRes.json();
        setAguardandoConfirmacaoCount(pending.total ?? 0);
      }
    } catch {
      // silencioso — mesma política das métricas auxiliares do modal
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
    setTimingData(null);
    setAgendadosCount(null);
    setAguardandoConfirmacaoCount(null);
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
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          throw new Error(payload?.error || `Erro ao carregar detalhamento (HTTP ${res.status})`);
        }
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
    setTimingData(null);
    setUtmMetrics(null);
    setAguardandoConfirmacaoCount(null);
    setQueueDetailModal(null);
  };

  const counts = useMemo(() => {
    const out: Record<CampaignFilter, number> = { todas: campaigns.length, ativas: 0, agendadas: 0, rascunhos: 0, pausadas: 0, encerradas: 0 };
    for (const c of campaigns) {
      const f = filterOf(c.status);
      out[f] += 1;
    }
    return out;
  }, [campaigns]);

  const visibleCampaigns = useMemo(() => {
    const q = search.trim().toLocaleLowerCase("pt-BR");
    return campaigns.filter(
      (c) =>
        (filter === "todas" || filterOf(c.status) === filter) &&
        (!q || c.nome.toLocaleLowerCase("pt-BR").includes(q))
    );
  }, [campaigns, filter, search]);

  const metricsCampaign = metricsModal ? campaigns.find((c) => c.id === metricsModal.campaignId) : undefined;

  return (
    <PageBody>
      <PageToolbar
        actions={
          <>
            {canRecalculate && (
              <Button variant="outline" onClick={handleRecalculateMetrics} disabled={recalculatingMetrics}>
                <RefreshCw aria-hidden="true" className={cn("size-3.5", recalculatingMetrics && "animate-spin")} />
                Recalcular métricas
              </Button>
            )}
            <Button onClick={openCreateModal}>
              <Plus className="size-3.5" aria-hidden="true" /> Nova campanha
            </Button>
          </>
        }
      >
        <Segmented
          size="lg"
          ariaLabel="Filtrar campanhas por situação"
          value={filter}
          onChange={setFilter}
          options={FILTERS.map((f) => ({ value: f.value, label: f.label, count: loading ? undefined : counts[f.value] }))}
        />
        <div className="relative w-full sm:w-56">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            type="search"
            aria-label="Buscar campanha pelo nome"
            placeholder="Buscar campanha"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 pl-8 text-[12.5px]"
          />
        </div>
      </PageToolbar>

      {loading ? (
        <div className="flex flex-col gap-2.5" aria-busy="true" aria-label="Carregando campanhas">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[112px] w-full rounded-[10px]" />
          ))}
        </div>
      ) : campaigns.length === 0 ? (
        <EmptyState
          icon={Megaphone}
          title="Nenhuma campanha cadastrada"
          hint="Crie a primeira campanha em “Nova campanha”."
        />
      ) : visibleCampaigns.length === 0 ? (
        <EmptyState icon={Search} title="Nenhuma campanha neste filtro" hint="Troque o filtro ou a busca." />
      ) : (
        <div className="ddm-stagger flex flex-col gap-2.5">
          {visibleCampaigns.map((c) => {
            const st = statusKey(c.status);
            const m = metricsMap[c.id];
            const total = m?.total_contatos ?? 0;
            const sentPct = total > 0 ? Math.min(100, (m!.total_enviados / total) * 100) : 0;
            const readPct = total > 0 ? Math.min(100, (m!.total_lidos / total) * 100) : 0;
            const showForecast = total > 0 && !["encerrada", "erro", "bloqueada_por_risco"].includes(c.status);
            return (
              <section
                key={c.id}
                aria-label={c.nome}
                className="flex flex-wrap items-center gap-x-6 gap-y-4 rounded-[10px] border border-border bg-card px-[18px] py-4 transition-colors hover:border-border-strong"
              >
                {/* Identificação e configuração */}
                <div className="flex min-w-0 flex-[1_1_260px] flex-col gap-1.5">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <h3 className="m-0 truncate font-sans text-sm font-semibold text-foreground" title={c.nome}>
                      {c.nome}
                    </h3>
                    <StatusChip tone={STATUS_TONE[st]}>{STATUS_LABELS[st]}</StatusChip>
                  </div>
                  <p className="m-0 truncate text-[12.5px] text-muted-foreground" title={configLine(c)}>
                    {configLine(c)}
                  </p>
                  {c.descricao ? (
                    <p className="m-0 line-clamp-1 text-xs text-muted-foreground">{c.descricao}</p>
                  ) : null}
                  {c.status === "agendado" && c.agendamento && (
                    <p className="m-0 flex items-center gap-1.5 text-[12.5px] font-medium text-foreground-2">
                      <Calendar className="size-3 shrink-0" aria-hidden="true" />
                      Começa {formatShortBrasilia(new Date(c.agendamento))} (Brasília)
                    </p>
                  )}
                  {/* Migration 160: o início falhou e a campanha voltou para rascunho — nunca em silêncio. */}
                  {c.status === "rascunho" && c.motivo_falha_inicio && (
                    <p role="alert" className="m-0 flex items-start gap-1.5 text-[12.5px] font-medium text-danger">
                      <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                      <span>{c.motivo_falha_inicio}</span>
                    </p>
                  )}
                </div>

                {/* Progresso e números reais (campaign_metrics_live) */}
                <div className="flex min-w-0 flex-[2_1_360px] flex-col gap-2">
                  {m ? (
                    <>
                      <div className="flex justify-between gap-3 text-xs tabular-nums text-foreground-2">
                        <span>
                          {m.total_enviados.toLocaleString("pt-BR")} de {total.toLocaleString("pt-BR")} contatos
                        </span>
                        <span className="font-semibold text-foreground">{Math.round(sentPct)}%</span>
                      </div>
                      <span
                        className="relative h-1.5 overflow-hidden rounded-full bg-surface-3"
                        title={`Enviados ${Math.round(sentPct)}% · lidos ${Math.round(readPct)}%`}
                      >
                        <span className="absolute inset-y-0 left-0 origin-left animate-ddm-bar bg-muted-foreground/45 transition-[width] duration-500" style={{ width: `${sentPct}%` }} />
                        <span className="absolute inset-y-0 left-0 origin-left animate-ddm-bar bg-primary transition-[width] duration-500" style={{ width: `${readPct}%` }} />
                      </span>
                      <div className="grid grid-cols-4 gap-2">
                        {[
                          ["Enviados", m.total_enviados],
                          ["Entregues", m.total_entregues],
                          ["Lidos", m.total_lidos],
                          ["Respostas", m.total_respostas],
                        ].map(([label, value]) => (
                          <div key={label} className="flex flex-col gap-px">
                            <span className="text-[11.5px] text-muted-foreground">{label}</span>
                            <span className="text-sm font-semibold tabular-nums text-foreground">
                              {Number(value).toLocaleString("pt-BR")}
                            </span>
                          </div>
                        ))}
                      </div>
                      {showForecast && (
                        <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                          <span>
                            {plannedDispatchCount(c, total).toLocaleString("pt-BR")} disparos previstos
                          </span>
                          <span className="inline-flex items-center gap-1">
                            <Clock className="size-3" aria-hidden="true" />
                            {campaignForecastDurationLabel(c, total)} · término {cardForecastLabel(c, total)}
                          </span>
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="m-0 text-xs text-muted-foreground">Ainda sem envios registrados.</p>
                  )}
                </div>

                {/* Ações */}
                <div className="ml-auto flex flex-none flex-wrap items-center gap-1.5">
                  {c.status === "em_execucao" ? (
                    <Button variant="outline" onClick={() => handlePause(c.id)}>
                      <Pause className="size-3.5" aria-hidden="true" /> Pausar
                    </Button>
                  ) : c.status === "agendado" ? (
                    <>
                      <Button onClick={() => handleStartClick(c.id, true)}>
                        <Play className="size-3.5" aria-hidden="true" /> Iniciar agora
                      </Button>
                      <Button variant="outline" onClick={() => setUnscheduleTarget(c)}>
                        <CalendarX2 className="size-3.5" aria-hidden="true" /> Desagendar
                      </Button>
                    </>
                  ) : c.status === "rascunho" || c.status === "pausada" ? (
                    <Button onClick={() => handleStartClick(c.id)}>
                      <Play className="size-3.5" aria-hidden="true" /> {c.status === "pausada" ? "Retomar" : "Iniciar"}
                    </Button>
                  ) : null}
                  {(c.status === "em_execucao" || c.status === "pausada") && (
                    <Button variant="outline" onClick={() => setStopConfirm({ id: c.id, nome: c.nome })}>
                      Encerrar
                    </Button>
                  )}
                  <Button variant="outline" onClick={() => handleMetricsClick(c)} aria-label={`Métricas — ${c.nome}`}>
                    <Gauge className="size-3.5" aria-hidden="true" /> Métricas
                  </Button>
                  <Link
                    href={`/disparador/campanhas/${c.id}`}
                    className={cn(buttonVariants({ variant: "outline" }))}
                    aria-label={`Detalhes por contato — ${c.nome}`}
                  >
                    Detalhes <ChevronRight className="size-3.5" aria-hidden="true" />
                  </Link>
                  {(c.status === "rascunho" || c.status === "agendado") && (
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => handleEditClick(c)}
                      title="Editar campanha"
                      aria-label={`Editar campanha — ${c.nome}`}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <Pencil className="size-4" aria-hidden="true" />
                    </Button>
                  )}
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => askDelete(c)}
                    title="Excluir campanha"
                    aria-label={`Excluir campanha — ${c.nome}`}
                    className="text-danger hover:bg-danger-soft hover:text-danger"
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                  </Button>
                </div>
              </section>
            );
          })}
        </div>
      )}

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

      {/* Excluir: confirmação (apaga a fila junto, ON DELETE CASCADE). */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir campanha?</AlertDialogTitle>
            <AlertDialogDescription>
              &quot;{deleteTarget?.nome}&quot; será excluída permanentemente, junto com o histórico de envios dela.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Voltar</AlertDialogCancel>
            <Button variant="destructive" onClick={() => deleteTarget && handleDelete(deleteTarget)}>
              Excluir campanha
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
            setRedConfirmed(false);
            setRedReason("");
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
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> Calculando público…
                  </p>
                ) : audienceInfo.ok && audienceInfo.source === "resume" ? (
                  <p className="text-sm text-muted-foreground">
                    A campanha está pausada: os envios que ficaram na fila serão retomados.
                  </p>
                ) : audienceInfo.ok ? (
                  <div className="rounded-lg bg-primary-soft p-3 text-sm">
                    <p className="text-foreground">
                      Enviar para{" "}
                      <span className="text-base font-semibold tabular-nums">{audienceInfo.total.toLocaleString("pt-BR")}</span>{" "}
                      {audienceInfo.source_label}
                      {audienceInfo.tags.length > 0 && <> ({audienceInfo.tags.join(", ")})</>}.
                    </p>
                    {audienceInfo.blacklisted > 0 ? (
                      <div className="mt-2 flex items-start gap-2 rounded-md border border-warning-border bg-warning-soft p-2 text-xs text-foreground">
                        <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden="true" />
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
                      <p className="mt-2 flex items-start gap-1.5 text-xs font-medium text-warning">
                        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                        Sem CSV e sem tabulação: a campanha vai para a conta inteira.
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="flex items-start gap-2 rounded-lg bg-danger-soft p-3 text-sm text-danger">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    <span>{audienceInfo.error}</span>
                  </div>
                )}
                {infoLoading && (
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> Consultando limites do canal…
                  </p>
                )}

                {!infoLoading && campaignInfo && campaignInfo.hasMeta && (
                  <div className="space-y-2">
                    {campaignInfo.channels.map((ch) => (
                      <div key={ch.id} className="space-y-1 rounded-lg border border-border p-3 text-sm">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium tabular-nums">{ch.display_phone_number || ch.phone_number_id}</span>
                          {ch.quality_rating && (
                            <StatusChip
                              tone={ch.quality_rating === "GREEN" ? "ok" : ch.quality_rating === "YELLOW" ? "warn" : "bad"}
                            >
                              Qualidade {qualityLabel(ch.quality_rating).toLowerCase()}
                            </StatusChip>
                          )}
                        </div>
                        <div className="text-muted-foreground">
                          Nível: <span className="font-medium text-foreground">{tierLabel(ch.tier)}</span> — até{" "}
                          <span className="font-medium tabular-nums text-foreground">
                            {ch.dailyLimit === Infinity ? "ilimitado" : (ch.dailyLimit ?? 1000).toLocaleString("pt-BR")}
                          </span>{" "}
                          disparos/dia
                        </div>

                        {ch.quality_rating === "RED" && (
                          <div className="flex items-start gap-2 rounded-md bg-danger-soft p-2 text-danger">
                            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                            <span className="font-medium">
                              Qualidade VERMELHA — este número está em risco de restrição pela Meta (envio limitado a
                              poucas mensagens por segundo). Campanha nova nele só pode ser iniciada pelo owner.
                              {!canOverrideRed && " Peça ao owner para iniciar esta campanha."}
                            </span>
                          </div>
                        )}

                        {ch.quality_rating === "YELLOW" && (
                          <div className="flex items-start gap-1.5 text-xs text-muted-foreground">
                            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                            <span>
                              Qualidade AMARELA — número em observação pela Meta, acompanhe o desempenho dos disparos.
                            </span>
                          </div>
                        )}

                        {ch.error && (
                          <div className="flex items-start gap-1.5 text-xs text-warning">
                            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                            {ch.error} — limite padrão aplicado
                          </div>
                        )}
                      </div>
                    ))}
                    {hasRedChannel && canOverrideRed && (
                      <div className="space-y-2 rounded-lg border border-danger/60 p-3 text-sm">
                        <label className="flex items-start gap-2">
                          <input
                            type="checkbox"
                            className="mt-1 accent-[var(--primary)]"
                            checked={redConfirmed}
                            onChange={(e) => setRedConfirmed(e.target.checked)}
                          />
                          <span>Confirmo iniciar mesmo com qualidade vermelha</span>
                        </label>
                        <Input
                          type="text"
                          aria-label="Motivo para iniciar com qualidade vermelha"
                          placeholder="Motivo (obrigatório, mín. 3 caracteres)"
                          maxLength={500}
                          value={redReason}
                          onChange={(e) => setRedReason(e.target.value)}
                        />
                      </div>
                    )}
                    <p className="text-xs text-muted-foreground">
                      Se o número de contatos exceder o limite diário, os disparos restantes serão agendados para os
                      dias seguintes automaticamente.
                    </p>
                  </div>
                )}

                {!infoLoading && campaignInfo && !campaignInfo.hasMeta && (
                  <p className="text-sm text-muted-foreground">Canal WAHA — sem limite de nível da Meta.</p>
                )}

                {!infoLoading && !campaignInfo && (
                  <p className="text-sm text-muted-foreground">Deseja iniciar esta campanha?</p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <Button
              onClick={handleStartConfirm}
              disabled={infoLoading || starting || !audienceInfo || !audienceInfo.ok || !redReady}
            >
              {starting ? "Iniciando…" : infoLoading ? "Consultando…" : "Iniciar campanha"}
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

      {/* Métricas da campanha: gaveta da direita (protótipo). Atualiza a cada 15 s enquanto aberta. */}
      <DetailDrawer
        open={!!metricsModal}
        onOpenChange={(open) => !open && closeMetricsModal()}
        title={metricsModal?.nome ?? ""}
        description="Métricas da campanha"
        headerExtra={
          metricsCampaign ? (
            <StatusChip tone={STATUS_TONE[statusKey(metricsCampaign.status)]}>
              {STATUS_LABELS[statusKey(metricsCampaign.status)]}
            </StatusChip>
          ) : null
        }
        size="md"
      >
        {metricsLoading ? (
          <div className="flex flex-col gap-3" aria-busy="true">
            <Skeleton className="h-48 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : !metricsData ? (
          <EmptyState title="Nenhuma métrica disponível para esta campanha" />
        ) : (
          <div className="flex flex-col gap-5">
            {/* KPIs — os que têm `status` abrem o detalhamento por contato. */}
            <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border">
              {[
                { label: "Disparos previstos", value: plannedDispatchCount(metricsCampaign, metricsData.total_contatos), dot: "bg-foreground-2", status: null },
                { label: "Total de contatos", value: metricsData.total_contatos, dot: "bg-foreground-2", status: "total" as const },
                { label: "A enviar", value: agendadosCount ?? 0, dot: "bg-muted-foreground", status: "agendado" as const },
                { label: "Enviados", value: metricsData.total_enviados, dot: "bg-[#5B8DEF]", status: "enviado" as const },
                { label: "Aguardando confirmação", value: aguardandoConfirmacaoCount ?? 0, dot: "bg-warning", status: "aguardando_confirmacao" as const },
                { label: "Entregues", value: metricsData.total_entregues, dot: "bg-success", status: "entregue" as const },
                { label: "Lidos", value: metricsData.total_lidos, dot: "bg-primary", status: "lido" as const },
                { label: "Respostas", value: metricsData.total_respostas, dot: "bg-primary", status: "respondido" as const },
                { label: "Blacklist", value: metricsData.total_blacklist, dot: "bg-foreground-2", status: "bloqueado" as const },
                { label: "Erros", value: metricsData.total_erros, dot: "bg-danger", status: "erro" as const },
                { label: "Tempo médio de resposta", value: formatResponseTime(metricsData.tempo_medio_resposta), dot: null, status: null },
                { label: "Tempo efetivo de disparo", value: formatCampaignDuration(timingData?.active_seconds ?? null), dot: null, status: null },
                { label: "Tempo pausado", value: formatCampaignDuration(timingData?.paused_seconds ?? null), dot: null, status: null },
                { label: "Tempo corrido", value: formatCampaignDuration(timingData?.wall_clock_seconds ?? null), dot: null, status: null },
              ].map(({ label, value, dot, status }) => {
                const body = (
                  <>
                    <span className="flex items-center gap-1.5 text-xs text-foreground-2">
                      {dot && <span aria-hidden="true" className={cn("size-[7px] rounded-[2px]", dot)} />}
                      {label}
                    </span>
                    <span className="text-lg font-semibold tabular-nums text-foreground">
                      {typeof value === "number" ? value.toLocaleString("pt-BR") : value}
                    </span>
                  </>
                );
                return status ? (
                  <button
                    key={label}
                    type="button"
                    onClick={() => openQueueDetail(status, label)}
                    title="Ver por contato"
                    className="flex flex-col gap-1 bg-card px-3.5 py-3 text-left transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                  >
                    {body}
                  </button>
                ) : (
                  <div key={label} className="flex flex-col gap-1 bg-card px-3.5 py-3">
                    {body}
                  </div>
                );
              })}
            </div>

            {metricsCampaign && metricsData.total_contatos > 0 &&
              !["encerrada", "erro", "bloqueada_por_risco"].includes(metricsCampaign.status) && (
                <div className="flex flex-col gap-2.5">
                  <p className="m-0 text-[13px] font-semibold text-foreground">Previsão do disparo</p>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="flex flex-col gap-0.5 rounded-lg bg-surface-3 px-3 py-2.5">
                      <span className="text-xs text-foreground-2">Duração estimada</span>
                      <span className="text-[13px] font-semibold text-foreground">
                        {campaignForecastDurationLabel(metricsCampaign, metricsData.total_contatos)}
                      </span>
                    </div>
                    <div className="flex flex-col gap-0.5 rounded-lg bg-surface-3 px-3 py-2.5">
                      <span className="text-xs text-foreground-2">Término previsto</span>
                      <span className="text-[13px] font-semibold text-foreground">
                        {cardForecastLabel(metricsCampaign, metricsData.total_contatos)}
                      </span>
                    </div>
                  </div>
                </div>
              )}

            {metricsData.total_enviados > 0 && (
              <div className="flex flex-col gap-2.5">
                <p className="m-0 text-[13px] font-semibold text-foreground">Taxas</p>
                {[
                  { label: "Entrega", part: metricsData.total_entregues },
                  { label: "Leitura", part: metricsData.total_lidos },
                  { label: "Resposta", part: metricsData.total_respostas },
                ].map(({ label, part }) => (
                  <RateRow key={label} label={label} part={part} total={metricsData.total_enviados} />
                ))}
              </div>
            )}

            {(utmMetricsLoading || utmMetrics) && (
              <div className="flex flex-col gap-2.5">
                <p className="m-0 text-[13px] font-semibold text-foreground">Rastreamento UTM</p>
                {utmMetricsLoading && !utmMetrics ? (
                  <Skeleton className="h-24 w-full" />
                ) : utmMetrics ? (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      {[
                        { label: "Cliques", value: utmMetrics.total_cliques.toLocaleString("pt-BR") },
                        { label: "Cliques únicos", value: utmMetrics.total_cliques_unicos.toLocaleString("pt-BR") },
                        { label: "Entraram no portal", value: utmMetrics.total_entraram_ddmpay.toLocaleString("pt-BR") },
                        { label: "Acordos", value: utmMetrics.total_acordos.toLocaleString("pt-BR") },
                        { label: "Pagaram", value: utmMetrics.total_pagaram.toLocaleString("pt-BR") },
                        {
                          label: "Valor total",
                          value: utmMetrics.valor_total.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }),
                        },
                      ].map(({ label, value }) => (
                        <div
                          key={label}
                          className="flex items-center justify-between gap-2.5 rounded-lg bg-surface-3 px-3 py-2.5 text-[12.5px]"
                        >
                          <span className="text-foreground-2">{label}</span>
                          <span className="font-semibold tabular-nums text-foreground">{value}</span>
                        </div>
                      ))}
                    </div>
                    {utmMetrics.total_cliques > 0 && (
                      <div className="flex flex-col gap-2.5">
                        <p className="m-0 text-xs font-semibold text-foreground-2">Funil</p>
                        <RateRow label="Clique → portal" part={utmMetrics.total_entraram_ddmpay} total={utmMetrics.total_cliques} />
                        <RateRow label="Portal → acordo" part={utmMetrics.total_acordos} total={utmMetrics.total_entraram_ddmpay} />
                        <RateRow label="Acordo → pagamento" part={utmMetrics.total_pagaram} total={utmMetrics.total_acordos} />
                      </div>
                    )}
                  </>
                ) : null}
              </div>
            )}

            {metricsData.updated_at && (
              <p className="m-0 text-center text-[11px] text-muted-foreground">
                Atualizado em{" "}
                {new Date(metricsData.updated_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}
              </p>
            )}
          </div>
        )}

        {/* Detalhamento por contato de uma métrica: gaveta aninhada (foco preso, Esc volta às métricas). */}
        <DetailDrawer
          open={!!(queueDetailModal && metricsModal)}
          onOpenChange={(open) => !open && setQueueDetailModal(null)}
          title={
            queueDetailModal
              ? `${queueDetailModal.label} — ${queueDetailTotal.toLocaleString("pt-BR")} mensage${queueDetailTotal === 1 ? "m" : "ns"}`
              : ""
          }
          description={metricsModal?.nome}
          size="xl"
          footer={
            queueDetailTotal > QUEUE_DETAIL_PAGE_SIZES[0] ? (
              <div className="flex w-full flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                  <span className="tabular-nums">
                    Página {queueDetailPage} de {Math.max(1, Math.ceil(queueDetailTotal / queueDetailPageSize))}
                  </span>
                  <label className="flex items-center gap-1.5">
                    Itens por página
                    <select
                      value={queueDetailPageSize}
                      onChange={(e) => {
                        setQueueDetailPageSize(Number(e.target.value));
                        setQueueDetailPage(1);
                      }}
                      disabled={queueDetailLoading}
                      className="h-8 rounded-[6px] border border-input bg-background px-2 text-xs text-foreground"
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
                    disabled={queueDetailPage <= 1 || queueDetailLoading}
                    onClick={() => setQueueDetailPage((p) => Math.max(1, p - 1))}
                  >
                    <ChevronLeft className="size-3.5" aria-hidden="true" /> Anterior
                  </Button>
                  <Button
                    variant="outline"
                    disabled={queueDetailPage >= Math.ceil(queueDetailTotal / queueDetailPageSize) || queueDetailLoading}
                    onClick={() => setQueueDetailPage((p) => p + 1)}
                  >
                    Próxima <ChevronRight className="size-3.5" aria-hidden="true" />
                  </Button>
                </div>
              </div>
            ) : undefined
          }
        >
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="relative w-full sm:max-w-xs">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <Input
                  type="search"
                  aria-label="Buscar por nome ou telefone"
                  value={queueDetailSearchInput}
                  onChange={(e) => setQueueDetailSearchInput(e.target.value)}
                  placeholder="Buscar por nome ou telefone"
                  className="h-8 pl-8 text-[12.5px]"
                />
              </div>
              <div className="flex flex-wrap gap-2">
              {metricsModal && queueDetailModal && (
                <ExportJobButton campaignId={metricsModal.campaignId} statusKey={queueDetailModal.status} />
              )}
              <Button
                variant="outline"
                onClick={handleExportQueueDetailXlsx}
                disabled={queueDetailExporting || queueDetailTotal === 0}
              >
                {queueDetailExporting ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Download className="size-3.5" aria-hidden="true" />
                )}
                Baixar XLSX
              </Button>
              </div>
            </div>

            {queueDetailModal?.status === "respondido" &&
              !queueDetailLoading &&
              metricsData &&
              queueDetailTotal < metricsData.total_respostas && (
                <p className="m-0 rounded-lg bg-surface-3 px-3 py-2 text-xs text-muted-foreground">
                  O card conta {metricsData.total_respostas} respostas; {metricsData.total_respostas - queueDetailTotal}{" "}
                  foram registradas antes do rastreio por envio e não aparecem nesta lista.
                </p>
              )}

            {queueDetailLoading ? (
              <div className="flex flex-col gap-2" aria-busy="true">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-9 w-full" />
                ))}
              </div>
            ) : queueDetailRows.length === 0 ? (
              <EmptyState title="Nenhum registro encontrado" />
            ) : (
              <div className="-mx-5 overflow-x-auto">
                <DenseTable minWidth={640}>
                  <thead>
                    <tr>
                      <Th>Contato</Th>
                      <Th>Telefone</Th>
                      <Th>Status</Th>
                      <Th>Mensagem final</Th>
                      {queueDetailModal?.status === "erro" && <Th>Tipo de erro</Th>}
                      {queueDetailModal?.status === "aguardando_confirmacao" && <Th>Motivo</Th>}
                      <Th>Data/hora</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {queueDetailRows.map((row) => (
                      <Tr key={row.id}>
                        <Td>
                          {row.conversation_id ? (
                            <Link
                              href={`/inbox?c=${row.conversation_id}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="font-semibold text-primary-text hover:underline"
                              title="Abrir a conversa no inbox"
                            >
                              {row.contact_name || row.phone || "Abrir conversa"}
                            </Link>
                          ) : (
                            <span className="font-semibold text-foreground">{row.contact_name || "—"}</span>
                          )}
                        </Td>
                        <Td className="whitespace-nowrap tabular-nums">{row.phone || "—"}</Td>
                        <Td className="capitalize">{row.status}</Td>
                        <Td className="max-w-xs truncate" title={row.mensagem_final || ""}>
                          {(row.mensagem_final || "").slice(0, 60)}
                          {(row.mensagem_final?.length ?? 0) > 60 ? "…" : ""}
                        </Td>
                        {queueDetailModal?.status === "erro" && <Td>{row.tipo_erro || "Outro"}</Td>}
                        {queueDetailModal?.status === "aguardando_confirmacao" && (
                          <Td className="max-w-xs text-xs text-muted-foreground">
                            {row.erro || "Aguardando confirmação final"}
                          </Td>
                        )}
                        <Td className="whitespace-nowrap text-xs text-muted-foreground">
                          {row.data_hora
                            ? new Date(row.data_hora).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })
                            : "—"}
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                </DenseTable>
              </div>
            )}
          </div>
        </DetailDrawer>
      </DetailDrawer>
    </PageBody>
  );
}

/** Linha de taxa (rótulo · barra · %), protegida contra divisão por zero. */
function RateRow({ label, part, total }: { label: string; part: number; total: number }) {
  const pct = total > 0 ? (part / total) * 100 : 0;
  return (
    <div className="grid grid-cols-[130px_minmax(0,1fr)_56px] items-center gap-2.5 text-[12.5px]">
      <span className="text-foreground-2">{label}</span>
      <span className="h-1.5 overflow-hidden rounded-full bg-surface-3">
        <span
          className="block h-full origin-left animate-ddm-bar rounded-full bg-primary"
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </span>
      <span className="text-right font-semibold tabular-nums text-foreground">{pct.toFixed(1).replace(".", ",")}%</span>
    </div>
  );
}
