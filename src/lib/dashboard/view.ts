// Cálculos de apresentação do Dashboard (puros, testáveis). Nada aqui
// busca dado: só transforma o que vem de queries.ts para a tela.

export type DeltaTone = 'up-good' | 'up-bad' | 'down-good' | 'down-bad' | 'flat'

/**
 * Direção e leitura de uma variação. `higherIsBetter` diz se subir é bom
 * (resolvidas) ou ruim (pendentes, tempo de resposta).
 */
export function deltaTone(delta: number, higherIsBetter: boolean): DeltaTone {
  if (!Number.isFinite(delta) || delta === 0) return 'flat'
  if (delta > 0) return higherIsBetter ? 'up-good' : 'up-bad'
  return higherIsBetter ? 'down-bad' : 'down-good'
}

/** "+14", "−3", "0" (sinal de menos tipográfico, separador pt-BR). */
export function formatDelta(delta: number): string {
  if (!Number.isFinite(delta) || delta === 0) return '0'
  const abs = Math.abs(delta).toLocaleString('pt-BR')
  return delta > 0 ? `+${abs}` : `−${abs}`
}

/** Minutos → "3m 42s", "45s", "1h 05m"; null → "—". */
export function formatMinutes(mins: number | null): string {
  if (mins == null || !Number.isFinite(mins)) return '—'
  const totalSec = Math.max(0, Math.round(mins * 60))
  if (totalSec < 60) return `${totalSec}s`
  const totalMin = Math.floor(totalSec / 60)
  if (totalMin < 60) {
    const s = totalSec % 60
    return s === 0 ? `${totalMin}m` : `${totalMin}m ${String(s).padStart(2, '0')}s`
  }
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return `${h}h ${String(m).padStart(2, '0')}m`
}

/** Tempo relativo curto do feed: "agora", "6 min", "2 h", "3 d". */
export function relativeShort(iso: string, nowMs: number = Date.now()): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return '—'
  const mins = Math.floor((nowMs - t) / 60_000)
  if (mins < 1) return 'agora'
  if (mins < 60) return `${mins} min`
  const h = Math.floor(mins / 60)
  if (h < 24) return `${h} h`
  return `${Math.floor(h / 24)} d`
}

/** "Atualizado agora" / "há N min" a partir do instante da última carga. */
export function updatedLabel(updatedAtMs: number, nowMs: number): string {
  const mins = Math.max(0, Math.floor((nowMs - updatedAtMs) / 60_000))
  return mins < 1 ? 'agora' : `há ${mins} min`
}

/** Percentual inteiro seguro (0 quando o total é 0). */
export function pct(part: number, total: number): number {
  if (!total || total <= 0) return 0
  return Math.round((part / total) * 100)
}

/**
 * Topo "redondo" do eixo Y para o maior valor: 1, 2, 2,5 ou 5 × 10^n,
 * sempre ≥ max. Zero vira 4 (para o eixo ter 4 divisões inteiras).
 */
export function niceAxisTop(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 4
  const exp = Math.pow(10, Math.floor(Math.log10(max)))
  for (const step of [1, 2, 2.5, 5, 10]) {
    const top = step * exp
    if (top >= max) return top
  }
  return 10 * exp
}

/** Índices dos rótulos do eixo X por período (primeiro e último sempre). */
export function xLabelIndexes(length: number): number[] {
  if (length <= 0) return []
  if (length <= 7) return Array.from({ length }, (_, i) => i)
  const last = length - 1
  const out = [0, Math.round(last * 0.25), Math.round(last * 0.5), Math.round(last * 0.75), last]
  return Array.from(new Set(out))
}

const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']

/** "2026-10-08" → "08 out" (sem fuso: a chave já é o dia local). */
export function dayKeyLabel(key: string): string {
  const [, m, d] = key.split('-')
  const month = MONTHS[Number(m) - 1]
  return month && d ? `${d} ${month}` : key
}
