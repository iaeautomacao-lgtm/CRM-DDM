"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { privateChatMediaUrl } from '@/lib/storage/chat-media';
import type { Message, MessageReaction } from "@/types";
import {
  Clock,
  Check,
  CheckCheck,
  XCircle,
  FileText,
  MapPin,
  LayoutTemplate,
  ImageOff,
  CornerDownLeft,
  BarChart2,
  User,
  Trash2,
  Megaphone,
  Download,
  ExternalLink,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Eye,
  Bot,
} from "lucide-react";
import { format } from "date-fns";
import { ReplyQuote } from "./reply-quote";
import { MessageReactions } from "./message-reactions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

interface MessageBubbleProps {
  message: Message;
  /** Pre-computed quote info for messages that reply to another. */
  reply?: { authorLabel: string; preview: string } | null;
  reactions?: MessageReaction[];
  currentUserId?: string;
  onToggleReaction?: (emoji: string) => void;
  /** Campanha do Disparador ligada à mensagem (message.campaign_id). `href`
   *  só para quem pode abrir a campanha (owner/admin). */
  campaign?: { name: string; href: string | null } | null;
  /** Autor acima da bolha (item 21 do PRD 23): "Você", o atendente com a cor
   *  dele, ou "Automação". null = mesma pessoa da mensagem anterior. */
  author?: { label: string; className: string; bot: boolean } | null;
}

/** Nome da campanha, como link quando o usuário pode abri-la. */
function CampaignName({ campaign }: { campaign: { name: string; href: string | null } }) {
  return campaign.href ? (
    <Link href={campaign.href} className="font-semibold underline-offset-2 hover:underline">
      {campaign.name}
    </Link>
  ) : (
    <span className="font-semibold">{campaign.name}</span>
  );
}

// Só aparece em bolhas de saída (tom suave da marca, redesenho DDM): os
// ícones usam o cinza do horário; azul fica reservado para "lida". Como "entregue" e
// "lida" diferem só pela cor, cada ícone leva rótulo para leitor de tela.
function StatusIcon({ status }: { status: Message["status"] }) {
  switch (status) {
    case "sending":
      return <Clock role="img" aria-label="Enviando" className="h-3 w-3 text-muted-foreground" />;
    case "sent":
      return <Check role="img" aria-label="Enviada" className="h-3 w-3 text-muted-foreground" />;
    case "delivered":
      return <CheckCheck role="img" aria-label="Entregue" className="h-3 w-3 text-muted-foreground" />;
    case "read":
      return <CheckCheck role="img" aria-label="Lida" className="h-3 w-3 text-sky-600 dark:text-sky-400" />;
    case "failed":
      return (
        <span className="inline-flex items-center gap-0.5 rounded bg-red-500 px-1 text-xs font-medium text-white">
          <XCircle className="h-3 w-3" aria-hidden="true" />
          Falha no envio
        </span>
      );
    default:
      return null;
  }
}

function MediaUnavailable({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <ImageOff className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span>{label} indisponível</span>
    </div>
  );
}

function MediaImage({ url, alt }: { url: string; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setError(false);
    setLoading(true);

    const load = async () => {
      try {
        // WAHA fallback/proxy precisa de fetch autenticado antes de virar src.
        // /api/chat-media pode ficar como URL: o navegador segue o redirect
        // autenticado para a signed URL de curta duração.
        if (url.startsWith("/api/whatsapp/media/")) {
          const res = await fetch(url, { credentials: "include" });
          if (!res.ok) throw new Error("Failed to load media");
          const blob = await res.blob();
          objectUrl = URL.createObjectURL(blob);
          if (!cancelled) setSrc(objectUrl);
        } else if (!cancelled) {
          setSrc(url);
        }
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);

  useEffect(() => {
    if (!viewerOpen) setZoom(1);
  }, [viewerOpen]);

  const downloadImage = useCallback(async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("download failed");
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const rawName = decodeURIComponent(url.split("?")[0].split("/").pop() || "imagem");
      const hasExtension = /\.[a-z0-9]{2,5}$/i.test(rawName);
      const extension = blob.type === "image/png" ? ".png"
        : blob.type === "image/webp" ? ".webp"
        : blob.type === "image/gif" ? ".gif"
        : ".jpg";
      anchor.href = objectUrl;
      anchor.download = hasExtension ? rawName : `${rawName || "imagem"}${extension}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch {
      // Fallback para mídia externa sem CORS: abre o original para o
      // navegador oferecer suas próprias ações de salvar.
      window.open(src ?? url, "_blank", "noopener,noreferrer");
    } finally {
      setDownloading(false);
    }
  }, [downloading, src, url]);

  if (error) {
    return (
      <div className="flex h-40 w-60 items-center justify-center rounded-lg bg-muted">
        <ImageOff className="h-8 w-8 text-muted-foreground" />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-40 w-60 items-center justify-center rounded-lg bg-muted">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setViewerOpen(true)}
        className="block cursor-zoom-in rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Ampliar imagem"
      >
        <img
          src={src ?? ""}
          alt={alt}
          className="max-h-64 max-w-60 rounded-lg object-cover"
          onError={() => setError(true)}
        />
      </button>

      <Dialog open={viewerOpen} onOpenChange={setViewerOpen}>
        <DialogContent
          showCloseButton
          className="h-[92dvh] max-h-[92dvh] w-[96vw] max-w-[96vw] overflow-hidden bg-background/95 p-0 sm:max-w-[96vw]"
        >
          <DialogTitle className="sr-only">Visualizar imagem</DialogTitle>
          <div className="absolute left-3 top-3 z-20 flex items-center gap-1 rounded-lg border border-border bg-background/90 p-1 shadow-sm">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setZoom((z) => Math.max(0.5, Number((z - 0.25).toFixed(2))))}
              aria-label="Diminuir zoom"
            >
              <ZoomOut className="h-4 w-4" />
            </Button>
            <span className="min-w-12 text-center text-xs tabular-nums text-muted-foreground">
              {Math.round(zoom * 100)}%
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setZoom((z) => Math.min(4, Number((z + 0.25).toFixed(2))))}
              aria-label="Aumentar zoom"
            >
              <ZoomIn className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setZoom(1)}
              aria-label="Restaurar zoom"
            >
              <RotateCcw className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => void downloadImage()}
              disabled={downloading}
              aria-label="Salvar imagem"
            >
              <Download className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => window.open(src ?? url, "_blank", "noopener,noreferrer")}
              aria-label="Abrir imagem original"
            >
              <ExternalLink className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex h-full w-full items-center justify-center overflow-auto p-12">
            <img
              src={src ?? ""}
              alt={alt}
              className="max-h-none max-w-none object-contain transition-transform duration-100"
              style={{ transform: `scale(${zoom})`, transformOrigin: "center" }}
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}


function documentNameFromUrl(url: string): string | null {
  try {
    const raw = decodeURIComponent(url.split("?")[0].split("/").pop() || "");
    if (!raw || !/\.[a-z0-9]{2,6}$/i.test(raw)) return null;
    return raw.replace(/^\d{10,}-/, "");
  } catch {
    return null;
  }
}

function canPreviewDocument(url: string, fileName: string | null): boolean {
  if (fileName && /\.(pdf|png|jpe?g|webp|gif)$/i.test(fileName)) return true;
  // Meta proxy não carrega extensão no path; ele normaliza Content-Type no
  // servidor, então PDFs/imagens continuam seguros para render inline.
  return url.startsWith("/api/whatsapp/media/");
}

function MediaDocument({
  url,
  label,
}: {
  url: string;
  label: string | null;
}) {
  const [viewerOpen, setViewerOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const fileName = documentNameFromUrl(url);
  const title = fileName || label || "Documento";
  const caption = label && label !== title ? label : null;
  const previewable = canPreviewDocument(url, fileName);

  const downloadDocument = useCallback(async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("download failed");
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download =
        fileName ||
        `documento.${
          blob.type === "application/pdf"
            ? "pdf"
            : blob.type === "image/png"
              ? "png"
              : blob.type === "image/webp"
                ? "webp"
                : blob.type === "image/jpeg"
                  ? "jpg"
                  : "bin"
        }`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch {
      window.open(url, "_blank", "noopener,noreferrer");
    } finally {
      setDownloading(false);
    }
  }, [downloading, fileName, url]);

  return (
    <>
      <div className="min-w-56 max-w-72 overflow-hidden rounded-lg border border-border/50 bg-muted/35">
        <button
          type="button"
          onClick={() => previewable && setViewerOpen(true)}
          disabled={!previewable}
          className={cn(
            "flex w-full items-center gap-3 px-3 py-3 text-left",
            previewable && "transition-colors hover:bg-muted/60",
          )}
          aria-label={previewable ? `Visualizar ${title}` : title}
        >
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-background/55">
            <FileText className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          </div>

          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{title}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {previewable ? "Visualizar no CRM" : "Arquivo para download"}
            </p>
          </div>

          {previewable && <Eye className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
        </button>

        <div className="flex items-center gap-1 border-t border-border/50 px-2 py-1.5">
          {previewable && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setViewerOpen(true)}
            >
              <Eye className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              Visualizar
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => void downloadDocument()}
            disabled={downloading}
          >
            <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            Baixar
          </Button>
        </div>
      </div>

      {caption && (
        <p className="mt-1 whitespace-pre-wrap break-words text-sm">
          {caption}
        </p>
      )}

      <Dialog open={viewerOpen} onOpenChange={setViewerOpen}>
        <DialogContent
          showCloseButton
          className="h-[92dvh] max-h-[92dvh] w-[96vw] max-w-[96vw] overflow-hidden bg-background p-0 sm:max-w-[96vw]"
        >
          <DialogTitle className="sr-only">Visualizar {title}</DialogTitle>

          <div className="flex h-12 items-center justify-between gap-3 border-b border-border px-3 pr-12">
            <div className="flex min-w-0 items-center gap-2">
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="truncate text-sm font-medium">{title}</span>
            </div>

            <div className="flex shrink-0 items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void downloadDocument()}
                disabled={downloading}
              >
                <Download className="mr-1.5 h-4 w-4" aria-hidden="true" />
                Baixar
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => window.open(url, "_blank", "noopener,noreferrer")}
                aria-label="Abrir arquivo em nova aba"
              >
                <ExternalLink className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <iframe
            src={url}
            title={title}
            className="h-[calc(92dvh-3rem)] w-full border-0 bg-muted/20"
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

function MessageContent({ message: originalMessage }: { message: Message }) {
  const message = { ...originalMessage, media_url: originalMessage.media_url ? privateChatMediaUrl(originalMessage.media_url) : null };
  switch (message.content_type) {
    case "text":
      return (
        <p className="whitespace-pre-wrap break-words text-[13.5px] leading-normal">
          {message.content_text}
        </p>
      );

    case "image":
      return (
        <div>
          {message.media_url ? (
            <MediaImage url={message.media_url} alt="Imagem compartilhada" />
          ) : (
            <MediaUnavailable label="Imagem" />
          )}
          {message.content_text && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {message.content_text}
            </p>
          )}
        </div>
      );

    case "video":
      return (
        <div>
          {message.media_url ? (
            <video
              src={message.media_url}
              controls
              className="max-h-64 max-w-60 rounded-lg"
            />
          ) : (
            <MediaUnavailable label="Vídeo" />
          )}
          {message.content_text && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {message.content_text}
            </p>
          )}
        </div>
      );

    case "audio":
      return (
        <div>
          {message.media_url ? (
            <audio src={message.media_url} controls className="max-w-60" />
          ) : (
            <MediaUnavailable label="Áudio" />
          )}
        </div>
      );

    case "document":
      if (!message.media_url) {
        return <MediaUnavailable label={message.content_text || "Documento"} />;
      }
      return (
        <MediaDocument
          url={message.media_url}
          label={message.content_text ?? null}
        />
      );

    case "template":
      return (
        <div>
          <span className="mb-1 inline-flex items-center gap-1 rounded bg-primary/20 px-1.5 py-0.5 text-xs font-medium text-primary">
            <LayoutTemplate className="h-3 w-3" />
            {message.template_name ? `Template · ${message.template_name}` : "Template"}
          </span>
          {message.content_text && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {message.content_text}
            </p>
          )}
        </div>
      );

    case "location":
      return (
        <div className="flex items-center gap-2 text-sm">
          <MapPin className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span>{message.content_text || "Localização compartilhada"}</span>
        </div>
      );

    case "interactive": {
      // Customer tapped a reply button or list row on a message the bot
      // sent. We show the tapped option's title (already in content_text,
      // set by parseMessageContent in the webhook) with a small affordance
      // so agents reading the inbox can tell at a glance that this is a
      // tap rather than the customer typing the same words.
      return (
        <div className="flex flex-col gap-0.5">
          <span className="inline-flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <CornerDownLeft className="h-3 w-3" />
            Resposta de botão
          </span>
          <p className="whitespace-pre-wrap break-words text-[13.5px] leading-normal">
            {message.content_text || "[Resposta interativa]"}
          </p>
        </div>
      );
    }

    case "sticker":
      return (
        <div className="bg-transparent p-0">
          {message.media_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={message.media_url}
              alt="Figurinha"
              className="max-h-36 max-w-36 bg-transparent object-contain"
            />
          ) : (
            <MediaUnavailable label="Figurinha" />
          )}
        </div>
      );

    case "poll":
      return (
        <div className="flex flex-col gap-2 rounded-lg bg-muted/30 p-3 border border-border/40 min-w-48">
          <div className="flex items-center gap-2 font-semibold text-sm">
            <BarChart2 className="h-4 w-4 text-primary" />
            <span>{message.content_text || "Enquete"}</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Votação ativa no WhatsApp.
          </p>
        </div>
      );

    case "vcard":
      return (
        <div className="flex items-center gap-3 rounded-lg bg-muted/40 p-3 border border-border/40 min-w-48">
          <div className="h-10 w-10 shrink-0 flex items-center justify-center rounded-full bg-primary/10">
            <User className="h-5 w-5 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground truncate">
              {message.content_text || "Contato Compartilhado"}
            </p>
            <p className="text-xs text-muted-foreground">
              vCard de Contato
            </p>
          </div>
        </div>
      );

    case "revoked":
      return (
        <div className="flex items-center gap-2 text-sm text-muted-foreground italic">
          <Trash2 className="h-4 w-4 shrink-0 text-muted-foreground/60" />
          <span>Mensagem apagada</span>
        </div>
      );

    default:
      return (
        <p className="whitespace-pre-wrap break-words text-[13.5px] leading-normal">
          {message.content_text || "[Tipo de mensagem não suportado]"}
        </p>
      );
  }
}

export function MessageBubble({
  message,
  reply,
  reactions,
  currentUserId,
  onToggleReaction,
  campaign,
  author,
}: MessageBubbleProps) {
  const isAgent = message.sender_type === "agent" || message.sender_type === "bot";
  const isBot = message.sender_type === "bot";
  // Mensagem do disparo (saída) ganha faixa no topo; a resposta do cliente
  // ganha uma linha abaixo dizendo a qual campanha ela responde.
  const campaignSend = isAgent && campaign ? campaign : null;
  const campaignReply = !isAgent && campaign && message.attribution_method ? campaign : null;
  const time = new Date(message.received_at ?? message.created_at).toLocaleTimeString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });

  // Row alignment + width cap are owned by <MessageActions> so its hover
  // group matches the bubble's content area, not the full row.
  return (
    <div
      className={cn(
        "flex flex-col",
        isAgent ? "items-end" : "items-start",
        author && "mt-2",
      )}
    >
      {author && (
        <span className={cn("mx-1 mb-1 inline-flex items-center gap-[5px] text-[11.5px] font-semibold", author.className)}>
          {author.bot && <Bot className="size-3" aria-hidden="true" />}
          {author.label}
        </span>
      )}
      <div
        className={cn(
          "relative border px-3 pb-[7px] pt-[9px] text-foreground",
          message.content_type === "sticker"
            ? "border-transparent bg-transparent p-0"
            : isBot
              ? "rounded-[12px_12px_4px_12px] border-bubble-bot-border bg-bubble-bot"
              : isAgent
                ? "rounded-[12px_12px_4px_12px] border-bubble-out-border bg-bubble-out"
                : "rounded-[12px_12px_12px_4px] border-bubble-in-border bg-bubble-in",
        )}
      >
        {campaignSend && (
          <div className="mb-1.5 flex items-center gap-1 border-b border-border pb-1 text-xs text-muted-foreground">
            <Megaphone className="h-3 w-3 shrink-0" />
            <span>
              Campanha: <CampaignName campaign={campaignSend} />
            </span>
          </div>
        )}
        {reply && (
          <ReplyQuote
            authorLabel={reply.authorLabel}
            preview={reply.preview}
            onPrimary={false}
          />
        )}
        <MessageContent message={message} />
        <div
          className="mt-[3px] flex items-center justify-end gap-1 text-[11px] tabular-nums text-muted-foreground"
        >
          {/* Bot = IA, fluxo, automação ou disparo — sem rótulo acima (ex.: bolha
              agrupada), o selo continua aqui para distinguir do atendente. */}
          {isBot && !author && (
            <span className="inline-flex items-center" title="Enviada por automação (IA, fluxo ou disparo)">
              <Bot className="size-3" aria-hidden="true" />
              <span className="sr-only">Automação</span>
            </span>
          )}
          <span>{time}</span>
          {isAgent && <StatusIcon status={message.status} />}
        </div>
      </div>
      {campaignReply && (
        <p
          className="mt-0.5 flex items-center gap-1 px-1 text-xs text-muted-foreground"
          title={
            message.attribution_method === "context"
              ? "O cliente respondeu citando a mensagem da campanha"
              : "Último disparo para este contato nos 7 dias anteriores à resposta"
          }
        >
          <Megaphone className="h-3 w-3 shrink-0" />
          <span>
            {message.attribution_method === "context" ? "Resposta à campanha" : "Provável resposta à campanha"}{" "}
            <CampaignName campaign={campaignReply} />
          </span>
        </p>
      )}
      {reactions && reactions.length > 0 && onToggleReaction && (
        <MessageReactions
          reactions={reactions}
          currentUserId={currentUserId}
          onToggle={onToggleReaction}
        />
      )}
    </div>
  );
}
