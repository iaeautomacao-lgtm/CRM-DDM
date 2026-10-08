'use client';

// Página pública /docs/api: abas "Guia" (texto em português + exemplos) e "Referência" (Scalar).
// Layout próprio (fora do dashboard), claro/escuro e responsivo.

import { useEffect, useState } from 'react';
import { BookOpen, ListTree, Menu, Moon, Sun, X } from 'lucide-react';

import { OmniDdmLogo } from '@/components/ui/omniddm-logo';
import { useTheme } from '@/hooks/use-theme';
import { cn } from '@/lib/utils';
import type { GuideExamples } from '@/lib/api/v1/docs-guide';
import { ApiGuide, GuideNav } from './api-guide';
import { ApiReference } from './api-reference';

type View = 'guia' | 'referencia';

export function ApiDocsPage({ examples }: { examples: GuideExamples }) {
  const { mode, toggleMode } = useTheme();
  const [view, setView] = useState<View>('guia');
  const [menuOpen, setMenuOpen] = useState(false);

  // #referencia abre a aba da referência; qualquer outra âncora é uma seção do guia.
  useEffect(() => {
    const sync = () => {
      if (window.location.hash === '#referencia') setView('referencia');
      else if (window.location.hash) setView('guia');
    };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  function choose(next: View) {
    setView(next);
    setMenuOpen(false);
    history.replaceState(null, '', next === 'referencia' ? '#referencia' : window.location.pathname);
    window.scrollTo({ top: 0 });
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-30 border-b border-border bg-background/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <OmniDdmLogo className="w-[128px]" priority />
            <div className="hidden h-5 w-px bg-border sm:block" />
            <p className="hidden text-xs text-muted-foreground sm:block">Documentação da API</p>
          </div>

          <div role="tablist" aria-label="Seções da documentação" className="ml-auto flex items-center gap-1 rounded-lg border border-border bg-muted/40 p-1">
            {(
              [
                ['guia', 'Guia', BookOpen],
                ['referencia', 'Referência', ListTree],
              ] as const
            ).map(([id, label, Icon]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={view === id}
                onClick={() => choose(id)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                  view === id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon className="size-4" />
                {label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={toggleMode}
            className="inline-flex size-9 items-center justify-center rounded-md border border-border text-muted-foreground hover:text-foreground"
            aria-label={mode === 'dark' ? 'Usar tema claro' : 'Usar tema escuro'}
          >
            {mode === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>

          {view === 'guia' && (
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              className="inline-flex size-9 items-center justify-center rounded-md border border-border text-muted-foreground hover:text-foreground lg:hidden"
              aria-label="Abrir menu do guia"
              aria-expanded={menuOpen}
            >
              {menuOpen ? <X className="size-4" /> : <Menu className="size-4" />}
            </button>
          )}
        </div>
        {view === 'guia' && menuOpen && (
          <div className="border-t border-border px-4 py-3 lg:hidden">
            <GuideNav onNavigate={() => setMenuOpen(false)} />
          </div>
        )}
      </header>

      {view === 'guia' ? (
        <div className="mx-auto grid max-w-7xl gap-8 px-4 py-8 lg:grid-cols-[16rem_minmax(0,1fr)]">
          <aside className="hidden lg:block">
            <div className="sticky top-24 space-y-3">
              <p className="px-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Neste guia</p>
              <GuideNav />
              <button
                type="button"
                onClick={() => choose('referencia')}
                className="mx-3 mt-2 text-left text-sm font-medium text-primary hover:underline"
              >
                Ver referência completa →
              </button>
            </div>
          </aside>
          <main className="min-w-0">
            <ApiGuide examples={examples} />
          </main>
        </div>
      ) : (
        <main className="mx-auto max-w-7xl px-2 py-4 sm:px-4">
          <ApiReference />
        </main>
      )}

      <footer className="border-t border-border px-4 py-6 text-center text-xs text-muted-foreground">
        Especificação OpenAPI:{' '}
        <a className="underline" href="/api/v1/openapi.json" target="_blank" rel="noreferrer">
          /api/v1/openapi.json
        </a>
      </footer>
    </div>
  );
}
