// "Relógio de janela" do disparador: o tempo só anda dentro da janela de
// envio (campaigns.janela_inicio/fim) e nos dias permitidos
// (campaigns.dias_envio), no fuso de Brasília (UTC-3 fixo, mesma premissa de
// send-window.ts). Funções puras.
//
// Por quê: as rodadas de uma campanha em lote/"Segmentado" eram agendadas em
// início + k·pausa no relógio comum. As rodadas que caíam fora da janela
// (ex.: depois das 18:00, ou no fim de semana) ficavam todas vencidas ao
// mesmo tempo e saíam juntas na abertura seguinte — uma rajada. Regra do
// negócio: "o disparo que passar do horário continua no próximo dia útil
// disponível, no mesmo intervalo de horário, mantendo o ritmo".
//
// Ex.: janela 08:00–18:00, pausa de 30 min, rodada às 17:45 → próxima às
// 08:15 do próximo dia permitido (os 15 min que faltavam da pausa são
// contados depois da abertura), não às 18:15.
//
// O fim da janela é EXCLUSIVO no relógio (18:00 já é fechado): nenhuma
// rodada é agendada no último minuto. canSendNow (send-window.ts) continua
// aceitando envio até 18:00:59 — a diferença só deixa o relógio do lado
// seguro.
//
// Também é a base para a estimativa de término no assistente (V2): simular
// itens/rodadas com scheduleRounds a partir do agendamento dá a mesma data
// que o startCampaign vai gravar.

import { canSendNow, parseHHMM } from "@/lib/disparador/send-window";

export interface SendWindowConfig {
  inicio?: string | null;
  fim?: string | null;
  dias?: number[] | null;
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const BR_OFFSET_MS = 3 * 60 * MINUTE_MS; // America/Sao_Paulo = UTC-3 fixo
/** Limite de dias percorridos (proteção contra configuração sem tempo aberto). */
const MAX_DAYS = 400;

/** Intervalos abertos [início, fim) em minutos do dia de Brasília. */
function openIntervals(janela: SendWindowConfig): Array<[number, number]> {
  const start = parseHHMM(janela.inicio);
  const end = parseHHMM(janela.fim);
  if (start === null || end === null || start === end) return [[0, 24 * 60]];
  if (start < end) return [[start, end]];
  // Cruza a meia-noite: a madrugada pertence ao dia (da semana) em que cai,
  // igual a canSendNow.
  return [
    [0, end],
    [start, 24 * 60],
  ];
}

function allowedDays(janela: SendWindowConfig): Set<number> | null {
  const dias = janela.dias;
  if (!dias || dias.length === 0) return null; // todos
  return new Set(dias.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6));
}

/** Instante UTC da meia-noite de Brasília do dia que contém `ms`. */
function brasiliaDayStart(ms: number): number {
  return Math.floor((ms - BR_OFFSET_MS) / DAY_MS) * DAY_MS + BR_OFFSET_MS;
}

function weekdayOf(dayStartUtc: number): number {
  return new Date(dayStartUtc - BR_OFFSET_MS).getUTCDay();
}

/** Segmentos abertos [ini, fim) (ms UTC) do dia de Brasília que começa em dayStart. */
function daySegments(dayStart: number, intervals: Array<[number, number]>, days: Set<number> | null) {
  if (days && !days.has(weekdayOf(dayStart))) return [];
  return intervals.map(([a, b]) => [dayStart + a * MINUTE_MS, dayStart + b * MINUTE_MS] as const);
}

/**
 * Avança `ms` de tempo ABERTO a partir de `from`. Com ms=0 devolve o
 * primeiro instante aberto ≥ from (o próprio `from` se já estiver aberto).
 * Sem nenhum dia/horário aberto possível, cai no relógio comum.
 */
export function addOpenWindowTime(from: Date, ms: number, janela: SendWindowConfig): Date {
  const intervals = openIntervals(janela);
  const days = allowedDays(janela);
  let remaining = Math.max(0, ms);
  if (days && days.size === 0) return new Date(from.getTime() + remaining);

  let cursor = from.getTime();
  let dayStart = brasiliaDayStart(cursor);
  for (let i = 0; i < MAX_DAYS; i++) {
    for (const [segStartRaw, segEnd] of daySegments(dayStart, intervals, days)) {
      const segStart = Math.max(cursor, segStartRaw);
      if (segStart >= segEnd) continue;
      const available = segEnd - segStart;
      // Estritamente menor: o instante devolvido fica DENTRO do segmento.
      if (remaining < available) return new Date(segStart + remaining);
      remaining -= available;
      cursor = segEnd;
    }
    dayStart += DAY_MS;
    cursor = Math.max(cursor, dayStart);
  }
  return new Date(cursor + remaining);
}

/** O instante está em tempo aberto do relógio de janela? */
export function isOpenWindowTime(at: Date, janela: SendWindowConfig): boolean {
  return addOpenWindowTime(at, 0, janela).getTime() === at.getTime();
}

/**
 * Último fechamento da janela em ou antes de `at` (fim do último segmento
 * aberto que terminou até `at`). Null se não houver nos últimos MAX_DAYS.
 */
export function lastWindowClose(at: Date, janela: SendWindowConfig): Date | null {
  const intervals = openIntervals(janela);
  const days = allowedDays(janela);
  if (days && days.size === 0) return null;
  const t = at.getTime();
  let dayStart = brasiliaDayStart(t);
  for (let i = 0; i < MAX_DAYS; i++) {
    const ends = daySegments(dayStart, intervals, days)
      .map(([, end]) => end)
      .filter((end) => end <= t);
    if (ends.length > 0) return new Date(Math.max(...ends));
    dayStart -= DAY_MS;
  }
  return null;
}

/**
 * Horário de cada rodada de uma campanha em lote/"Segmentado": a 1ª na
 * primeira abertura ≥ start, as seguintes `pauseSeconds` de tempo ABERTO
 * depois da anterior. Pausa 0 = todas juntas (comportamento de sempre).
 */
export function scheduleRounds(
  start: Date,
  roundCount: number,
  pauseSeconds: number,
  janela: SendWindowConfig
): Date[] {
  const rounds: Date[] = [];
  if (roundCount <= 0) return rounds;
  const pauseMs = Math.max(0, pauseSeconds) * 1000;
  let current = addOpenWindowTime(start, 0, janela);
  for (let k = 0; k < roundCount; k++) {
    rounds.push(current);
    if (k < roundCount - 1) current = pauseMs > 0 ? addOpenWindowTime(current, pauseMs, janela) : current;
  }
  return rounds;
}

/**
 * O item foi agendado num período FECHADO da janela (fila montada antes do
 * relógio de janela — ex.: uma rodada a cada 30 min atravessando a noite e
 * o fim de semana —, retomada, mudança de janela…)? Usado pelo cron para
 * decidir se a fila de uma campanha em lote precisa ser redistribuída
 * (queue-reflow.ts).
 *
 * Antes (PR #75) cada item desses era empurrado para "abertura + o quanto
 * ele estava depois do fechamento", contado no relógio de janela. Numa fila
 * antiga isso transformava o período fechado inteiro em espera: janela
 * 08–18 seg–sex, item de segunda 07:45 → terça da semana seguinte, enquanto
 * o de segunda 08:00 saía na hora (ordem invertida).
 *
 * Não conta como inconsistente:
 * - horário aberto, ou aceito pela regra de envio (canSendNow, fim
 *   inclusivo até HH:MM:59);
 * - "transbordo" de uma rodada iniciada antes do fechamento: os itens da
 *   rodada saem em início + 100 ms·posição + 3 s·mensagem (startCampaign),
 *   então uma rodada às 17:59 pode ter itens um pouco depois das 18:00.
 *   `spillToleranceMs` cobre esse espalhamento.
 */
export function isScheduledInClosedWindow(
  scheduledAt: Date,
  janela: SendWindowConfig,
  spillToleranceMs: number
): boolean {
  if (Number.isNaN(scheduledAt.getTime())) return false;
  if (isOpenWindowTime(scheduledAt, janela) || canSendNow(janela, scheduledAt)) return false;
  const closedAt = lastWindowClose(scheduledAt, janela);
  if (closedAt && scheduledAt.getTime() - closedAt.getTime() <= Math.max(0, spillToleranceMs)) return false;
  return true;
}
