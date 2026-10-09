// F12 (PRD 11): token expirado = milhares de itens com o MESMO erro por minuto → uma rajada de INSERT em system_logs. O log por item
// passa por aqui: 1 registro por (campanha, evento, código) por janela; o que foi suprimido é contado e entra no próximo registro
// ("suppressed"). Estado em memória do processo (só reduz ruído; reiniciar apenas reabre a janela — nada depende dele).
export const LOG_THROTTLE_WINDOW_MS = 60_000;
const MAX_KEYS = 2_000;

const state = new Map<string, { windowStart: number; suppressed: number }>();

/** Devolve `{ log: true, suppressed }` quando deve gravar (suppressed = quantos foram omitidos na janela anterior) e `{ log: false }` quando já gravou nesta janela. */
export function throttleItemLog(
  campaignId: string,
  event: string,
  code: string | number | null | undefined,
  now: number = Date.now(),
): { log: true; suppressed: number } | { log: false } {
  const key = `${campaignId}|${event}|${code ?? ""}`;
  const cur = state.get(key);
  if (cur && now - cur.windowStart < LOG_THROTTLE_WINDOW_MS) {
    cur.suppressed++;
    return { log: false };
  }
  if (state.size >= MAX_KEYS) state.clear();
  state.set(key, { windowStart: now, suppressed: 0 });
  return { log: true, suppressed: cur?.suppressed ?? 0 };
}

export function resetLogThrottleForTests() {
  state.clear();
}
