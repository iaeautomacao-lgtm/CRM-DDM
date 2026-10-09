"use client";

import { ShieldAlert } from "lucide-react";

/** Explica como liberar as notificações depois que o navegador as bloqueou
 *  (o site não pode pedir de novo: só o usuário desfaz o bloqueio). */
export function PushDeniedHelp({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-start gap-2 rounded-md bg-warning-soft px-3 py-2 text-[12.5px] leading-relaxed text-foreground">
      <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden="true" />
      <p>
        As notificações estão bloqueadas para este site.
        {compact ? " " : <br />}
        Para liberar, clique no ícone de cadeado ao lado do endereço, em <strong>Notificações</strong> escolha
        <strong> Permitir</strong> e recarregue a página.
      </p>
    </div>
  );
}
