"use client";

import { useState, type ReactNode } from "react";
import { CornerUpLeft, Copy, SmilePlus } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { usePermission } from "@/hooks/use-permission";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { Message } from "@/types";

// WhatsApp's own quick-reaction bar starts with these six. Picking the same
// set keeps the affordance familiar without pulling in a 300KB emoji library.
const QUICK_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

interface MessageActionsProps {
  message: Message;
  onReply: () => void;
  onReact: (emoji: string) => void;
  children: ReactNode;
}

/**
 * Hover/long-press toolbar wrapper around a `<MessageBubble>`. The bubble
 * itself stays a pure presenter — this component owns the action surface so
 * the bubble's render path is unaffected when the toolbar isn't visible.
 */
export function MessageActions({
  message,
  onReply,
  onReact,
  children,
}: MessageActionsProps) {
  // Touch devices have no hover. Long-press fires `contextmenu`; we capture
  // it, suppress the native menu, and pin the toolbar open until the user
  // interacts elsewhere.
  // Reagir e responder exigem inbox.reply (o servidor bloqueia em /api/whatsapp/react e no envio); sem ela só resta Copiar.
  const canReply = usePermission("inbox.reply");
  const [touchOpen, setTouchOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const isAgent =
    message.sender_type === "agent" || message.sender_type === "bot";

  const handleContextMenu = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    // Em mídia/links preservamos o menu nativo do navegador ("Salvar imagem
    // como...", "Abrir em nova guia"...). O long-press customizado continua
    // existindo no restante da bolha para reações/resposta.
    if (target.closest("img, video, audio, a[href]")) return;
    e.preventDefault();
    setTouchOpen(true);
  };

  const handleCopy = async () => {
    const text = message.content_text ?? "";
    if (!text) {
      toast.error("Nada para copiar");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copiado");
    } catch {
      toast.error("Falha ao copiar");
    }
    setTouchOpen(false);
  };

  const handlePickEmoji = (emoji: string) => {
    onReact(emoji);
    setPickerOpen(false);
    setTouchOpen(false);
  };

  const handleReply = () => {
    onReply();
    setTouchOpen(false);
  };

  // Row alignment lives here (not in MessageBubble) so the `group/actions`
  // hover region matches the bubble's content width — hovering empty space
  // in the row no longer reveals the toolbar.
  return (
    <div
      className={cn(
        "flex w-full",
        isAgent ? "justify-end" : "justify-start",
      )}
      onContextMenu={handleContextMenu}
      onBlur={() => setTouchOpen(false)}
    >
      {/* `min-w-0` lets this flex child respect the message-width cap.
       *  Default `min-width: auto` lets content (a long quote preview,
       *  an unbroken URL) push past the cap and shove the row past
       *  100%, which used to bleed across into the contact-sidebar
       *  area. See issue #165. */}
      <div className="group/actions relative min-w-0 max-w-[78%] xl:max-w-[72%]">
        {children}
      <div
        data-touch-open={touchOpen || pickerOpen ? "true" : undefined}
        className={cn(
          // No celular (toque longo) os botões ficam com 28px; no desktop
          // mantêm o tamanho compacto de antes.
          "absolute -top-4 z-10 flex h-9 items-center gap-0.5 lg:-top-3 lg:h-7 rounded-full border border-border bg-popover/95 px-1 shadow-md backdrop-blur-sm transition-opacity",
          "opacity-0 group-hover/actions:opacity-100 group-focus-within/actions:opacity-100",
          "data-[touch-open=true]:opacity-100",
          isAgent ? "right-3" : "left-3",
        )}
      >
        {canReply && (
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger
            className="flex h-7 w-7 items-center justify-center rounded-full text-popover-foreground hover:bg-muted hover:text-foreground lg:h-5 lg:w-5"
            aria-label="Reagir"
          >
            <SmilePlus className="h-3.5 w-3.5" aria-hidden="true" />
          </PopoverTrigger>
          <PopoverContent
            className="flex w-auto flex-row gap-1 p-1.5"
            sideOffset={6}
          >
            {QUICK_EMOJIS.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => handlePickEmoji(e)}
                className="flex h-8 w-8 items-center justify-center rounded-full text-lg leading-none transition-transform hover:scale-125 hover:bg-muted"
                aria-label={`Reagir com ${e}`}
              >
                {e}
              </button>
            ))}
          </PopoverContent>
        </Popover>
        )}
        {canReply && (
        <button
          type="button"
          onClick={handleReply}
          className="flex h-7 w-7 items-center justify-center rounded-full text-popover-foreground hover:bg-muted hover:text-foreground lg:h-5 lg:w-5"
          aria-label="Responder"
        >
          <CornerUpLeft className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        )}
        <button
          type="button"
          onClick={handleCopy}
          className="flex h-7 w-7 items-center justify-center rounded-full text-popover-foreground hover:bg-muted hover:text-foreground lg:h-5 lg:w-5"
          aria-label="Copiar"
        >
          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
      </div>
    </div>
  );
}
