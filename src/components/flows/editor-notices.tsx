"use client";

/**
 * Avisos não bloqueantes do editor de fluxos (PRD 03, P-2), logo abaixo
 * do cabeçalho:
 *   - conflito: outra aba/usuário salvou antes; oferece recarregar a versão
 *     do servidor (o trabalho local fica no rascunho do navegador);
 *   - rascunho local: alterações não salvas deste fluxo encontradas neste
 *     navegador ao abrir; Recuperar / Descartar.
 */

import { format } from "date-fns";
import { AlertTriangle, History, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useFlowEditor } from "./flow-editor-state";

export function EditorNotices() {
  const { conflict, reloadFromServer, draftOffer, recoverDraft, discardDraft } =
    useFlowEditor();

  if (!conflict && !draftOffer) return null;

  return (
    <div className="flex flex-col gap-2 px-6 pt-3">
      {conflict && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-lg border border-danger/30 bg-danger-soft px-4 py-2.5 text-sm text-foreground"
        >
          <AlertTriangle className="h-4 w-4 shrink-0 text-danger" aria-hidden />
          <p className="min-w-0 flex-1">
            Este fluxo foi alterado em outra aba ou por outra pessoa, e o
            salvamento automático foi pausado. Suas alterações ficam
            guardadas neste navegador: depois de recarregar, você pode
            recuperá-las.
          </p>
          <Button size="sm" variant="outline" onClick={reloadFromServer}>
            <RefreshCw className="h-3.5 w-3.5" />
            Recarregar versão do servidor
          </Button>
        </div>
      )}

      {draftOffer && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-3 rounded-lg border border-warning/30 bg-warning-soft px-4 py-2.5 text-sm text-foreground"
        >
          <History className="h-4 w-4 shrink-0 text-warning" aria-hidden />
          <p className="min-w-0 flex-1">
            Há alterações não salvas deste fluxo neste navegador (de{" "}
            {format(new Date(draftOffer.savedAt), "dd/MM/yyyy 'às' HH:mm")}).
            {draftOffer.basedOnOlderVersion &&
              " Elas foram feitas sobre uma versão anterior: ao recuperar e salvar, substituem a versão atual do servidor."}
          </p>
          <div className="flex items-center gap-1.5">
            <Button size="sm" onClick={recoverDraft}>
              Recuperar
            </Button>
            <Button size="sm" variant="ghost" onClick={discardDraft}>
              Descartar
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
