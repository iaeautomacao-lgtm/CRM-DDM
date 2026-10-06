"use client";

// Lista de respostas rápidas que abre acima do campo de mensagem — pelo
// atalho "/" (o composer controla teclado e filtro) ou pelo botão ⚡.

import Link from "next/link";
import { Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import type { QuickReply } from "@/lib/quick-replies";

interface QuickReplyMenuProps {
  items: QuickReply[];
  activeIndex: number;
  loading: boolean;
  query: string;
  /** Mostra o link "Gerenciar" (quem pode cadastrar). */
  canManage: boolean;
  onPick: (reply: QuickReply) => void;
  onHover: (index: number) => void;
}

export const QUICK_REPLY_MENU_ID = "quick-reply-menu";

export function QuickReplyMenu({
  items,
  activeIndex,
  loading,
  query,
  canManage,
  onPick,
  onHover,
}: QuickReplyMenuProps) {
  return (
    <div
      className="absolute bottom-full left-0 right-0 z-20 mb-2 overflow-hidden rounded-xl border border-border bg-popover shadow-lg"
      // Clique no item não pode tirar o foco do campo antes do onPick.
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Zap className="h-3 w-3 text-primary" />
          Respostas rápidas {query ? <span className="font-mono">/{query}</span> : null}
        </span>
        <span className="hidden sm:inline">↑↓ escolher · Enter inserir · Esc fechar</span>
      </div>
      {loading ? (
        <p className="px-3 py-3 text-xs text-muted-foreground">Carregando…</p>
      ) : items.length === 0 ? (
        <p className="px-3 py-3 text-xs text-muted-foreground">
          {query ? "Nenhuma resposta com esse atalho." : "Nenhuma resposta rápida cadastrada."}{" "}
          {canManage && (
            <Link href="/respostas-rapidas" className="text-primary hover:underline">
              Cadastrar
            </Link>
          )}
        </p>
      ) : (
        <ul id={QUICK_REPLY_MENU_ID} role="listbox" aria-label="Respostas rápidas" className="max-h-64 overflow-y-auto py-1">
          {items.map((r, i) => (
            <li
              key={r.id}
              id={`${QUICK_REPLY_MENU_ID}-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              onMouseEnter={() => onHover(i)}
              onClick={() => onPick(r)}
              className={cn(
                "cursor-pointer px-3 py-2",
                i === activeIndex ? "bg-accent text-accent-foreground" : "hover:bg-muted",
              )}
            >
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-xs text-primary">/{r.shortcut}</span>
                <span className="truncate text-sm font-medium">{r.title}</span>
              </div>
              <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{r.content}</p>
            </li>
          ))}
        </ul>
      )}
      {canManage && items.length > 0 && (
        <div className="border-t border-border px-3 py-1.5 text-right text-xs">
          <Link href="/respostas-rapidas" className="text-muted-foreground hover:text-foreground hover:underline">
            Gerenciar respostas rápidas
          </Link>
        </div>
      )}
    </div>
  );
}
