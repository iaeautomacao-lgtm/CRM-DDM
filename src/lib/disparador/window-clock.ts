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

/**
 * Soma quanto de um intervalo de relógio comum caiu dentro da janela real
 * de envio. É o inverso conceitual de addOpenWindowTime: em vez de avançar
 * N ms de tempo aberto, mede quantos ms abertos existem entre dois
 * instantes.
 *
 * Usado nas métricas de campanha para que "tempo efetivo de disparo" não
 * conte noite, fim de semana ou outro período em que o motor não poderia
 * enviar. Configuração inválida de dias segue a mesma tolerância de
 * addOpenWindowTime e cai para relógio comum.
 */
export function openWindowDurationMs(
  from: Date,
  to: Date,
  janela: SendWindowConfig
): number {
  const start = from.getTime();
  const end = to.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;

  const intervals = openIntervals(janela);
  const days = allowedDays(janela);
  if (days && days.size === 0) return end - start;

  let total = 0;
  let dayStart = brasiliaDayStart(start);
  for (let i = 0; i < MAX_DAYS && dayStart < end; i++, dayStart += DAY_MS) {
    for (const [segStart, segEnd] of daySegments(dayStart, intervals, days)) {
      const overlapStart = Math.max(start, segStart);
      const overlapEnd = Math.min(end, segEnd);
      if (overlapEnd > overlapStart) total += overlapEnd - overlapStart;
    }
  }
  return total;
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

/** Passo máximo entre itens de uma rodada (rodadas pequenas: igual a antes). */
export const ROUND_STEP_MS = 100;
/** Espalhamento máximo de uma rodada inteira, qualquer que seja o tamanho. */
export const ROUND_MAX_SPREAD_MS = 2000;
/**
 * Espaço entre mensagens da sequência de um mesmo contato. 7 s (era 3 s): a
 * Meta aceita ~1 mensagem a cada 6 s para o mesmo usuário (erro 131056,
 * limite por par de usuários); 3 s gerava 131056 em sequências de 2+
 * templates.
 */
export const INTRA_CONTACT_MS = 7000;

/**
 * Deslocamento do item `position` (0-based) numa rodada de `roundSize`
 * contatos, somado ao horário da rodada.
 *
 * Antes era 100 ms × posição: no "Imediato" (rodada única) uma base de 50 mil
 * só vencia inteira depois de ~83 min, segurando o envio por mais vagas que
 * o motor tivesse. Agora a rodada inteira vence em no máximo 2 s; o ritmo
 * vem das vagas do motor (max_in_flight por número, concorrência do
 * processo, limite_por_hora, rodadas do Segmentado), não do agendamento.
 *
 * O pequeno espalhamento (monótono, < 2 s) não é para espaçar envio: mantém
 * os empates de scheduled_at pequenos (≈ roundSize/2000 itens por
 * milissegundo), então o ORDER BY (scheduled_at, id) do cron continua barato
 * no índice (campaign_id, status, scheduled_at), e garante que todas as 1ªs
 * mensagens da rodada vencem antes de qualquer 2ª mensagem de sequência
 * (que fica INTRA_CONTACT_MS = 7 s depois da anterior do mesmo contato).
 */
export function roundSpreadOffsetMs(position: number, roundSize: number): number {
  const size = Math.max(1, Math.floor(roundSize));
  const pos = Math.min(Math.max(0, Math.floor(position)), size - 1);
  const step = Math.min(ROUND_STEP_MS, ROUND_MAX_SPREAD_MS / size);
  return Math.min(ROUND_MAX_SPREAD_MS - 1, Math.floor(pos * step));
}

/**
 * Horário (ms) da 1ª mensagem do contato `index` (0-based, na ordem da fila)
 * de uma campanha em lote/"Segmentado"/"Imediato" com `total` contatos:
 * horário da rodada Math.floor(index / batchSize) + roundSpreadOffsetMs.
 * Mensagens seguintes da sequência do contato: + j × INTRA_CONTACT_MS.
 * Usado pelo startCampaign e pelo reflow (mesma regra nos dois).
 */
export function roundContactTimeMs(
  roundTimes: readonly Date[],
  index: number,
  batchSize: number,
  total: number
): number {
  const size = Math.max(1, Math.floor(batchSize));
  const round = Math.floor(index / size);
  const roundSize = Math.min(size, Math.max(1, total - round * size));
  return roundTimes[round].getTime() + roundSpreadOffsetMs(index % size, roundSize);
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
 *   rodada saem em início + espalhamento (< 2 s; filas antigas: 100 ms ×
 *   posição) + 7 s·mensagem (startCampaign), então uma rodada às 17:59 pode
 *   ter itens um pouco depois das 18:00. `spillToleranceMs` cobre esse
 *   espalhamento.
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
