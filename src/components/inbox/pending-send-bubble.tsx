"use client";

import { Clock } from "lucide-react";
import type { ComposerMediaKind, SendMediaPayload } from "./message-composer";

/** A message queued during the Undo-Send delay — not yet sent to WAHA. */
export type PendingSendData =
  | { kind: "text"; text: string; replyToId?: string }
  | { kind: "media"; payload: SendMediaPayload };

const MEDIA_LABEL: Record<ComposerMediaKind, string> = {
  image: "Imagem",
  video: "Vídeo",
  document: "Documento",
  audio: "Áudio",
};

interface PendingSendBubbleProps {
  data: PendingSendData;
  secondsLeft: number;
  onUndo: () => void;
  onEdit: () => void;
}

export function PendingSendBubble({
  data,
  secondsLeft,
  onUndo,
  onEdit,
}: PendingSendBubbleProps) {
  const preview =
    data.kind === "text"
      ? data.text
      : data.payload.filename
        ? `${MEDIA_LABEL[data.payload.kind]} · ${data.payload.filename}`
        : MEDIA_LABEL[data.payload.kind];
  const caption = data.kind === "media" ? data.payload.caption : undefined;

  return (
    <div className="flex flex-col items-end">
      <div className="relative max-w-[72%] animate-ddm-pop rounded-[12px_12px_4px_12px] border border-dashed border-bubble-out-border bg-bubble-out px-3 pb-[7px] pt-[9px] text-foreground">
        <p className="whitespace-pre-wrap break-words text-[13.5px] italic opacity-90">
          {preview}
        </p>
        {caption && (
          <p className="mt-1 whitespace-pre-wrap break-words text-[13.5px] italic opacity-80">
            {caption}
          </p>
        )}
        <div className="mt-[3px] flex items-center justify-end gap-1 text-[11px] text-muted-foreground">
          <Clock className="h-3 w-3" />
          <span>Enviando em {secondsLeft}s</span>
        </div>
      </div>
      <div className="mt-1 flex items-center gap-3 text-xs">
        <button
          type="button"
          onClick={onEdit}
          className="text-muted-foreground hover:text-foreground hover:underline"
        >
          Editar
        </button>
        <button
          type="button"
          onClick={onUndo}
          className="text-muted-foreground hover:text-foreground hover:underline"
        >
          Desfazer
        </button>
      </div>
    </div>
  );
}
