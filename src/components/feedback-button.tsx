"use client";

import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { Bug } from "lucide-react";

import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

// Botão flutuante em todas as páginas autenticadas (montado uma vez em
// dashboard-shell.tsx, mesmo padrão headless-mount de PresenceHeartbeat)
// — deixa qualquer usuário reportar um problema técnico direto pro
// /ddm-logs (POST /api/feedback -> system_logs, source='feedback').
// Sempre opcional: nunca bloqueia a UI, nenhum erro de envio é exibido
// (falha silenciosa — reportar um bug não pode virar um bug em si).
//
// Arrastável: posição persiste em localStorage como {side, top} — o
// padrão (nunca arrastado ainda) continua sendo bottom:80/right:20 via
// CSS, sem depender de nenhuma leitura de window/localStorage no
// primeiro render (evita mismatch de hydration).

const STORAGE_KEY = "ddm-feedback-button-position";
const BUTTON_SIZE = 48; // h-12 w-12
const EDGE_MARGIN = 8;
const DRAG_THRESHOLD_PX = 5;

type Side = "left" | "right";
interface SavedPosition {
  side: Side;
  top: number;
}

function loadSavedPosition(): SavedPosition | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      (parsed.side === "left" || parsed.side === "right") &&
      typeof parsed.top === "number"
    ) {
      return { side: parsed.side, top: parsed.top };
    }
  } catch {
    // localStorage indisponível ou valor corrompido — segue com o padrão.
  }
  return null;
}

export function FeedbackButton() {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [page, setPage] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  // null até o efeito de mount ler o localStorage — servidor e primeiro
  // render do cliente sempre concordam no padrão bottom:80/right:20.
  const [savedPosition, setSavedPosition] = useState<SavedPosition | null>(null);
  // Só não-null durante o arraste em si (top/left absolutos, seguindo o
  // cursor); volta a null ao soltar, quando savedPosition assume.
  const [dragPosition, setDragPosition] = useState<{ top: number; left: number } | null>(null);

  // Estado do arraste em andamento — ref (não state) porque é lido/
  // escrito de dentro dos listeners de mousemove/mouseup, não precisa
  // re-renderizar por si só (dragPosition já cobre o feedback visual).
  const dragRef = useRef<{
    startX: number;
    startY: number;
    startTop: number;
    startLeft: number;
    moved: boolean;
  } | null>(null);
  // Setado no mouseup de um arraste real — o onClick nativo que o
  // navegador dispara logo em seguida precisa ser ignorado, senão o
  // popover abriria toda vez que o usuário soltasse o botão.
  const suppressClickRef = useRef(false);

  useEffect(() => {
    setSavedPosition(loadSavedPosition());
  }, []);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setSent(false);
      setPage(window.location.pathname);
    }
  }

  function handleTriggerMouseDown(e: ReactMouseEvent<HTMLButtonElement>) {
    if (e.button !== 0) return; // só botão esquerdo do mouse
    const rect = e.currentTarget.getBoundingClientRect();
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startTop: rect.top,
      startLeft: rect.left,
      moved: false,
    };

    function handleMouseMove(moveEvent: globalThis.MouseEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = moveEvent.clientX - drag.startX;
      const dy = moveEvent.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
        drag.moved = true;
      }
      if (!drag.moved) return;
      setDragPosition({ top: drag.startTop + dy, left: drag.startLeft + dx });
    }

    function handleMouseUp() {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);

      const drag = dragRef.current;
      dragRef.current = null;
      if (!drag?.moved) {
        // Moveu menos de 5px — é um clique, não um arraste. Deixa o
        // clique seguir seu curso normal (abre o popover).
        setDragPosition(null);
        return;
      }

      suppressClickRef.current = true;
      setDragPosition((current) => {
        const finalLeft = current?.left ?? drag.startLeft;
        const finalTop = current?.top ?? drag.startTop;
        // Snap pra borda mais próxima horizontalmente; posição vertical
        // fica exatamente onde o usuário soltou (clampada pra não sair
        // da tela).
        const side: Side = finalLeft + BUTTON_SIZE / 2 < window.innerWidth / 2 ? "left" : "right";
        const clampedTop = Math.min(
          Math.max(finalTop, EDGE_MARGIN),
          window.innerHeight - BUTTON_SIZE - EDGE_MARGIN
        );
        const next: SavedPosition = { side, top: clampedTop };
        setSavedPosition(next);
        try {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch {
          // localStorage indisponível — a posição só não sobrevive a reload.
        }
        return null;
      });
    }

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  }

  function handleTriggerClick(e: ReactMouseEvent) {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      e.preventDefault();
      e.stopPropagation();
    }
  }

  async function handleSubmit() {
    if (!message.trim() || sending) return;
    setSending(true);
    try {
      await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: message.trim(),
          page: page.trim() || window.location.pathname,
          user_agent: navigator.userAgent,
        }),
      });
      setSent(true);
      setMessage("");
      setTimeout(() => setOpen(false), 3000);
    } catch {
      // Best-effort — ver comentário no topo do arquivo.
    } finally {
      setSending(false);
    }
  }

  const isDragging = dragPosition !== null;
  const triggerStyle: CSSProperties = isDragging
    ? { top: dragPosition.top, left: dragPosition.left, transition: "none" }
    : savedPosition
      ? ({ top: savedPosition.top, [savedPosition.side]: 20 } as CSSProperties)
      : { bottom: 80, right: 20 };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        aria-label="Reportar problema"
        className={`fixed z-40 flex h-12 w-12 items-center justify-center rounded-full bg-[#FF5706] text-white shadow-lg transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-[#FF5706]/50 ${
          isDragging ? "cursor-grab opacity-80" : ""
        }`}
        style={triggerStyle}
        onMouseDown={handleTriggerMouseDown}
        onClick={handleTriggerClick}
      >
        <Bug className="h-5 w-5" />
      </PopoverTrigger>
      <PopoverContent className="w-80" side="top" align="end" sideOffset={10}>
        {sent ? (
          <p className="py-4 text-center text-sm font-medium text-[#FF5706]">
            Obrigado! Problema reportado.
          </p>
        ) : (
          <div className="space-y-3">
            <PopoverTitle>Reportar problema</PopoverTitle>
            <Textarea
              placeholder="Descreva o problema que encontrou..."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={4}
              autoFocus
            />
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Em qual página/tela?</label>
              <Input value={page} onChange={(e) => setPage(e.target.value)} />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
                Cancelar
              </Button>
              <Button
                size="sm"
                className="bg-[#FF5706] text-white hover:bg-[#FF5706]/90"
                disabled={!message.trim() || sending}
                onClick={handleSubmit}
              >
                {sending ? "Enviando..." : "Enviar"}
              </Button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
