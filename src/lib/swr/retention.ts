// Teto de memória do cache SWR (LGPD/minimização): sem limite, chaves que variam (página, filtro, busca) acumulam respostas
// com dado pessoal enquanto a aba estiver aberta. Cada hook declara quantas entradas do mesmo nome ficam (LRU) e, se quiser,
// quantos "grupos" (ex.: a busca atual e a última) — o que passa disso é apagado do cache. clearSwrCache() zera tudo.

export interface Retention {
  /** Máximo de entradas por nome (páginas, filtros...). A mais antiga sai primeiro. */
  maxEntries: number;
  /** Agrupa entradas (ex.: token da busca). Com `maxGroups`, só os grupos mais recentes ficam. */
  group?: string;
  maxGroups?: number;
}

/** Teto padrão por nome: nenhuma chave futura cresce sem limite, mesmo que o autor esqueça de declarar. */
export const DEFAULT_MAX_ENTRIES = 30;

interface Entry {
  cacheKey: string;
  group: string;
}

type Store = { delete(key: string): unknown };

const registry = new Map<string, Entry[]>();

/** Marca a chave como a mais recente do nome e apaga do cache o que passou dos tetos. Devolve as chaves apagadas. */
export function touchRetained(store: Store, name: string, cacheKey: string, retention: Retention): string[] {
  const group = retention.group ?? "";
  const entries = (registry.get(name) ?? []).filter((e) => e.cacheKey !== cacheKey);
  entries.push({ cacheKey, group });

  const evicted: string[] = [];
  const drop = (e: Entry) => {
    store.delete(e.cacheKey);
    evicted.push(e.cacheKey);
  };

  let kept = entries;
  if (retention.maxGroups !== undefined) {
    // Grupos por recência da última entrada (o mais novo por último).
    const groups: string[] = [];
    for (const e of entries) {
      const i = groups.indexOf(e.group);
      if (i >= 0) groups.splice(i, 1);
      groups.push(e.group);
    }
    const allowed = new Set(groups.slice(-Math.max(1, retention.maxGroups)));
    kept = entries.filter((e) => {
      if (allowed.has(e.group)) return true;
      drop(e);
      return false;
    });
  }
  while (kept.length > Math.max(1, retention.maxEntries)) {
    const oldest = kept.shift();
    if (oldest) drop(oldest);
  }
  registry.set(name, kept);
  return evicted;
}

/** A chave ainda é uma das retidas do nome? (resposta que chega depois de a chave sair do teto é descartada). */
export function isRetained(name: string, cacheKey: string): boolean {
  return (registry.get(name) ?? []).some((e) => e.cacheKey === cacheKey);
}

/** Esquece o controle (junto com clearSwrCache). */
export function clearRetention(): void {
  registry.clear();
}

/** Só para testes e diagnóstico. */
export function retainedCount(name?: string): number {
  if (name) return registry.get(name)?.length ?? 0;
  let n = 0;
  for (const v of registry.values()) n += v.length;
  return n;
}
