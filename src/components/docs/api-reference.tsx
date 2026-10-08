'use client';

// Referência completa da API: Scalar API Reference (fixado em versão, via jsDelivr — sem dependência
// npm nova), lendo /api/v1/openapi.json. Sem fontes externas, sem telemetria, sem envio de requisições
// reais pelo navegador ("Try it" desligado), tema do CRM (cores via variáveis CSS do app).

import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { useTheme } from '@/hooks/use-theme';

// Manter igual ao caminho liberado na CSP (next.config.ts).
export const SCALAR_VERSION = '1.73.0';
export const SCALAR_SRC = `https://cdn.jsdelivr.net/npm/@scalar/api-reference@${SCALAR_VERSION}/dist/browser/standalone.js`;

type ScalarGlobal = { createApiReference: (target: HTMLElement | string, config: Record<string, unknown>) => { destroy?: () => void } };

const SCALAR_CSS = `
  .scalar-app, .scalar-api-reference { --scalar-font: var(--font-sans, system-ui, sans-serif); }
  .light-mode, .dark-mode {
    --scalar-color-accent: var(--primary);
    --scalar-background-1: var(--background);
    --scalar-background-2: var(--muted);
    --scalar-background-3: var(--accent);
    --scalar-color-1: var(--foreground);
    --scalar-color-2: var(--muted-foreground);
    --scalar-border-color: var(--border);
  }
`;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if ((window as unknown as { Scalar?: unknown }).Scalar) return resolve();
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('script')));
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('script'));
    document.body.appendChild(script);
  });
}

export function ApiReference() {
  const host = useRef<HTMLDivElement>(null);
  const { mode } = useTheme();
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    let instance: { destroy?: () => void } | null = null;
    (async () => {
      try {
        await loadScript(SCALAR_SRC);
        const Scalar = (window as unknown as { Scalar?: ScalarGlobal }).Scalar;
        if (cancelled || !host.current || !Scalar) throw new Error('scalar');
        instance = Scalar.createApiReference(host.current, {
          url: '/api/v1/openapi.json',
          layout: 'modern',
          theme: 'none',
          withDefaultFonts: false,
          telemetry: false,
          // Só leitura: sem "Try it" e sem cliente de requisições no navegador.
          hideTestRequestButton: true,
          hideClientButton: true,
          agent: { disabled: true },
          mcp: { disabled: true },
          hideDarkModeToggle: true,
          forceDarkModeState: mode === 'dark' ? 'dark' : 'light',
          defaultOpenAllTags: false,
          documentDownloadType: 'json',
          showDeveloperTools: 'never',
          hiddenClients: true,
          customCss: SCALAR_CSS,
          metaData: { title: 'Referência da API — CRM DDM' },
        });
        setState('ready');
      } catch {
        if (!cancelled) setState('error');
      }
    })();
    return () => {
      cancelled = true;
      instance?.destroy?.();
    };
  }, [mode]);

  return (
    <div>
      {state === 'loading' && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="text-primary size-6 animate-spin" />
        </div>
      )}
      {state === 'error' && (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
          Não foi possível carregar a referência (CDN indisponível). A especificação continua disponível em{' '}
          <a className="underline" href="/api/v1/openapi.json" target="_blank" rel="noreferrer">
            /api/v1/openapi.json
          </a>{' '}
          e o guia ao lado cobre todos os endpoints.
        </p>
      )}
      <div ref={host} className="min-h-[60vh]" />
    </div>
  );
}
