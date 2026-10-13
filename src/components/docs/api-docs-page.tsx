'use client';

// Página pública /docs/api (fora do dashboard, claro/escuro pelo sistema com troca manual).
// Uma página só: navegação lateral fixa com busca e grupos de rotas, "Comece aqui", um bloco por rota e
// "Erros e limites". Cada seção e cada rota tem âncora (#id) para link direto.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Menu, Moon, Search, Sun, X } from 'lucide-react';

import { OmniDdmLogo } from '@/components/ui/omniddm-logo';
import { useTheme } from '@/hooks/use-theme';
import { cn } from '@/lib/utils';
import type { GuideExamples } from '@/lib/api/v1/docs-guide';
import type { ReferenceModel } from '@/lib/api/v1/docs-reference';
import { ErrorsSection, GroupNotes, IntroSection } from './api-guide';
import { MethodBadge, ReferenceGroup } from './api-reference';

interface NavRoute {
  id: string;
  method: string;
  path: string;
  summary: string;
}
interface NavGroup {
  id: string;
  name: string;
  routes: NavRoute[];
}

const normalize = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/** Id da seção/rota visível mais acima na tela (destaque do item ativo na navegação). */
function useActiveId(ids: string[]): string {
  const [active, setActive] = useState('comece');
  const key = ids.join('|');
  useEffect(() => {
    const elements = key
      .split('|')
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (elements.length === 0 || typeof IntersectionObserver === 'undefined') return;
    const visible = new Set<string>();
    const order = elements.map((el) => el.id);
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target.id);
          else visible.delete(e.target.id);
        }
        const first = order.find((id) => visible.has(id));
        if (first) setActive(first);
      },
      { rootMargin: '-90px 0px -60% 0px' },
    );
    elements.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [key]);
  return active;
}

function DocsNav({ groups, query, onQuery, activeId, onNavigate }: { groups: NavGroup[]; query: string; onQuery: (q: string) => void; activeId: string; onNavigate?: () => void }) {
  const q = normalize(query.trim());
  const filtered = useMemo(
    () =>
      groups
        .map((g) => ({
          ...g,
          routes: q ? g.routes.filter((r) => normalize(`${r.method} ${r.path} ${r.summary} ${r.id} ${g.name}`).includes(q)) : g.routes,
        }))
        .filter((g) => g.routes.length > 0),
    [groups, q],
  );
  const first = filtered[0]?.routes[0];

  const item = (href: string, active: boolean, children: ReactNode) => (
    <a
      href={href}
      onClick={onNavigate}
      aria-current={active ? 'location' : undefined}
      className={cn(
        'flex items-center gap-2 rounded-full px-3 py-1.5 text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        active ? 'bg-primary-soft font-semibold text-primary-text' : 'text-foreground-2 hover:bg-surface-hover hover:text-foreground',
      )}
    >
      {children}
    </a>
  );

  return (
    <nav aria-label="Navegação da documentação" className="space-y-4">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && first) {
              window.location.hash = first.id;
              onNavigate?.();
            }
          }}
          placeholder="Buscar rota, método ou campo"
          aria-label="Buscar na documentação"
          className="h-10 w-full rounded-full border border-border bg-card pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        />
      </div>

      {!q && (
        <div className="space-y-0.5">
          <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Começar</p>
          {item('#comece', activeId === 'comece', 'Comece aqui')}
          {item('#erros', activeId === 'erros', 'Erros e limites')}
        </div>
      )}

      {filtered.length === 0 && <p className="px-3 text-sm text-muted-foreground">Nenhuma rota encontrada para “{query}”.</p>}

      {filtered.map((g) => (
        <div key={g.id} className="space-y-0.5">
          <a
            href={`#${g.id}`}
            onClick={onNavigate}
            className="block rounded-full px-3 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            {g.name}
          </a>
          {g.routes.map((r) =>
            item(
              `#${r.id}`,
              activeId === r.id,
              <>
                <MethodBadge method={r.method} />
                <span className="min-w-0 truncate" title={`${r.method} ${r.path}`}>
                  {r.summary}
                </span>
              </>,
            ),
          )}
        </div>
      ))}
    </nav>
  );
}

export function ApiDocsPage({ examples, reference }: { examples: GuideExamples; reference: ReferenceModel }) {
  const { mode, toggleMode } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState('');

  const groups: NavGroup[] = useMemo(
    () =>
      reference.groups.map((g) => ({
        id: g.id,
        name: g.name,
        routes: g.operations.map((o) => ({ id: o.id, method: o.method, path: o.path, summary: o.summary })),
      })),
    [reference],
  );
  const ids = useMemo(() => ['comece', ...groups.flatMap((g) => [g.id, ...g.routes.map((r) => r.id)]), 'erros'], [groups]);
  const activeId = useActiveId(ids);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-30 border-b border-border bg-background/90 backdrop-blur">
        <div className="mx-auto flex max-w-[88rem] items-center gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <OmniDdmLogo className="w-[128px]" priority />
            <div className="hidden h-5 w-px bg-border sm:block" />
            <h1 className="hidden font-heading text-sm font-semibold text-foreground-2 sm:block">Documentação da API</h1>
          </div>

          <a
            href="/api/v1/openapi.json"
            target="_blank"
            rel="noreferrer"
            className="ml-auto hidden h-9 items-center rounded-full border border-border px-4 text-[13px] font-semibold text-foreground-2 transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:inline-flex"
          >
            OpenAPI (JSON)
          </a>
          <button
            type="button"
            onClick={toggleMode}
            className="ml-auto inline-flex size-9 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:ml-0"
            aria-label={mode === 'dark' ? 'Usar tema claro' : 'Usar tema escuro'}
          >
            {mode === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            className="inline-flex size-9 items-center justify-center rounded-full border border-border text-muted-foreground hover:bg-surface-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring lg:hidden"
            aria-label={menuOpen ? 'Fechar menu da documentação' : 'Abrir menu da documentação'}
            aria-expanded={menuOpen}
          >
            {menuOpen ? <X className="size-4" /> : <Menu className="size-4" />}
          </button>
        </div>
        {menuOpen && (
          <div className="max-h-[70vh] overflow-y-auto border-t border-border px-4 py-3 lg:hidden">
            <DocsNav groups={groups} query={query} onQuery={setQuery} activeId={activeId} onNavigate={() => setMenuOpen(false)} />
          </div>
        )}
      </header>

      <div className="mx-auto grid max-w-[88rem] gap-8 px-4 py-8 lg:grid-cols-[17rem_minmax(0,1fr)]">
        <aside className="hidden lg:block">
          <div className="sticky top-24 max-h-[calc(100vh-7rem)] overflow-y-auto pr-1">
            <DocsNav groups={groups} query={query} onQuery={setQuery} activeId={activeId} />
          </div>
        </aside>

        <main className="min-w-0 space-y-14">
          <IntroSection examples={examples} />
          {reference.groups.map((g) => (
            <ReferenceGroup key={g.id} group={g} notes={<GroupNotes group={g.name} examples={examples} />} />
          ))}
          <ErrorsSection />
        </main>
      </div>

      <footer className="border-t border-border px-4 py-6 text-center text-xs text-muted-foreground">
        Especificação OpenAPI:{' '}
        <a className="underline" href="/api/v1/openapi.json" target="_blank" rel="noreferrer">
          /api/v1/openapi.json
        </a>
      </footer>
    </div>
  );
}
