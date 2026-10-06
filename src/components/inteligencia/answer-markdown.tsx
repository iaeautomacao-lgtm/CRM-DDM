"use client";

import Link from "next/link";
import { Fragment, useMemo } from "react";
import { parseMarkdown, type InlineToken } from "@/lib/intelligence/chat/markdown";

function Inline({ tokens }: { tokens: InlineToken[] }) {
  return (
    <>
      {tokens.map((t, i) => {
        switch (t.type) {
          case "bold":
            return <strong key={i}>{t.text}</strong>;
          case "code":
            return (
              <code key={i} className="rounded bg-muted px-1 py-0.5 text-[0.85em]">
                {t.text}
              </code>
            );
          case "link":
            return t.internal ? (
              <Link key={i} href={t.href} className="text-primary underline-offset-4 hover:underline">
                {t.text}
              </Link>
            ) : (
              <a
                key={i}
                href={t.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline-offset-4 hover:underline"
              >
                {t.text}
              </a>
            );
          default:
            return <Fragment key={i}>{t.text}</Fragment>;
        }
      })}
    </>
  );
}

/** Resposta do DDM Intelligence com o markdown mínimo de lib/intelligence/chat/markdown.ts. */
export function AnswerMarkdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className="space-y-2 text-sm leading-relaxed">
      {blocks.map((b, i) => {
        if (b.type === "heading") {
          return (
            <p key={i} className="font-semibold">
              <Inline tokens={b.tokens} />
            </p>
          );
        }
        if (b.type === "list") {
          const ListTag = b.ordered ? "ol" : "ul";
          return (
            <ListTag key={i} className={b.ordered ? "list-decimal space-y-1 pl-5" : "list-disc space-y-1 pl-5"}>
              {b.items.map((item, j) => (
                <li key={j}>
                  <Inline tokens={item} />
                </li>
              ))}
            </ListTag>
          );
        }
        return (
          <p key={i}>
            {b.lines.map((line, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                <Inline tokens={line} />
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}
