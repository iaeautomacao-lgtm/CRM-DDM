import type { Metadata, Viewport } from "next";
import { WebchatClient } from "@/components/webchat/webchat-client";

// /w/[token] — página pública do Webchat (aberta pelo botão/link enviado
// no WhatsApp). Fora do grupo (dashboard): sem login, sem menu. Toda a
// autorização é o token, validado pelas rotas /api/webchat/[token]/*.

export const metadata: Metadata = {
  title: "Atendimento",
  robots: { index: false, follow: false },
  // O link é a credencial do cliente: não vazar no Referer ao abrir links
  // externos enviados na conversa.
  referrer: "no-referrer",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Zoom liberado (WCAG 1.4.4, decisão do dono 13/10). O campo de texto tem 16px
  // (text-base), então o iOS não dá zoom automático ao focar.
  // Teclado virtual encolhe a página em vez de cobrir o campo de texto.
  interactiveWidget: "resizes-content",
};

export default async function WebchatPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <WebchatClient token={token} />;
}
