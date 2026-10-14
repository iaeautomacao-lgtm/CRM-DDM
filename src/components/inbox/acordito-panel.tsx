"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, Loader2, RefreshCw } from "lucide-react";

import { AcorditoMark, AcorditoMascote } from "@/components/ddm/acordito";
import type { AcorditoState } from "@/hooks/use-acordito-suggestions";
import type { AcorditoSuggestion } from "@/lib/acordito/client";
import { cn } from "@/lib/utils";

const COLLAPSE_KEY = "wacrm:acordito-collapsed";

/**
 * "O Acordito sugere": 3 respostas para a conversa aberta. Clicar COLOCA o texto no campo para editar; nunca
 * envia. Esconde-se sozinho quando o servidor nega (forbidden) e avisa em uma linha quando está desligado,
 * sem IA configurada ou sem cota.
 */
export function AcorditoPanel({
  state,
  onPick,
  onRegenerate,
}: {
  state: AcorditoState;
  onPick: (s: AcorditoSuggestion) => void;
  onRegenerate: () => void;
}) {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggle = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1");
      } catch {}
      return !c;
    });
  };

  if (state.status === "idle") return null;
  if (state.status === "error" && state.code === "forbidden") return null;

  const loading = state.status === "loading";
  const suggestions = state.status === "ready" || state.status === "loading" ? state.suggestions : [];

  return (
    <section
      aria-label="Sugestões do Acordito"
      className="mb-2 rounded-field border border-primary-soft-2 bg-primary-soft/40 px-2.5 py-2"
    >
      <div className="flex items-center justify-between gap-2">
        <AcorditoMark className="text-[12.5px]">O Acordito sugere</AcorditoMark>
        <div className="flex items-center gap-0.5">
          {!collapsed && state.status !== "error" && (
            <button
              type="button"
              onClick={onRegenerate}
              disabled={loading}
              title="Pedir outras sugestões"
              aria-label="Gerar sugestões de novo"
              className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              <RefreshCw className={cn("size-3.5", loading && "animate-spin")} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            onClick={toggle}
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Mostrar sugestões do Acordito" : "Recolher sugestões do Acordito"}
            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {collapsed ? <ChevronUp className="size-4" aria-hidden="true" /> : <ChevronDown className="size-4" aria-hidden="true" />}
          </button>
        </div>
      </div>

      {!collapsed && (
        <div className="mt-1.5" aria-live="polite">
          {state.status === "error" ? (
            <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground">
              {/* Desligado, sem IA ou sem cota: o mascote acompanha o aviso (não é falha da tela). */}
              {state.code !== "unknown" && <AcorditoMascote width={40} />}
              <span className="min-w-0 flex-1">{state.message}</span>
              {state.code === "unknown" && (
                <button type="button" onClick={onRegenerate} className="font-medium text-primary-text hover:underline">
                  Tentar de novo
                </button>
              )}
            </div>
          ) : loading && suggestions.length === 0 ? (
            <p className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              Pensando em boas respostas…
            </p>
          ) : suggestions.length === 0 ? (
            <p className="text-[12.5px] text-muted-foreground">Sem sugestões por enquanto.</p>
          ) : (
            <ul className={cn("flex flex-col gap-1.5", loading && "opacity-60")}>
              {suggestions.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => onPick(s)}
                    title="Usar no campo para editar"
                    className="w-full rounded-md border border-border bg-card px-2.5 py-1.5 text-left text-[13px] text-foreground hover:border-primary-soft-2 hover:bg-primary-soft disabled:cursor-wait"
                  >
                    <span className="line-clamp-3 whitespace-pre-wrap">{s.text}</span>
                  </button>
                </li>
              ))}
              <li className="px-0.5 text-[11px] text-muted-foreground">Clique para editar no campo. Nada é enviado sem você.</li>
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
