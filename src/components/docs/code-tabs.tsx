'use client';

// Blocos de código da documentação da API: abas curl / JavaScript / Python / n8n, seletor de exemplo
// (quando a rota tem mais de um corpo, ex.: campanha Meta × WAHA) e botão "Copiar".

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { Snippets } from '@/lib/api/v1/docs-examples';
import type { SnippetSet } from '@/lib/api/v1/docs-reference';

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function CopyButton({ text, className, label = 'Copiar' }: { text: string; className?: string; label?: string }) {
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
        'inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-card px-3 text-xs font-semibold text-foreground-2 transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        className,
      )}
      aria-label={`${label} código`}
    >
      {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
      {copied ? 'Copiado!' : label}
    </button>
  );
}

export function CodeBlock({ code, label }: { code: string; label?: string }) {
  return (
    <div className="overflow-hidden rounded-field border border-border bg-surface-3/60">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <span className="text-xs font-semibold text-muted-foreground">{label ?? 'Código'}</span>
        <CopyButton text={code} />
      </div>
      <pre className="max-h-[28rem] overflow-auto p-3 font-mono text-xs leading-relaxed text-foreground">
        <code>{code}</code>
      </pre>
    </div>
  );
}

const TABS = [
  { id: 'curl', label: 'curl' },
  { id: 'js', label: 'JavaScript' },
  { id: 'python', label: 'Python' },
  { id: 'n8n', label: 'n8n' },
] as const;

type TabId = (typeof TABS)[number]['id'];

/** Abas de linguagem para UM conjunto de snippets. */
export function CodeTabs({ snippets, title }: { snippets: Snippets; title?: string }) {
  const [tab, setTab] = useState<TabId>('curl');
  const code = snippets[tab];
  return (
    <div className="overflow-hidden rounded-field border border-border bg-surface-3/60">
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
                'h-7 rounded-full px-3 text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                tab === t.id ? 'bg-primary-solid text-primary-foreground' : 'text-foreground-2 hover:bg-surface-hover hover:text-foreground',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <CopyButton text={code} />
      </div>
      {tab === 'n8n' && (
        <p className="border-b border-border px-3 py-1.5 text-xs text-foreground-2">
          Copie e cole direto na tela do fluxo do n8n (Ctrl+V): o nó “HTTP Request” já vem montado. Troque{' '}
          <code className="font-mono">SUA_CHAVE_DE_API</code> pela sua chave (de preferência numa credencial “Header Auth”).
        </p>
      )}
      <pre className="max-h-[28rem] overflow-auto p-3 font-mono text-xs leading-relaxed text-foreground">
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** Exemplos de uma rota: se houver mais de um corpo, mostra um seletor acima das abas. */
export function RouteExamples({ sets, title }: { sets: SnippetSet[]; title: string }) {
  const [index, setIndex] = useState(0);
  const current = sets[Math.min(index, sets.length - 1)];
  return (
    <div className="space-y-2">
      {sets.length > 1 && (
        <div role="group" aria-label="Exemplo de corpo" className="flex flex-wrap gap-1.5">
          {sets.map((s, i) => (
            <button
              key={s.label ?? i}
              type="button"
              aria-pressed={index === i}
              onClick={() => setIndex(i)}
              className={cn(
                'h-7 rounded-full border px-3 text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                index === i ? 'border-primary bg-primary-soft text-primary-text' : 'border-border text-foreground-2 hover:bg-surface-hover',
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
      <CodeTabs snippets={current.snippets} title={title} />
    </div>
  );
}
