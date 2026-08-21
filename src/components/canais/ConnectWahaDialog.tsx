import { apiFetch } from "@/lib/api-fetch";
"use client";

// ============================================================
// ConnectWahaDialog — QR / pairing-code flow for a WAHA channel.
// Replicates whatsapp-config.tsx's actual behavior (verified by
// reading it, not assumed):
//   - QR is a plain <img src="/api/whatsapp/waha/qr?session=&id=&t=">
//     (the route returns raw image bytes, not JSON/base64) — `t` is a
//     cache-busting counter, not a real polling fetch.
//   - Status polling is GET /api/whatsapp/config (same endpoint the
//     table uses) filtered to this config's id, every 5s — matching
//     whatsapp-config.tsx's checkWahaStatus/interval exactly, not a
//     dedicated status endpoint (none exists).
//   - Pairing code: POST /api/whatsapp/waha/pairing-code with
//     { phoneNumber, session, configId } — configId, NOT id (that
//     route names the field differently from start/stop/qr).
// ============================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { QrCode, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import type { ChannelConfig } from "./types";

const POLL_MS = 5000;
const QR_STATUSES = new Set(["SCAN_QR", "SCAN_QR_CODE", "STARTING"]);

export function ConnectWahaDialog({
  config,
  open,
  onOpenChange,
  onConnected,
}: {
  config: ChannelConfig | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: () => void;
}) {
  const [status, setStatus] = useState<string>("STARTING");
  const [qrTrigger, setQrTrigger] = useState(0);
  const [showPairing, setShowPairing] = useState(false);
  const [pairingPhone, setPairingPhone] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [pairingLoading, setPairingLoading] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);

  const startedRef = useRef(false);
  const connectedRef = useRef(false);

  const checkStatus = useCallback(async () => {
    if (!config) return;
    try {
      const res = await apiFetch("/api/whatsapp/config");
      const data = await res.json();
      const list = data.configs || [];
      const current = list.find((c: ChannelConfig) => c.id === config.id);
      if (!current) return;
      setStatus(current.session_status || "STOPPED");
      if (current.connected && !connectedRef.current) {
        connectedRef.current = true;
        toast.success("WhatsApp conectado!");
        onConnected();
      }
    } catch (err) {
      console.error("[canais] failed to check WAHA status:", err);
    }
  }, [config, onConnected]);

  // Kick off the session once per open + poll status every 5s,
  // bumping qrTrigger while a QR is expected to force the <img> to
  // refetch — same shape as whatsapp-config.tsx's effect.
  useEffect(() => {
    if (!open || !config) {
      startedRef.current = false;
      connectedRef.current = false;
      setShowPairing(false);
      setPairingCode("");
      setPairingError(null);
      return;
    }

    if (!startedRef.current) {
      startedRef.current = true;
      apiFetch("/api/whatsapp/waha/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: config.waha_session, id: config.id }),
      }).catch((err) => console.error("[canais] waha/start failed:", err));
    }

    checkStatus();
    const interval = setInterval(() => {
      checkStatus();
      if (QR_STATUSES.has(status)) setQrTrigger((prev) => prev + 1);
    }, POLL_MS);

    return () => clearInterval(interval);
    // `status` is a dep so the interval is recreated on every status
    // change — otherwise the closure over `status` goes stale and
    // qrTrigger stops reacting to real transitions (matches
    // whatsapp-config.tsx's own effect, which lists sessionStatus as a
    // dep for the same reason).
  }, [open, config?.id, status, checkStatus]);

  async function handlePairingSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!config) return;
    let phoneCleaned = pairingPhone.replace(/\D/g, "");
    if ((phoneCleaned.length === 10 || phoneCleaned.length === 11) && !phoneCleaned.startsWith("55")) {
      phoneCleaned = "55" + phoneCleaned;
      setPairingPhone(phoneCleaned);
    }
    setPairingLoading(true);
    setPairingError(null);
    setPairingCode("");
    try {
      const res = await apiFetch("/api/whatsapp/waha/pairing-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phoneNumber: phoneCleaned,
          session: config.waha_session,
          configId: config.id,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to request pairing code");
      setPairingCode(data.code);
      toast.success("Código de pareamento gerado!");
    } catch (err) {
      setPairingError(err instanceof Error ? err.message : "Failed to generate code");
      toast.error(err instanceof Error ? err.message : "Erro ao gerar código");
    } finally {
      setPairingLoading(false);
    }
  }

  if (!config) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <QrCode className="size-4" />
            Conectar {config.waha_session}
          </DialogTitle>
          <DialogDescription>
            Abra o WhatsApp no celular → Dispositivos conectados → Conectar dispositivo, e escaneie
            o QR abaixo.
          </DialogDescription>
        </DialogHeader>

        {!showPairing ? (
          <div className="space-y-3">
            <div className="flex items-center justify-center rounded-xl border border-border bg-muted/30 p-4">
              {status === "WORKING" ? (
                <p className="text-sm font-medium text-[#14532D]">Conectado!</p>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`/api/whatsapp/waha/qr?session=${encodeURIComponent(config.waha_session ?? "")}&id=${encodeURIComponent(config.id)}&t=${qrTrigger}`}
                  alt="QR code de conexão"
                  className="size-56 rounded-lg bg-white p-2"
                />
              )}
            </div>
            <p className="text-center text-xs text-muted-foreground">Status: {status}</p>
            <Button variant="outline" className="w-full" onClick={() => setShowPairing(true)}>
              <KeyRound className="size-4" />
              Usar código de pareamento
            </Button>
          </div>
        ) : (
          <form onSubmit={handlePairingSubmit} className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="pairing-phone">Número de telefone (com DDI/DDD)</Label>
              <Input
                id="pairing-phone"
                value={pairingPhone}
                onChange={(e) => setPairingPhone(e.target.value)}
                placeholder="5511999999999"
                disabled={pairingLoading}
              />
            </div>
            {pairingCode && (
              <p className="text-center text-2xl font-semibold tracking-widest text-foreground">
                {pairingCode}
              </p>
            )}
            {pairingError && <p className="text-sm text-destructive">{pairingError}</p>}
            <div className="flex justify-between gap-2">
              <Button type="button" variant="outline" onClick={() => setShowPairing(false)}>
                Usar QR code
              </Button>
              <Button type="submit" disabled={pairingLoading}>
                {pairingLoading ? "Gerando…" : "Gerar código"}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
