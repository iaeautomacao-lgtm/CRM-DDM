"use client";

// ============================================================
// MessageModal — shows one disp_message_queue item's full message
// text. Blue header (#3B3DBF) is deliberately only used here, per
// spec — every other Relatórios surface uses the DDM orange/light
// palette.
// ============================================================

import { MessageCircle, XIcon } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";

export function MessageModal({
  open,
  onOpenChange,
  message,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  message: string | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <div className="-mx-4 -mt-4 mb-2 flex items-center justify-between rounded-t-xl bg-[#3B3DBF] px-4 py-3">
          <DialogTitle className="flex items-center gap-2 text-white">
            <MessageCircle className="size-4" />
            Mensagem
          </DialogTitle>
          <DialogClose
            render={
              <button type="button" className="text-white/80 hover:text-white" aria-label="Fechar" />
            }
          >
            <XIcon className="size-4" />
          </DialogClose>
        </div>

        <div className="rounded-lg border border-border bg-card p-3">
          <p className="whitespace-pre-wrap text-sm text-foreground">
            {message || "Sem conteúdo registrado para esta mensagem."}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
