// Janela de horário de envio das campanhas (fuso de Brasília) — regra
// única usada pelo cron, pelo envio do item e pelo worker.
//
// Antes: o cron e o envio aplicavam regras diferentes (o envio ignorava a
// janela se começasse 00:00 ou terminasse 23:59), uma janela que cruza a
// meia-noite (ex.: 20:00–02:00) nunca enviava, e fora da janela o item era
// sempre adiado para "amanhã" — mesmo às 6h com a janela abrindo às 8h de
// hoje.

const BR_OFFSET_HOURS = 3; // America/Sao_Paulo = UTC-3 fixo (sem horário de verão desde 2019)

/** "08:30" → 510; null se vazio/inválido. */
export function parseHHMM(value: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((value ?? "").trim());
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
