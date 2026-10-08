'use client';

// Blocos de código da documentação da API: abas curl / JavaScript / n8n e botão "Copiar".

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { Snippets } from '@/lib/api/v1/docs-examples';

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        if (await copyText(text)) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1800);
        }
      }}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground',
        className,
      )}
      aria-label="Copiar código"
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {copied ? 'Copiado!' : 'Copiar'}
    </button>
  );
}

export function CodeBlock({ code, label }: { code: string; label?: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-muted/40">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <span className="text-xs font-medium text-muted-foreground">{label ?? 'Código'}</span>
        <CopyButton text={code} />
      </div>
      <pre className="max-h-[28rem] overflow-auto p-3 text-xs leading-relaxed text-foreground">
        <code>{code}</code>
      </pre>
    </div>
  );
}

const TABS = [
  { id: 'curl', label: 'curl' },
  { id: 'js', label: 'JavaScript (fetch)' },
  { id: 'n8n', label: 'n8n (HTTP Request)' },
] as const;

export function CodeTabs({ snippets, title }: { snippets: Snippets; title?: string }) {
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('curl');
  const code = snippets[tab];
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-muted/40">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-2 py-1.5">
        <div role="tablist" aria-label={title ?? 'Linguagem do exemplo'} className="flex flex-wrap gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                tab === t.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <CopyButton text={code} />
      </div>
      {tab === 'n8n' && (
        <p className="border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
          Copie e cole direto na tela do fluxo do n8n (Ctrl+V): o nó “HTTP Request” já vem montado. Troque{' '}
          <code>SUA_CHAVE_DE_API</code> pela sua chave (de preferência numa credencial “Header Auth”).
        </p>
      )}
      <pre className="max-h-[28rem] overflow-auto p-3 text-xs leading-relaxed text-foreground">
        <code>{code}</code>
      </pre>
    </div>
  );
}
