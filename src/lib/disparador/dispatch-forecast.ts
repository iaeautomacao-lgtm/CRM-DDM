// Previsão de término de uma campanha do disparador — função pura usada
// pelo assistente "Nova campanha" (passo Configurações e Revisão) e pelos
// cards da lista. Não muda nada no motor: só simula o que ele faz.
//
// O motor atual é por número em paralelo (throughput-config.ts,
// dispatch-scheduler.ts):
//   - O cron roda 1× por minuto.
//   - Cada número tem concorrência configurada (slots = min(per_number, global))
//     e orçamento de envio (budgetSeconds, padrão 35 s).
//   - A vazão real por número é calculada a partir da latência medida:
//     envios/min por número = slots ÷ latência × budget(s).
//   - Fora da janela/dia permitido o cron pula a campanha: o tempo da fila
//     só anda com a janela aberta (relógio de janela).
//   - "Imediato" = um lote só (batch_size enorme, sem pausa): tudo vence no
//     início e sai no ritmo do cron.
//   - "Segmentado" = rodadas de ceil(base × %) contatos, espaçadas por
//     `pausa` de tempo ABERTO (scheduleRounds). Uma rodada maior do que o
//     cron consegue mandar num minuto continua nos ticks seguintes; se ela
//     demorar mais que a pausa, a próxima rodada fica na fila atrás dela.
//
// Para várias contas no mesmo número a previsão é por campanha isolada
// (outras campanhas no mesmo número dividem o ritmo). Feriados não são considerados.

import { addOpenWindowTime, scheduleRounds, type SendWindowConfig } from "@/lib/disparador/window-clock";

/** Intervalo do cron externo (crontab, 1×/min). */
export const CRON_TICK_MS = 60_000;
/** Orçamento de envio por tick padrão: deadline de 40 s menos 5 s de folga (cron/route.ts). */
export const CRON_SEND_BUDGET_SECONDS = 35;
/** Concorrência padrão de envios por número (claim_dispatch_item default). */
export const CRON_SEND_CONCURRENCY = 4;
/** Segundos por envio padrão (quando não há telemetria recente): Meta (0,85s) e WAHA (2s). */
export const SEND_SECONDS_PER_ITEM = { otimista: 0.85, conservador: 2 } as const;
/** batch_size gravado no modo Imediato (um lote só). */
export const IMEDIATO_BATCH_SIZE = 999_999;

export interface ThroughputRateConfig {
  slots?: number;
  budgetSeconds?: number;
}

/**
 * Calcula a vazão teórica em envios/min por número:
 * envios/min = slots ÷ latência × budget(s)
 */
export function calculateThroughputPerMinute(
  slots: number,
  latencySeconds: number,
  budgetSeconds: number
): number {
  if (slots <= 0 || latencySeconds <= 0 || budgetSeconds <= 0) return 0;
  return (slots / latencySeconds) * budgetSeconds;
}

/**
 * Itens por minuto que o cron consegue enviar para UMA campanha no número,
 * dado o limite de candidatos e o tempo de resposta medido. Fracionário
 * quando há limite_por_hora baixo (ex.: 30/h = 0,5/min).
 */
export function cronItemsPerMinute(
  candidateLimit: number,
  secondsPerItem: number,
  hourlyLimit?: number | null,
  throughput?: ThroughputRateConfig
): number {
  const slots = throughput?.slots ?? CRON_SEND_CONCURRENCY;
  const budget = throughput?.budgetSeconds ?? CRON_SEND_BUDGET_SECONDS;
  const byTime = Math.floor(calculateThroughputPerMinute(slots, Math.max(0.05, secondsPerItem), budget));
  let perMinute = Math.max(1, Math.min(Math.max(1, candidateLimit), byTime));
  if (hourlyLimit != null && hourlyLimit > 0) perMinute = Math.min(perMinute, hourlyLimit / 60);
  return perMinute;
}

export type ForecastDispatch =
  | { mode: "imediato" }
  | { mode: "segmentado"; percent: number; pauseMinutes: number }
  /** Lote de tamanho fixo (campanhas antigas "Personalizado"/sequenciais). */
  | { mode: "lote"; contactsPerRound: number; pauseMinutes: number };

export interface ForecastThroughputInput {
  /** Slots por número: min(per_number, global). Padrão = 4. */
  slots?: number;
  /** Orçamento de envio por tick em segundos. Padrão = 35. */
  budgetSeconds?: number;
  /** Latência em segundos por envio: otimista (ex: avg) e conservador (ex: p95). */
  latency?: {
    otimista: number;
    conservador: number;
  };
}

export interface ForecastInput {
  /** Contatos que vão receber (já sem duplicados/blacklist, quando conhecido). */
  contacts: number;
  /** Mensagens por contato (Padrão com sequência = N; Rotação/Aleatório = 1). */
  messagesPerContact: number;
  dispatch: ForecastDispatch;
  /** Agendamento (ou "agora" se a campanha for iniciada manualmente). */
  start: Date;
  janela: SendWindowConfig;
  /** campaigns.limite_por_hora, se configurado (não tem campo no assistente). */
  hourlyLimit?: number | null;
  /** Parâmetros do motor real (slots por número, orçamento, latência). */
  throughput?: ForecastThroughputInput;
}

export interface ForecastScenario {
  /** Itens por minuto considerados neste cenário. */
  perMinute: number;
  /** Fim estimado (último envio). */
  end: Date;
}

export interface ForecastResult {
  /** Itens da fila (contatos × mensagens por contato). */
  items: number;
  rounds: number;
  contactsPerRound: number;
  itemsPerRound: number;
  /** Primeiro instante com a janela aberta a partir do início. */
  firstSendAt: Date;
  /** Horário (no relógio de janela) da última rodada. */
  lastRoundAt: Date;
  otimista: ForecastScenario;
  conservador: ForecastScenario;
  /** Minutos para uma rodada cheia sair (otimista–conservador). */
  roundDrainMinutes: { min: number; max: number };
  /** Uma rodada demora mais que o intervalo: as rodadas encostam umas nas outras. */
  roundsOverlap: boolean;
  /** Rodada de 1 contato: o motor usa o envio sequencial (1 item por intervalo). */
  sequentialFallback: boolean;
  /** Vazão de referência em envios/min por número para exibição na UI. */
  ratePerMinute: number;
}

interface Plan {
  rounds: number;
  contactsPerRound: number;
  itemsPerRound: (k: number) => number;
  pauseSeconds: number;
  candidateLimit: number;
  sequentialFallback: boolean;
}

function plan(input: ForecastInput): Plan {
  const contacts = Math.max(0, Math.floor(input.contacts));
  const mpc = Math.max(1, Math.floor(input.messagesPerContact));
  if (input.dispatch.mode === "imediato") {
    return {
      rounds: contacts > 0 ? 1 : 0,
      contactsPerRound: contacts,
      itemsPerRound: () => contacts * mpc,
      pauseSeconds: 0,
      candidateLimit: IMEDIATO_BATCH_SIZE,
      sequentialFallback: false,
    };
  }
  const pauseSeconds = Math.max(0, input.dispatch.pauseMinutes) * 60;
  // Mesma conta do startCampaign: batch_size = ceil(contatos × % / 100).
  const perRound =
    input.dispatch.mode === "lote"
      ? Math.max(1, Math.floor(input.dispatch.contactsPerRound))
      : Math.max(1, Math.ceil((contacts * Math.min(100, Math.max(1, input.dispatch.percent))) / 100));
  if (perRound === 1) {
    // batch_size = 1: caminho sequencial do motor — reserve_campaign_tick
    // libera 1 item a cada intervalo (no mínimo 1 tick).
    return {
      rounds: contacts * mpc,
      contactsPerRound: 1,
      itemsPerRound: () => 1,
      pauseSeconds: Math.max(pauseSeconds, CRON_TICK_MS / 1000),
      candidateLimit: 1,
      sequentialFallback: true,
    };
  }
  const rounds = Math.ceil(contacts / perRound);
  return {
    rounds,
    contactsPerRound: perRound,
    itemsPerRound: (k) => Math.min(perRound, contacts - k * perRound) * mpc,
    pauseSeconds,
    candidateLimit: perRound,
    sequentialFallback: false,
  };
}

function simulate(p: Plan, times: Date[], perMinute: number, janela: SendWindowConfig): Date {
  let finish = times[0]?.getTime() ?? 0;
  for (let k = 0; k < times.length; k++) {
    const begin = new Date(Math.max(times[k].getTime(), finish));
    const minutes = Math.ceil(p.itemsPerRound(k) / perMinute);
    finish = addOpenWindowTime(begin, minutes * CRON_TICK_MS, janela).getTime();
  }
  return new Date(finish);
}

/** Previsão de término (faixa otimista–conservadora), no relógio de janela. */
export function forecastCampaign(input: ForecastInput): ForecastResult {
  const p = plan(input);
  const mpc = Math.max(1, Math.floor(input.messagesPerContact));
  const items = p.sequentialFallback ? p.rounds : Math.max(0, Math.floor(input.contacts)) * mpc;
  const firstSendAt = addOpenWindowTime(input.start, 0, input.janela);
  const times = scheduleRounds(input.start, p.rounds, p.pauseSeconds, input.janela);

  const slots = input.throughput?.slots ?? CRON_SEND_CONCURRENCY;
  const budgetSeconds = input.throughput?.budgetSeconds ?? CRON_SEND_BUDGET_SECONDS;
  const secOtimista = input.throughput?.latency?.otimista ?? SEND_SECONDS_PER_ITEM.otimista;
  const secConservador = input.throughput?.latency?.conservador ?? SEND_SECONDS_PER_ITEM.conservador;

  const perMinOtimista = cronItemsPerMinute(p.candidateLimit, secOtimista, input.hourlyLimit, { slots, budgetSeconds });
  const perMinConservador = cronItemsPerMinute(p.candidateLimit, secConservador, input.hourlyLimit, { slots, budgetSeconds });
  const fullRound = p.itemsPerRound(0);
  const drainMin = Math.ceil(fullRound / perMinOtimista);
  const drainMax = Math.ceil(fullRound / perMinConservador);

  return {
    items,
    rounds: p.rounds,
    contactsPerRound: p.contactsPerRound,
    itemsPerRound: fullRound,
    firstSendAt,
    lastRoundAt: times[times.length - 1] ?? firstSendAt,
    otimista: {
      perMinute: perMinOtimista,
      end: times.length ? simulate(p, times, perMinOtimista, input.janela) : firstSendAt,
    },
    conservador: {
      perMinute: perMinConservador,
      end: times.length ? simulate(p, times, perMinConservador, input.janela) : firstSendAt,
    },
    roundDrainMinutes: { min: drainMin, max: drainMax },
    roundsOverlap: p.rounds > 1 && p.pauseSeconds > 0 && drainMax * 60 > p.pauseSeconds,
    sequentialFallback: p.sequentialFallback,
    ratePerMinute: Math.round(calculateThroughputPerMinute(slots, secOtimista, budgetSeconds)),
  };
}

/**
 * Previsão a partir das colunas de uma campanha salva (cards da lista).
 * batch_percent → Segmentado; batch_size > 1 sem pausa → Imediato; demais
 * ("Personalizado" em lote, Balanceado/Cauteloso com batch_size = 1) → lote
 * fixo. O sequencial sai ~1 contato por minuto; as pausas anti-spam de
 * 10 min/1 h desses modos antigos não entram (a previsão fica otimista).
 */
export function forecastFromCampaign(
  campaign: {
    batch_size?: number | null;
    batch_pause_seconds?: number | null;
    batch_percent?: number | null;
    janela_inicio?: string | null;
    janela_fim?: string | null;
    dias_envio?: number[] | null;
    limite_por_hora?: number | null;
  },
  contacts: number,
  messagesPerContactValue: number,
  start: Date,
  throughput?: ForecastThroughputInput
): ForecastResult {
  const janela = { inicio: campaign.janela_inicio, fim: campaign.janela_fim, dias: campaign.dias_envio };
  const pauseMinutes = Math.max(0, campaign.batch_pause_seconds ?? 0) / 60;
  const batchSize = Math.max(1, campaign.batch_size ?? 1);
  const dispatch: ForecastDispatch =
    campaign.batch_percent != null && campaign.batch_percent > 0
      ? { mode: "segmentado", percent: campaign.batch_percent, pauseMinutes }
      : batchSize > 1 && pauseMinutes === 0
        ? { mode: "imediato" }
        : {
            mode: "lote",
            contactsPerRound: batchSize,
            pauseMinutes: batchSize > 1 ? pauseMinutes : Math.max(1, pauseMinutes),
          };
  return forecastCampaign({
    contacts,
    messagesPerContact: messagesPerContactValue,
    dispatch,
    start,
    janela,
    hourlyLimit: campaign.limite_por_hora ?? null,
    throughput,
  });
}
