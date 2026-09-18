"use client";

import { apiFetch } from "@/lib/api-fetch";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
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
  Pencil,
  Upload,
  Loader2,
  BarChart2,
  Search,
  CheckCircle2
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
import { trackAction } from "@/hooks/use-telemetry";
import { normalizePhone } from "@/lib/whatsapp/phone-utils";
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
  agendamento?: string | null;
  created_at: string;
  // Migration 078 — disparo em lote (ver worker.ts)
  batch_size?: number;
  batch_pause_seconds?: number;
  // Teto de envios/hora, enforced ao vivo por worker.ts/cron/route.ts —
  // usado pela estimativa (estimarDisparo) como piso de tempo mínimo.
  limite_por_hora?: number;
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
  waba_id?: string;
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
};

const STATUS_LABELS: Record<string, string> = {
  rascunho: "Rascunho",
  agendado: "Agendado",
  em_execucao: "Em Execução",
  pausada: "Pausada",
  encerrada: "Encerrada",
};

// Browser-local safety net against an accidentally closed creation modal,
// not a per-campaign store. Never touched by edit mode (see editingId
// guards below), so editing a real campaign can't clobber or be clobbered
// by this. Scoped by account_id (see draftKey below) so a shared browser
// profile logged into different accounts never bleeds a draft across them.
function draftStorageKey(accountId: string | null): string | null {
  return accountId ? `disparador:campaign-draft:${accountId}` : null;
}

// Campos DDM do sub-step de mapeamento de colunas (Step 2, após a prévia
// do CSV) — chave bate com o que import/route.ts espera em column_map.
const COLUMN_MAP_FIELDS: Array<{ key: string; label: string }> = [
  { key: "name", label: "Nome" },
  { key: "phone", label: "Telefone Principal" },
  { key: "cpf", label: "CPF" },
  { key: "var1", label: "VAR1" },
  { key: "var2", label: "VAR2" },
  { key: "var3", label: "VAR3" },
];

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
  batchSize: number;
  batchPauseSeconds: number;
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
      aviso = "Janela de horário inválida (fim antes do início) — estimativa ignora a janela.";
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
  // Resolved once in loadData() — used to scope the localStorage draft key.
  const [accountId, setAccountId] = useState<string | null>(null);
  const draftKey = draftStorageKey(accountId);
  // Identifica esta sessão de criação de campanha antes que ela exista de
  // fato em wacrm.campaigns (links UTM podem ser gerados no Step 2, antes
  // do submit do Step 3) — ver handleGerarUTM/handleSubmit. Regenerado em
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
  const [objetivo, setObjetivo] = useState("");
  const [selectedSessions, setSelectedSessions] = useState<string[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [tagSearch, setTagSearch] = useState("");
  const [intervaloMin, setIntervaloMin] = useState(30);
  const [intervaloMax, setIntervaloMax] = useState(60);
  const [janelaInicio, setJanelaInicio] = useState("08:00");
  const [janelaFim, setJanelaFim] = useState("18:00");
  const [batchSize, setBatchSize] = useState(1);
  const [batchPauseSeconds, setBatchPauseSeconds] = useState(0);
  const [agendarPara, setAgendarPara] = useState<string>("");
  const [mensagens, setMensagens] = useState<any[]>([{ tipo: "texto", conteudo: "" }]);

  const [wizardStep, setWizardStep] = useState(1);
  // Step 2 — importação de base
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
  const [columnMap, setColumnMap] = useState<Record<string, string>>({});
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
      objetivo,
      selectedSessions,
      selectedTags,
      intervaloMin,
      intervaloMax,
      janelaInicio,
      janelaFim,
      batchSize,
      batchPauseSeconds,
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
    objetivo,
    selectedSessions,
    selectedTags,
    intervaloMin,
    intervaloMax,
    janelaInicio,
    janelaFim,
    batchSize,
    batchPauseSeconds,
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
        // wacrm.campaigns has no account_id yet (migration 040 not
        // applied), so scope by the caller's account via created_by —
        // see getDisparadorScope.
        const { userIds } = await getDisparadorScope(supabase);
        const { data: campaignList } = await supabase
          .from("campaigns")
          .select("id, nome, objetivo, descricao, status, session_ids, tags_filtro, mensagens, intervalo_min, intervalo_max, janela_inicio, janela_fim, agendamento, created_by, batch_size, batch_pause_seconds, limite_por_hora")
          .in("created_by", userIds)
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

  // Recarrega só a lista de tags — reutilizada por loadData() no mount e
  // por handleSubmit() após um import de CSV bem-sucedido, para que a tag
  // recém-criada com o nome da campanha apareça no seletor de filtros da
  // próxima vez que o modal for aberto (na sessão atual, o próprio
  // handleSubmit já garante o filtro certo via tagsFinais, sem depender
  // desta lista estar atualizada).
  const loadTags = async () => {
    const supabase = createClient();
    const { data: tagList } = await supabase.from("tags").select("id, name, color").order("name");
    setTags(tagList ?? []);
  };

  const loadData = async () => {
    setLoading(true);
    try {
      const supabase = createClient();

      // wacrm.campaigns has no account_id yet (migration 040 not
      // applied), so scope by the caller's account via created_by —
      // see getDisparadorScope.
      const { userIds, accountId: scopedAccountId } = await getDisparadorScope(supabase);
      setAccountId(scopedAccountId);

      // Load Campaigns
      const { data: campaignList } = await supabase
        .from("campaigns")
        .select("*")
        .in("created_by", userIds)
        .order("created_at", { ascending: false });
      setCampaigns(campaignList ?? []);

      // Load Tags
      await loadTags();

      // Load enabled WhatsApp channels (WAHA + Meta)
      const { data: configList } = await supabase
        .from("whatsapp_config")
        .select("id, waha_session, provider, display_phone_number, waba_id")
        .eq("habilitado", true);

      const wahaSessions = (configList ?? []).map((c) => ({
        id: c.id,
        name: c.provider === "meta"
          ? `WhatsApp Oficial (Meta)${c.display_phone_number ? ` — ${c.display_phone_number}` : ""}`
          : (c.waha_session || "Sessão WAHA"),
        provider: c.provider,
        display_phone_number: c.display_phone_number,
        waba_id: c.waba_id,
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
        trackAction("campaign_started", { campaign_id: id });
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
    setBatchSize(campaign.batch_size ?? 1);
    setBatchPauseSeconds(campaign.batch_pause_seconds ?? 0);
    // Edição só é permitida para campanhas em "rascunho" (ver PATCH
    // /api/disparador/campaigns/[id]), que por definição nunca têm
    // agendamento — campo sempre reseta vazio aqui.
    setAgendarPara("");
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
    setObjetivo(pendingDraft.objetivo);
    setSelectedSessions(pendingDraft.selectedSessions);
    setSelectedTags(pendingDraft.selectedTags);
    setIntervaloMin(pendingDraft.intervaloMin);
    setIntervaloMax(pendingDraft.intervaloMax);
    setJanelaInicio(pendingDraft.janelaInicio);
    setJanelaFim(pendingDraft.janelaFim);
    setBatchSize(pendingDraft.batchSize ?? 1);
    setBatchPauseSeconds(pendingDraft.batchPauseSeconds ?? 0);
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
    setImportFile(null);
    setImportPreview(null);
    setImportStats(null);
    setImportAllRows(null);
    setUtmGerado(false);
    setUtmLoading(false);
    setUtmProgress(null);
    setCsvHeaders([]);
    setColumnMap({});
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
    if (selectedSessions.length === 0) {
      toast.error("Selecione pelo menos uma sessão do WhatsApp.");
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
    if (
      mensagens.some(
        (m) =>
          ["imagem", "audio", "ligacao"].includes(m.tipo) && !m.url?.trim()
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
        "foram gerados — clique em \"Gerar UTM\" no Step 2 antes de salvar, " +
        "senão esses contatos não receberão link."
      );
    }

    // Horário de Brasília — assume o fuso do navegador do usuário
    // (datetime-local não carrega timezone própria).
    const agendamentoISO = agendarPara
      ? new Date(agendarPara).toISOString()
      : null;

    // Se importou CSV, garante que o filtro da campanha inclui a tag do
    // import (mesmo nome usado como defaultTag abaixo) — sem isso,
    // tags_filtro fica vazio e start/route.ts dispara para TODOS os
    // contatos da conta, não só os importados nesta sessão.
    const tagDoCsv = nome.trim();
    let tagsFinais = importFile && !selectedTags.includes(tagDoCsv)
      ? [...selectedTags, tagDoCsv]
      : selectedTags;

    setIsSubmitting(true);
    try {
      // Se há arquivo para importar, envia para o servidor primeiro
      if (importFile) {
        const formData = new FormData();
        formData.append("file", importFile);
        // Tag com o nome da campanha para identificar os contatos
        formData.append("defaultTag", tagDoCsv);
        // campaign_id (edição) ou draft_id (criação, campanha ainda não
        // existe) — persistem VAR1/VAR2/VAR3 em
        // wacrm.contact_import_variables (migration 079). Mesmo padrão
        // de idColumn/idValue usado em handleGerarUTM abaixo.
        if (editingId) {
          formData.append("campaign_id", editingId);
        } else {
          formData.append("draft_id", draftId);
        }
        // Mapeamento de colunas confirmado/ajustado no Step 2 (Correção 3)
        // — só envia se o usuário chegou a importar um CSV com colunas
        // detectadas (columnMap fica vazio se parseImportFile nunca rodou,
        // ex: reimportação de um estado antigo). Vazio → import/route.ts
        // cai 100% na heurística de sempre (retrocompat).
        if (Object.keys(columnMap).length > 0) {
          formData.append("column_map", JSON.stringify(columnMap));
        }
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

        // Nome real da tag usada no import — pode diferir de tagDoCsv
        // quando já existia uma tag com o mesmo nome em outra
        // capitalização (a rota casa por nome case-insensitive, mas o
        // filtro de tags_filtro em start/route.ts é case-sensitive contra
        // tags.name). Sem isso, tagsFinais poderia guardar um nome que
        // não bate com a tag de fato vinculada aos contatos, e a
        // campanha dispararia para zero contatos.
        if (importResult.tagName && importResult.tagName !== tagDoCsv) {
          tagsFinais = tagsFinais.map((t) => (t === tagDoCsv ? importResult.tagName : t));
        }

        trackAction("csv_imported", {
          total_rows: importados + duplicados + invalidos + erros.length,
          tag: importResult.tagName || tagDoCsv,
        });

        // Repopula o seletor de tags com a tag recém-criada (útil ao
        // reabrir/editar esta campanha depois — a sessão atual já usa
        // tagsFinais acima, não depende deste reload).
        await loadTags();
      }

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
            tags_filtro: tagsFinais,
            mensagens,
            intervalo_min: intervaloMin,
            intervalo_max: intervaloMax,
            janela_inicio: janelaInicio,
            janela_fim: janelaFim,
            batch_size: batchSize,
            batch_pause_seconds: batchPauseSeconds,
            agendamento: agendamentoISO,
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
        const supabase = createClient();

        // created_by is required for the ownership check in the
        // start/stop routes (campaign.created_by !== user.id) — without
        // it, every campaign is unowned and that check always rejects.
        const {
          data: { session },
        } = await supabase.auth.getSession();
        const user = session?.user;
        if (!user) throw new Error("Não autenticado");
        // accountId resolvido em loadData() via getDisparadorScope (mesmo
        // padrão já usado pelo resto do arquivo) — necessário pra migration
        // 040 (RLS do Disparador) poder ser aplicada depois.
        if (!accountId) throw new Error("Conta não resolvida — recarregue a página e tente de novo.");

        const campaignData = {
          nome,
          descricao,
          objetivo,
          session_ids: selectedSessions,
          tags_filtro: tagsFinais,
          mensagens,
          intervalo_min: intervaloMin,
          intervalo_max: intervaloMax,
          janela_inicio: janelaInicio,
          janela_fim: janelaFim,
          batch_size: batchSize,
          batch_pause_seconds: batchPauseSeconds,
          agendamento: agendamentoISO,
          status: agendamentoISO ? "agendado" : "rascunho",
          created_by: user.id,
          account_id: accountId,
          // Migration 080 — grava o draftId usado no import (Step 3 acima)
          // para que startCampaign.ts consiga relinkar
          // contact_import_variables de forma determinística no start,
          // mesmo se o relink abaixo (best-effort, client-side) já tiver
          // rodado ou tiver falhado silenciosamente.
          import_draft_id: draftId,
        };

        const { data: newCampaign, error } = await supabase
          .from("campaigns")
          .insert(campaignData)
          .select("id")
          .single();
        if (error) throw error;

        // Links UTM gerados no Step 2 (antes de a campanha existir) foram
        // salvos sob draftId — agora que o campaign_id real existe,
        // reatribui essas linhas para que start/route.ts consiga achá-las.
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

        // VAR1/VAR2/VAR3 do CSV (Step 2) também foram salvas sob draftId
        // em wacrm.contact_import_variables (migration 079) quando o
        // import aconteceu antes de esta campanha existir — mesmo motivo
        // do relink de UTM acima. Sem custo se nenhum import usou VARn.
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
    setNome("");
    setDescricao("");
    setObjetivo("");
    setSelectedSessions([]);
    setSelectedTags([]);
    setTagSearch("");
    setMensagens([{ tipo: "texto", conteudo: "" }]);
    setIntervaloMin(30);
    setIntervaloMax(60);
    setBatchSize(1);
    setBatchPauseSeconds(0);
    setAgendarPara("");
    setWizardStep(1);
    setImportFile(null);
    setImportPreview(null);
    setImportStats(null);
    setImportAllRows(null);
    setUtmGerado(false);
    setUtmLoading(false);
    setUtmProgress(null);
    setCsvHeaders([]);
    setColumnMap({});
    // Nova sessão de criação — qualquer link UTM salvo sob o draftId
    // anterior fica órfão (campaign_id nunca chegou a ser preenchido),
    // mas isso é inofensivo: nada mais faz join por esse draftId.
    setDraftId(crypto.randomUUID());
  };

  // Meta channels can only send approved templates — the picker needs to
  // know this to show the Meta catalog instead of the account's own
  // editable disparador_message_templates list.
  const hasMeta = sessions
    .filter((s) => selectedSessions.includes(s.id))
    .some((s) => s.provider === "meta");

  // Derivado, recalculado a cada render — barato o suficiente pra não
  // precisar de useMemo. Null quando não há CSV importado nesta sessão
  // (campanha "via tags do CRM" não tem N conhecido no cliente antes do
  // start de verdade — ver investigação, não existe endpoint hoje que
  // resolva a contagem de contatos por tag sem duplicar a lógica de
  // start/route.ts).
  const estimativa = (importStats?.valid ?? 0) > 0
    ? estimarDisparo(
        importStats!.valid,
        mensagens.length,
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

  const parseImportFile = async (file: File) => {
    setImportLoading(true);
    setImportPreview(null);
    setImportStats(null);
    setImportAllRows(null);
    setUtmGerado(false);
    setUtmProgress(null);
    setCsvHeaders([]);
    setColumnMap({});
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

      const headers = dataLines[0].split(sep).map(h =>
        h.trim().toLowerCase().replace(/["\r]/g, "")
      );

      // Índices das colunas
      const phoneIdx = headers.findIndex(h =>
        ["contato", "telefone", "phone", "celular", "tel",
         "fone", "whatsapp", "número", "numero"].includes(h)
      );
      // Mesma lista de NAME_FIELD_KEYS do backend (import/route.ts) — "var1"
      // por último, cobrindo o formato Meta CONTATO;VAR1;VAR2;VAR3 quando
      // não há coluna de nome padrão.
      const nameIdx = headers.findIndex(h =>
        ["nome", "name", "nome completo", "full name", "cliente", "var1"].includes(h)
      );
      const cpfIdx = headers.findIndex(h =>
        ["cpf", "documento", "document"].includes(h)
      );
      const varIndices = headers
        .map((h, i) => h.startsWith("var") ? i : -1)
        .filter(i => i >= 0);

      if (phoneIdx === -1) {
        toast.error("Coluna de telefone não encontrada. Use: CONTATO, telefone, phone...");
        return;
      }

      // Mapeamento manual (Correção 3) — pré-seleciona com base na mesma
      // heurística usada acima (Nome/Telefone/CPF) e, para VAR1/2/3,
      // procura a coluna com o nome literal exato (mesmo critério do
      // getField(row, "var1") no backend), não apenas "começa com var" —
      // varIndices abaixo é só pra prévia/propagação de template, cobre
      // qualquer coluna "varN".
      const var1Idx = headers.findIndex(h => h === "var1");
      const var2Idx = headers.findIndex(h => h === "var2");
      const var3Idx = headers.findIndex(h => h === "var3");
      const detectedMap: Record<string, string> = {};
      if (phoneIdx >= 0) detectedMap.phone = headers[phoneIdx];
      if (nameIdx >= 0) detectedMap.name = headers[nameIdx];
      if (cpfIdx >= 0) detectedMap.cpf = headers[cpfIdx];
      if (var1Idx >= 0) detectedMap.var1 = headers[var1Idx];
      if (var2Idx >= 0) detectedMap.var2 = headers[var2Idx];
      if (var3Idx >= 0) detectedMap.var3 = headers[var3Idx];
      setCsvHeaders(headers);
      setColumnMap(detectedMap);

      const rows = dataLines.slice(1, 6); // preview: primeiros 5
      const allRows = dataLines.slice(1);

      const preview = rows
        .map(line => {
          const cols = line.split(sep).map(c => c.trim().replace(/["\r]/g, ""));
          const phone = cols[phoneIdx] || "";
          if (!phone) return null;
          return {
            phone,
            name: nameIdx >= 0 ? cols[nameIdx] : undefined,
            cpf: cpfIdx >= 0 ? cols[cpfIdx] || undefined : undefined,
            variables: varIndices.map(i => cols[i] || ""),
            raw: Object.fromEntries(headers.map((h, i) => [h, cols[i] || ""])),
          };
        })
        .filter(Boolean) as typeof importPreview;

      const validCount = allRows.filter(line => {
        const cols = line.split(sep);
        return cols[phoneIdx]?.trim();
      }).length;

      setImportPreview(preview);
      setImportStats({
        total: allRows.length,
        valid: validCount,
        invalid: allRows.length - validCount,
      });
      setImportFile(file);

      // Propagar variáveis estáticas do CSV para o template_variable_map
      // Lê todos os valores de cada coluna VAR e, se for único para
      // todos os contatos, preenche como static.value automaticamente.
      // Se variar por contato, deixa em branco e avisa o usuário.
      if (varIndices.length > 0) {
        // Coletar todos os valores de cada coluna VAR para todos os contatos
        const varValueSets: Set<string>[] = varIndices.map(() => new Set<string>());

        for (const line of allRows) {
          const cols = line.split(sep).map((c: string) => c.trim().replace(/["\r]/g, ""));
          if (!cols[phoneIdx]?.trim()) continue;
          varIndices.forEach((colIdx, i) => {
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
            // varIndices[0] = VAR1, varIndices[1] = VAR2, etc.
            // Mas {{1}} já é contact_field:name normalmente, então
            // mapeamos: entry idx → varIdx com mesmo offset
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

        // Aviso se alguma variável varia por contato
        const hasVariableVars = varValueSets.some(set => set.size > 1);
        if (hasVariableVars) {
          toast.warning(
            "Algumas variáveis variam por contato no CSV. " +
            "Use a API externa para disparos com variáveis individuais."
          );
        }
      }

      // Armazena TODOS os contatos (não só os 5 do preview) — usado pelo
      // lote de geração de UTM em handleGerarUTM, que precisa do CSV
      // inteiro, não apenas da amostra exibida em tela.
      const allContacts = allRows
        .map(line => {
          const cols = line.split(sep).map((c: string) =>
            c.trim().replace(/["\r]/g, "")
          );
          const phone = cols[phoneIdx]?.trim();
          if (!phone) return null;
          return {
            phone,
            cpf: cpfIdx >= 0 ? cols[cpfIdx] || undefined : undefined,
            variables: varIndices.map(i => cols[i] || ""),
          };
        })
        .filter(Boolean) as Array<{ phone: string; cpf?: string; variables: string[] }>;
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

  // waba_id do canal Meta selecionado (se só um selecionado)
  const selectedMetaWabaId = useMemo(() => {
    const metaSessions = sessions.filter(
      s => selectedSessions.includes(s.id) && s.provider === 'meta'
    );
    return metaSessions.length === 1 ? metaSessions[0].waba_id : undefined;
  }, [sessions, selectedSessions]);

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

    setUtmMetricsLoading(true);
    try {
      const utmRes = await fetch(
        `/api/disparador/utm/metricas?campanha=${encodeURIComponent(campaignNome)}&canal=whatsapp`
      );
      if (utmRes.ok) {
        const utmData = await utmRes.json();
        setUtmMetrics(utmData.metricas ?? null);
      }
    } catch {
      // silencioso — UTM é opcional
    } finally {
      setUtmMetricsLoading(false);
    }
  };

  const handleMetricsClick = async (campaign: typeof campaigns[0]) => {
    setMetricsModal({ campaignId: campaign.id, nome: campaign.nome });
    setMetricsData(null);
    setMetricsLoading(true);
    await fetchMetrics(campaign.id, campaign.nome);
    setMetricsLoading(false);

    // Auto-refresh a cada 15 segundos enquanto o modal estiver aberto.
    if (metricsRefreshRef.current) clearInterval(metricsRefreshRef.current);
    metricsRefreshRef.current = setInterval(() => {
      fetchMetrics(campaign.id, campaign.nome, true);
    }, 15000);
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
      toast.error("Preencha o nome da campanha no Step 1 antes de gerar UTM");
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
          console.warn("[UTM] Falha na requisição:", await res.text());
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

      // Re-chaveia cpf→link_curto por telefone normalizado (contacts não
      // tem coluna de CPF — ver migration 076) e persiste em
      // disparador_utm_links, o que de fato alimenta o envio via
      // start/route.ts. draftId enquanto a campanha ainda não existe;
      // editingId quando estamos editando um rascunho já criado.
      const phoneLinkRows = source
        .filter((c) => c.cpf && linkMap.has(c.cpf))
        .map((c) => ({
          campaign_id: editingId ?? null,
          draft_id: editingId ? null : draftId,
          phone_normalized: normalizePhone(c.phone),
          link_curto: linkMap.get(c.cpf!)!,
        }))
        .filter((r) => r.phone_normalized);

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
                  {(c.batch_size ?? 1) > 1 && (
                    <div className="flex items-center gap-1.5 truncate">
                      <Layers className="h-3.5 w-3.5" /> Lote: {c.batch_size}x / pausa {c.batch_pause_seconds ?? 0}s
                    </div>
                  )}
                </div>

                {/* Tempo estimado — só quando métricas dessa campanha já
                    foram carregadas nesta sessão (usuário abriu o modal
                    de métricas pelo menos uma vez); sem isso, "—" em vez
                    de disparar uma query por card (evita N+1). */}
                <div className="text-[11px] text-muted-foreground">
                  ⏱{" "}
                  {metricsMap[c.id]?.total_contatos ? (
                    <>
                      {estimarDisparo(
                        metricsMap[c.id].total_contatos,
                        Array.isArray(c.mensagens) ? c.mensagens.length : 1,
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
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => handleMetricsClick(c)}
                      className="h-8 w-8 text-muted-foreground hover:text-foreground"
                      title="Ver métricas"
                    >
                      <BarChart2 className="h-4 w-4" />
                    </Button>
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
            <header className="px-6 py-4 border-b border-border bg-muted/20">
              <div className="flex justify-between items-center mb-3">
                <h3 className="font-bold text-foreground">
                  {editingId ? "Editar Campanha" : "Nova Campanha de Disparo"}
                </h3>
                <Button size="icon" variant="ghost" onClick={closeModal} className="h-8 w-8 text-muted-foreground">
                  <X className="h-5 w-5" />
                </Button>
              </div>
              {/* Step indicators */}
              <div className="flex gap-2">
                {[
                  { step: 1, label: "Configuração" },
                  { step: 2, label: "Importar Base" },
                  { step: 3, label: "Resumo" },
                ].map(({ step, label }) => (
                  <button
                    key={step}
                    type="button"
                    onClick={() => setWizardStep(step)}
                    className={cn(
                      "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors",
                      wizardStep === step
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <span className={cn(
                      "flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-bold",
                      wizardStep === step ? "bg-primary-foreground/20" : "bg-muted-foreground/20"
                    )}>
                      {step}
                    </span>
                    {label}
                  </button>
                ))}
              </div>
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

            {wizardStep === 1 && (
            <div className="flex-1 overflow-y-auto p-6 space-y-4">
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
                <div className="relative mb-2">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2
                    h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                  <input
                    type="text"
                    placeholder="Buscar tag..."
                    value={tagSearch}
                    onChange={(e) => setTagSearch(e.target.value)}
                    className="w-full pl-8 pr-3 py-1.5 text-xs rounded-md border
                      border-border bg-background text-foreground placeholder:text-muted-foreground
                      focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
                <div className="flex flex-wrap gap-2 max-h-24 overflow-y-auto border border-border p-2 rounded-md">
                  {tags
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

              {/* Batch dispatch (migration 078) */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Mensagens por lote</label>
                  <input
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
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none"
                  />
                  <p className="text-[10px] text-muted-foreground">
                    Quantas mensagens enviar em paralelo por ciclo (default: 1).
                  </p>
                </div>
                {batchSize > 1 && (
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">Pausa entre lotes (segundos)</label>
                    <input
                      type="number"
                      min={0}
                      max={3600}
                      value={batchPauseSeconds}
                      onChange={(e) => setBatchPauseSeconds(Number(e.target.value))}
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none"
                    />
                    <p className="text-[10px] text-muted-foreground">
                      Tempo de espera entre cada lote (0 = sem pausa extra).
                    </p>
                  </div>
                )}
              </div>

              {/* Agendamento futuro */}
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">
                  Agendar para (opcional)
                </label>
                <input
                  type="datetime-local"
                  value={agendarPara}
                  onChange={(e) => setAgendarPara(e.target.value)}
                  className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <p className="text-[10px] text-muted-foreground">
                  Horário de Brasília. Se não preenchido, inicia imediatamente ao clicar em "Iniciar".
                </p>
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
                                  <SelectTrigger className="h-7 w-40 border-border bg-background text-xs">
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
                                    Resolvido por contato via "Gerar UTM" no Step 2
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
                                    className={cn(
                                      "h-7 flex-1 border-border bg-background text-xs",
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
            </div>
            )}

            {wizardStep === 2 && (
              <div className="flex-1 overflow-y-auto p-6 space-y-4">
                <div>
                  <h4 className="font-medium text-foreground mb-1">
                    Importar Base de Contatos
                  </h4>
                  <p className="text-xs text-muted-foreground">
                    Opcional — se preferir usar contatos já cadastrados com tags,
                    avance para o próximo passo.
                  </p>
                </div>

                {mensagens.some((msg) =>
                  msg.template_variable_map?.some(
                    (e: any) => e.type === "static" && !e.value
                  )
                ) &&
                  !importFile && (
                    <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-600">
                      ⚠ Rascunho restaurado com variáveis de template incompletas.
                      Reimporte o CSV para preencher automaticamente os valores de{" "}
                      {"{{2}}"}, {"{{3}}"}, etc.
                    </div>
                  )}

                {/* Upload area */}
                <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-border rounded-lg cursor-pointer hover:border-primary/50 hover:bg-muted/30 transition-colors">
                  <div className="flex flex-col items-center gap-1">
                    <Upload className="h-6 w-6 text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">
                      {importFile ? importFile.name : "Clique ou arraste CSV / XLSX"}
                    </span>
                    {!importFile && (
                      <span className="text-xs text-muted-foreground/70">
                        Formatos aceitos: .csv, .xlsx, .xls, .txt
                      </span>
                    )}
                  </div>
                  <input
                    type="file"
                    accept=".csv,.xlsx,.xls,.txt"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) parseImportFile(file);
                    }}
                  />
                </label>

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
                        Detectado automaticamente a partir do cabeçalho do CSV — corrija se
                        alguma coluna estiver errada antes de criar a campanha.
                      </p>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {COLUMN_MAP_FIELDS.map((field) => (
                        <div key={field.key}>
                          <label className="mb-1 block text-[10px] text-muted-foreground">
                            {field.label}
                          </label>
                          <Select
                            value={columnMap[field.key] || "__none__"}
                            onValueChange={(val) => {
                              setColumnMap((prev) => {
                                const next = { ...prev };
                                if (!val || val === "__none__") delete next[field.key];
                                else next[field.key] = val;
                                return next;
                              });
                            }}
                          >
                            <SelectTrigger className="h-8 w-full border-border bg-background text-xs">
                              <SelectValue placeholder="Não mapeado" />
                            </SelectTrigger>
                            <SelectContent className="border-border bg-popover">
                              <SelectItem value="__none__">Não mapeado</SelectItem>
                              {csvHeaders.map((h) => (
                                <SelectItem key={h} value={h}>
                                  {h}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      ))}
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
                      Preview (primeiros 5 contatos):
                    </p>
                    <div className="rounded-md border border-border overflow-hidden">
                      <table className="w-full text-xs">
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
              </div>
            )}

            {wizardStep === 3 && (
              <div className="flex-1 overflow-y-auto p-6 space-y-4">
                <h4 className="font-medium text-foreground">Resumo da Campanha</h4>

                <div className="space-y-3 rounded-lg border border-border p-4 bg-muted/20 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Nome</span>
                    <span className="font-medium">{nome || "—"}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Canal</span>
                    <span className="font-medium">
                      {sessions
                        .filter(s => selectedSessions.includes(s.id))
                        .map(s => s.name)
                        .join(", ") || "—"}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Janela</span>
                    <span className="font-medium">{janelaInicio} — {janelaFim}</span>
                  </div>
                  {agendarPara && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Agendado para</span>
                      <span className="font-medium">
                        {new Date(agendarPara).toLocaleString("pt-BR", {
                          timeZone: "America/Sao_Paulo",
                          day: "2-digit",
                          month: "2-digit",
                          year: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Mensagens</span>
                    <span className="font-medium">{mensagens.length}</span>
                  </div>
                  {selectedTags.length > 0 && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Filtro de tags</span>
                      <span className="font-medium">{selectedTags.join(", ")}</span>
                    </div>
                  )}
                  {importStats && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Contatos a importar</span>
                      <span className="font-medium text-green-600">
                        {importStats.valid} válidos
                      </span>
                    </div>
                  )}
                  {!importStats && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Contatos</span>
                      <span className="font-medium text-muted-foreground">
                        Via tags do CRM
                      </span>
                    </div>
                  )}
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
                        <p className="text-xs text-amber-500 text-right">⚠ {estimativa.aviso}</p>
                      )}
                    </div>
                  )}
                </div>

                {hasMeta && !importStats && (
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-600">
                    ⚠ Canal Meta selecionado sem base importada. Certifique-se de
                    que os contatos já estão no CRM com as tags corretas e que
                    o template está configurado nas mensagens.
                  </div>
                )}

                {/* Safety net educativo: com a Correção 1 (tagsFinais em
                    handleSubmit) isto raramente aparece quando há import,
                    já que a tag da campanha é adicionada automaticamente
                    ao salvar — mas ainda vale o aviso para campanhas sem
                    import nenhuma que também deixaram o filtro vazio. */}
                {selectedTags.length === 0 && (
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-600">
                    ⚠ Nenhum filtro de tag selecionado — a campanha será enviada
                    para todos os contatos da conta. Se quiser enviar só para
                    os contatos importados, o filtro será aplicado
                    automaticamente ao salvar.
                  </div>
                )}
              </div>
            )}

            <footer className="px-6 py-4 border-t border-border flex justify-between items-center bg-muted/20">
              <Button
                type="button"
                variant="outline"
                onClick={() => wizardStep === 1 ? closeModal() : setWizardStep(wizardStep - 1)}
              >
                {wizardStep === 1 ? "Cancelar" : "← Voltar"}
              </Button>

              <div className="flex gap-2">
                {wizardStep < 3 && (
                  <Button
                    type="button"
                    onClick={() => setWizardStep(wizardStep + 1)}
                    disabled={wizardStep === 1 && (!nome.trim() || selectedSessions.length === 0)}
                  >
                    Próximo →
                  </Button>
                )}
                {wizardStep === 3 && (
                  <Button
                    type="button"
                    onClick={handleSubmit}
                    disabled={isSubmitting || !nome.trim() || selectedSessions.length === 0}
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
        wabaId={selectedMetaWabaId}
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

      {metricsModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-card border border-border w-full max-w-md rounded-xl shadow-2xl">
            <header className="px-6 py-4 border-b border-border flex justify-between items-center">
              <div>
                <h3 className="font-bold text-foreground">Métricas da Campanha</h3>
                <p className="text-xs text-muted-foreground truncate max-w-[280px]">
                  {metricsModal.nome}
                </p>
              </div>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => {
                  if (metricsRefreshRef.current) {
                    clearInterval(metricsRefreshRef.current);
                    metricsRefreshRef.current = null;
                  }
                  setMetricsModal(null);
                  setMetricsData(null);
                  setUtmMetrics(null);
                }}
              >
                <X className="h-5 w-5" />
              </Button>
            </header>

            <div className="p-6 overflow-y-auto max-h-[70vh]">
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
                  {/* Grid de KPIs */}
                  <div className="grid grid-cols-2 gap-3">
                    {[
                      { label: "Total de Contatos", value: metricsData.total_contatos, color: "text-foreground" },
                      { label: "Enviados", value: metricsData.total_enviados, color: "text-blue-500" },
                      { label: "Entregues", value: metricsData.total_entregues, color: "text-green-500" },
                      { label: "Lidos", value: metricsData.total_lidos, color: "text-purple-500" },
                      { label: "Respostas", value: metricsData.total_respostas, color: "text-orange-500" },
                      { label: "Blacklist", value: metricsData.total_blacklist, color: "text-yellow-500" },
                      { label: "Erros", value: metricsData.total_erros, color: "text-red-500" },
                      {
                        label: "Tempo Médio Resposta",
                        value: formatResponseTime(metricsData.tempo_medio_resposta),
                        color: "text-foreground",
                      },
                    ].map(({ label, value, color }) => (
                      <div
                        key={label}
                        className="rounded-lg border border-border bg-muted/20 p-3 text-center"
                      >
                        <p className={`text-xl font-bold ${color}`}>{value}</p>
                        <p className="text-[11px] text-muted-foreground mt-0.5">{label}</p>
                      </div>
                    ))}
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
    </div>
  );
}