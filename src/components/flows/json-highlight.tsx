"use client";

/**
 * Shared JSON syntax-highlighting primitives — dark background, mono
 * font, keys in the DDM brand orange (#FF5706). Used by both the
 * run-history event sheet (runs/page.tsx) and the Flow Builder's
 * debug-mode node event panel (node-debug-sheet.tsx), which used to
 * each carry their own copy of this tokenizer.
 *
 * No highlighting library — a small regex tokenizer over
 * `JSON.stringify`'s output is enough for the four token classes JSON
 * actually has (keys, strings, numbers/true/false/null) and avoids a
 * dependency for something this contained.
 */

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const JSON_TOKEN_RE =
  /"(?:\\.|[^"\\])*"(?:\s*:)?|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

function tokenizeJson(json: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  JSON_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = JSON_TOKEN_RE.exec(json))) {
    if (match.index > lastIndex) {
      nodes.push(json.slice(lastIndex, match.index));
    }
    const tok = match[0];
    if (tok.endsWith(":")) {
      nodes.push(
        <span key={key++} style={{ color: "#FF5706" }}>
          {tok}
        </span>,
      );
    } else if (tok.startsWith('"')) {
      nodes.push(
        <span key={key++} className="text-emerald-300">
          {tok}
        </span>,
      );
    } else if (tok === "true" || tok === "false") {
      nodes.push(
        <span key={key++} className="text-sky-300">
          {tok}
        </span>,
      );
    } else if (tok === "null") {
      nodes.push(
        <span key={key++} className="text-neutral-500">
          {tok}
        </span>,
      );
    } else {
      nodes.push(
        <span key={key++} className="text-purple-300">
          {tok}
        </span>,
      );
    }
    lastIndex = JSON_TOKEN_RE.lastIndex;
  }
  if (lastIndex < json.length) nodes.push(json.slice(lastIndex));
  return nodes;
}

/**
 * Renders an already-formatted JSON string with syntax highlighting.
 * `className` merges on top of the default dark/mono block (via
 * `cn`/tailwind-merge) so a caller can override padding/font-size
 * without forking the component — see node-debug-sheet.tsx's more
 * compact preview for an example.
 */
export function JsonHighlight({
  value,
  className,
}: {
  value: string;
  className?: string;
}) {
  return (
    <pre
      className={cn(
        "overflow-x-auto rounded-md bg-[#0b0b0d] p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-neutral-300",
        className,
      )}
    >
      {tokenizeJson(value)}
    </pre>
  );
}

const COLLAPSE_THRESHOLD = 500;

/**
 * Collapsible JSON block for arbitrary values — stringifies internally
 * (unlike `JsonHighlight`, which takes an already-formatted string).
 * Collapses to the first COLLAPSE_THRESHOLD chars with a "Ver mais"
 * toggle when the formatted JSON is longer than that — full detail is
 * one click away, not hidden, just not dumped on-screen by default for
 * a fat payload (e.g. an http_fetch response_body or a long ai_agent
 * last_reply).
 */
export function CollapsibleJson({
  value,
  className,
}: {
  value: unknown;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const json = JSON.stringify(value, null, 2) ?? "null";
  const isLong = json.length > COLLAPSE_THRESHOLD;
  const shown = isLong && !expanded ? `${json.slice(0, COLLAPSE_THRESHOLD)}…` : json;
  return (
    <div>
      <JsonHighlight value={shown} className={className} />
      {isLong && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-[10.5px] text-primary hover:opacity-80"
        >
          {expanded ? "Ver menos" : "Ver mais"}
        </button>
      )}
    </div>
  );
}

/** Copies `value` (any JSON-serializable payload) to the clipboard. */
export function CopyJsonButton({ value }: { value: unknown }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(JSON.stringify(value, null, 2));
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          toast.error("Não foi possível copiar.");
        }
      }}
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[10.5px] text-muted-foreground transition-colors hover:text-foreground"
    >
      {copied ? (
        <>
          <Check className="h-3 w-3" /> Copiado
        </>
      ) : (
        <>
          <Copy className="h-3 w-3" /> Copiar
        </>
      )}
    </button>
  );
}
