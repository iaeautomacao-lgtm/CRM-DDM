"use client";

import { useEffect, useRef } from "react";
import { Phone, PhoneOff, Mic, Volume2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type CallInfo = {
  sessionId: string;
  callId: string;
  peer: string;
  status: string;
  direction: "inbound" | "outbound";
};

// Status da chamada (CallStatus do broker, em inglês) → texto pt-BR.
const CALL_STATUS_LABELS: Record<string, string> = {
  offering: "Chamando",
  answering: "Conectando",
  relay: "Conectando",
  active: "Ativa",
  ended: "Encerrada",
  incoming: "Recebendo",
};

type VoipCallOverlayProps = {
  activeCall: CallInfo | null;
  incomingCall: CallInfo | null;
  audioStream: MediaStream | null;
  contactName: string;
  onAccept: () => void;
  onReject: () => void;
  onHangup: () => void;
};

export function VoipCallOverlay({
  activeCall,
  incomingCall,
  audioStream,
  contactName,
  onAccept,
  onReject,
  onHangup,
}: VoipCallOverlayProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Play audio stream when available
  useEffect(() => {
    if (audioRef.current && audioStream) {
      audioRef.current.srcObject = audioStream;
      audioRef.current.play().catch((err) => {
        console.error("[VoIP Audio] Playback failed:", err);
      });
    }
  }, [audioStream]);

  if (!activeCall && !incomingCall) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm animate-in fade-in duration-200">
      {/* Hidden Audio Player for WebRTC remote stream */}
      <audio ref={audioRef} autoPlay className="hidden" />

      {/* Ringing / Incoming Call Card */}
      {incomingCall && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="voip-incoming-title"
          className="w-full max-w-80 rounded-2xl border border-border bg-card p-6 text-center shadow-2xl animate-in zoom-in-95 duration-200"
        >
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-400 animate-pulse" aria-hidden="true">
            <Phone className="h-8 w-8" />
          </div>
          <h3 id="voip-incoming-title" className="mt-4 text-lg font-bold text-foreground">Ligação Recebida</h3>
          <p className="mt-1 text-sm font-medium text-primary">{contactName}</p>
          <p className="text-xs text-muted-foreground">{incomingCall.peer}</p>

          <div className="mt-6 flex justify-center gap-4">
            <Button
              onClick={onReject}
              variant="destructive"
              className="flex h-12 w-12 items-center justify-center rounded-full p-0"
              title="Recusar Chamada"
              aria-label="Recusar chamada"
            >
              <PhoneOff className="h-5 w-5" aria-hidden="true" />
            </Button>
            <Button
              onClick={onAccept}
              className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500 p-0 text-white hover:bg-emerald-600"
              title="Atender Chamada"
              aria-label="Atender chamada"
            >
              <Phone className="h-5 w-5" aria-hidden="true" />
            </Button>
          </div>
        </div>
      )}

      {/* Outbound / Active Call Card */}
      {activeCall && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="voip-active-title"
          className="w-full max-w-80 rounded-2xl border border-border bg-card p-6 text-center shadow-2xl animate-in zoom-in-95 duration-200"
        >
          <div aria-hidden="true" className={cn(
            "mx-auto flex h-16 w-16 items-center justify-center rounded-full text-white",
            activeCall.status === "active" ? "bg-emerald-500" : "bg-primary animate-pulse"
          )}>
            {activeCall.status === "active" ? (
              <Volume2 className="h-8 w-8" />
            ) : (
              <Phone className="h-8 w-8" />
            )}
          </div>
          <h3 id="voip-active-title" className="mt-4 text-lg font-bold text-foreground">
            {activeCall.status === "active" ? "Chamada em Andamento" : "Chamando..."}
          </h3>
          <p className="mt-1 text-sm font-medium text-primary">{contactName}</p>
          <p className="text-xs text-muted-foreground">{activeCall.peer}</p>
          
          <div className="mt-3 flex items-center justify-center gap-1.5 text-xs text-muted-foreground" role="status">
            <span aria-hidden="true" className={cn(
              "h-2 w-2 rounded-full",
              activeCall.status === "active" ? "bg-emerald-500 animate-ping" : "bg-amber-500"
            )} />
            <span>{CALL_STATUS_LABELS[activeCall.status] ?? activeCall.status}</span>
          </div>

          <div className="mt-6 flex justify-center gap-4">
            <Button
              onClick={onHangup}
              variant="destructive"
              className="flex h-12 w-28 items-center justify-center gap-2 rounded-full px-4"
            >
              <PhoneOff className="h-4 w-4" aria-hidden="true" />
              Desligar
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
