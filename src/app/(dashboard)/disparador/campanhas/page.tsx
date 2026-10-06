"use client";

import { utmCpfKey, utmPhoneKey } from "@/lib/disparador/utm-links";
import { apiFetch } from "@/lib/api-fetch";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import {
  CampaignWebchatSettings,
  EMPTY_CAMPAIGN_WEBCHAT,
  campaignWebchatPayload,
  type CampaignWebchatValue,
} from "@/components/disparador/campaign-webchat-settings";
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
  Pencil,
  Upload,
  Loader2,
  BarChart2,
  Search,
  CheckCircle2,
  Download,
  ListChecks,
  Activity,
  AlertTriangle,
  Info,
  RefreshCw,
  ChevronLeft,
  ChevronRight
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
import { trackAction } from "@/hooks/use-telemetry";
import { useAuth } from "@/hooks/use-auth";
import { useDialogA11y } from "@/hooks/use-dialog-a11y";
import { TEMPLATE_VARS } from "@/lib/disparador/template-vars";
import { MessageTemplatePicker } from "@/components/disparador/message-template-picker";
import {
  findVariableProblems,
  previewCampaignMessage,
  synthesizeWahaVariableMap,
  placeholderNumbers,
  type PreviewContact,
} from "@/lib/disparador/preview-message";
import { WEEKDAY_LABELS, brasiliaLocalToIso, formatBrasilia } from "@/lib/disparador/send-window";
import {
  TEMPLATE_VALIDATION_COLUMNS,
  validateCampaignTemplate,
  type LocalTemplateRow,
} from "@/lib/disparador/template-validation";
import {
  campaignChannelGroupKey,
  stripMessageTemplate,
  validateCampaignChannels,
  validateCampaignMessages,
  type CampaignChannel,
} from "@/lib/disparador/campaign-validation";
import {
  looksLikeImportHeader,
  normalizeImportHeader,
  resolveImportRows,
  suggestImportColumnMap,
  type ImportColumnMap,
} from "@/lib/disparador/import-mapping";

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
  created_at: string;
  updated_at?: string | null;
  // Migration 078 — disparo em lote (ver worker.ts)
  batch_size?: number;
  batch_pause_seconds?: number;
  // Teto de envios/hora, enforced ao vivo por worker.ts/cron/route.ts —
  // usado pela estimativa (estimarDisparo) como piso de tempo mínimo.
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
  // equipe do passo Público (teamFilter), nunca enviado de volta ao servidor.
  team_id?: string | null;
  // Canal desabilitado não recebe envio: só aparece na lista se já estiver
  // selecionado (campanha antiga), para poder ser desmarcado.
  habilitado?: boolean;
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
    // Resolvido por contato em src/lib/disparador/startCampaign.ts a
    // partir de wacrm.disparador_utm_links (telefone normalizado ->
    // link_curto), populada por handleGerarUTM — ver migration 076.
    | { type: "utm_link" }
    // Resolvido por contato em startCampaign.ts a partir de
    // wacrm.contact_import_variables (contact_id + var_index -> value),
    // populada no import de contatos a partir das colunas VAR1/VAR2/VAR3
    // do CSV — ver migration 079.
    | { type: "csv_var"; index: 0 | 1 | 2 }
  >;
}

const STATUS_COLORS: Record<string, string> = {
  rascunho: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  agendado: "bg-blue-500/10 text-blue-500 border border-blue-500/20",
  em_execucao: "bg-emerald-500/10 text-emerald-500 border border-emerald-500/20",
  pausada: "bg-amber-500/10 text-amber-500 border border-amber-500/20",
  encerrada: "bg-zinc-500/10 text-zinc-500 border border-zinc-500/20",
  preparando: "bg-blue-500/10 text-blue-600 border border-blue-500/20 dark:text-blue-400",
};

const STATUS_LABELS: Record<string, string> = {
  rascunho: "Rascunho",
  agendado: "Agendado",
  em_execucao: "Em Execução",
  pausada: "Pausada",
  encerrada: "Encerrada",
  preparando: "Preparando envio",
};

type DispatchMode = "imediato" | "balanceado" | "cauteloso" | "personalizado" | "segmentado";

interface DispatchModeOption {
  key: DispatchMode;
  emoji: string;
  label: string;
  description: string;
  // Ausente em "personalizado" e "segmentado" — os campos técnicos ficam
  // sob controle manual do usuário (personalizado) ou são derivados de
  // batchPercent/batchPauseMinutes (segmentado) em vez de serem
  // sobrescritos ao trocar de modo.
  preset?: { batchSize: number; batchPauseSeconds: number; intervaloMin: number; intervaloMax: number };
}

const DISPATCH_MODES: DispatchModeOption[] = [
  {
    key: "imediato",
    emoji: "🚀",
    label: "Imediato",
    description: "Sem pausas, envia tudo de uma vez",
    // batchSize bem acima de qualquer lista real — na prática todos os
    // contatos caem num lote só (ver estimarDisparo/startCampaign.ts).
    preset: { batchSize: 999999, batchPauseSeconds: 0, intervaloMin: 0, intervaloMax: 0 },
  },
  {
    key: "balanceado",
    emoji: "⚖️",
    label: "Balanceado",
    description: "Pausas automáticas anti-spam ativadas",
    preset: { batchSize: 1, batchPauseSeconds: 0, intervaloMin: 1, intervaloMax: 3 },
  },
  {
    key: "cauteloso",
    emoji: "🐢",
    label: "Cauteloso",
    description: "Pausas longas entre mensagens",
    preset: { batchSize: 1, batchPauseSeconds: 0, intervaloMin: 5, intervaloMax: 15 },
  },
  {
    key: "personalizado",
    emoji: "⚙️",
    label: "Personalizado",
    description: "Configuração manual dos campos técnicos",
  },
  {
    key: "segmentado",
    emoji: "📊",
    label: "Segmentado",
    description: "Envia um percentual da lista a cada rodada",
  },
];

// Reconstrói o modo a partir dos valores técnicos salvos (edição de
// campanha existente ou draft antigo sem dispatchMode gravado) — cai em
// "personalizado" quando a combinação não bate exatamente com nenhum
// preset (campanha criada antes desta mudança, ou ajustada manualmente).
// batchPercent tem prioridade sobre a busca por preset: uma campanha só
// tem esse campo preenchido quando "Segmentado" foi escolhido (migration
// 114), então ele por si só já identifica o modo sem precisar bater
// contra batchSize/batchPauseSeconds (que nem são o preset estático de
// nenhum outro modo nesse caso).
function inferDispatchMode(
  batchSize: number,
  batchPauseSeconds: number,
  intervaloMin: number,
  intervaloMax: number,
  batchPercent?: number | null
): DispatchMode {
  if (batchPercent != null) return "segmentado";
  const found = DISPATCH_MODES.find(
    (m) =>
      m.preset &&
      m.preset.batchSize === batchSize &&
      m.preset.batchPauseSeconds === batchPauseSeconds &&
      m.preset.intervaloMin === intervaloMin &&
      m.preset.intervaloMax === intervaloMax
  );
  return found?.key ?? "personalizado";
}

type TemplateMode = "sequencia" | "rotacao" | "aleatorio";

const TEMPLATE_MODE_OPTIONS: Array<{ key: TemplateMode; label: string; description: string }> = [
  { key: "sequencia", label: "Sequência", description: "Todas as mensagens, em ordem, para cada contato" },
  { key: "rotacao", label: "Rotação", description: "1 mensagem por contato, alternando em round-robin" },
  { key: "aleatorio", label: "Aleatório", description: "1 mensagem por contato, sorteada entre as configuradas" },
];

// campaigns.dias_permitidos (jsonb "dias da semana permitidos") nunca foi
// lida por este código — reaproveitada para guardar o modo de alternância
// de templates sem precisar de uma migration nova (ver EDITABLE_FIELDS em
// api/disparador/campaigns/[id]/route.ts e a mesma lógica em
// startCampaign.ts). Linhas antigas ainda têm o array-default
// [1,2,3,4,5,6]; qualquer valor que não seja "rotacao"/"aleatorio" cai em
// "sequencia" (comportamento original).
function parseTemplateMode(raw: unknown): TemplateMode {
  return raw === "rotacao" || raw === "aleatorio" ? raw : "sequencia";
}

// Browser-local safety net against an accidentally closed creation modal,
// not a per-campaign store. Never touched by edit mode (see editingId
// guards below), so editing a real campaign can't clobber or be clobbered
// by this. Scoped by account_id (see draftKey below) so a shared browser
// profile logged into different accounts never bleeds a draft across them.
function draftStorageKey(accountId: string | null): string | null {
  return accountId ? `disparador:campaign-draft:${accountId}` : null;
}

// Campos DDM do sub-step de mapeamento de colunas (passo Público, após a prévia
// do CSV) — chave bate com o que import/route.ts espera em column_map.
const COLUMN_MAP_FIELDS: Array<{ key: keyof ImportColumnMap; label: string }> = [
  { key: "name", label: "Nome do contato" },
  { key: "phone", label: "Telefone principal" },
  { key: "cpf", label: "CPF" },
  { key: "var1", label: "Variável do template {{1}}" },
  { key: "var2", label: "Variável do template {{2}}" },
  { key: "var3", label: "Variável do template {{3}}" },
];

type WizardStep = 1 | 2 | 3 | 4;

const WIZARD_STEPS: Array<{ step: WizardStep; label: string }> = [
  { step: 1, label: "Público" },
  { step: 2, label: "Mensagem" },
  { step: 3, label: "Agenda" },
  { step: 4, label: "Revisão" },
];

// Tipos de mensagem que só fazem sentido com uma URL de mídia.
const MEDIA_MESSAGE_TYPES = ["imagem", "video", "audio", "arquivo", "ligacao"];

// Contato fictício da prévia quando não há CSV (público por tabulação ou
// conta inteira) — só nome/telefone/empresa; VARn e UTM ficam pendentes.
const SAMPLE_PREVIEW_CONTACT = {
  name: "Maria Silva",
  phone: "5511999990000",
  company: "Empresa Exemplo",
};

function formatColumnLabel(value: string | null | undefined): string {
  return !value || value === "__none__" ? "Nenhum" : value;
}

interface CampaignDraft {
  nome: string;
  descricao: string;
  selectedSessions: string[];
  selectedTags: string[];
  intervaloMin: number;
  intervaloMax: number;
  janelaInicio: string;
  janelaFim: string;
  batchSize: number;
  batchPauseSeconds: number;
  batchPercent: number;
  batchPauseMinutes: number;
  dispatchMode: DispatchMode;
  templateMode: TemplateMode;
  mensagens: CampaignMessage[];
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

interface EstimativaDisparo {
  totalSegundos: number;
  pausas1h: number;
  pausas10m: number;
  diasNecessarios: number;
  fimEstimado: Date;
  label: string;
  detalhe: string;
  aviso?: string;
}

// Trava de segurança contra janelas configuradas de forma degenerada (ex:
// 1 minuto de janela por dia com milhares de contatos) — sem isso o loop
// de simulação dia-a-dia abaixo rodaria efetivamente pra sempre.
const MAX_DIAS_SIMULACAO_ESTIMATIVA = 3650;

// Replica, em tempo de estimativa, exatamente o que start/route.ts calcula
// pra scheduled_at (delay médio por contato + pausas anti-spam a cada
// 20/100 contatos) e o que processQueue.ts faz quando um item cai fora da
// janela (empurra pro início da janela do dia seguinte). Pura — sem
// fetch, sem state, só matemática a partir dos parâmetros recebidos.
//
// `janelaAtiva` usa o MESMO critério de start/route.ts (hasWindow): só
// conta como ativa quando início e fim estão preenchidos e nenhum dos
// dois está no valor-padrão de "sem restrição" (00:00 / 23:59).
//
// batchSize/batchPauseSeconds (migration 078, ver worker.ts): com
// batchSize > 1, N contatos são processados em grupos de batchSize em
// paralelo — o tempo do lote é o do item mais lento dele (delayPorContato,
// não a soma), com batchPauseSeconds entre lotes consecutivos. Defaults
// (1 / 0) reduzem a fórmula exatamente ao comportamento sequencial
// anterior, então chamadas existentes sem esses dois argumentos continuam
// idênticas.
function estimarDisparo(
  n: number,
  numMensagens: number,
  intervaloMinS: number,
  intervaloMaxS: number,
  janelaInicio: string | null,
  janelaFim: string | null,
  agora: Date = new Date(),
  batchSize: number = 1,
  batchPauseSeconds: number = 0,
  limitePorHora: number = 0
): EstimativaDisparo {
  if (n <= 0) {
    return {
      totalSegundos: 0,
      pausas1h: 0,
      pausas10m: 0,
      diasNecessarios: 0,
      fimEstimado: agora,
      label: "—",
      detalhe: "",
    };
  }

  const intraDelayS = 3;
  const intervaloMedioS = (intervaloMinS + intervaloMaxS) / 2;
  const delayPorContatoS = Math.max(0, numMensagens - 1) * intraDelayS + intervaloMedioS;

  // Com batchSize > 1, os lotes saem em paralelo entre si — o tempo total
  // é só a soma das pausas entre lotes (batchPauseSeconds), igual ao que
  // startCampaign.ts de fato agenda (loteIndex * batchPauseMs); intervalo_
  // min/max não são usados nesse modo, então delayPorContatoS não entra
  // aqui. batchSize=1 (default) usa a fórmula sequencial de sempre.
  const batchSizeEfetivo = Math.max(1, batchSize);
  const numLotes = Math.ceil(n / batchSizeEfetivo);
  const pausaEntreLotesS = batchPauseSeconds * Math.max(0, numLotes - 1);
  let tempoBrutoS: number;
  if (batchSizeEfetivo > 1) {
    // Modo lote: só conta pausa entre lotes
    // intervalo_min/max não são usados pelo startCampaign.ts neste modo
    tempoBrutoS = Math.max(0, numLotes - 1) * batchPauseSeconds;
  } else {
    // Modo sequencial: fórmula atual (não alterar)
    tempoBrutoS = numLotes * delayPorContatoS + pausaEntreLotesS;
  }

  // limite_por_hora (teto de envios/hora, enforced ao vivo por worker.ts/
  // cron/route.ts) — nunca reduz a estimativa, só impõe um piso quando o
  // teto é mais restritivo que o ritmo calculado acima.
  if (limitePorHora > 0) {
    const tempoMinPorLimiteS = Math.ceil(n / limitePorHora) * 3600;
    tempoBrutoS = Math.max(tempoBrutoS, tempoMinPorLimiteS);
  }

  // Pausas anti-spam — mesma regra "else if" (não cumulativa) de
  // start/route.ts: no contato 100 (múltiplo de 100 E de 20), só a pausa
  // de 1h conta. Suprimidas quando batchSize > 1: batchPauseSeconds já
  // controla o ritmo do lote, e essas pausas automáticas foram desenhadas
  // pro ritmo sequencial do WAHA (API não oficial) — redundantes aqui.
  const pausas1h = batchSizeEfetivo > 1 ? 0 : Math.floor(n / 100);
  const pausas10m = batchSizeEfetivo > 1 ? 0 : Math.floor(n / 20) - Math.floor(n / 100);
  const tempoPausasS = pausas1h * 3600 + pausas10m * 600;
  const tempoComPausasS = tempoBrutoS + tempoPausasS;

  const janelaAtiva =
    !!janelaInicio && !!janelaFim && janelaInicio !== "00:00" && janelaFim !== "23:59";

  let fimEstimado: Date;
  let diasNecessarios = 0;
  let aviso: string | undefined;

  if (!janelaAtiva) {
    fimEstimado = new Date(agora.getTime() + tempoComPausasS * 1000);
  } else {
    const [inicioH, inicioM] = janelaInicio!.split(":").map(Number);
    const [fimH, fimM] = janelaFim!.split(":").map(Number);
    const inicioMin = inicioH * 60 + inicioM;
    const fimMin = fimH * 60 + fimM;
    const janelaSegundosPorDia = Math.max(0, (fimMin - inicioMin) * 60);

    if (janelaSegundosPorDia === 0) {
      // Janela degenerada (fim <= início) — não dá pra simular, cai pro
      // caso sem janela em vez de travar.
      fimEstimado = new Date(agora.getTime() + tempoComPausasS * 1000);
      aviso = "Janela passa da meia-noite — a estimativa de tempo ignora a janela.";
    } else {
      let tempoRestanteS = tempoComPausasS;
      let cursor = new Date(agora);

      while (true) {
        if (diasNecessarios > MAX_DIAS_SIMULACAO_ESTIMATIVA) {
          aviso = "Estimativa muito longa para a janela configurada — verifique o horário.";
          break;
        }

        const cursorMin = cursor.getHours() * 60 + cursor.getMinutes();
        const dentroDaJanela = cursorMin >= inicioMin && cursorMin < fimMin;

        if (!dentroDaJanela) {
          // Fora da janela agora — pula pro início da janela seguinte
          // (hoje, se ainda não abriu; amanhã, se já fechou), igual ao
          // "empurra pra amanhã" que processQueueItem faz por item.
          const alvo = new Date(cursor);
          if (cursorMin >= fimMin) alvo.setDate(alvo.getDate() + 1);
          alvo.setHours(inicioH, inicioM, 0, 0);
          cursor = alvo;
          diasNecessarios += 1;
          continue;
        }

        const restanteHojeS = (fimMin - cursorMin) * 60 - cursor.getSeconds();
        const consumidoS = Math.min(tempoRestanteS, restanteHojeS);
        tempoRestanteS -= consumidoS;
        cursor = new Date(cursor.getTime() + consumidoS * 1000);

        if (tempoRestanteS <= 0) break;

        // Consumiu o resto da janela de hoje e ainda sobra tempo —
        // avança pro início da janela de amanhã.
        const amanha = new Date(cursor);
        amanha.setDate(amanha.getDate() + 1);
        amanha.setHours(inicioH, inicioM, 0, 0);
        cursor = amanha;
        diasNecessarios += 1;
      }

      fimEstimado = cursor;

      // Aviso educativo: uma vez que o cronograma extrapola a janela de
      // um dia, os itens empurrados pra amanhã perdem o espaçamento
      // planejado (todos caem no mesmo scheduled_at, ver processQueue.ts)
      // e saem na cadência real do worker, não em intervalo_min/max — a
      // estimativa tende a ser otimista nesse cenário.
      if (!aviso && diasNecessarios > 1 && tempoComPausasS > janelaSegundosPorDia * 0.8) {
        aviso = "Estimativa aproximada — janela estreita pode alterar o espaçamento real.";
      }
    }
  }

  const totalSegundos = Math.max(
    0,
    Math.round((fimEstimado.getTime() - agora.getTime()) / 1000)
  );

  const detalheParts: string[] = [];
  if (batchSizeEfetivo > 1) {
    detalheParts.push(`Lote de ${batchSizeEfetivo}x — pausa ${batchPauseSeconds}s entre lotes`);
  }
  if (pausas1h > 0) detalheParts.push(`${pausas1h} pausa${pausas1h > 1 ? "s" : ""} de 1h`);
  if (pausas10m > 0) detalheParts.push(`${pausas10m} pausa${pausas10m > 1 ? "s" : ""} de 10min`);

  return {
    totalSegundos,
    pausas1h,
    pausas10m,
    diasNecessarios,
    fimEstimado,
    label: `~${formatResponseTime(totalSegundos)}`,
    detalhe: detalheParts.join(" + "),
    aviso,
  };
}

// Mesmos aliases de coluna usados no import server-side
// (src/app/api/disparador/contacts/import/route.ts: TELEFONE2_KEYS/
// TELEFONE3_KEYS) — duplicado aqui porque o preview do wizard faz seu
// próprio parse client-side (parseImportFile) e guarda o CSV bruto por
// linha em `raw`, então dá pra derivar a contagem sem re-parsear nada.
const ALT_PHONE_COLUMN_KEYS = [
  ["telefone2", "telefone 2", "fone2", "fone 2", "celular2", "celular 2", "whatsapp2", "whatsapp 2", "tel2", "tel 2"],
  ["telefone3", "telefone 3", "fone3", "fone 3", "celular3", "celular 3", "whatsapp3", "whatsapp 3", "tel3", "tel 3"],
];

function countAltPhones(raw: Record<string, string>): number {
  return ALT_PHONE_COLUMN_KEYS.filter((keys) => keys.some((k) => raw[k]?.trim())).length;
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

function isDraftEmpty(draft: CampaignDraft): boolean {
  return (
    !draft.nome.trim() &&
    !draft.descricao.trim() &&
    draft.selectedSessions.length === 0 &&
    draft.selectedTags.length === 0 &&
    draft.mensagens.length <= 1 &&
    !draft.mensagens[0]?.conteudo?.trim() &&
    !draft.mensagens[0]?.prompt?.trim()
  );
}

export default function CampanhasPage() {
  const { canManageMembers } = useAuth();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [recalculatingMetrics, setRecalculatingMetrics] = useState(false);
  const [tags, setTags] = useState<TagItem[]>([]);
  const [sessions, setSessions] = useState<WahaSession[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  // "" = Todas as equipes — filtra `sessions` no passo Público (ver
  // filteredSessions), nunca enviado ao servidor.
  const [teamFilter, setTeamFilter] = useState("");
  // Resolved once in loadData() — used to scope the localStorage draft key.
  const [accountId, setAccountId] = useState<string | null>(null);
  const draftKey = draftStorageKey(accountId);
  // Identifica esta sessão de criação de campanha antes que ela exista de
  // fato em wacrm.campaigns (links UTM podem ser gerados no passo Público, antes
  // do submit na Revisão) — ver handleGerarUTM/handleSubmit. Regenerado em
  // resetForm() a cada nova sessão; não usado em modo de edição
  // (editingId já tem o campaign_id real).
  const [draftId, setDraftId] = useState<string>(() => crypto.randomUUID());

  // Form Modal States
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Evita duplo-submit de handleSubmit (double-click / rede lenta) — sem
  // isso, dois inserts concorrentes em wacrm.campaigns competem pelo
  // mesmo relink de contact_import_variables/disparador_utm_links (ver
  // investigação do incidente de VAR2 vazio).
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [nome, setNome] = useState("");
  const [descricao, setDescricao] = useState("");
  const [selectedSessions, setSelectedSessions] = useState<string[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [tagSearch, setTagSearch] = useState("");
  // Defaults batem com o preset "balanceado" (DISPATCH_MODES) — dispatchMode
  // já nasce "balanceado" abaixo, então os valores técnicos precisam
  // concordar mesmo antes de resetForm()/handleDispatchModeChange() rodar.
  const [intervaloMin, setIntervaloMin] = useState(1);
  const [intervaloMax, setIntervaloMax] = useState(3);
  const [janelaInicio, setJanelaInicio] = useState("08:00");
  const [janelaFim, setJanelaFim] = useState("18:00");
  // Dias da semana permitidos (vazio = todos).
  const [diasEnvio, setDiasEnvio] = useState<number[]>([]);
  const [batchSize, setBatchSize] = useState(1);
  const [batchPauseSeconds, setBatchPauseSeconds] = useState(0);
  // Modo "Segmentado" — % da lista por rodada + intervalo entre rodadas
  // em minutos. Convertidos para batchSize/batchPauseSeconds só para a
  // prévia/estimativa (ver handleDispatchModeChange e o useEffect
  // abaixo); o cálculo que de fato vale para o envio é feito em
  // startCampaign.ts no momento real do início, contra batch_percent.
  const [batchPercent, setBatchPercent] = useState(10);
  const [batchPauseMinutes, setBatchPauseMinutes] = useState(30);
  const [dispatchMode, setDispatchMode] = useState<DispatchMode>("balanceado");
  const [templateMode, setTemplateMode] = useState<TemplateMode>("sequencia");
  const [webchat, setWebchat] = useState<CampaignWebchatValue>(EMPTY_CAMPAIGN_WEBCHAT);
  const [agendarPara, setAgendarPara] = useState<string>("");
  const [mensagens, setMensagens] = useState<any[]>([{ tipo: "texto", conteudo: "" }]);

  // Assistente em 4 passos: 1 Público, 2 Mensagem, 3 Agenda, 4 Revisão.
  // `maxVisitedStep` libera os indicadores de passos já vistos; avançar
  // sempre passa por validateWizardStep. `errorStep` = passo cujo "Avançar"
  // foi barrado — os erros dele ficam visíveis (e recalculados) no topo.
  const [wizardStep, setWizardStep] = useState<WizardStep>(1);
  const [maxVisitedStep, setMaxVisitedStep] = useState<WizardStep>(1);
  const [errorStep, setErrorStep] = useState<WizardStep | null>(null);
  // Aceite explícito de "todos os contatos da conta" quando não há CSV nem
  // tabulação (antes era só um aviso no resumo).
  const [confirmAllContacts, setConfirmAllContacts] = useState(false);
  // Campanha em edição já tem base importada vinculada ("csv", ou antiga
  // sem audience_mode mas com import_draft_id) — o passo Público não exige
  // reimportar. Campanha por tabulação/conta NÃO entra aqui: zerar as
  // tabulações dela exige o aceite de "toda a conta".
  const [editingHasImportedBase, setEditingHasImportedBase] = useState(false);
  // Passo Público — importação de base
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importPreview, setImportPreview] = useState<Array<{
    phone: string;
    name?: string;
    cpf?: string;
    variables: string[];
    raw: Record<string, string>;
  }> | null>(null);
  const [importAllRows, setImportAllRows] = useState<Array<{
    phone: string;
    cpf?: string;
    variables: string[];
  }> | null>(null);
  const [importLoading, setImportLoading] = useState(false);
  const [utmGerado, setUtmGerado] = useState(false);
  const [utmLoading, setUtmLoading] = useState(false);
  const [utmProgress, setUtmProgress] = useState<{
    total: number;
    gerados: number;
    erros: number;
  } | null>(null);
  const [importStats, setImportStats] = useState<{
    total: number;
    valid: number;
    invalid: number;
  } | null>(null);
  // Mapeamento manual de colunas (Correção 3) — headers do CSV pra
  // popular os selects, e o mapeamento em si (campo DDM -> nome da coluna
  // no CSV), pré-preenchido pela heurística de parseImportFile e ajustável
  // pelo usuário antes de confirmar o import. Enviado como column_map
  // (JSON) pra import/route.ts; se nunca for tocado ainda é enviado com os
  // valores detectados automaticamente, então o backend sempre recebe um
  // mapeamento explícito quando há CSV (a heurística do backend só entra
  // em campos deixados em branco no select).
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [columnMap, setColumnMap] = useState<ImportColumnMap>({});
  const [mappingConfirmed, setMappingConfirmed] = useState(false);
  const [parsedImportData, setParsedImportData] = useState<{
    headers: string[];
    rows: string[][];
    hasHeader: boolean;
  } | null>(null);
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

  // Troca de "Modo de disparo": aplica os valores técnicos do preset
  // (delay/lote) de uma vez, exceto em "personalizado" — nesse caso os
  // campos ficam como estavam para o usuário ajustar manualmente.
  const handleDispatchModeChange = (mode: DispatchMode) => {
    setDispatchMode(mode);
    const preset = DISPATCH_MODES.find((m) => m.key === mode)?.preset;
    if (preset) {
      setBatchSize(preset.batchSize);
      setBatchPauseSeconds(preset.batchPauseSeconds);
      setIntervaloMin(preset.intervaloMin);
      setIntervaloMax(preset.intervaloMax);
    }
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
  // Público real da campanha no modal de início (PRD-01) — mesma resolução
  // do startCampaign (GET .../audience).
  const [audienceInfo, setAudienceInfo] = useState<
    | { ok: true; total: number; source: string; source_label: string; tags: string[]; already_sent: number }
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

  // Auto-save the in-progress form to localStorage — creation mode only.
  // Skipped while a restore decision is pending so we don't overwrite the
  // saved draft with the blank fields the modal opened with.
  useEffect(() => {
    if (!showModal || editingId || pendingDraft || !draftKey) return;

    const draft: CampaignDraft = {
      nome,
      descricao,
      selectedSessions,
      selectedTags,
      intervaloMin,
      intervaloMax,
      janelaInicio,
      janelaFim,
      batchSize,
      batchPauseSeconds,
      batchPercent,
      batchPauseMinutes,
      dispatchMode,
      templateMode,
      mensagens,
    };

    if (isDraftEmpty(draft)) {
      localStorage.removeItem(draftKey);
    } else {
      localStorage.setItem(draftKey, JSON.stringify(draft));
    }
  }, [
    showModal,
    editingId,
    pendingDraft,
    draftKey,
    nome,
    descricao,
    selectedSessions,
    selectedTags,
    intervaloMin,
    intervaloMax,
    janelaInicio,
    janelaFim,
    batchSize,
    batchPauseSeconds,
    batchPercent,
    batchPauseMinutes,
    dispatchMode,
    templateMode,
    mensagens,
  ]);

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

  // Poll campaigns periodically if any campaign is in execution
  useEffect(() => {
    const hasActiveCampaign = campaigns.some((c) => c.status === "em_execucao");
    if (!hasActiveCampaign) return;

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
          // Poll payload omits created_at (unused by the card UI) to
          // shave egress — cast past the stricter select()-inferred type.
          setCampaigns(campaignList as unknown as Campaign[]);
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
      // métricas" primeiro. metricsMap também alimenta a estimativa de
      // tempo dos cards (estimarDisparo), que antes só aparecia depois
      // do modal ser aberto pelo menos uma vez nesta sessão.
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

  // Abre o modal e busca info do canal antes de confirmar
  const handleStartClick = async (id: string) => {
    setStartConfirmId(id);
    setCampaignInfo(null);
    setAudienceInfo(null);
    setInfoLoading(true);
    audienceForRef.current = id;
    // Retomar campanha pausada não recalcula o público (startCampaign retoma
    // a fila existente) — só campanhas que ainda vão montar a fila.
    const isResume = campaigns.find((c) => c.id === id)?.status === "pausada";
    if (isResume) {
      setAudienceInfo({ ok: true, total: -1, source: "resume", source_label: "", tags: [], already_sent: 0 });
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

  // Open the modal pre-filled with an existing draft campaign's data.
  // Always sources from the real campaign row, never from the
  // localStorage creation-draft — clear any pending restore prompt so it
  // can't bleed into an edit session.
  const handleEditClick = (campaign: Campaign) => {
    setPendingDraft(null);
    setEditingId(campaign.id);
    setNome(campaign.nome);
    setDescricao(campaign.descricao || "");
    setSelectedSessions(campaign.session_ids || []);
    lastChannelGroupRef.current = null;
    setSelectedTags(campaign.tags_filtro || []);
    setIntervaloMin(campaign.intervalo_min);
    setIntervaloMax(campaign.intervalo_max);
    setJanelaInicio(campaign.janela_inicio);
    setJanelaFim(campaign.janela_fim);
    setDiasEnvio(campaign.dias_envio ?? []);
    setBatchSize(campaign.batch_size ?? 1);
    setBatchPauseSeconds(campaign.batch_pause_seconds ?? 0);
    if (campaign.batch_percent != null) {
      setBatchPercent(campaign.batch_percent);
      setBatchPauseMinutes(Math.max(1, Math.round((campaign.batch_pause_seconds ?? 0) / 60)));
    }
    setDispatchMode(
      inferDispatchMode(
        campaign.batch_size ?? 1,
        campaign.batch_pause_seconds ?? 0,
        campaign.intervalo_min,
        campaign.intervalo_max,
        campaign.batch_percent
      )
    );
    setTemplateMode(parseTemplateMode(campaign.dias_permitidos));
    setWebchat({
      webchat_enabled: campaign.webchat_enabled ?? false,
      webchat_flow_id: campaign.webchat_flow_id ?? null,
      webchat_message: campaign.webchat_message ?? "",
      webchat_button_text: campaign.webchat_button_text ?? "",
    });
    // Edição só é permitida para campanhas em "rascunho" (ver PATCH
    // /api/disparador/campaigns/[id]), que por definição nunca têm
    // agendamento — campo sempre reseta vazio aqui.
    setAgendarPara("");
    setMensagens(
      campaign.mensagens && campaign.mensagens.length > 0
        ? campaign.mensagens
        : [{ tipo: "texto", conteudo: "" }]
    );
    // Campanha já salva para "conta inteira" sem tabulação: o aceite já foi
    // dado antes (na criação, ou é campanha anterior ao assistente).
    setEditingHasImportedBase(
      campaign.audience_mode === "csv" ||
        (campaign.audience_mode == null && Boolean(campaign.import_draft_id))
    );
    setConfirmAllContacts(
      campaign.audience_mode === "account" && (campaign.tags_filtro ?? []).length === 0
    );
    setWizardStep(1);
    setMaxVisitedStep(1);
    setErrorStep(null);
    setShowModal(true);
  };

  // Open the modal for a brand new campaign. If a draft was left behind
  // by an accidentally closed modal, surface it for the user to decide
  // on rather than restoring it silently.
  const openCreateModal = () => {
    setEditingId(null);
    resetForm();

    let draft: CampaignDraft | null = null;
    if (draftKey) {
      try {
        const raw = localStorage.getItem(draftKey);
        draft = raw ? JSON.parse(raw) : null;
      } catch {
        draft = null;
      }
    }
    setPendingDraft(draft);

    setShowModal(true);
  };

  const restoreDraft = () => {
    if (!pendingDraft) return;
    setNome(pendingDraft.nome);
    setDescricao(pendingDraft.descricao);
    setSelectedSessions(pendingDraft.selectedSessions);
    setSelectedTags(pendingDraft.selectedTags);
    setIntervaloMin(pendingDraft.intervaloMin);
    setIntervaloMax(pendingDraft.intervaloMax);
    setJanelaInicio(pendingDraft.janelaInicio);
    setJanelaFim(pendingDraft.janelaFim);
    setBatchSize(pendingDraft.batchSize ?? 1);
    setBatchPauseSeconds(pendingDraft.batchPauseSeconds ?? 0);
    // Drafts salvos antes desta mudança não têm batchPercent/batchPauseMinutes.
    setBatchPercent(pendingDraft.batchPercent ?? 10);
    setBatchPauseMinutes(pendingDraft.batchPauseMinutes ?? 30);
    // Drafts salvos antes desta mudança não têm dispatchMode gravado —
    // reconstrói a partir dos valores técnicos nesse caso.
    setDispatchMode(
      pendingDraft.dispatchMode ??
        inferDispatchMode(
          pendingDraft.batchSize ?? 1,
          pendingDraft.batchPauseSeconds ?? 0,
          pendingDraft.intervaloMin,
          pendingDraft.intervaloMax
        )
    );
    // Drafts salvos antes desta mudança não têm templateMode gravado.
    setTemplateMode(pendingDraft.templateMode ?? "sequencia");
    setMensagens(pendingDraft.mensagens);
    setPendingDraft(null);

    // Base importada pertence ao CSV anterior; força reimport para
    // repropagar o template_variable_map com os valores corretos.
    setImportFile(null);
    setImportPreview(null);
    setImportStats(null);
    setImportAllRows(null);
    setCsvHeaders([]);
    setColumnMap({});
    setMappingConfirmed(false);
    setParsedImportData(null);
  };

  const discardDraft = () => {
    if (draftKey) localStorage.removeItem(draftKey);
    setPendingDraft(null);
  };

  const closeModal = () => {
    setShowModal(false);
    setEditingId(null);
    setPendingDraft(null);
    setWizardStep(1);
    setMaxVisitedStep(1);
    setErrorStep(null);
    setConfirmAllContacts(false);
    setImportFile(null);
    setImportPreview(null);
    setImportStats(null);
    setImportAllRows(null);
    setUtmGerado(false);
    setUtmLoading(false);
    setUtmProgress(null);
    setCsvHeaders([]);
    setColumnMap({});
    setMappingConfirmed(false);
    setParsedImportData(null);
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
    if (isSubmitting) return;
    if (!nome.trim()) {
      toast.error("Insira o nome da campanha.");
      return;
    }
    if (!channelValidation.ok) {
      toast.error(channelValidation.error);
      return;
    }
    if (mensagens.some((m) => m.tipo === "texto" && !m.conteudo.trim())) {
      toast.error("Todas as mensagens de texto precisam de conteúdo.");
      return;
    }
    if (mensagens.some((m) => m.tipo === "ia" && !m.prompt?.trim())) {
      toast.error("O prompt da mensagem IA não pode estar vazio.");
      return;
    }
    if (importFile && (!mappingConfirmed || !columnMap.phone)) {
      toast.error("Confirme o mapeamento e selecione a coluna de contato antes de importar.");
      return;
    }
    if (
      mensagens.some(
        (m) =>
          ["imagem", "video", "audio", "arquivo", "ligacao"].includes(m.tipo) && !m.url?.trim()
      )
    ) {
      toast.error("A URL da mídia é obrigatória para este tipo de mensagem.");
      return;
    }
    // Validar template_variable_map — variáveis estáticas não podem estar
    // vazias (Meta rejeita com erro #131008 no envio real).
    for (const msg of mensagens) {
      if (msg.template_variable_map) {
        const variavelVazia = msg.template_variable_map.findIndex(
          (v: any) => v.type === "static" && !v.value?.trim()
        );
        if (variavelVazia !== -1) {
          toast.error(
            `Variável {{${variavelVazia + 1}}} do template está vazia. Preencha um valor fixo ou mude para "Campo do contato".`
          );
          return;
        }
      }
    }
    const timeRegex = /^\d{2}:\d{2}(:\d{2})?$/;
    if (janelaInicio && !timeRegex.test(janelaInicio)) {
      toast.error("Horário de início inválido — use HH:MM.");
      return;
    }
    if (janelaFim && !timeRegex.test(janelaFim)) {
      toast.error("Horário de fim inválido — use HH:MM.");
      return;
    }
    const usaUtmLink = mensagens.some((m) =>
      Array.isArray(m.template_variable_map) &&
      m.template_variable_map.some((v: any) => v.type === "utm_link")
    );
    if (usaUtmLink && !utmGerado) {
      toast.warning(
        "Uma mensagem usa \"Link UTM personalizado\" mas os links ainda não " +
        "foram gerados — clique em \"Gerar UTM\" no passo Público antes de salvar, " +
        "senão esses contatos não receberão link."
      );
    }

    // Horário de Brasília com offset -03:00 explícito (datetime-local não
    // carrega fuso; antes valia o fuso do navegador).
    const agendamentoISO = agendarPara ? brasiliaLocalToIso(agendarPara) : null;
    if (agendarPara && !agendamentoISO) {
      toast.error("Data de agendamento inválida.");
      return;
    }

    setIsSubmitting(true);
    try {
      // Se há arquivo para importar, envia para o servidor primeiro
      if (importFile) {
        const formData = new FormData();
        formData.append("file", importFile);
        // campaign_id (edição) ou draft_id (criação, campanha ainda não
        // existe) — persistem VAR1/VAR2/VAR3 em
        // wacrm.contact_import_variables (migration 079). Mesmo padrão
        // de idColumn/idValue usado em handleGerarUTM abaixo.
        if (editingId) {
          formData.append("campaign_id", editingId);
        } else {
          formData.append("draft_id", draftId);
        }
        // Mapeamento de colunas confirmado/ajustado no passo Público (Correção 3)
        // — só envia se o usuário chegou a importar um CSV com colunas
        // detectadas (columnMap fica vazio se parseImportFile nunca rodou,
        // ex: reimportação de um estado antigo). Vazio → import/route.ts
        // cai 100% na heurística de sempre (retrocompat).
        if (Object.keys(columnMap).length > 0) {
          formData.append("column_map", JSON.stringify(columnMap));
        }
        formData.append("mapping_confirmed", mappingConfirmed ? "true" : "false");
        formData.append("has_header", parsedImportData?.hasHeader ? "true" : "false");
        formData.append("column_headers", JSON.stringify(csvHeaders));
        const importRes = await apiFetch(
          "/api/disparador/contacts/import",
          { method: "POST", body: formData }
        );
        if (!importRes.ok) {
          const err = await importRes.json();
          throw new Error(err.error || "Erro ao importar contatos");
        }
        const importResult = await importRes.json();

        const { importados = 0, duplicados = 0, invalidos = 0, erros = [] } = importResult.results ?? {};
        const partes = [`${importados} importados`];
        if (duplicados > 0) partes.push(`${duplicados} duplicados`);
        if (invalidos > 0) partes.push(`${invalidos} inválidos`);
        if (erros.length > 0) partes.push(`${erros.length} erros`);

        if (importados > 0) {
          toast.success(partes.join(" · "));
        } else {
          toast.warning(partes.join(" · ") + " — nenhum contato novo foi adicionado");
        }
        // VAR1–VAR3 que não foram gravadas: a campanha sairia com variável
        // vazia (contato marcado como erro) — avisa em vez de seguir calado.
        const variaveisFalhas = Number(importResult.results?.variaveis_falhas ?? 0);
        if (variaveisFalhas > 0) {
          toast.error(
            `${variaveisFalhas} valores de VAR1–VAR3 não foram salvos. Importe o arquivo de novo antes de iniciar a campanha.`,
            { duration: 15000 }
          );
        }

        trackAction("csv_imported", {
          total_rows: importados + duplicados + invalidos + erros.length,
        });
      }

      if (editingId) {
        // Editing goes through a server route so ownership + the
        // "rascunho" status lock are re-checked there (see
        // /api/disparador/campaigns/[id] PATCH) instead of trusting a
        // direct client-side update.
        // WAHA texto livre com {{N}} no conteúdo mas sem template_variable_map
        // (mensagem digitada à mão, não veio do catálogo de templates Meta nem
        // já foi processada) — sintetiza o mapa a partir do columnMap do passo Público
        // pra startCampaign.ts conseguir resolver os placeholders no enqueue.
        // Regra extraída para synthesizeWahaVariableMap (preview-message.ts),
        // a mesma usada pela prévia do passo Revisão.
        const mensagensComMap = mensagens.map((msg: any) => synthesizeWahaVariableMap(msg, columnMap));

        const res = await apiFetch(`/api/disparador/campaigns/${editingId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            // Só muda a origem do público quando houve import nesta edição;
            // senão uma campanha de CSV viraria "conta inteira".
            // Sem base importada, o público passa a ser o que a tela mostra:
            // tabulação, ou toda a conta (já confirmada no passo Público).
            ...(importAllRows?.length
              ? { audience_mode: "csv" }
              : keepsExistingAudience
                ? {}
                : { audience_mode: selectedTags.length > 0 ? "tags" : "account" }),
            nome,
            descricao,
            session_ids: selectedSessions,
            tags_filtro: selectedTags,
            mensagens: mensagensComMap,
            intervalo_min: intervaloMin,
            intervalo_max: intervaloMax,
            janela_inicio: janelaInicio,
            janela_fim: janelaFim,
            dias_envio: diasEnvio.length > 0 ? diasEnvio : null,
            batch_size: batchSize,
            batch_pause_seconds: batchPauseSeconds,
            // Migration 114 — modo "Segmentado"; null em qualquer outro modo.
            batch_percent: dispatchMode === "segmentado" ? batchPercent : null,
            // Reaproveita a coluna dias_permitidos — ver parseTemplateMode.
            dias_permitidos: templateMode,
            agendamento: agendamentoISO,
            ...campaignWebchatPayload(webchat),
          }),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || "Erro ao atualizar campanha");
        }
        toast.success("Campanha atualizada!");
        // total_contatos não é conhecido aqui — só é resolvido dentro
        // de startCampaign() (contagem real acontece no início do
        // envio, não na criação/edição do formulário).
        trackAction("campaign_updated", { campaign_id: editingId, nome, total_contatos: null });
      } else {
        if (!accountId) throw new Error("Conta não resolvida — recarregue a página e tente de novo.");

        // A criação é server-authoritative: account_id, created_by e status
        // são definidos/revalidados na API, não confiados ao navegador.
        const mensagensComMap = mensagens.map((msg: any) =>
          synthesizeWahaVariableMap(msg, columnMap)
        );

        const res = await apiFetch("/api/disparador/campaigns", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            nome,
            descricao,
            session_ids: selectedSessions,
            tags_filtro: selectedTags,
            mensagens: mensagensComMap,
            intervalo_min: intervaloMin,
            intervalo_max: intervaloMax,
            janela_inicio: janelaInicio,
            janela_fim: janelaFim,
            ...(diasEnvio.length > 0 ? { dias_envio: diasEnvio } : {}),
            batch_size: batchSize,
            batch_pause_seconds: batchPauseSeconds,
            batch_percent: dispatchMode === "segmentado" ? batchPercent : null,
            dias_permitidos: templateMode,
            agendamento: agendamentoISO,
            ...campaignWebchatPayload(webchat),
            audience_mode:
              importAllRows?.length ? "csv" : selectedTags.length > 0 ? "tags" : "account",
            import_draft_id: draftId,
          }),
        });
        const created = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(created.error || "Erro ao criar campanha");
        const newCampaign = { id: created.id as string };

        // Dados auxiliares do draft ainda têm escrita client-side própria.
        // O estado crítico da campanha não depende mais disso e já foi
        // persistido/revalidado pela API acima.
        const supabase = createClient();
        if (utmGerado) {
          const { error: relinkErr } = await supabase
            .from("disparador_utm_links")
            .update({ campaign_id: newCampaign.id })
            .eq("draft_id", draftId)
            .is("campaign_id", null);
          if (relinkErr) {
            console.error("[UTM] Falha ao vincular links à campanha:", relinkErr);
          }
        }

        const { error: csvVarRelinkErr } = await supabase
          .from("contact_import_variables")
          .update({ campaign_id: newCampaign.id })
          .eq("draft_id", draftId)
          .is("campaign_id", null);
        if (csvVarRelinkErr) {
          console.error("[Contacts Import] Falha ao vincular variáveis CSV à campanha:", csvVarRelinkErr);
        }

        if (draftKey) localStorage.removeItem(draftKey);
        toast.success("Campanha criada!");
        // total_contatos não é conhecido aqui — mesma observação do
        // ramo de edição acima.
        trackAction("campaign_created", { campaign_id: newCampaign.id, nome, total_contatos: null });
      }

      setShowModal(false);
      setEditingId(null);
      setPendingDraft(null);
      resetForm();
      loadData();
    } catch (err: any) {
      toast.error(err.message || "Erro ao salvar campanha");
    } finally {
      setIsSubmitting(false);
    }
  };

  const resetForm = () => {
    setDiasEnvio([]);
    setNome("");
    setDescricao("");
    setSelectedSessions([]);
    lastChannelGroupRef.current = null;
    setSelectedTags([]);
    setTagSearch("");
    setTeamFilter("");
    setMensagens([{ tipo: "texto", conteudo: "" }]);
    // "Balanceado" é o modo default do formulário — ver DISPATCH_MODES.
    setDispatchMode("balanceado");
    const balanceadoPreset = DISPATCH_MODES.find((m) => m.key === "balanceado")!.preset!;
    setIntervaloMin(balanceadoPreset.intervaloMin);
    setIntervaloMax(balanceadoPreset.intervaloMax);
    setBatchSize(balanceadoPreset.batchSize);
    setBatchPauseSeconds(balanceadoPreset.batchPauseSeconds);
    setBatchPercent(10);
    setBatchPauseMinutes(30);
    setTemplateMode("sequencia");
    setWebchat(EMPTY_CAMPAIGN_WEBCHAT);
    setAgendarPara("");
    setWizardStep(1);
    setMaxVisitedStep(1);
    setErrorStep(null);
    setConfirmAllContacts(false);
    setImportFile(null);
    setImportPreview(null);
    setImportStats(null);
    setImportAllRows(null);
    setUtmGerado(false);
    setUtmLoading(false);
    setUtmProgress(null);
    setCsvHeaders([]);
    setColumnMap({});
    setMappingConfirmed(false);
    setParsedImportData(null);
    // Nova sessão de criação — qualquer link UTM salvo sob o draftId
    // anterior fica órfão (campaign_id nunca chegou a ser preenchido),
    // mas isso é inofensivo: nada mais faz join por esse draftId.
    setDraftId(crypto.randomUUID());
    setEditingHasImportedBase(false);
  };

  // Meta channels can only send approved templates — the picker needs to
  // know this to show the Meta catalog instead of the account's own
  // editable disparador_message_templates list.
  const hasMeta = sessions
    .filter((s) => selectedSessions.includes(s.id))
    .some((s) => s.provider === "meta");

  // Canais como a validação compartilhada (campaign-validation.ts) espera —
  // mesma regra do PATCH e do startCampaign: só canais habilitados, sem
  // misturar Meta e WAHA, campanha Meta = uma única WABA.
  const validationChannels: CampaignChannel[] = useMemo(
    () =>
      sessions.map((s) => ({
        id: s.id,
        provider: s.provider ?? null,
        waba_id: s.waba_id ?? null,
        habilitado: s.habilitado,
        label: s.name,
      })),
    [sessions]
  );
  const channelValidation = validateCampaignChannels(selectedSessions, validationChannels);
  // WABA da campanha Meta (o picker e a validação de template usam só ela).
  const campaignWabaId =
    channelValidation.ok && channelValidation.provider === "meta" ? channelValidation.wabaId : undefined;

  // Validação dos templates Meta escolhidos (mesma regra do início da
  // campanha e do PATCH — template-validation.ts via campaign-validation.ts):
  // aviso inline logo ao escolher e bloqueio do Avançar/Salvar.
  const templateNamesKey = useMemo(
    () =>
      [...new Set(mensagens.map((m) => m.template_name).filter((n): n is string => !!n))]
        .sort()
        .join("|"),
    [mensagens]
  );
  const [templateCatalogRows, setTemplateCatalogRows] = useState<LocalTemplateRow[]>([]);
  // Para qual (conta#nomes) templateCatalogRows foi carregado — enquanto
  // não bate, o passo Mensagem espera em vez de acusar "não encontrado".
  const [templateCatalogKey, setTemplateCatalogKey] = useState<string | null>(null);
  useEffect(() => {
    if (!hasMeta || !accountId || !templateNamesKey) return;
    let cancelled = false;
    const key = `${accountId}#${templateNamesKey}`;
    (async () => {
      const { data, error } = await createClient()
        .from("message_templates")
        .select(TEMPLATE_VALIDATION_COLUMNS)
        .eq("account_id", accountId)
        .in("name", templateNamesKey.split("|"));
      if (cancelled) return;
      if (error) console.error("Falha ao ler o catálogo de templates:", error.message);
      setTemplateCatalogRows(error ? [] : ((data ?? []) as LocalTemplateRow[]));
      setTemplateCatalogKey(key);
    })();
    return () => {
      cancelled = true;
    };
  }, [hasMeta, accountId, templateNamesKey]);

  const templateWarning = (msg: CampaignMessage): string | null => {
    if (!hasMeta || !msg.template_name || !Array.isArray(msg.template_variable_map)) return null;
    if (templateCatalogKey !== `${accountId ?? ""}#${templateNamesKey}`) return null;
    const result = validateCampaignTemplate({
      templateName: msg.template_name,
      language: msg.template_language || "pt_BR",
      mappedVariables: msg.template_variable_map.length,
      rows: templateCatalogRows,
      wabaIds: campaignWabaId ? [campaignWabaId] : [],
    });
    return result.ok ? null : result.error;
  };

  // Troca de canais. Mudar o provider (Meta ↔ WAHA) ou a WABA invalida os
  // templates escolhidos (são da WABA) e o mapa de variáveis: pede
  // confirmação e limpa template_* de todas as mensagens. Trocar de número
  // dentro da mesma WABA mantém tudo. lastChannelGroupRef guarda o último
  // grupo válido, para "desmarca tudo e marca outro número" também contar.
  const lastChannelGroupRef = useRef<string | null>(null);
  const [pendingChannelChange, setPendingChannelChange] = useState<string[] | null>(null);
  const channelChangeNeedsReset = (next: string[]): boolean => {
    const prevKey =
      campaignChannelGroupKey(selectedSessions, validationChannels) ?? lastChannelGroupRef.current;
    const nextKey = campaignChannelGroupKey(next, validationChannels);
    if (!prevKey || !nextKey || prevKey === nextKey) return false;
    const nextIsMeta = nextKey.startsWith("meta:");
    return mensagens.some(
      (m: CampaignMessage) =>
        Boolean(m.template_name) ||
        Array.isArray(m.template_variable_map) ||
        (nextIsMeta && (m.tipo !== "texto" || Boolean(m.conteudo?.trim())))
    );
  };
  const applyChannelSelection = (next: string[], resetTemplates: boolean) => {
    const nextKey = campaignChannelGroupKey(next, validationChannels);
    if (resetTemplates) {
      const nextIsMeta = Boolean(nextKey?.startsWith("meta:"));
      setMensagens(
        mensagens.map((m: CampaignMessage) =>
          // Meta só envia template: a mensagem volta a ficar vazia,
          // esperando a escolha de um template da nova WABA.
          nextIsMeta ? { tipo: "texto", conteudo: "" } : stripMessageTemplate(m)
        )
      );
    }
    if (nextKey) lastChannelGroupRef.current = nextKey;
    setSelectedSessions(next);
  };
  const changeChannelSelection = (next: string[]) => {
    if (channelChangeNeedsReset(next)) setPendingChannelChange(next);
    else applyChannelSelection(next, false);
  };

  // Derivado, recalculado a cada render — barato o suficiente pra não
  // precisar de useMemo. Null quando não há CSV importado nesta sessão
  // (campanha "via tags do CRM" não tem N conhecido no cliente antes do
  // start de verdade — ver investigação, não existe endpoint hoje que
  // resolva a contagem de contatos por tag sem duplicar a lógica de
  // start/route.ts).
  // "rotacao"/"aleatorio" mandam só 1 mensagem por contato (ver
  // startCampaign.ts: messagesToSend) — a estimativa precisa refletir isso
  // pra não superestimar o tempo com o intraDelay de uma sequência que não
  // vai acontecer.
  const numMensagensPorContato = templateMode === "sequencia" ? mensagens.length : 1;

  const estimativa = (importStats?.valid ?? 0) > 0
    ? estimarDisparo(
        importStats!.valid,
        numMensagensPorContato,
        intervaloMin,
        intervaloMax,
        janelaInicio || null,
        janelaFim || null,
        undefined,
        batchSize,
        batchPauseSeconds,
        // Sem state de limite_por_hora no wizard hoje (campo não tem UI
        // aqui — ver investigação) — 0 = sem teto, comportamento igual
        // a antes desta mudança.
        0
      )
    : null;

  // Canais WAHA (texto livre) entre os selecionados — junto com hasMeta,
  // decide o aviso de canais misturados e quais prévias mostrar.
  const hasWaha = sessions
    .filter((s) => selectedSessions.includes(s.id))
    .some((s) => s.provider !== "meta");

  // Na edição sem novo CSV, a base pode ter sido importada antes (VARn
  // ficam no servidor) — aí não dá para conferir columnMap no cliente.
  const csvMappingKnown = Boolean(importFile) || !editingId;

  // Público já vinculado à campanha em edição ("csv" ou campanha antiga).
  const keepsExistingAudience = Boolean(editingId) && editingHasImportedBase;

  // Validação de cada passo do assistente — lista de mensagens em pt-BR,
  // vazia quando o passo está ok. handleSubmit mantém as próprias checagens
  // (rede de segurança); estas só impedem avançar com dados incompletos.
  const validateWizardStep = (step: WizardStep): string[] => {
    const errors: string[] = [];
    if (step === 1) {
      if (!nome.trim()) errors.push("Informe o nome da campanha.");
      if (!channelValidation.ok) errors.push(channelValidation.error);
      if (importLoading) errors.push("Aguarde a leitura do arquivo terminar.");
      if (importFile) {
        if (!columnMap.phone) errors.push("No mapeamento de colunas, escolha a coluna do telefone.");
        else if (!mappingConfirmed) errors.push("Clique em \"Confirmar mapeamento\" para usar a base importada.");
        if (importStats && importStats.valid === 0) errors.push("A base importada não tem nenhum contato válido.");
      } else if (selectedTags.length === 0 && !keepsExistingAudience && !confirmAllContacts) {
        errors.push(
          "Defina o público: importe uma base, escolha uma tabulação ou confirme o envio para todos os contatos da conta."
        );
      }
    }
    if (step === 2) {
      if (mensagens.length === 0) errors.push("Adicione pelo menos uma mensagem.");
      mensagens.forEach((m: CampaignMessage, i: number) => {
        const rotulo = `${templateMode === "sequencia" ? "Mensagem" : "Template"} #${i + 1}`;
        // Meta: a falta do template é acusada por validateCampaignMessages abaixo.
        if (!hasMeta && m.tipo === "texto" && !m.conteudo?.trim()) errors.push(`${rotulo}: escreva o texto.`);
        if (m.tipo === "ia" && !m.prompt?.trim()) errors.push(`${rotulo}: escreva o prompt da IA.`);
        if (MEDIA_MESSAGE_TYPES.includes(m.tipo) && !m.url?.trim()) {
          errors.push(`${rotulo}: informe a URL da mídia (ou use "Upload").`);
        }
        for (const problem of findVariableProblems(m, { columnMap, hasCsv: csvMappingKnown })) {
          errors.push(`${rotulo}: ${problem}`);
        }
      });
      // Regras por provider (campaign-validation.ts, as mesmas do servidor):
      // Meta = só template aprovado, presente no catálogo da WABA da
      // campanha e compatível. Erro de template bloqueia o Avançar/Salvar.
      if (channelValidation.ok && mensagens.length > 0) {
        if (
          channelValidation.provider === "meta" &&
          templateNamesKey &&
          templateCatalogKey !== `${accountId ?? ""}#${templateNamesKey}`
        ) {
          errors.push("Aguarde: conferindo os templates no catálogo do número.");
        } else {
          errors.push(
            ...validateCampaignMessages(mensagens, channelValidation.provider, {
              wabaId: channelValidation.wabaId,
              templateRows: templateCatalogRows,
              rotulo: templateMode === "sequencia" ? "Mensagem" : "Template",
            })
          );
        }
      }
    }
    if (step === 3) {
      const timeRegex = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
      const inicioOk = !janelaInicio || timeRegex.test(janelaInicio);
      const fimOk = !janelaFim || timeRegex.test(janelaFim);
      if (!inicioOk) errors.push("Início da janela inválido — use HH:MM (ex: 08:00).");
      if (!fimOk) errors.push("Fim da janela inválido — use HH:MM (ex: 18:00).");
      // Fim antes do início é janela que passa da meia-noite (ex.: 20:00–02:00),
      // suportada pelo envio (send-window.ts) — não é erro.
      if (dispatchMode === "personalizado" && intervaloMin > intervaloMax) {
        errors.push("O intervalo mínimo não pode ser maior que o máximo.");
      }
      if (agendarPara) {
        // Horário digitado = Brasília (offset -03:00), não o fuso do navegador.
        const iso = brasiliaLocalToIso(agendarPara);
        const quando = iso ? new Date(iso).getTime() : NaN;
        if (Number.isNaN(quando)) errors.push("Data de agendamento inválida.");
        else if (quando <= Date.now()) errors.push("O agendamento precisa ser numa data e hora futuras.");
      }
    }
    return errors;
  };

  // Navegação do assistente: voltar é livre; avançar (pelo botão ou pelo
  // indicador) exige que todos os passos anteriores ao destino sejam
  // válidos — para no primeiro com erro e mostra os erros dele.
  const goToWizardStep = (target: WizardStep): boolean => {
    if (target <= wizardStep) {
      setWizardStep(target);
      setErrorStep(null);
      return true;
    }
    for (let s = 1 as WizardStep; s < target; s = (s + 1) as WizardStep) {
      const errors = validateWizardStep(s);
      if (errors.length > 0) {
        setWizardStep(s);
        setErrorStep(s);
        toast.error(errors[0]);
        return false;
      }
    }
    setWizardStep(target);
    setErrorStep(null);
    setMaxVisitedStep((prev) => (target > prev ? target : prev));
    return true;
  };

  const handleWizardFinish = (e: React.FormEvent) => {
    // Revalida tudo (algo pode ter mudado ao voltar a um passo) antes do
    // handleSubmit de sempre.
    for (let s = 1 as WizardStep; s < 4; s = (s + 1) as WizardStep) {
      const errors = validateWizardStep(s);
      if (errors.length > 0) {
        setWizardStep(s);
        setErrorStep(s);
        toast.error(errors[0]);
        return;
      }
    }
    void handleSubmit(e);
  };

  const currentStepErrors = errorStep === wizardStep ? validateWizardStep(wizardStep) : [];

  // Contatos da prévia do passo Revisão: até 3 linhas reais do CSV; sem
  // CSV, um contato de exemplo. undefined = valor só conhecido no envio.
  const previewContacts: Array<{ key: string; titulo: string; contact: PreviewContact }> =
    importFile && importPreview && importPreview.length > 0
      ? importPreview.slice(0, 3).map((row, idx) => ({
          key: `csv-${idx}`,
          titulo: `${row.name ?? "Contato"} · ${row.phone}`,
          contact: {
            // Sem coluna de nome mapeada, vale o nome do cadastro no CRM.
            name: columnMap.name ? (row.name ?? null) : undefined,
            phone: row.phone,
            company: undefined,
            csvVars: row.variables,
            // Links UTM são gerados no servidor; sem "Gerar UTM" saem vazios.
            utmLink: utmGerado ? undefined : null,
          },
        }))
      : [
          {
            key: "exemplo",
            titulo: `${SAMPLE_PREVIEW_CONTACT.name} (exemplo)`,
            contact: {
              ...SAMPLE_PREVIEW_CONTACT,
              // Criação sem CSV: não existe VARn nem UTM para ninguém.
              csvVars: editingId ? undefined : [],
              utmLink: editingId ? undefined : null,
            },
          },
        ];

  // Bolha de prévia de uma mensagem para um contato (passo Revisão). Com
  // template e canais Meta + WAHA, mostra as duas versões — os caminhos de
  // envio são diferentes e nunca unificados.
  const renderMessagePreview = (msg: CampaignMessage, idx: number, contact: PreviewContact) => {
    const rotulo = `${templateMode === "sequencia" ? "Mensagem" : "Template"} #${idx + 1}`;
    if (msg.tipo === "ia") {
      return (
        <div className="space-y-1">
          <p className="text-[10px] font-bold text-muted-foreground">{rotulo} · IA</p>
          <p className="rounded-lg bg-muted/40 px-3 py-2 text-xs italic text-muted-foreground">
            Texto gerado pela IA no envio, a partir do prompt: “{msg.prompt ?? ""}”
          </p>
        </div>
      );
    }
    if (msg.tipo === "audio" || msg.tipo === "ligacao") {
      return (
        <div className="space-y-1">
          <p className="text-[10px] font-bold text-muted-foreground">
            {rotulo} · {msg.tipo === "ligacao" ? "Ligação" : "Áudio"}
          </p>
          <p className="break-all rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            {msg.url || "(sem arquivo de áudio)"}
          </p>
        </div>
      );
    }

    const effective = synthesizeWahaVariableMap(msg, columnMap);
    const variantes: Array<{ titulo: string | null; isMeta: boolean }> =
      msg.template_name && hasMeta
        ? [
            { titulo: hasWaha ? "Canais oficiais (Meta) — template aprovado" : null, isMeta: true },
            ...(hasWaha ? [{ titulo: "Canais WAHA — texto com variáveis preenchidas", isMeta: false }] : []),
          ]
        : [{ titulo: null, isMeta: false }];

    return (
      <div className="space-y-1">
        <p className="text-[10px] font-bold text-muted-foreground">
          {rotulo}
          {msg.tipo === "imagem" && " · Imagem"}
          {msg.template_name && ` · template ${msg.template_name}`}
        </p>
        {msg.tipo === "imagem" && (
          <p className="break-all text-[10px] text-muted-foreground">🖼 {msg.url || "(sem imagem)"}</p>
        )}
        {variantes.map((v) => {
          const preview = previewCampaignMessage(effective, contact, { isMetaChannel: v.isMeta });
          if (preview.segments.length === 0) return null;
          return (
            <div key={String(v.isMeta)} className="space-y-1">
              {v.titulo && <p className="text-[10px] text-muted-foreground">{v.titulo}</p>}
              <div
                className={cn(
                  "whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-xs text-foreground",
                  preview.willSkip ? "border border-red-500/40 bg-red-500/5" : "bg-emerald-500/10"
                )}
              >
                {preview.segments.map((seg, si) =>
                  seg.kind === "text" ? (
                    <span key={si}>{seg.text}</span>
                  ) : seg.empty ? (
                    <span key={si} className="rounded bg-red-500/15 px-1 font-medium text-red-600 dark:text-red-400">
                      {seg.token} (vazio — este contato não será enviado)
                    </span>
                  ) : seg.pending ? (
                    <span key={si} className="italic text-muted-foreground">[{seg.label}]</span>
                  ) : (
                    <span key={si} className="rounded bg-primary/10 px-0.5">{seg.value}</span>
                  )
                )}
              </div>
              {preview.willSkip && (
                <p className="text-[10px] font-medium text-red-600 dark:text-red-400">
                  Este contato não será enviado:{" "}
                  {preview.emptyVars.map((n) => `{{${n}}}`).join(", ")} sem valor.
                </p>
              )}
            </div>
          );
        })}
        {hasMeta && !msg.template_name && (
          <p className="text-[10px] text-amber-600">
            Nos canais Meta, mensagem sem template aprovado só chega a quem conversou com você nas
            últimas 24h.
          </p>
        )}
      </div>
    );
  };

  const refreshImportResolution = (nextMap: ImportColumnMap) => {
    if (!parsedImportData) return;
    const resolved = resolveImportRows(parsedImportData.headers, parsedImportData.rows, nextMap);
    setImportPreview(resolved.rows.slice(0, 5));
    setImportStats({
      total: parsedImportData.rows.length,
      valid: resolved.rows.length,
      invalid: resolved.invalidRows,
    });
    setImportAllRows(resolved.rows.map((row) => ({
      phone: row.phone,
      cpf: row.cpf,
      variables: [...row.variables],
    })));
  };

  const VAR_COLUMN_KEYS = ["var1", "var2", "var3"] as const;

  // Auto-promoção: quando o passo Público mapeia uma coluna var1/2/3 do CSV mas o
  // {{n}} correspondente no passo Mensagem ainda está como "valor fixo" vazio
  // (default de onSelect do MessageTemplatePicker para {{2}}, {{3}}, ...),
  // promove esse slot pra csv_var em vez de exigir que o usuário repita
  // manualmente no passo Mensagem uma escolha que já fez no passo Público — sem isso o
  // submit bloqueia com "Variável {{n}} do template está vazia" mesmo com
  // o CSV corretamente mapeado (ver investigação). Não toca entries que já
  // têm valor (static preenchido) nem outros tipos (contact_field/
  // utm_link/csv_var já setado).
  const autoPromoteTemplateVars = (map: ImportColumnMap) => {
    setMensagens((prev) =>
      prev.map((msg) => {
        if (!Array.isArray(msg.template_variable_map)) return msg;
        const newMap = msg.template_variable_map.map((entry: any, idx: number) => {
          if (entry?.type !== "static" || entry.value?.trim()) return entry;
          const columnKey = VAR_COLUMN_KEYS[idx];
          if (!columnKey || !map[columnKey]) return entry;
          return { type: "csv_var", index: idx as 0 | 1 | 2 };
        });
        return { ...msg, template_variable_map: newMap };
      })
    );
  };

  const parseImportFile = async (file: File) => {
    setImportLoading(true);
    setImportPreview(null);
    setImportStats(null);
    setImportAllRows(null);
    setUtmGerado(false);
    setUtmProgress(null);
    setCsvHeaders([]);
    setColumnMap({});
    setMappingConfirmed(false);
    setParsedImportData(null);
    try {
      const isXlsx = file.name.endsWith(".xlsx") || file.name.endsWith(".xls");

      let dataLines: string[];
      let sep = ";";

      if (isXlsx) {
        // file.text() retorna binário pra XLSX — usa a lib xlsx (já é
        // dependência do projeto) pra ler a planilha e converter a
        // primeira aba pra CSV com ; como separador.
        const XLSX = await import("xlsx");
        const arrayBuffer = await file.arrayBuffer();
        const workbook = XLSX.read(arrayBuffer, { type: "array" });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const csv = XLSX.utils.sheet_to_csv(sheet, { FS: ";" });
        dataLines = csv.split("\n").filter(Boolean);
      } else {
        const text = await file.text();
        // Detecta separador
        sep = text.startsWith("sep=")
          ? text.split("\n")[0].split("=")[1]?.trim() || ";"
          : text.includes(";") ? ";" : ",";

        const lines = text.split("\n").filter(Boolean);
        // Remove linha sep= se existir
        dataLines = lines[0].toLowerCase().startsWith("sep=")
          ? lines.slice(1)
          : lines;
      }

      if (dataLines.length < 2) {
        toast.error("Arquivo vazio ou sem dados");
        return;
      }

      const firstValues = dataLines[0].split(sep).map(value => value.trim().replace(/["\r]/g, ""));
      const hasHeader = looksLikeImportHeader(firstValues);
      const headers = (hasHeader ? firstValues : firstValues.map((_, index) => `coluna_${index + 1}`))
        .map(normalizeImportHeader);
      const allRows = (hasHeader ? dataLines.slice(1) : dataLines).map(line =>
        line.split(sep).map(value => value.trim().replace(/["\r]/g, ""))
      );
      const detectedMap = suggestImportColumnMap(headers);
      setCsvHeaders(headers);
      setColumnMap(detectedMap);
      setMappingConfirmed(false);
      setParsedImportData({ headers, rows: allRows, hasHeader });

      const resolved = resolveImportRows(headers, allRows, detectedMap);
      const preview = resolved.rows.slice(0, 5);
      const validCount = resolved.rows.length;

      setImportPreview(preview);
      setImportStats({
        total: allRows.length,
        valid: validCount,
        invalid: resolved.invalidRows,
      });
      setImportFile(file);

      // Propagar variáveis estáticas do CSV para o template_variable_map
      // Lê todos os valores de cada coluna VAR e, se for único para
      // todos os contatos, preenche como static.value automaticamente.
      // Se variar por contato, deixa em branco e avisa o usuário.
      const mappedVariableIndexes = [detectedMap.var1, detectedMap.var2, detectedMap.var3]
        .map((header) => header ? headers.indexOf(header) : -1)
        .filter((index) => index >= 0);
      if (mappedVariableIndexes.length > 0) {
        // Coletar todos os valores de cada coluna VAR para todos os contatos
        const varValueSets: Set<string>[] = mappedVariableIndexes.map(() => new Set<string>());

        for (const cols of allRows) {
          if (!resolved.rows.some((row) => row.raw[headers[0]] === cols[0])) continue;
          mappedVariableIndexes.forEach((colIdx, i) => {
            const val = cols[colIdx] || "";
            if (val) varValueSets[i].add(val);
          });
        }

        // Para cada mensagem que tem template_variable_map, preencher
        // os static.value com os valores únicos do CSV
        setMensagens(prev => prev.map(msg => {
          if (!msg.template_name || !msg.template_variable_map) return msg;

          const newMap = msg.template_variable_map.map((entry: any, idx: number) => {
            if (entry.type !== "static") return entry;

            // idx 0 = {{1}}, idx 1 = {{2}}, etc.
            const varIdx = idx; // VAR(idx+1) corresponde a {{idx+1}}
            if (varIdx >= varValueSets.length) return entry;

            const values = varValueSets[varIdx];
            if (values.size === 1) {
              // Valor único → preenche automaticamente
              return { ...entry, value: [...values][0] };
            }
            // Múltiplos valores → mantém vazio (varia por contato)
            return entry;
          });

          return { ...msg, template_variable_map: newMap };
        }));

        // Variável varia por contato → não dá pra preencher um static.value
        // único acima; promove pra csv_var (resolvido por contato em
        // startCampaign.ts) em vez de deixar {{n}} vazio.
        const hasVariableVars = varValueSets.some(set => set.size > 1);
        if (hasVariableVars) {
          autoPromoteTemplateVars(detectedMap);
          toast.warning(
            "Variáveis com valores diferentes por contato foram mapeadas " +
            "automaticamente para as colunas do CSV."
          );
        }
      }

      // Armazena TODOS os contatos (não só os 5 do preview) — usado pelo
      // lote de geração de UTM em handleGerarUTM, que precisa do CSV
      // inteiro, não apenas da amostra exibida em tela.
      const allContacts = resolved.rows.map((row) => ({
        phone: row.phone,
        cpf: row.cpf,
        variables: [...row.variables],
      }));
      setImportAllRows(allContacts);
    } catch (err) {
      toast.error("Erro ao ler arquivo");
    } finally {
      setImportLoading(false);
    }
  };

  // Mapa waba_id → display_phone_number para o picker de templates
  const channelMap = useMemo(() => {
    const map: Record<string, string> = {};
    sessions.forEach(s => {
      if (s.waba_id && s.display_phone_number) {
        map[s.waba_id] = s.display_phone_number;
      }
    });
    return map;
  }, [sessions]);

  // Canais filtrados pela equipe selecionada no passo Público (teamFilter="" =
  // Todas as equipes, mostra tudo). Puramente client-side sobre a lista
  // já carregada em loadData() — nenhuma query nova por troca de filtro.
  // Canal desabilitado só aparece se já estiver selecionado (para poder
  // ser desmarcado) — nunca é oferecido para uma campanha nova.
  const filteredSessions = useMemo(
    () =>
      sessions.filter(
        (s) =>
          (s.habilitado !== false || selectedSessions.includes(s.id)) &&
          (!teamFilter || s.team_id === teamFilter)
      ),
    [sessions, teamFilter, selectedSessions]
  );

  // Melhor estimativa de total de contatos disponível agora, para a
  // prévia do modo "Segmentado" — import desta sessão (passo Público) tem
  // prioridade; editando uma campanha que já tem métricas reais, usa
  // total_contatos dela; sem nenhum dos dois, null (a prévia cai no
  // exemplo ilustrativo — ver segmentadoExampleBase abaixo).
  const totalContatosConhecidos =
    importAllRows?.length ??
    (editingId ? metricsMap[editingId]?.total_contatos : undefined) ??
    null;

  // Resolve batchPercent/batchPauseMinutes (Segmentado) para
  // batchSize/batchPauseSeconds — os campos que de fato vão no payload
  // de criação/edição. batchSize só é atualizado quando o total real é
  // conhecido (senão ficaria salvando uma contagem baseada no exemplo
  // ilustrativo); a resolução definitiva acontece em startCampaign.ts no
  // momento real do início, contra o total de contatos nesse momento.
  useEffect(() => {
    if (dispatchMode !== "segmentado") return;
    setBatchPauseSeconds(Math.max(0, batchPauseMinutes) * 60);
    if (totalContatosConhecidos && totalContatosConhecidos > 0) {
      setBatchSize(Math.max(1, Math.ceil(totalContatosConhecidos * (batchPercent / 100))));
    }
  }, [dispatchMode, batchPercent, batchPauseMinutes, totalContatosConhecidos]);

  // Texto de exemplo dinâmico do modo "Segmentado" — usa o total real
  // quando conhecido (totalContatosConhecidos), senão um exemplo
  // ilustrativo de 2.000 contatos, deixando claro qual dos dois é.
  const segmentadoExampleBase =
    totalContatosConhecidos && totalContatosConhecidos > 0 ? totalContatosConhecidos : 2000;
  const segmentadoPorRodada = Math.max(1, Math.ceil(segmentadoExampleBase * (batchPercent / 100)));
  const segmentadoRodadas = Math.max(1, Math.ceil(segmentadoExampleBase / segmentadoPorRodada));
  const segmentadoTempoLabel = formatResponseTime(segmentadoRodadas * batchPauseMinutes * 60);

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

  // Gera links de rastreamento (UTM) via proxy server-side (/api/disparador/utm)
  // para TODOS os contatos do CSV (importAllRows). O mapeamento cpf→link é
  // re-chaveado por telefone normalizado e persistido em
  // wacrm.disparador_utm_links (ver migration 076), chave por draftId
  // enquanto a campanha ainda não existe (nova campanha) ou por
  // campaign_id direto (editando um rascunho existente). start/route.ts lê
  // essa tabela para resolver entradas `{ type: "utm_link" }` do
  // template_variable_map por contato. O preview (5 primeiras linhas) é só
  // feedback visual — quem realmente alimenta o envio é a tabela.
  const handleGerarUTM = async () => {
    const source = importAllRows ?? importPreview ?? [];
    if (source.length === 0) return;
    if (!nome.trim()) {
      toast.error("Preencha o nome da campanha no passo Público antes de gerar UTM");
      return;
    }

    // Detectar URL destino — pega VAR3 (índice 2) do primeiro contato
    // Se variar por contato, cada um usa o seu próprio VAR3
    const hasCpf = source.some(p => p.cpf);
    if (!hasCpf) {
      toast.error("CSV não tem coluna CPF/cpf/documento — necessário para gerar UTM");
      return;
    }

    setUtmLoading(true);
    try {
      // Monta payload de lote — agrupa por url_destino
      // já que a API aceita uma url_destino por chamada
      // Se todos têm a mesma VAR3, uma chamada basta
      // Se variam, faz uma chamada por URL única
      const urlGroups = new Map<string, typeof source>();
      for (const contact of source) {
        const url = contact.variables[2] || "";
        if (!url) continue;
        if (!urlGroups.has(url)) urlGroups.set(url, []);
        urlGroups.get(url)!.push(contact);
      }

      // Mapa de cpf → link_curto
      const linkMap = new Map<string, string>();

      const totalAlunos = [...urlGroups.values()]
        .flat()
        .filter(c => c.cpf).length;

      setUtmProgress({ total: totalAlunos, gerados: 0, erros: 0 });

      for (const [urlDestino, contacts] of urlGroups) {
        const alunos = contacts
          .filter(c => c.cpf)
          .map(c => c.cpf!);

        if (alunos.length === 0) continue;

        const res = await fetch("/api/disparador/utm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            canal: "whatsapp",
            campanha: nome.trim(),
            url_destino: urlDestino.startsWith("http")
              ? urlDestino
              : `https://${urlDestino}`,
            alunos,
          }),
        });

        if (!res.ok) {
          const detail = await res.text();
          console.warn("[UTM] Falha na requisição:", detail);
          // Antes ficava só no console: chave UTM_API_KEY ausente ou
          // utmpay fora do ar pareciam "UTM não funciona".
          toast.error(
            res.status === 401 || res.status === 403
              ? "Serviço de UTM recusou a chave (confira UTM_API_KEY no servidor)"
              : `Falha ao gerar links UTM (HTTP ${res.status})`
          );
          // Lote inteiro falhou — conta todos como erro, senão a barra
          // de progresso trava sem nunca chegar em "total".
          setUtmProgress(prev => prev ? { ...prev, erros: prev.erros + alunos.length } : null);
          continue;
        }

        const data = await res.json();
        const links: Array<{ aluno_id: string; link_curto: string }> =
          data.links ?? [];

        for (const link of links) {
          linkMap.set(link.aluno_id, link.link_curto);
        }

        // Conta quantos vieram com link_curto válido
        const geradosNesteLote = links.filter(l => l.link_curto).length;
        const errosNesteLote = alunos.length - geradosNesteLote;

        setUtmProgress(prev => prev ? {
          ...prev,
          gerados: prev.gerados + geradosNesteLote,
          erros: prev.erros + errosNesteLote,
        } : null);
      }

      if (linkMap.size === 0) {
        toast.error("Nenhum link UTM foi gerado. Verifique os CPFs e a URL destino.");
        return;
      }

      // Atualizar importPreview com os link_curto no lugar de VAR3 (feedback
      // visual das 5 primeiras linhas — não é o que alimenta o envio).
      setImportPreview(prev =>
        (prev ?? []).map(contact => {
          if (!contact.cpf) return contact;
          const linkCurto = linkMap.get(contact.cpf);
          if (!linkCurto) return contact; // mantém VAR3 original se falhar
          const newVariables = [...contact.variables];
          newVariables[2] = linkCurto; // substitui VAR3
          return { ...contact, variables: newVariables };
        })
      );

      // Persiste cpf→link_curto em disparador_utm_links, o que de fato
      // alimenta o envio (startCampaign). Chave principal: CPF (migration
      // 129); telefone com a MESMA regra do import (DDI 55) — antes ia o
      // telefone cru do CSV e o envio não achava o link (ver utm-links.ts).
      // draftId enquanto a campanha ainda não existe; editingId quando
      // estamos editando um rascunho já criado.
      const phoneLinkRows = source
        .filter((c) => c.cpf && linkMap.has(c.cpf))
        .map((c) => ({
          campaign_id: editingId ?? null,
          draft_id: editingId ? null : draftId,
          phone_normalized: utmPhoneKey(c.phone),
          cpf: utmCpfKey(c.cpf),
          link_curto: linkMap.get(c.cpf!)!,
        }))
        .filter((r) => r.phone_normalized || r.cpf);

      let saved = 0;
      try {
        const supabase = createClient();
        const idColumn = editingId ? "campaign_id" : "draft_id";
        const idValue = editingId ?? draftId;

        // Substitui qualquer geração anterior desta mesma sessão/campanha
        // (re-gerar UTM depois de reimportar o CSV não deve acumular lixo).
        await supabase.from("disparador_utm_links").delete().eq(idColumn, idValue);

        if (phoneLinkRows.length > 0) {
          const { error: saveErr } = await supabase
            .from("disparador_utm_links")
            .insert(phoneLinkRows);
          if (saveErr) throw saveErr;
          saved = phoneLinkRows.length;
        }
      } catch (saveErr: any) {
        // Tabela pode não existir ainda (migration 076 não aplicada) — não
        // derruba a geração em si, mas os links não chegarão ao envio.
        console.error("[UTM] Falha ao salvar disparador_utm_links:", saveErr);
        toast.warning(
          "Links UTM gerados, mas não foi possível salvá-los para o envio. " +
          "Confirme se a migration 076 foi aplicada."
        );
      }

      setUtmGerado(true);
      toast.success(
        saved > 0
          ? `${linkMap.size} links UTM gerados — ${saved} contatos receberão o link personalizado no envio.`
          : `${linkMap.size} links UTM gerados com sucesso!`
      );
    } catch (err: any) {
      toast.error("Erro ao gerar links UTM: " + err.message);
    } finally {
      setUtmLoading(false);
    }
  };

  const selectedTemplates = mensagens
    .filter((message) => message.template_name)
    .map((message) => ({
      name: message.template_name as string,
      language: message.template_language as string | undefined,
      variableCount: Array.isArray(message.template_variable_map)
        ? message.template_variable_map.length
        : 0,
    }));

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
  // origem ao fechar. O assistente NÃO fecha com Esc (perderia o passo a
  // passo/importação em andamento); métricas e drilldown fecham.
  const wizardA11y = useDialogA11y(showModal);
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
                  <span className={`shrink-0 text-[10px] font-medium px-2 py-0.5 rounded-full capitalize ${STATUS_COLORS[c.status] || STATUS_COLORS.rascunho}`}>
                    {STATUS_LABELS[c.status] || c.status}
                  </span>
                </header>

                <p className="text-xs text-muted-foreground line-clamp-2 min-h-[32px]">{c.descricao || "Sem descrição fornecida."}</p>

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
                <div className="grid grid-cols-2 gap-2 pt-2 text-[11px] text-muted-foreground border-t border-border/40">
                  <div className="flex items-center gap-1.5 truncate">
                    <Clock className="h-3.5 w-3.5" /> Delay: {c.intervalo_min}s - {c.intervalo_max}s
                  </div>
                  <div className="flex items-center gap-1.5 truncate">
                    <Tag className="h-3.5 w-3.5" /> Tabulação:{" "}
                    {c.tags_filtro.length === 0
                      ? "Todos"
                      : c.tags_filtro.length === 1
                        ? c.tags_filtro[0]
                        : `${c.tags_filtro[0]} +${c.tags_filtro.length - 1}`}
                  </div>
                  <div className="flex items-center gap-1.5 truncate">
                    <Smartphone className="h-3.5 w-3.5" /> Canais: {c.session_ids.length} ativos
                  </div>
                  <div className="flex items-center gap-1.5 truncate">
                    <Calendar className="h-3.5 w-3.5" /> Janela: {c.janela_inicio} - {c.janela_fim}
                  </div>
                  {(c.batch_size ?? 1) > 1 && (
                    <div className="flex items-center gap-1.5 truncate">
                      <Layers className="h-3.5 w-3.5" /> Lote: {c.batch_size}x / pausa {c.batch_pause_seconds ?? 0}s
                    </div>
                  )}
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
                <div className="text-[11px] text-muted-foreground">
                  ⏱{" "}
                  {c.status === "encerrada" && campaignDurationLabel(c) !== "—" ? (
                    <>{campaignDurationLabel(c)} total</>
                  ) : c.status === "em_execucao" && campaignDurationLabel(c) !== "—" ? (
                    <>{campaignDurationLabel(c)} em execução</>
                  ) : c.status === "pausada" && campaignDurationLabel(c) !== "—" ? (
                    <>{campaignDurationLabel(c)} até a pausa</>
                  ) : metricsMap[c.id]?.total_contatos ? (
                    <>
                      {estimarDisparo(
                        metricsMap[c.id].total_contatos,
                        parseTemplateMode(c.dias_permitidos) === "sequencia"
                          ? (Array.isArray(c.mensagens) ? c.mensagens.length : 1)
                          : 1,
                        c.intervalo_min ?? 90,
                        c.intervalo_max ?? 300,
                        c.janela_inicio || null,
                        c.janela_fim || null,
                        undefined,
                        c.batch_size,
                        c.batch_pause_seconds,
                        c.limite_por_hora ?? 0
                      ).label} estimado
                    </>
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
                    ) : (
                      <Button size="sm" onClick={() => handleStartClick(c.id)} disabled={c.status === "encerrada" || c.status === "preparando"} className="h-9 gap-1 text-xs">
                        <Play className="h-3.5 w-3.5" aria-hidden="true" /> Iniciar
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
                    {c.status === "rascunho" && (
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

      {/* Creation Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div
            ref={wizardA11y.ref}
            tabIndex={-1}
            onKeyDown={wizardA11y.onKeyDown}
            role="dialog"
            aria-modal="true"
            aria-labelledby="campaign-wizard-title"
            className="bg-card border border-border w-full max-w-2xl rounded-xl shadow-2xl flex flex-col max-h-[calc(100dvh-2rem)] sm:max-h-[85vh] overflow-hidden outline-none"
          >
            <header className="px-4 py-3 sm:px-6 sm:py-4 border-b border-border bg-muted/20">
              <div className="flex justify-between items-center gap-2 mb-3">
                <h3 id="campaign-wizard-title" className="font-bold text-foreground">
                  {editingId ? "Editar Campanha" : "Nova Campanha de Disparo"}
                </h3>
                <Button size="icon" variant="ghost" onClick={closeModal} aria-label="Fechar" className="h-9 w-9 shrink-0 text-muted-foreground">
                  <X className="h-5 w-5" aria-hidden="true" />
                </Button>
              </div>
              {/* Indicadores de passo — voltar é livre; avançar passa pela
                  mesma validação do botão "Avançar" (goToWizardStep). */}
              <nav aria-label="Passos do assistente" className="flex flex-wrap gap-2">
                {WIZARD_STEPS.map(({ step, label }) => (
                  <button
                    key={step}
                    type="button"
                    onClick={() => goToWizardStep(step)}
                    aria-current={wizardStep === step ? "step" : undefined}
                    className={cn(
                      "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors",
                      wizardStep === step
                        ? "bg-primary text-primary-foreground"
                        : step <= maxVisitedStep
                          ? "bg-muted text-foreground hover:bg-muted/70"
                          : "bg-muted text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <span className={cn(
                      "flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-bold",
                      wizardStep === step ? "bg-primary-foreground/20" : "bg-muted-foreground/20"
                    )}>
                      {step < wizardStep ? <CheckCircle2 className="h-3 w-3" /> : step}
                    </span>
                    Passo {step} · {label}
                  </button>
                ))}
              </nav>
            </header>

            {pendingDraft && !editingId && (
              <div className="mx-4 sm:mx-6 mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-700 dark:text-amber-400">
                <span>Rascunho anterior encontrado.</span>
                <div className="flex gap-2 shrink-0">
                  <Button type="button" size="sm" variant="outline" className="h-9 text-xs" onClick={discardDraft}>
                    Descartar
                  </Button>
                  <Button type="button" size="sm" className="h-9 text-xs" onClick={restoreDraft}>
                    Restaurar
                  </Button>
                </div>
              </div>
            )}

            {/* Erros do passo atual após um "Avançar" barrado — recalculados
                a cada render, então somem conforme o usuário corrige. */}
            {currentStepErrors.length > 0 && (
              <div
                role="alert"
                className="mx-4 sm:mx-6 mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-xs text-red-600 dark:text-red-400"
              >
                <p className="mb-1 flex items-center gap-1.5 font-medium">
                  <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" /> Corrija antes de avançar:
                </p>
                <ul className="list-disc space-y-0.5 pl-5">
                  {currentStepErrors.map((err, i) => (
                    <li key={i}>{err}</li>
                  ))}
                </ul>
              </div>
            )}

            {wizardStep === 1 && (
            <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4">
              <div className="space-y-1">
                <label htmlFor="campaign-nome" className="text-xs font-medium text-muted-foreground">Nome da Campanha</label>
                <input
                  id="campaign-nome"
                  type="text"
                  value={nome}
                  onChange={(e) => setNome(e.target.value)}
                  placeholder="Ex: Reativação Clientes Inativos"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
                />
              </div>

              <div className="space-y-1">
                <label htmlFor="campaign-descricao" className="text-xs font-medium text-muted-foreground">Descrição</label>
                <textarea
                  id="campaign-descricao"
                  value={descricao}
                  onChange={(e) => setDescricao(e.target.value)}
                  placeholder="Descreva brevemente a meta da campanha..."
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 resize-none h-16"
                />
              </div>

              {/* Equipe — filtra a lista de canais abaixo (client-side,
                  sobre `sessions` já carregado); não é enviado ao servidor,
                  só decide quais checkboxes aparecem. */}
              <div className="space-y-1">
                <label id="campaign-equipe-label" className="text-xs font-medium text-muted-foreground">Equipe</label>
                <Select value={teamFilter || "__all__"} onValueChange={(v) => setTeamFilter(v === "__all__" ? "" : v || "")}>
                  <SelectTrigger className="w-full" aria-labelledby="campaign-equipe-label">
                    <SelectValue>
                      {(v: string) => (v === "__all__" ? "Todas as equipes" : (teams.find((t) => t.id === v)?.name ?? v))}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">Todas as equipes</SelectItem>
                    {teams.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Channels Selector */}
              <div className="space-y-1">
                <p id="campaign-canais-label" className="text-xs font-medium text-muted-foreground">Canais de WhatsApp</p>
                <div role="group" aria-labelledby="campaign-canais-label" className="flex flex-wrap gap-2 max-h-24 overflow-y-auto border border-border p-2 rounded-md">
                  {filteredSessions.length === 0 ? (
                    <span className="text-xs text-muted-foreground">
                      {sessions.length === 0
                        ? "Nenhum canal de WhatsApp conectado encontrado."
                        : "Nenhum canal para a equipe selecionada."}
                    </span>
                  ) : (
                    filteredSessions.map((s) => (
                      <label key={s.id} className="flex items-center gap-1.5 bg-muted/50 border border-border rounded px-2.5 py-1 text-xs cursor-pointer hover:bg-muted text-foreground">
                        <input
                          type="checkbox"
                          checked={selectedSessions.includes(s.id)}
                          onChange={(e) => {
                            changeChannelSelection(
                              e.target.checked
                                ? [...selectedSessions, s.id]
                                : selectedSessions.filter((id) => id !== s.id)
                            );
                          }}
                        />
                        {s.name}
                      </label>
                    ))
                  )}
                </div>
                <p className="flex items-start gap-1 text-[10px] text-muted-foreground">
                  <Info className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
                  Uma campanha usa só números oficiais (Meta) de uma mesma conta WhatsApp Business, ou
                  só sessões WAHA.
                </p>
              </div>

              {/* Seleção inválida (Meta + WAHA, WABAs diferentes, número
                  sem WABA, canal desabilitado): bloqueia o Avançar. */}
              {selectedSessions.length > 0 && !channelValidation.ok && (
                <p
                  role="alert"
                  className="flex items-start gap-1.5 rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-[11px] font-medium text-red-600 dark:text-red-400"
                >
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>{channelValidation.error}</span>
                </p>
              )}

              {/* Filtrar por tabulação */}
              <div className="space-y-1">
                <p id="campaign-tags-label" className="text-xs font-medium text-muted-foreground">Filtrar por tabulação</p>
                <p className="text-[10px] text-muted-foreground">
                  Sem base importada, envia para os contatos da conta com esta tabulação. Com base
                  importada, envia só para os contatos da base que têm a tabulação.
                </p>
                <div className="relative mb-2">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2
                    h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                  <input
                    type="search"
                    aria-label="Buscar tabulação"
                    placeholder="Buscar tabulação..."
                    value={tagSearch}
                    onChange={(e) => setTagSearch(e.target.value)}
                    className="w-full pl-8 pr-3 py-1.5 text-xs rounded-md border
                      border-border bg-background text-foreground placeholder:text-muted-foreground
                      focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
                <div role="group" aria-labelledby="campaign-tags-label" className="flex flex-wrap gap-2 max-h-24 overflow-y-auto border border-border p-2 rounded-md">
                  {tags.length === 0 ? (
                    <span className="text-xs text-muted-foreground">Nenhuma tabulação cadastrada.</span>
                  ) : (
                    tags
                      .filter((t) =>
                        t.name.toLowerCase().includes(tagSearch.toLowerCase())
                      )
                      .map((t) => (
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
                      ))
                  )}
                </div>
              </div>

              <div>
                <h4 className="font-medium text-foreground mb-1">
                  Importar Base de Contatos
                </h4>
                <p className="text-xs text-muted-foreground">
                  Opcional — sem base, o público vem das tabulações acima (ou de todos os
                  contatos da conta, se nenhuma for escolhida).
                </p>
              </div>

              {keepsExistingAudience && !importFile && (
                <div className="flex gap-2 rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    Esta campanha mantém a base já importada. Importe um arquivo só se quiser
                    substituí-la.
                  </span>
                </div>
              )}

              {mensagens.some((msg) =>
                msg.template_variable_map?.some(
                  (e: any) => e.type === "static" && !e.value
                )
              ) &&
                !importFile && (
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
                    ⚠ Rascunho restaurado com variáveis de template incompletas.
                    Reimporte o CSV para preencher automaticamente os valores de{" "}
                    {"{{2}}"}, {"{{3}}"}, etc.
                  </div>
                )}

              {/* Upload area */}
              <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-border rounded-lg cursor-pointer hover:border-primary/50 hover:bg-muted/30 transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/50">
                <div className="flex flex-col items-center gap-1 px-2 text-center">
                  <Upload className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
                  <span className="text-sm text-muted-foreground">
                    {importFile ? importFile.name : "Clique ou arraste CSV / XLSX"}
                  </span>
                  {!importFile && (
                    <span className="text-xs text-muted-foreground/70">
                      Formatos aceitos: .csv, .xlsx, .xls, .txt
                    </span>
                  )}
                </div>
                {/* sr-only (não "hidden"): o input continua alcançável por Tab;
                    o foco aparece na borda do label (focus-within). */}
                <input
                  type="file"
                  accept=".csv,.xlsx,.xls,.txt"
                  className="sr-only"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) parseImportFile(file);
                  }}
                />
              </label>

              {/* Baixar modelo — mesmo arquivo estático usado em
                  /disparador/contatos (não gerado client-side). */}
              <a
                href="/modelo_importacao_disparador.csv"
                download
                className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1.5 text-xs h-9")}
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" /> Baixar modelo de exemplo
              </a>

              {/* Formato esperado */}
              <div className="rounded-md bg-muted/40 p-3 text-xs space-y-1">
                <p className="font-medium text-foreground">Formatos aceitos:</p>
                {hasMeta ? (
                  <>
                    <p className="text-muted-foreground">
                      Meta (variáveis): <code className="bg-muted px-1 rounded">
                        CONTATO;VAR1;VAR2;VAR3
                      </code>
                    </p>
                    <p className="text-muted-foreground">
                      Padrão CRM: <code className="bg-muted px-1 rounded">
                        telefone;nome;empresa;tags
                      </code>
                    </p>
                  </>
                ) : (
                  <p className="text-muted-foreground">
                    Padrão CRM: <code className="bg-muted px-1 rounded">
                      telefone;nome;empresa;tags
                    </code>
                  </p>
                )}
              </div>

              {importLoading && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Lendo arquivo...
                </div>
              )}

              {/* Stats */}
              {importStats && (
                <div className="flex gap-3">
                  <div className="flex-1 rounded-md bg-muted/40 p-3 text-center">
                    <p className="text-lg font-bold text-foreground">{importStats.total}</p>
                    <p className="text-xs text-muted-foreground">Total</p>
                  </div>
                  <div className="flex-1 rounded-md bg-green-500/10 p-3 text-center">
                    <p className="text-lg font-bold text-green-600">{importStats.valid}</p>
                    <p className="text-xs text-muted-foreground">Válidos</p>
                  </div>
                  {importStats.invalid > 0 && (
                    <div className="flex-1 rounded-md bg-red-500/10 p-3 text-center">
                      <p className="text-lg font-bold text-red-600">{importStats.invalid}</p>
                      <p className="text-xs text-muted-foreground">Inválidos</p>
                    </div>
                  )}
                </div>
              )}
              {importStats && importStats.invalid > 0 && (
                <p className="text-xs text-amber-700 dark:text-amber-500">
                  {importStats.invalid} linha{importStats.invalid > 1 ? "s" : ""} sem contato resolvido foi{importStats.invalid > 1 ? "ram" : ""} excluída{importStats.invalid > 1 ? "s" : ""} da prévia e da importação.
                </p>
              )}

              {/* Mapeamento de colunas (Correção 3) — sub-step depois da
                  prévia, corrige a heurística automática antes do import
                  de verdade em handleSubmit. */}
              {csvHeaders.length > 0 && (
                <div className="rounded-md border border-border bg-muted/20 p-3 space-y-2">
                  <div>
                    <p className="text-xs font-medium text-foreground">
                      Mapeamento de colunas
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      Escolha qual coluna da sua planilha alimenta cada campo do CRM e cada variável do template aprovado no WhatsApp.
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      As variáveis {"{{1}}"}, {"{{2}}"} e {"{{3}}"} seguem exatamente a ordem do template aprovado.
                    </p>
                  </div>
                  <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-3 gap-y-2">
                    <div className="text-[10px] font-medium text-muted-foreground">Campo do CRM / Template</div>
                    <div className="text-[10px] font-medium text-muted-foreground">Coluna da planilha</div>
                    {COLUMN_MAP_FIELDS.map((field) => (
                      <div key={field.key} className="col-span-2 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-3">
                        <label className="block text-xs text-foreground">
                          {field.label}
                        </label>
                        <Select
                          value={columnMap[field.key] === "__none__" ? undefined : columnMap[field.key] || undefined}
                          onValueChange={(val) => {
                            const nextMap = (() => {
                              const next = { ...columnMap };
                              if (!val || val === "__none__") delete next[field.key as keyof ImportColumnMap];
                              else next[field.key as keyof ImportColumnMap] = val;
                              return next;
                            })();
                            setColumnMap(nextMap);
                            setMappingConfirmed(false);
                            refreshImportResolution(nextMap);
                          }}
                        >
                          <SelectTrigger className="h-8 w-full border-border bg-background text-xs" aria-label={`Coluna da planilha para ${field.label}`}>
                            <SelectValue placeholder="Nenhum">
                              {formatColumnLabel(columnMap[field.key])}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent className="border-border bg-popover">
                            <SelectItem value="__none__">{formatColumnLabel("__none__")}</SelectItem>
                            {csvHeaders.map((h) => (
                              <SelectItem key={h} value={h}>
                                {formatColumnLabel(h)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    ))}
                  </div>
                  <div className="rounded-md border border-border/60 bg-background/50 p-2 text-[10px] text-muted-foreground">
                    <p className="mb-1 font-medium text-foreground">Mapeamento aplicado</p>
                    <p>{"{{1}}"} ← {formatColumnLabel(columnMap.var1)}</p>
                    <p>{"{{2}}"} ← {formatColumnLabel(columnMap.var2)}</p>
                    <p>CPF ← {formatColumnLabel(columnMap.cpf)}</p>
                    <p>{"{{3}}"} ← {formatColumnLabel(columnMap.var3)}</p>
                  </div>
                  <div className="flex items-center justify-between gap-3 border-t border-border pt-2">
                    <p className="text-[10px] text-muted-foreground">
                      O contato é obrigatório. A prévia acima usa exatamente este mapa.
                    </p>
                    <Button
                      type="button"
                      size="sm"
                      variant={mappingConfirmed ? "outline" : "default"}
                      disabled={!columnMap.phone}
                      onClick={() => {
                        setMappingConfirmed(true);
                        autoPromoteTemplateVars(columnMap);
                      }}
                    >
                      {mappingConfirmed ? "Mapeamento confirmado" : "Confirmar mapeamento"}
                    </Button>
                  </div>
                </div>
              )}

              {/* Gerar UTM */}
              {importPreview && importPreview.some(p => p.cpf) &&
               importPreview.some(p => p.variables[2]) && (
                <div className="rounded-md border border-border bg-muted/20 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs font-medium text-foreground">
                        Links de rastreamento (UTM)
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        Gera um link curto rastreável para cada aluno via VAR3
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant={utmGerado ? "outline" : "default"}
                      onClick={handleGerarUTM}
                      disabled={utmLoading}
                      className="shrink-0 gap-1.5"
                    >
                      {utmLoading ? (
                        <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Gerando...</>
                      ) : utmGerado ? (
                        <><CheckCircle2 className="h-3.5 w-3.5 text-green-500" /> Gerado</>
                      ) : (
                        "🔗 Gerar UTM"
                      )}
                    </Button>
                  </div>

                  {/* Barra de progresso durante geração */}
                  {utmLoading && utmProgress && (
                    <div className="space-y-1.5">
                      <div className="flex justify-between text-[10px] text-muted-foreground">
                        <span>Gerando links...</span>
                        <span>{utmProgress.gerados + utmProgress.erros} / {utmProgress.total}</span>
                      </div>
                      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                        <div
                          className="h-full bg-primary rounded-full transition-all duration-300"
                          style={{
                            width: `${utmProgress.total > 0
                              ? ((utmProgress.gerados + utmProgress.erros) / utmProgress.total) * 100
                              : 0}%`
                          }}
                        />
                      </div>
                    </div>
                  )}

                  {/* Resultado após geração */}
                  {!utmLoading && utmGerado && utmProgress && (
                    <div className={cn(
                      "rounded-md px-3 py-2 text-xs",
                      utmProgress.erros > 0
                        ? "bg-amber-500/10 border border-amber-500/20"
                        : "bg-green-500/10 border border-green-500/20"
                    )}>
                      <p className={utmProgress.erros > 0 ? "text-amber-600" : "text-green-600"}>
                        {utmProgress.gerados > 0 && (
                          <><CheckCircle2 className="h-3.5 w-3.5 inline mr-1" />
                          {utmProgress.gerados} link{utmProgress.gerados !== 1 ? "s" : ""} UTM gerado{utmProgress.gerados !== 1 ? "s" : ""}</>
                        )}
                        {utmProgress.erros > 0 && (
                          <span className="text-amber-600 ml-2">
                            · {utmProgress.erros} erro{utmProgress.erros !== 1 ? "s" : ""}
                          </span>
                        )}
                      </p>
                      {utmProgress.erros > 0 && (
                        <p className="text-[10px] text-muted-foreground mt-0.5">
                          Os erros não impactam o disparo — esses alunos receberão a URL original.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Preview table */}
              {importPreview && importPreview.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    Preview com mapeamento aplicado (primeiros 5 contatos):
                  </p>
                  {/* Rolagem horizontal só dentro da tabela (celular). */}
                  <div className="rounded-md border border-border overflow-x-auto">
                    <table className="w-full min-w-max text-xs">
                      <thead className="bg-muted/40">
                        <tr>
                          <th className="px-3 py-2 text-left font-medium">Telefone</th>
                          {importPreview[0]?.name !== undefined && (
                            <th className="px-3 py-2 text-left font-medium">Nome</th>
                          )}
                          {importPreview[0]?.cpf !== undefined && (
                            <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                              CPF
                            </th>
                          )}
                          {importPreview[0]?.variables.map((_, i) => (
                            <th key={i} className="px-3 py-2 text-left font-medium">
                              {"{{"}{i + 1}{"}}"}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {importPreview.map((row, i) => {
                          const altCount = countAltPhones(row.raw);
                          const colCount =
                            1 +
                            (row.name !== undefined ? 1 : 0) +
                            (row.cpf !== undefined ? 1 : 0) +
                            row.variables.length;
                          return (
                            <Fragment key={i}>
                              <tr className="border-t border-border/50">
                                <td className="px-3 py-2 font-mono">{row.phone}</td>
                                {row.name !== undefined && (
                                  <td className="px-3 py-2">{row.name}</td>
                                )}
                                {row.cpf !== undefined && (
                                  <td className="px-3 py-2 font-mono text-muted-foreground text-[10px]">
                                    {row.cpf}
                                  </td>
                                )}
                                {row.variables.map((v, j) => (
                                  <td key={j} className="px-3 py-2">{v}</td>
                                ))}
                              </tr>
                              {altCount > 0 && (
                                <tr className="bg-muted/10">
                                  <td colSpan={colCount} className="px-3 py-1 text-[10px] text-muted-foreground">
                                    📱 +{altCount} número{altCount > 1 ? "s" : ""} alternativo{altCount > 1 ? "s" : ""}
                                  </td>
                                </tr>
                              )}
                            </Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Sem CSV e sem tabulação o público é a conta inteira — exige
                  aceite explícito (antes era só um aviso no resumo). */}
              {!importFile && selectedTags.length === 0 && !keepsExistingAudience && (
                <label className="flex cursor-pointer items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={confirmAllContacts}
                    onChange={(e) => setConfirmAllContacts(e.target.checked)}
                  />
                  <span>
                    Nenhuma base importada e nenhuma tabulação escolhida.{" "}
                    <strong>Confirmo que quero enviar para todos os contatos da conta.</strong>
                  </span>
                </label>
              )}
            </div>
            )}

            {wizardStep === 2 && (
            <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4">
              {/* Messages bubbles configuration */}
              <div className="space-y-2">
                <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                  <Layers className="h-3.5 w-3.5" />{" "}
                  {templateMode === "rotacao"
                    ? "Templates de Rotação"
                    : templateMode === "aleatorio"
                      ? "Templates Aleatórios"
                      : "Mensagens Sequenciais"}
                </h4>
                <p className="text-[11px] text-muted-foreground">
                  Clique em uma variável abaixo do campo de texto para inseri-la na posição do
                  cursor — elas são substituídas pelos dados do contato no momento do envio.
                  Sequência, rotação ou sorteio entre as mensagens é escolhido no passo Agenda.
                </p>
                {/* Colunas do CSV mapeadas no passo Público — já conhecidas
                    aqui, para o usuário saber o que {{1}}..{{3}} vão receber. */}
                {importFile && (columnMap.var1 || columnMap.var2 || columnMap.var3) && (
                  <div className="rounded-md border border-border/60 bg-muted/30 p-2 text-[11px] text-muted-foreground">
                    Colunas da base disponíveis:{" "}
                    {(["var1", "var2", "var3"] as const)
                      .filter((k) => columnMap[k])
                      .map((k) => `{{${k.slice(3)}}} = "${columnMap[k]}"`)
                      .join(" · ")}
                  </div>
                )}

                {mensagens.map((msg, i) => (
                  <div key={i} className="rounded-lg border border-border p-4 bg-muted/20 relative space-y-3">
                    <div className="flex justify-between items-center">
                      <span className="text-[10px] font-bold text-muted-foreground">
                        {templateMode !== "sequencia" ? `Template #${i + 1}` : `Mensagem #${i + 1}`}
                      </span>
                      {mensagens.length > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => setMensagens(mensagens.filter((_, idx) => idx !== i))}
                          aria-label={`Remover ${templateMode !== "sequencia" ? "template" : "mensagem"} ${i + 1}`}
                          title="Remover"
                          className="h-8 w-8 text-red-500 hover:bg-red-500/10"
                        >
                          <X className="h-4 w-4" aria-hidden="true" />
                        </Button>
                      )}
                    </div>
                    {templateMode === "rotacao" && mensagens.length > 1 && (
                      <p className="text-[10px] text-muted-foreground -mt-2">
                        Contatos: {[0, 1, 2].map((k) => i + 1 + k * mensagens.length).join(", ")}...
                        {" "}(posição {i + 1} no round-robin)
                      </p>
                    )}

                    {/* Canal oficial (Meta): só template aprovado — texto
                        livre, IA, imagem, áudio e ligação são só WAHA
                        (campaign-validation.ts, mesma regra do servidor). */}
                    {hasMeta ? (
                      <p className="text-[11px] text-muted-foreground">
                        Canal oficial (Meta): a mensagem é um <strong>template aprovado</strong> da conta
                        WhatsApp Business do número escolhido.
                      </p>
                    ) : (
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs" role="group" aria-label="Tipo da mensagem">
                      <button
                        type="button"
                        onClick={() => {
                          const updated = [...mensagens];
                          updated[i].tipo = "texto";
                          setMensagens(updated);
                        }}
                        aria-pressed={msg.tipo === "texto"}
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
                        aria-pressed={msg.tipo === "ia"}
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
                        aria-pressed={msg.tipo === "imagem"}
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
                        aria-pressed={msg.tipo === "audio"}
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
                        aria-pressed={msg.tipo === "ligacao"}
                        className={`py-1.5 border rounded-md font-medium ${msg.tipo === "ligacao" ? "bg-primary text-primary-foreground border-primary" : "bg-card text-muted-foreground border-border"}`}
                      >
                        Ligação
                      </button>
                    </div>
                    )}

                    {(msg.tipo === "texto" || hasMeta) && (
                      <div className="space-y-1.5">
                        {/* Meta: o corpo é o do template aprovado (a Meta
                            envia o texto aprovado, não o editado) — só leitura. */}
                        <textarea
                          ref={(el) => { varFieldRefs.current[`conteudo-${i}`] = el; }}
                          value={msg.conteudo ?? ""}
                          readOnly={hasMeta}
                          onChange={(e) => {
                            if (hasMeta) return;
                            const updated = [...mensagens];
                            updated[i].conteudo = e.target.value;
                            setMensagens(updated);
                          }}
                          placeholder={hasMeta ? "Escolha um template aprovado em \"Carregar de um Template\"." : "Escreva a mensagem..."}
                          aria-label={`Texto da mensagem ${i + 1}`}
                          className={cn(
                            "w-full min-h-[60px] rounded-md border border-input bg-background px-3 py-2 text-xs focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 resize-none",
                            hasMeta && "bg-muted/40 text-muted-foreground"
                          )}
                        />
                        <div className="flex flex-wrap items-center gap-1">
                          {!hasMeta && TEMPLATE_VARS.map((v) => (
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
                            <FileText className="h-3 w-3" aria-hidden="true" />
                            Carregar de um Template
                          </button>
                        </div>

                        {(() => {
                          const aviso = templateWarning(msg);
                          return aviso ? (
                            <p
                              role="alert"
                              className="flex items-start gap-1.5 rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-[11px] font-medium text-red-600 dark:text-red-400"
                            >
                              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                              <span>{aviso} A campanha não vai iniciar com este template.</span>
                            </p>
                          ) : null;
                        })()}

                        {msg.template_name && msg.template_variable_map && msg.template_variable_map.length > 0 && (
                          <div className="space-y-2 rounded-md border border-border bg-card p-3">
                            <p className="text-[10px] font-bold text-muted-foreground">
                              Variáveis do template &quot;{msg.template_name}&quot; ({msg.template_language})
                            </p>
                            {msg.template_variable_map.map((entry: any, varIdx: number) => (
                              <div key={varIdx} className="flex flex-wrap items-center gap-2">
                                <span className="w-10 shrink-0 font-mono text-[10px] text-muted-foreground">
                                  {`{{${varIdx + 1}}}`}
                                </span>
                                <Select
                                  value={
                                    entry.type === "contact_field"
                                      ? entry.field
                                      : entry.type === "utm_link"
                                        ? "utm_link"
                                        : entry.type === "csv_var"
                                          ? `csv_var_${entry.index}`
                                          : "static"
                                  }
                                  onValueChange={(val) => {
                                    if (!val) return;
                                    const updated = [...mensagens];
                                    const map = [...(updated[i].template_variable_map || [])];
                                    if (val.startsWith("csv_var_")) {
                                      const index = parseInt(val.split("_")[2], 10) as 0 | 1 | 2;
                                      map[varIdx] = { type: "csv_var", index };
                                    } else {
                                      map[varIdx] =
                                        val === "static"
                                          ? { type: "static", value: "" }
                                          : val === "utm_link"
                                            ? { type: "utm_link" }
                                            : { type: "contact_field", field: val };
                                    }
                                    updated[i] = { ...updated[i], template_variable_map: map };
                                    setMensagens(updated);
                                  }}
                                >
                                  <SelectTrigger className="h-7 w-40 border-border bg-background text-xs" aria-label={`Origem da variável ${varIdx + 1}`}>
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent className="border-border bg-popover">
                                    <SelectItem value="name">Nome do contato</SelectItem>
                                    <SelectItem value="phone">Telefone</SelectItem>
                                    <SelectItem value="company">Empresa</SelectItem>
                                    <SelectItem value="utm_link">Link UTM personalizado</SelectItem>
                                    <SelectItem value="static">Valor fixo</SelectItem>
                                    <SelectItem value="csv_var_0">VAR1 (do CSV)</SelectItem>
                                    <SelectItem value="csv_var_1">VAR2 (do CSV)</SelectItem>
                                    <SelectItem value="csv_var_2">VAR3 (do CSV)</SelectItem>
                                  </SelectContent>
                                </Select>
                                {entry.type === "utm_link" && (
                                  <span className="flex-1 text-[10px] text-muted-foreground">
                                    Resolvido por contato via &quot;Gerar UTM&quot; no passo Público
                                    (telefone → link_curto).
                                  </span>
                                )}
                                {entry.type === "csv_var" && (
                                  <span className="flex-1 text-[10px] text-muted-foreground">
                                    Resolvido por contato a partir da coluna VAR{entry.index + 1} do CSV importado.
                                  </span>
                                )}
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
                                    placeholder={
                                      importFile && !entry.value
                                        ? "Será preenchido pelo CSV..."
                                        : "Valor fixo..."
                                    }
                                    aria-label={`Valor fixo da variável ${varIdx + 1}`}
                                    className={cn(
                                      "h-7 min-w-32 flex-1 border-border bg-background text-xs",
                                      importFile && !entry.value
                                        ? "border-amber-500/50 placeholder:text-amber-500/70"
                                        : !entry.value?.trim() && "border-red-500"
                                    )}
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
                          aria-label={`Prompt da IA da mensagem ${i + 1}`}
                          className="w-full min-h-[60px] rounded-md border border-input bg-background px-3 py-2 text-xs focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 resize-none"
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
                            aria-label={`Link da imagem da mensagem ${i + 1}`}
                            className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-xs focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
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
                          aria-label={`Legenda da imagem da mensagem ${i + 1}`}
                          className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
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
                            aria-label={`Link do áudio da mensagem ${i + 1}`}
                            className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-xs focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
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
                  <Plus className="h-4 w-4 mr-1" />{" "}
                  {templateMode !== "sequencia" ? "Adicionar Template" : "Adicionar Mensagem Sequencial"}
                </Button>
              </div>
            </div>
            )}

            {wizardStep === 3 && (
            <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4">
              {/* Modo de disparo */}
              <div className="space-y-2">
                <p id="campaign-dispatch-label" className="text-xs font-medium text-muted-foreground">Modo de disparo</p>
                <div role="group" aria-labelledby="campaign-dispatch-label" className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {DISPATCH_MODES.map((m) => (
                    <button
                      key={m.key}
                      type="button"
                      onClick={() => handleDispatchModeChange(m.key)}
                      aria-pressed={dispatchMode === m.key}
                      className={cn(
                        "flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left transition-colors",
                        dispatchMode === m.key
                          ? "border-primary bg-primary/10"
                          : "border-input bg-background hover:bg-muted/50"
                      )}
                    >
                      <span className="text-sm font-medium">
                        {m.emoji} {m.label}
                      </span>
                      <span className="text-[10px] text-muted-foreground">{m.description}</span>
                    </button>
                  ))}
                </div>
                {dispatchMode === "imediato" && (
                  <p className="text-xs text-amber-700 dark:text-amber-500">
                    ⚠️ Sem proteção anti-spam. Recomendado apenas para listas pequenas ou canais
                    com histórico saudável.
                  </p>
                )}
              </div>

              {/* Janela de horário — independente do modo de disparo */}
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <label htmlFor="campaign-janela-inicio" className="text-xs font-medium text-muted-foreground">Início da janela (HH:MM)</label>
                  <input
                    id="campaign-janela-inicio"
                    inputMode="numeric"
                    type="text"
                    value={janelaInicio}
                    onChange={(e) => setJanelaInicio(e.target.value)}
                    placeholder="08:00"
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 text-center"
                  />
                </div>
                <div className="space-y-1">
                  <label htmlFor="campaign-janela-fim" className="text-xs font-medium text-muted-foreground">Fim da janela (HH:MM)</label>
                  <input
                    id="campaign-janela-fim"
                    inputMode="numeric"
                    type="text"
                    value={janelaFim}
                    onChange={(e) => setJanelaFim(e.target.value)}
                    placeholder="18:00"
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 text-center"
                  />
                </div>
              </div>

              {/* Dias da semana — vazio = todos */}
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">
                  Dias de envio <span className="font-normal">(nenhum marcado = todos os dias)</span>
                </p>
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Dias de envio">
                  {WEEKDAY_LABELS.map((label, day) => {
                    const on = diasEnvio.includes(day);
                    return (
                      <button
                        key={label}
                        type="button"
                        aria-pressed={on}
                        onClick={() =>
                          setDiasEnvio((prev) =>
                            on ? prev.filter((d) => d !== day) : [...prev, day].sort((a, b) => a - b)
                          )
                        }
                        className={cn(
                          "h-9 min-w-11 rounded-md border px-2 text-xs font-medium transition-colors",
                          on
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border text-muted-foreground hover:bg-muted hover:text-foreground"
                        )}
                      >
                        {label}
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    onClick={() => setDiasEnvio([1, 2, 3, 4, 5])}
                    className="h-9 rounded-md px-2 text-xs text-muted-foreground underline-offset-2 hover:underline"
                  >
                    Seg a Sex
                  </button>
                </div>
              </div>

              {/* Campos técnicos — só em modo "Personalizado" */}
              {dispatchMode === "personalizado" && (
                <div className="space-y-4 rounded-md border border-border/60 bg-muted/20 p-3">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <label htmlFor="campaign-intervalo-min" className="text-xs font-medium text-muted-foreground">Intervalo mín. (s)</label>
                      <input
                        id="campaign-intervalo-min"
                        type="number"
                        value={intervaloMin}
                        onChange={(e) => setIntervaloMin(Number(e.target.value))}
                        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
                      />
                    </div>
                    <div className="space-y-1">
                      <label htmlFor="campaign-intervalo-max" className="text-xs font-medium text-muted-foreground">Intervalo máx. (s)</label>
                      <input
                        id="campaign-intervalo-max"
                        type="number"
                        value={intervaloMax}
                        onChange={(e) => setIntervaloMax(Number(e.target.value))}
                        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
                      />
                    </div>
                  </div>

                  {/* Batch dispatch (migration 078) */}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <label htmlFor="campaign-batch-size" className="text-xs font-medium text-muted-foreground">Mensagens por lote</label>
                      <input
                        id="campaign-batch-size"
                        type="number"
                        min={1}
                        max={500}
                        value={batchSize}
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          setBatchSize(val);
                          // Zera a pausa quando o lote volta a 1 — evita que um
                          // batch_pause_seconds esquecido de uma edição anterior
                          // insira uma pausa extra no comportamento de item único.
                          if (val <= 1) setBatchPauseSeconds(0);
                        }}
                        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
                      />
                      <p className="text-[10px] text-muted-foreground">
                        Quantas mensagens enviar em paralelo por ciclo (default: 1).
                      </p>
                    </div>
                    {batchSize > 1 && (
                      <div className="space-y-1">
                        <label htmlFor="campaign-batch-pause" className="text-xs font-medium text-muted-foreground">Pausa entre lotes (segundos)</label>
                        <input
                          id="campaign-batch-pause"
                          type="number"
                          min={0}
                          max={3600}
                          value={batchPauseSeconds}
                          onChange={(e) => setBatchPauseSeconds(Number(e.target.value))}
                          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
                        />
                        <p className="text-[10px] text-muted-foreground">
                          Tempo de espera entre cada lote (0 = sem pausa extra).
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Campos técnicos — só em modo "Segmentado". batchSize/
                  batchPauseSeconds (o que de fato vai no payload) são
                  derivados de batchPercent/batchPauseMinutes pelo useEffect
                  logo acima de channelMap — a resolução
                  definitiva contra o total real de contatos acontece em
                  startCampaign.ts no momento do início. */}
              {dispatchMode === "segmentado" && (
                <div className="space-y-4 rounded-md border border-border/60 bg-muted/20 p-3">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <label htmlFor="campaign-batch-percent" className="text-xs font-medium text-muted-foreground">Percentual por rodada</label>
                      <input
                        id="campaign-batch-percent"
                        type="number"
                        min={1}
                        max={50}
                        value={batchPercent}
                        onChange={(e) =>
                          setBatchPercent(Math.min(50, Math.max(1, Number(e.target.value) || 1)))
                        }
                        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
                      />
                      <p className="text-[10px] text-muted-foreground">De 1% a 50% da lista por rodada.</p>
                    </div>
                    <div className="space-y-1">
                      <label htmlFor="campaign-batch-pause-min" className="text-xs font-medium text-muted-foreground">Intervalo entre rodadas (min)</label>
                      <input
                        id="campaign-batch-pause-min"
                        type="number"
                        min={1}
                        max={1440}
                        value={batchPauseMinutes}
                        onChange={(e) =>
                          setBatchPauseMinutes(Math.max(1, Number(e.target.value) || 1))
                        }
                        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
                      />
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Para {segmentadoExampleBase.toLocaleString("pt-BR")} contatos
                    {!totalContatosConhecidos && " (exemplo)"}: {segmentadoPorRodada.toLocaleString("pt-BR")} por
                    rodada a cada {batchPauseMinutes} min (~{segmentadoRodadas} rodadas, ~{segmentadoTempoLabel} para
                    concluir).
                  </p>
                </div>
              )}

              {/* Agendamento futuro */}
              <div className="space-y-1">
                <label htmlFor="campaign-agendar-para" className="text-xs font-medium text-muted-foreground">
                  Agendar para (opcional)
                </label>
                <input
                  id="campaign-agendar-para"
                  type="datetime-local"
                  value={agendarPara}
                  onChange={(e) => setAgendarPara(e.target.value)}
                  className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <p className="text-[10px] text-muted-foreground">
                  Horário de Brasília. Se não preenchido, inicia imediatamente ao clicar em &quot;Iniciar&quot;.
                </p>
              </div>

              <div className="space-y-1.5">
                <p id="campaign-template-mode-label" className="text-xs font-medium text-muted-foreground">Modo de templates</p>
                <div role="group" aria-labelledby="campaign-template-mode-label" className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {TEMPLATE_MODE_OPTIONS.map((opt) => (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => setTemplateMode(opt.key)}
                      aria-pressed={templateMode === opt.key}
                      className={cn(
                        "flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left transition-colors",
                        templateMode === opt.key
                          ? "border-primary bg-primary/10"
                          : "border-input bg-background hover:bg-muted/50"
                      )}
                    >
                      <span className="text-xs font-medium">{opt.label}</span>
                      <span className="text-[10px] text-muted-foreground">{opt.description}</span>
                    </button>
                  ))}
                </div>
                {templateMode !== "sequencia" && (
                  <p className="text-xs text-amber-700 dark:text-amber-500">
                    ⚠ Cada contato receberá apenas 1 template.
                  </p>
                )}
                {templateMode !== "sequencia" && mensagens.length < 2 && (
                  <p className="text-xs text-amber-700 dark:text-amber-500">
                    ⚠️ Adicione pelo menos 2 templates para que a rotação/aleatório funcione.
                    Com apenas 1, todos os contatos receberão o mesmo template.
                  </p>
                )}
              </div>

              {/* Webchat de campanha (migration 127) */}
              <CampaignWebchatSettings value={webchat} onChange={setWebchat} />
            </div>
            )}

            {wizardStep === 4 && (
              <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4">
                <h4 className="font-medium text-foreground">Resumo da Campanha</h4>

                <div className="space-y-3 rounded-lg border border-border p-4 bg-muted/20 text-sm">
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">Nome</span>
                    <span className="text-right font-medium">{nome || "—"}</span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">Canais</span>
                    <span className="text-right font-medium">
                      {sessions
                        .filter(s => selectedSessions.includes(s.id))
                        .map(s => s.name)
                        .join(", ") || "—"}
                    </span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">Público</span>
                    <span className="text-right font-medium">
                      {importStats
                        ? `Base importada: ${importStats.valid.toLocaleString("pt-BR")} contatos válidos${selectedTags.length > 0 ? " com a tabulação escolhida" : ""}`
                        : keepsExistingAudience
                          ? `Base já importada na campanha${selectedTags.length > 0 ? " com a tabulação escolhida" : ""}`
                          : selectedTags.length > 0
                            ? "Contatos da conta com a tabulação escolhida"
                            : "Todos os contatos da conta"}
                    </span>
                  </div>
                  {selectedTags.length > 0 && (
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">Tabulações</span>
                      <span className="text-right font-medium">{selectedTags.join(", ")}</span>
                    </div>
                  )}
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">Mensagens</span>
                    <span className="text-right font-medium">
                      {mensagens.length} · {TEMPLATE_MODE_OPTIONS.find((m) => m.key === templateMode)?.label}
                    </span>
                  </div>
                  {selectedTemplates.length > 0 && (
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">Templates</span>
                      <span className="text-right font-medium">
                        {selectedTemplates
                          .map((template) => `${template.name}${template.language ? ` · ${template.language}` : ""}`)
                          .join(", ")}
                      </span>
                    </div>
                  )}
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">Modo de disparo</span>
                    <span className="text-right font-medium">
                      {DISPATCH_MODES.find((m) => m.key === dispatchMode)?.emoji}{" "}
                      {DISPATCH_MODES.find((m) => m.key === dispatchMode)?.label}
                    </span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">Janela de envio</span>
                    <span className="text-right font-medium">
                      {janelaInicio && janelaFim ? `${janelaInicio} às ${janelaFim}` : "Sem restrição de horário"}
                    </span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">Dias de envio</span>
                    <span className="text-right font-medium">
                      {diasEnvio.length === 0 || diasEnvio.length === 7
                        ? "Todos os dias"
                        : diasEnvio.map((d) => WEEKDAY_LABELS[d]).join(", ")}
                    </span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">Início</span>
                    <span className="text-right font-medium">
                      {agendarPara
                        ? `Agendado para ${formatBrasilia(brasiliaLocalToIso(agendarPara) ?? "")} (Brasília)`
                        : "Ao clicar em \"Iniciar\" na lista de campanhas"}
                    </span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">Webchat ao responder</span>
                    <span className="text-right font-medium">{webchat.webchat_enabled ? "Ativado" : "Desativado"}</span>
                  </div>
                  {estimativa && (
                    <div className="flex flex-col gap-1">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground text-sm">Tempo estimado</span>
                        <span className="font-semibold text-sm">{estimativa.label}</span>
                      </div>
                      {estimativa.detalhe && (
                        <p className="text-xs text-muted-foreground text-right">{estimativa.detalhe}</p>
                      )}
                      {estimativa.aviso && (
                        <p className="text-xs text-amber-700 dark:text-amber-500 text-right">⚠ {estimativa.aviso}</p>
                      )}
                    </div>
                  )}
                </div>

                {hasMeta && !importStats && !keepsExistingAudience && (
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
                    ⚠ Canal Meta selecionado sem base importada. Certifique-se de
                    que os contatos já estão no CRM com as tabulações corretas e que
                    o template está configurado nas mensagens.
                  </div>
                )}

                {/* Público "conta inteira" — o aceite explícito fica no passo
                    Público; aqui só reforça antes de salvar. */}
                {selectedTags.length === 0 && !importStats && !keepsExistingAudience && (
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
                    ⚠ Sem base importada e sem tabulação: a campanha será enviada para
                    todos os contatos da conta (confirmado no passo Público).
                  </div>
                )}

                {/* Prévia por contato — previewCampaignMessage (preview-message.ts)
                    espelha a resolução de variáveis do startCampaign, bifurcada
                    por tipo de canal (template Meta × texto WAHA). */}
                <div className="space-y-3">
                  <div>
                    <h4 className="font-medium text-foreground">Prévia por contato</h4>
                    <p className="text-xs text-muted-foreground">
                      {importFile && importPreview && importPreview.length > 0
                        ? `Como os ${previewContacts.length} primeiros contatos da base vão receber a mensagem.`
                        : "Sem base importada: prévia com um contato de exemplo. Os dados de cada contato (nome, empresa, variáveis) são preenchidos no envio."}
                    </p>
                  </div>
                  {previewContacts.map((pc, ci) => {
                    const doContato =
                      templateMode === "rotacao" && mensagens.length > 0
                        ? [{ msg: mensagens[ci % mensagens.length], idx: ci % mensagens.length }]
                        : mensagens.map((msg, idx) => ({ msg, idx }));
                    return (
                      <div key={pc.key} className="space-y-2 rounded-lg border border-border p-3">
                        <p className="text-xs font-medium text-foreground">{pc.titulo}</p>
                        {doContato.map(({ msg, idx }) => (
                          <Fragment key={idx}>{renderMessagePreview(msg, idx, pc.contact)}</Fragment>
                        ))}
                      </div>
                    );
                  })}
                  {templateMode === "rotacao" && mensagens.length > 1 && (
                    <p className="text-[11px] text-muted-foreground">
                      Modo rotação: exemplo da alternância — no envio a ordem segue a lista do público.
                    </p>
                  )}
                  {templateMode === "aleatorio" && mensagens.length > 1 && (
                    <p className="text-[11px] text-muted-foreground">
                      Modo aleatório: cada contato recebe só uma destas mensagens, sorteada no envio.
                    </p>
                  )}
                </div>
              </div>
            )}

            <footer className="px-4 py-3 sm:px-6 sm:py-4 border-t border-border flex flex-wrap justify-between items-center gap-2 bg-muted/20">
              <Button
                type="button"
                variant="outline"
                onClick={() => wizardStep === 1 ? closeModal() : goToWizardStep((wizardStep - 1) as WizardStep)}
              >
                {wizardStep === 1 ? "Cancelar" : "← Voltar"}
              </Button>

              <div className="flex gap-2">
                {wizardStep < 4 && (
                  <Button
                    type="button"
                    onClick={() => goToWizardStep((wizardStep + 1) as WizardStep)}
                  >
                    Avançar →
                  </Button>
                )}
                {wizardStep === 4 && (
                  <Button
                    type="button"
                    onClick={handleWizardFinish}
                    disabled={isSubmitting}
                    className={isSubmitting ? "opacity-50 cursor-not-allowed gap-1.5" : "gap-1.5"}
                  >
                    {isSubmitting ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        {editingId ? "Salvando..." : agendarPara ? "Agendando..." : "Criando..."}
                      </>
                    ) : editingId ? "Salvar Alterações" : agendarPara ? "Agendar Campanha" : "Criar Campanha"}
                  </Button>
                )}
              </div>
            </footer>
          </div>
        </div>
      )}

      <MessageTemplatePicker
        open={templatePickerIndex !== null}
        hasMeta={hasMeta}
        wabaId={campaignWabaId}
        channelMap={channelMap}
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
            // Maior {{n}} (não o número de ocorrências: "{{1}} … {{1}}" é 1).
            const varCount = Math.max(0, ...placeholderNumbers(bodyText));

            // Mapeamento padrão: {{n}} → coluna VARn do CSV quando ela foi
            // mapeada no passo Público (o CSV agora vem antes da mensagem);
            // senão {{1}} → nome do contato e demais → estático vazio.
            const varColumns = [columnMap.var1, columnMap.var2, columnMap.var3];
            const defaultMap: CampaignMessage["template_variable_map"] = Array.from(
              { length: varCount },
              (_, idx) =>
                importFile && idx < 3 && varColumns[idx]
                  ? { type: "csv_var" as const, index: idx as 0 | 1 | 2 }
                  : idx === 0
                    ? { type: "contact_field" as const, field: "name" as const }
                    : { type: "static" as const, value: "" }
            );

            updated[templatePickerIndex] = {
              ...updated[templatePickerIndex],
              // Meta só envia template: a mensagem é sempre do tipo texto.
              tipo: "texto",
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
                    {audienceInfo.already_sent > 0 && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {audienceInfo.already_sent.toLocaleString("pt-BR")} já receberam nesta campanha e serão pulados.
                      </p>
                    )}
                    <p className="mt-1 text-xs text-muted-foreground">Contatos na blacklist são pulados no envio.</p>
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

      {/* Troca de provider (Meta ↔ WAHA) ou de WABA com templates já
          escolhidos: confirma antes de limpar template/variáveis. */}
      <AlertDialog
        open={pendingChannelChange !== null}
        onOpenChange={(open) => !open && setPendingChannelChange(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Trocar o tipo de canal?</AlertDialogTitle>
            <AlertDialogDescription>
              Os templates são da conta WhatsApp Business (WABA) de cada número. Mudar entre Meta e
              WAHA, ou para um número de outra WABA, apaga os templates e o mapeamento de variáveis
              já escolhidos nas mensagens desta campanha.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Manter canais</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => {
                if (pendingChannelChange) applyChannelSelection(pendingChannelChange, true);
                setPendingChannelChange(null);
              }}
            >
              Trocar e limpar templates
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