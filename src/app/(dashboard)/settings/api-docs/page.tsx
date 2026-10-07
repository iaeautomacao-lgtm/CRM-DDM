'use client';

// Documentação navegável da API pública: renderiza /api/v1/openapi.json
// com Swagger UI carregado do CDN permitido (cdn.jsdelivr.net/npm) — sem
// dependência npm nova. Só logado e owner/admin/supervisor.

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Loader2 } from 'lucide-react';

import { RequireRole } from '@/components/auth/require-role';

const SWAGGER_VERSION = '5.17.14';
const CDN = `https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_VERSION}`;

type SwaggerUIBundleFn = (config: Record<string, unknown>) => unknown;

function loadCss(href: string): void {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (existing) {
      if ((window as unknown as { SwaggerUIBundle?: unknown }).SwaggerUIBundle) resolve();
      else {
        existing.addEventListener('load', () => resolve());
        existing.addEventListener('error', () => reject(new Error('script')));
      }
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

function ApiDocsViewer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        loadCss(`${CDN}/swagger-ui.css`);
        await loadScript(`${CDN}/swagger-ui-bundle.js`);
        if (cancelled || !containerRef.current) return;
        const bundle = (window as unknown as { SwaggerUIBundle?: SwaggerUIBundleFn }).SwaggerUIBundle;
        if (!bundle) throw new Error('bundle');
        bundle({
          url: '/api/v1/openapi.json',
          domNode: containerRef.current,
          docExpansion: 'list',
          defaultModelsExpandDepth: 0,
          tryItOutEnabled: false,
        });
        setState('ready');
      } catch {
        if (!cancelled) setState('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Documentação da API</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            API pública <code className="text-xs">/api/v1</code> — envio de mensagens e campanhas do Disparador.
            Especificação OpenAPI:{' '}
            <a className="underline" href="/api/v1/openapi.json" target="_blank" rel="noreferrer">
              /api/v1/openapi.json
            </a>
            .
          </p>
        </div>
        <Link
          href="/settings?tab=api"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Voltar para API keys
        </Link>
      </div>

      {state === 'loading' && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="text-primary size-6 animate-spin" />
        </div>
      )}
      {state === 'error' && (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          Não foi possível carregar o visualizador (CDN indisponível). A especificação continua disponível em{' '}
          <a className="underline" href="/api/v1/openapi.json" target="_blank" rel="noreferrer">
            /api/v1/openapi.json
          </a>
          .
        </p>
      )}
      <div ref={containerRef} className="rounded-lg bg-white p-2 text-black" />
    </div>
  );
}

export default function ApiDocsPage() {
  return (
    <RequireRole
      min="supervisor"
      fallback={<p className="text-sm text-muted-foreground">Você não tem permissão para ver a documentação da API.</p>}
    >
      <ApiDocsViewer />
    </RequireRole>
  );
}
