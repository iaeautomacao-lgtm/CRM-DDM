"use client";

// ============================================================
// ContactTimelineModal — "Ver histórico" from a Monitoramento card's
// ⋮ menu opens this instead of navigating away, so the supervisor
// never loses their place on the board (Fortics' "Linha do tempo"
// pattern). Wraps the existing ContactTimeline, unchanged.
// ============================================================

import { History } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ContactTimeline } from "./ContactTimeline";

export function ContactTimelineModal({
  open,
  onClose,
  contactId,
  contactName,
}: {
  open: boolean;
  onClose: () => void;
  contactId: string;
  contactName: string;
}) {
  const contactInitial = (contactName.trim() || "?").charAt(0).toUpperCase();

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-3xl gap-0 p-0 sm:max-w-3xl">
        <DialogHeader className="border-b border-border px-4 py-3">
          <DialogTitle className="flex items-center gap-2">
            <History className="size-4 text-primary" />
            Linha do tempo
          </DialogTitle>
        </DialogHeader>

        <div className="max-h-[85vh] overflow-y-auto">
          <ContactTimeline
            contactId={contactId}
            contactName={contactName}
            contactInitial={contactInitial}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
