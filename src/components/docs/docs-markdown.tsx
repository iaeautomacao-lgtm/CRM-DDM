// Markdown mínimo das descrições da spec (parágrafos, listas com "- ", **negrito**, *itálico* e `código`).
// Sem HTML cru: tudo vira elemento React, então texto da spec nunca injeta marcação.

import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g;

export function Inline({ text }: { text: string }) {
  const parts = text.split(INLINE).filter((p) => p !== '');
  return (
    <>
      {parts.map((part, i): ReactNode => {
        if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={i}>{part.slice(2, -2)}</strong>;
        if (part.startsWith('`') && part.endsWith('`') && part.length > 2)
          return (
            <code key={i} className="rounded-md bg-surface-3 px-1.5 py-0.5 font-mono text-[0.85em] text-foreground">
              {part.slice(1, -1)}
            </code>
          );
        if (part.startsWith('*') && part.endsWith('*') && part.length > 2) return <em key={i}>{part.slice(1, -1)}</em>;
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  const blocks = source
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  return (
    <div className={cn('space-y-3 text-sm leading-relaxed text-foreground-2', className)}>
      {blocks.map((block, i) => {
        const lines = block.split('\n');
        if (lines.every((l) => /^\s*[-*] /.test(l))) {
          return (
            <ul key={i} className="list-disc space-y-1 pl-5">
              {lines.map((l, j) => (
                <li key={j}>
                  <Inline text={l.replace(/^\s*[-*] /, '')} />
                </li>
              ))}
            </ul>
          );
        }
        if (/^#{2,4} /.test(block)) {
          return (
            <h4 key={i} className="pt-1 font-heading text-sm font-semibold text-foreground">
              <Inline text={block.replace(/^#{2,4} /, '')} />
            </h4>
          );
        }
        return (
          <p key={i}>
            <Inline text={lines.join(' ')} />
          </p>
        );
      })}
    </div>
  );
}
