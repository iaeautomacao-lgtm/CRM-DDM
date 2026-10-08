// Janela de horário de envio das campanhas (fuso de Brasília) — regra
// única usada pelo cron, pelo envio do item e pelo worker.
//
// Antes: o cron e o envio aplicavam regras diferentes (o envio ignorava a
// janela se começasse 00:00 ou terminasse 23:59), uma janela que cruza a
// meia-noite (ex.: 20:00–02:00) nunca enviava, e fora da janela o item era
// sempre adiado para "amanhã" — mesmo às 6h com a janela abrindo às 8h de
// hoje.

const BR_OFFSET_HOURS = 3; // America/Sao_Paulo = UTC-3 fixo (sem horário de verão desde 2019)

/**
 * "08:30" → 510; null se vazio/inválido. Aceita também "08:30:00": coluna
 * do tipo time no Postgres volta com segundos — antes isso virava null e a
 * janela era ignorada em silêncio (envio a qualquer hora).
 */
export function parseHHMM(value: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec((value ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Minutos desde 00:00 em Brasília. */
export function brasiliaMinutes(now: Date = new Date()): number {
  const utc = now.getUTCHours() * 60 + now.getUTCMinutes();
  return (utc - BR_OFFSET_HOURS * 60 + 24 * 60) % (24 * 60);
}

/**
 * Dentro da janela? Sem janela (ou inválida) = sempre. Início igual ao fim
 * = dia inteiro. Início depois do fim = cruza a meia-noite.
 */
export function isWithinSendWindow(
  inicio: string | null | undefined,
  fim: string | null | undefined,
  now: Date = new Date(),
): boolean {
  const start = parseHHMM(inicio);
  const end = parseHHMM(fim);
  if (start === null || end === null || start === end) return true;
  const cur = brasiliaMinutes(now);
  if (start < end) return cur >= start && cur <= end;
  return cur >= start || cur <= end;
}

/**
 * Próxima abertura da janela a partir de agora: hoje, se o início ainda
 * não chegou; senão amanhã.
 */
export function nextWindowStart(inicio: string, now: Date = new Date()): Date {
  const start = parseHHMM(inicio) ?? 0;
  const cur = brasiliaMinutes(now);
  const deltaMin = start > cur ? start - cur : 24 * 60 - cur + start;
  const next = new Date(now.getTime() + deltaMin * 60_000);
  next.setUTCSeconds(0, 0);
  return next;
}

// ---- Dias da semana (campaigns.dias_envio, migration 144) ----
// 0 = domingo … 6 = sábado, no fuso de Brasília. Vazio/null = todos.

export const WEEKDAY_LABELS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"] as const;

export function brasiliaWeekday(now: Date = new Date()): number {
  return new Date(now.getTime() - BR_OFFSET_HOURS * 3_600_000).getUTCDay();
}

export function isAllowedDay(dias: number[] | null | undefined, now: Date = new Date()): boolean {
  if (!dias || dias.length === 0) return true;
  return dias.includes(brasiliaWeekday(now));
}

/** Pode enviar agora? Dia permitido E dentro da janela de horário. */
export function canSendNow(
  janela: { inicio?: string | null; fim?: string | null; dias?: number[] | null },
  now: Date = new Date(),
): boolean {
  return isAllowedDay(janela.dias, now) && isWithinSendWindow(janela.inicio, janela.fim, now);
}

/** Próxima meia-noite de Brasília depois de `now`. */
function nextBrasiliaMidnight(now: Date): Date {
  const mins = brasiliaMinutes(now);
  const next = new Date(now.getTime() + (24 * 60 - mins) * 60_000);
  next.setUTCSeconds(0, 0);
  return next;
}

/**
 * Próximo momento em que a campanha pode enviar: respeita a janela de
 * horário e pula os dias não permitidos (ex.: sábado/domingo).
 */
export function nextSendSlot(
  janela: { inicio?: string | null; fim?: string | null; dias?: number[] | null },
  now: Date = new Date(),
): Date {
  const hasWindow = parseHHMM(janela.inicio) !== null && parseHHMM(janela.fim) !== null && janela.inicio !== janela.fim;
  let candidate = isWithinSendWindow(janela.inicio, janela.fim, now) || !hasWindow ? now : nextWindowStart(janela.inicio!, now);
  for (let i = 0; i < 8 && !isAllowedDay(janela.dias, candidate); i++) {
    const midnight = nextBrasiliaMidnight(candidate);
    candidate = hasWindow && !isWithinSendWindow(janela.inicio, janela.fim, midnight)
      ? nextWindowStart(janela.inicio!, midnight)
      : midnight;
  }
  return candidate;
}

// ---- Agendamento (campaigns.agendamento) ----
// O assistente usa <input type="datetime-local">, que não carrega fuso.
// Antes, new Date(valor) usava o fuso do NAVEGADOR — um operador com o
// sistema fora de Brasília agendava horas antes/depois do que a tela dizia
// ("Horário de Brasília"). Mesma premissa de UTC-3 fixo usada acima.

/** "2026-10-06T14:30" (horário de Brasília) → ISO UTC; null se inválido. */
export function brasiliaLocalToIso(local: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec((local ?? "").trim());
  if (!m) return null;
  const date = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? "00"}-03:00`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Instante → "06/10/2026, 14:30" no horário de Brasília. */
export function formatBrasilia(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
