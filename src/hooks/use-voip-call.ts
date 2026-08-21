"use client";

import { apiFetch } from "@/lib/api-fetch";

import { useEffect, useState, useCallback, useRef } from "react";
import { toast } from "sonner";
import { openCall, OpenCall, getClientId } from "@/lib/voip/webrtc";
import { voipEventStream, BrokerEvent, CallStatus } from "@/lib/voip/event-stream";

export type CallInfo = {
  sessionId: string;
  callId: string;
  peer: string;
  status: CallStatus;
  direction: "inbound" | "outbound";
};

export function useVoipCall(sessionName: string) {
  const [voipBaseUrl, setVoipBaseUrl] = useState<string>("");
  const [activeCall, setActiveCall] = useState<CallInfo | null>(null);
  const [incomingCall, setIncomingCall] = useState<CallInfo | null>(null);
  const [audioStream, setAudioStream] = useState<MediaStream | null>(null);
  const openConnRef = useRef<OpenCall | null>(null);

  // Fetch VoIP Base URL Config
  useEffect(() => {
    apiFetch("/api/whatsapp/voip-url")
      .then((res) => res.json())
      .then((data) => {
        if (data && data.url) setVoipBaseUrl(data.url);
      })
      .catch((err) => console.warn("Failed to fetch VoIP URL in hook:", err));
  }, []);

  // Initialize event stream connection
  useEffect(() => {
    if (!sessionName) return;

    voipEventStream.connect();

    const unsubscribe = voipEventStream.on((ev: BrokerEvent) => {
      if (ev.type === "call-list") {
        const myCall = ev.calls.find((c) => c.sessionId === sessionName && (c.owner === getClientId() || c.status === "incoming"));
        if (myCall) {
          if (myCall.status === "incoming") {
            setIncomingCall({
              sessionId: myCall.sessionId,
              callId: myCall.callId,
              peer: myCall.peer,
              status: "incoming",
              direction: "inbound",
            });
          } else {
            setActiveCall({
              sessionId: myCall.sessionId,
              callId: myCall.callId,
              peer: myCall.peer,
              status: myCall.status,
              direction: myCall.direction,
            });
          }
        }
      } else if (ev.type === "call-status" && ev.sessionId === sessionName) {
        if (ev.owner === getClientId()) {
          setActiveCall({
            sessionId: ev.sessionId,
            callId: ev.id,
            peer: ev.peer,
            status: ev.status,
            direction: ev.owner ? "outbound" : "inbound",
          });
        }
      } else if (ev.type === "call-ended" && ev.sessionId === sessionName) {
        if (openConnRef.current && ev.id === activeCall?.callId) {
          openConnRef.current.close();
          openConnRef.current = null;
        }
        if (ev.id === activeCall?.callId) {
          setActiveCall(null);
          setAudioStream(null);
          toast.info(`Chamada encerrada: ${ev.reason}`);
        }
        if (ev.id === incomingCall?.callId) {
          setIncomingCall(null);
        }
      } else if (ev.type === "incoming" && ev.sessionId === sessionName) {
        setIncomingCall({
          sessionId: ev.sessionId,
          callId: ev.id,
          peer: ev.peer,
          status: "incoming",
          direction: "inbound",
        });
      } else if (ev.type === "incoming-claimed" && ev.sessionId === sessionName) {
        if (ev.owner !== getClientId() && incomingCall?.callId === ev.id) {
          setIncomingCall(null); // Claimed by another agent
        }
      }
    });

    return () => {
      unsubscribe();
    };
  }, [sessionName, activeCall, incomingCall]);

  const startOutboundCall = useCallback(async (phone: string) => {
    if (!sessionName || !voipBaseUrl) {
      toast.error("WhatsApp VoIP não configurado ou offline.");
      return;
    }

    try {
      toast.info(`Iniciando chamada para ${phone}...`);
      
      // Start call signaling via Go server (Direct CORS)
      const res = await fetch(`${voipBaseUrl}/api/sessions/${sessionName}/calls`, {
        method: "POST",
        headers: {
          "X-Client-Id": getClientId(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          phone: phone.replace("+", ""),
          duration_ms: 300_000,
          record: false,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Erro HTTP ${res.status}`);
      }

      const { call } = await res.json();
      
      // Open WebRTC channel (Direct CORS)
      const conn = await openCall(voipBaseUrl, sessionName, call.callId, null);
      openConnRef.current = conn;

      if (conn.remoteStream) {
        setAudioStream(conn.remoteStream);
      }

      setActiveCall({
        sessionId: sessionName,
        callId: call.callId,
        peer: phone,
        status: "offering",
        direction: "outbound",
      });

    } catch (err: any) {
      console.error("[VoIP] Start call failed:", err);
      toast.error(`Falha ao iniciar ligação: ${err.message}`);
    }
  }, [sessionName, voipBaseUrl]);

  const acceptInboundCall = useCallback(async () => {
    if (!incomingCall || !voipBaseUrl) return;

    try {
      // Accept signaling (Direct CORS)
      const res = await fetch(`${voipBaseUrl}/api/sessions/${incomingCall.sessionId}/calls/${incomingCall.callId}/accept`, {
        method: "POST",
        headers: {
          "X-Client-Id": getClientId(),
          "Content-Type": "application/json",
        },
        body: "{}",
      });

      if (!res.ok) throw new Error(`Falha ao aceitar: HTTP ${res.status}`);

      // Open WebRTC connection (Direct CORS)
      const conn = await openCall(voipBaseUrl, incomingCall.sessionId, incomingCall.callId, null);
      openConnRef.current = conn;

      if (conn.remoteStream) {
        setAudioStream(conn.remoteStream);
      }

      setActiveCall({
        ...incomingCall,
        status: "active",
      });
      setIncomingCall(null);
    } catch (err: any) {
      console.error("[VoIP] Accept call failed:", err);
      toast.error(err.message);
    }
  }, [incomingCall, voipBaseUrl]);

  const rejectInboundCall = useCallback(async () => {
    if (!incomingCall || !voipBaseUrl) return;

    try {
      // Reject signaling (Direct CORS)
      await fetch(`${voipBaseUrl}/api/sessions/${incomingCall.sessionId}/calls/${incomingCall.callId}/reject`, {
        method: "POST",
        headers: {
          "X-Client-Id": getClientId(),
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      setIncomingCall(null);
    } catch (err: any) {
      console.error("[VoIP] Reject call failed:", err);
    }
  }, [incomingCall, voipBaseUrl]);

  const endActiveCall = useCallback(async () => {
    if (!activeCall || !voipBaseUrl) return;

    try {
      // End call (Direct CORS)
      await fetch(`${voipBaseUrl}/api/sessions/${activeCall.sessionId}/calls/${activeCall.callId}`, {
        method: "DELETE",
        headers: {
          "X-Client-Id": getClientId(),
        },
      });

      if (openConnRef.current) {
        openConnRef.current.close();
        openConnRef.current = null;
      }
      setActiveCall(null);
      setAudioStream(null);
    } catch (err: any) {
      console.error("[VoIP] End call failed:", err);
    }
  }, [activeCall, voipBaseUrl]);

  return {
    activeCall,
    incomingCall,
    audioStream,
    startOutboundCall,
    acceptInboundCall,
    rejectInboundCall,
    endActiveCall,
  };
}