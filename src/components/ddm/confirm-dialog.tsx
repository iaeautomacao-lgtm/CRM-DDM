"use client";

import { useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

type ConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /** Conteúdo extra entre a descrição e os botões (ex.: campo para digitar o nome). */
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Botão de confirmar em tom destrutivo (padrão). */
  destructive?: boolean;
  /** Ocupado por fora (ex.: o chamador já controla o estado da ação). */
  busy?: boolean;
  /** Impede confirmar (ex.: o nome digitado ainda não confere). */
  confirmDisabled?: boolean;
  /**
   * Ação confirmada. Se devolver uma Promise, o diálogo fica aberto e ocupado até ela terminar
   * e só então fecha; se ela falhar, o diálogo continua aberto (o chamador mostra o erro).
   */
  onConfirm: () => void | Promise<void>;
};

/**
 * Confirmação única do app para ações destrutivas ou sem volta, montada sobre o AlertDialog
 * (papel alertdialog, foco inicial no botão seguro). Textos curtos: o que vai acontecer e, se
 * for o caso, que não dá para desfazer.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel = "Confirmar",
  cancelLabel = "Cancelar",
  destructive = true,
  busy = false,
  confirmDisabled = false,
  onConfirm,
}: ConfirmDialogProps) {
  const [pending, setPending] = useState(false);
  const working = busy || pending;

  async function handleConfirm() {
    if (working) return;
    setPending(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch {
      // o chamador mostra o erro; o diálogo continua aberto para tentar de novo
    } finally {
      setPending(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => (working && !next ? undefined : onOpenChange(next))}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description ? <AlertDialogDescription>{description}</AlertDialogDescription> : null}
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={working}>{cancelLabel}</AlertDialogCancel>
          <Button
            type="button"
            variant={destructive ? "destructive" : "default"}
            disabled={working || confirmDisabled}
            onClick={() => void handleConfirm()}
          >
            {working ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
