"use client";

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
  KeyboardEvent,
} from "react";
import {
  Send,
  LayoutTemplate,
  Paperclip,
  Image as ImageIcon,
  Video,
  FileText,
  Mic,
  Square,
  X,
  Loader2,
  Zap,
  AlertTriangle,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { GatedButton } from "@/components/ui/gated-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { usePermissions } from "@/hooks/use-permission";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api-fetch";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  uploadAccountMedia,
  deleteAccountMedia,
  MEDIA_MAX_BYTES_BY_KIND,
} from "@/lib/storage/upload-media";
import { ReplyQuote } from "./reply-quote";
import { QuickReplyMenu, QUICK_REPLY_MENU_ID } from "./quick-reply-menu";
import { trackQuickReplyUse, useQuickReplies } from "@/hooks/use-quick-replies";
import { useAuth } from "@/hooks/use-auth";
import {
  filterQuickReplies,
  matchSlashQuery,
  renderQuickReply,
  type QuickReply,
} from "@/lib/quick-replies";

/** Media content types an agent can send from the composer. */
export type ComposerMediaKind = "image" | "video" | "document" | "audio";

/** Supabase Storage bucket holding agent-sent chat attachments (migration 023). */
export const CHAT_MEDIA_BUCKET = "chat-media";

/** Meta caps media captions at 1024 chars. Enforced here and in the send route. */
export const MEDIA_CAPTION_MAX = 1024;

/** Hard cap on a single voice recording so it can't blow the upload/
 *  transcode limits — auto-stops the recorder when reached. */
const MAX_RECORDING_SECONDS = 5 * 60;

export interface SendMediaPayload {
  kind: ComposerMediaKind;
  /** Public chat-media URL Meta fetches at send time. */
  mediaUrl: string;
  /** Storage object path — lets the caller GC the object if the send fails. */
  path: string;
  /** Optional caption (image/video/document only). */
  caption?: string;
  /** Original file name — surfaced to the recipient for documents. */
  filename?: string;
  replyToId?: string;
}

interface ReplyDraft {
  /** Internal UUID of the message being replied to — sent back through onSend. */
  id: string;
  authorLabel: string;
  preview: string;
}

// Mirrors the chat-media bucket's allowed_mime_types (migration 023) for
// the file picker so unsupported files are rejected before upload rather
// than failing with a confusing Storage error. Audio has no picker — it's
// captured via the recorder.
const PICKER_ACCEPT: Record<"image" | "video" | "document", string> = {
  image: "image/png,image/jpeg,image/webp",
  video: "video/mp4,video/3gpp",
  document:
    "application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain",
};

export interface MediaDraft {
  kind: ComposerMediaKind;
  mediaUrl: string;
  /** Storage path — used to GC the object if the draft is discarded. */
  path: string;
  filename: string;
  caption: string;
}

/**
 * Handed back by the Undo-Send "Editar" action so the composer can restore
 * what the agent typed/attached. Each recall carries an `id` purely so a new
 * recall (even one with identical content) is a distinct object reference —
 * the composer's effect keys off that to apply it exactly once.
 */
export type RecallDraft =
  | { id: string; text: string }
  | { id: string; media: MediaDraft };

interface MessageComposerProps {
  conversationId: string;
  sessionExpired: boolean;
  onSend: (text: string, replyToId?: string) => void;
  onSendMedia: (payload: SendMediaPayload) => void;
  /** Ausente no Webchat (template é recurso do WhatsApp): o botão some. */
  onOpenTemplates?: () => void;
  replyTo?: ReplyDraft | null;
  onClearReply?: () => void;
  /** Set by the parent when an Undo-Send "Editar" click recalls a pending
   *  message back into the composer. */
  recall?: RecallDraft | null;
  /** Fired once the recall above has been applied, so the parent can clear it. */
  onRecallHandled?: () => void;
  /** Nome do contato para {nome}/{primeiro_nome} das respostas rápidas. */
  contactName?: string | null;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Worker that encodes mic input to Ogg/Opus entirely in the browser
 *  (vendored from opus-recorder into /public). Recording client-side in a
 *  Meta-accepted format means no server ffmpeg / transcode step. */
const OPUS_ENCODER_PATH = "/opus/encoderWorker.min.js";

export function MessageComposer({
  conversationId,
  sessionExpired,
  onSend,
  onSendMedia,
  onOpenTemplates,
  replyTo,
  onClearReply,
  recall,
  onRecallHandled,
  contactName,
}: MessageComposerProps) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Media attachment state. `draft` holds an uploaded-but-not-yet-sent
  // attachment; `busy` covers the upload/transcode window.
  const [draft, setDraft] = useState<MediaDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const documentInputRef = useRef<HTMLInputElement>(null);
  // Mirror of `draft` for the unmount cleanup, which can't read render
  // state. Kept in sync below so navigating away with a staged-but-unsent
  // attachment GCs the orphaned object.
  const draftRef = useRef<MediaDraft | null>(null);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  // Best-effort GC of a staged object the user never sent. Fire-and-forget.
  const removeStaged = useCallback((path: string | undefined) => {
    if (!path) return;
    void deleteAccountMedia(CHAT_MEDIA_BUCKET, path).catch(() => {});
  }, []);

  // Voice recording state. The recorder encodes Ogg/Opus in-browser
  // (opus-recorder) so there's no server-side transcode.
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const recorderRef = useRef<import("opus-recorder").default | null>(null);
  const cancelledRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Viewers (read-only role) can browse the inbox but never send.
  // For solo users this is always true — single-owner accounts pass
  // every capability — so the disabled branch is a no-op there.
  const { can, canOpen } = usePermissions();
  const canSend = can("inbox.reply");
  const readOnly = !canSend;
  // Media (like free-form text) is only allowed inside the 24h window.
  const inputsDisabled = readOnly || sessionExpired;

  // PRD 23, item 18 — IA no texto do operador (POST /api/ai/rewrite, #220):
  // devolve o rascunho corrigido + uma variação por tom. Nada é enviado: a
  // escolha só troca o rascunho, o operador revisa e envia. Usa a chave de IA
  // da conta (409 ai_not_configured quando não há) e tem limite por usuário.
  const canRewrite = can("inbox.ai_assist");
  const [rewriting, setRewriting] = useState(false);
  const [rewriteOpen, setRewriteOpen] = useState(false);
  const [rewriteOptions, setRewriteOptions] = useState<{ key: string; label: string; text: string }[]>([]);

  const requestRewrite = async () => {
    const draft = text.trim();
    if (!draft || rewriting) return;
    setRewriting(true);
    try {
      const res = await apiFetch("/api/ai/rewrite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: draft, tones: ["formal", "cordial", "objetivo"] }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        corrected?: string;
        variations?: { tone: string; label: string; text: string }[];
        error?: string;
        code?: string;
      };
      if (!res.ok) {
        toast.error(
          json.code === "ai_not_configured"
            ? "A IA não está configurada nesta conta. Peça a um administrador para cadastrar a chave."
            : json.error ?? "Não foi possível revisar o texto agora",
        );
        return;
      }
      const options = [
        ...(json.corrected ? [{ key: "corrected", label: "Corrigido", text: json.corrected }] : []),
        ...(json.variations ?? []).map((v) => ({ key: v.tone, label: v.label, text: v.text })),
      ];
      if (options.length === 0) {
        toast.error("A IA não devolveu sugestões para este texto");
        return;
      }
      setRewriteOptions(options);
      setRewriteOpen(true);
    } finally {
      setRewriting(false);
    }
  };

  const applyRewrite = (value: string) => {
    setText(value);
    setRewriteOpen(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Tear down any live recording + timer on unmount so a mid-record
  // navigation doesn't leak the mic, and GC a staged-but-unsent
  // attachment so it doesn't orphan in the bucket.
  useEffect(() => {
    return () => {
      clearTimer();
      cancelledRef.current = true;
      // stop() releases the mic stream + audio context inside opus-recorder.
      void recorderRef.current?.stop().catch(() => {});
      removeStaged(draftRef.current?.path);
    };
  }, [clearTimer, removeStaged]);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    // Max 4 lines (~96px)
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
  }, []);

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || sending || sessionExpired) return;

    setSending(true);
    try {
      onSend(trimmed, replyTo?.id);
      setText("");
      try {
        localStorage.removeItem(`wacrm:draft:${conversationId}`);
      } catch {}
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    } finally {
      setSending(false);
    }
  }, [text, sending, sessionExpired, onSend, replyTo?.id, conversationId]);

  // ---- Respostas rápidas ("/atalho" ou botão ⚡) ----------------------
  const { profile } = useAuth();
  const { replies: quickReplies, loading: quickRepliesLoading } = useQuickReplies();
  const canManageQuickReplies = canOpen("/respostas-rapidas");
  // start = posição da "/" no texto; null = aberto pelo botão (insere no
  // cursor). Menu fechado = qr null.
  const [qr, setQr] = useState<{ start: number | null; query: string } | null>(null);
  const [qrIndex, setQrIndex] = useState(0);
  const qrQuery = qr?.query ?? null;
  const qrFromButton = qr !== null && qr.start === null;
  const qrItems = useMemo(
    () =>
      qrQuery === null
        ? []
        : qrFromButton
          ? quickReplies
          : filterQuickReplies(quickReplies, qrQuery),
    [quickReplies, qrQuery, qrFromButton],
  );

  const closeQuickReplies = useCallback(() => {
    setQr(null);
    setQrIndex(0);
  }, []);

  const saveDraft = useCallback(
    (val: string) => {
      try {
        if (val) localStorage.setItem(`wacrm:draft:${conversationId}`, val);
        else localStorage.removeItem(`wacrm:draft:${conversationId}`);
      } catch (err) {
        console.error("[Draft] Failed to save draft:", err);
      }
    },
    [conversationId],
  );

  const pickQuickReply = useCallback(
    (reply: QuickReply) => {
      const el = textareaRef.current;
      const rendered = renderQuickReply(reply.content, {
        contactName,
        agentName: profile?.full_name ?? null,
      });
      const caret = el?.selectionStart ?? text.length;
      // Pelo "/": troca "/consulta" pelo texto. Pelo botão: insere no cursor.
      const from = qr?.start ?? caret;
      const to = qr?.start != null ? qr.start + 1 + qr.query.length : (el?.selectionEnd ?? caret);
      const next = text.slice(0, from) + rendered + text.slice(to);
      setText(next);
      saveDraft(next);
      closeQuickReplies();
      trackQuickReplyUse(reply.id);
      requestAnimationFrame(() => {
        const t = textareaRef.current;
        if (!t) return;
        t.focus();
        const pos = from + rendered.length;
        t.setSelectionRange(pos, pos);
        adjustHeight();
      });
    },
    [contactName, profile?.full_name, text, qr, saveDraft, closeQuickReplies, adjustHeight],
  );

  // Trocar de conversa fecha o menu.
  useEffect(() => {
    closeQuickReplies();
  }, [conversationId, closeQuickReplies]);

  // Campo esvaziado por fora (envio) fecha o menu aberto pelo "/".
  const textEmpty = text === "";
  const qrStart = qr?.start ?? null;
  useEffect(() => {
    if (textEmpty && qrStart !== null) closeQuickReplies();
  }, [textEmpty, qrStart, closeQuickReplies]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter que confirma composição de IME (acentos) não escolhe nem envia.
      if (e.nativeEvent.isComposing) return;
      if (qr) {
        if (e.key === "Escape") {
          e.preventDefault();
          closeQuickReplies();
          return;
        }
        if (qrItems.length > 0) {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const delta = e.key === "ArrowDown" ? 1 : -1;
            setQrIndex((i) => (i + delta + qrItems.length) % qrItems.length);
            return;
          }
          if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
            e.preventDefault();
            pickQuickReply(qrItems[Math.min(qrIndex, qrItems.length - 1)]);
            return;
          }
        }
        // Menu aberto sem itens (atalho errado ou lista carregando): Enter
        // só fecha — não manda "/bolto" para o cliente.
        if (e.key === "Enter" && !e.shiftKey && qr.start !== null) {
          e.preventDefault();
          closeQuickReplies();
          return;
        }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend, qr, qrItems, qrIndex, pickQuickReply, closeQuickReplies]
  );

  // Load draft on mount / conversationId change
  useEffect(() => {
    if (!conversationId) return;
    try {
      const saved = localStorage.getItem(`wacrm:draft:${conversationId}`);
      setText(saved || "");
      setTimeout(() => {
        adjustHeight();
        // Foca o campo ao abrir/trocar de conversa (no-op se desabilitado).
        // Só com ponteiro fino (desktop): no celular abriria o teclado
        // virtual cobrindo a conversa.
        if (window.matchMedia?.("(pointer: fine)").matches) textareaRef.current?.focus();
      }, 50);
    } catch {
      setText("");
    }
  }, [conversationId, adjustHeight]);

  // Undo-Send "Editar" recall — restores the text or the staged media draft
  // that was pulled back from a pending (not-yet-sent) message. Runs once
  // per recall: `onRecallHandled` clears it on the parent, which flips this
  // effect's `recall` dependency back to null and stops it from reapplying.
  useEffect(() => {
    if (!recall) return;
    if ("text" in recall) {
      setQr(null);
      setText(recall.text);
      requestAnimationFrame(() => {
        adjustHeight();
        textareaRef.current?.focus();
      });
    } else {
      removeStaged(draftRef.current?.path);
      setDraft(recall.media);
    }
    onRecallHandled?.();
  }, [recall, adjustHeight, onRecallHandled, removeStaged]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const val = e.target.value;
      setText(val);
      saveDraft(val);
      // "/" no começo ou depois de espaço abre as respostas rápidas.
      const caret = e.target.selectionStart ?? val.length;
      const match = matchSlashQuery(val.slice(0, caret));
      if (match) {
        if (qr?.query !== match.query || qr?.start !== match.start) setQrIndex(0);
        setQr(match);
      } else if (qr) {
        // Digitar texto comum fecha (senão o Enter inseriria uma resposta
        // em vez de enviar).
        closeQuickReplies();
      }
      adjustHeight();
    },
    [saveDraft, qr, closeQuickReplies, adjustHeight]
  );

  // Upload a captured file to chat-media and stage it as a draft.
  const stageUpload = useCallback(
    async (kind: ComposerMediaKind, file: File) => {
      // Per-kind ceiling mirrors Meta's caps (image 5 MB, etc.) so we
      // reject before upload rather than orphaning an object that Meta
      // would then refuse at send.
      const max = MEDIA_MAX_BYTES_BY_KIND[kind];
      if (file.size > max) {
        toast.error(
          `File is ${(file.size / 1024 / 1024).toFixed(1)} MB — ${kind} limit is ${Math.round(
            max / 1024 / 1024,
          )} MB.`,
        );
        return;
      }
      setBusy(true);
      try {
        const { publicUrl, path } = await uploadAccountMedia(CHAT_MEDIA_BUCKET, file);
        // Replacing an existing draft? GC the previous object first.
        removeStaged(draftRef.current?.path);
        setDraft({ kind, mediaUrl: publicUrl, path, filename: file.name, caption: "" });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Falha no envio do arquivo");
      } finally {
        setBusy(false);
      }
    },
    [removeStaged],
  );

  const handlePicked = useCallback(
    (kind: "image" | "video" | "document", file: File | undefined) => {
      if (file) void stageUpload(kind, file);
    },
    [stageUpload],
  );

  // ---- Voice recording (client-side Ogg/Opus, no server transcode) ---

  // The encoded Ogg/Opus file from opus-recorder → upload as an audio
  // draft. WhatsApp renders Ogg/Opus as a playable voice note.
  const finalizeRecording = useCallback(
    async (bytes: Uint8Array) => {
      // Uint8Array is a valid BlobPart at runtime; the cast sidesteps the
      // lib.dom ArrayBufferLike-vs-ArrayBuffer generic mismatch.
      const file = new File([bytes as unknown as BlobPart], `voice-${Date.now()}.ogg`, {
        type: "audio/ogg",
      });
      if (file.size === 0) return; // cancelled / empty take
      if (file.size > MEDIA_MAX_BYTES_BY_KIND.audio) {
        toast.error("Gravação muito longa (acima de 16 MB).");
        return;
      }
      setBusy(true);
      try {
        const { publicUrl, path } = await uploadAccountMedia(CHAT_MEDIA_BUCKET, file);
        removeStaged(draftRef.current?.path);
        setDraft({ kind: "audio", mediaUrl: publicUrl, path, filename: file.name, caption: "" });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Falha no envio do arquivo");
      } finally {
        setBusy(false);
      }
    },
    [removeStaged],
  );

  const startRecording = useCallback(async () => {
    if (inputsDisabled || busy || recording) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined") {
      toast.error("Gravação de voz não suportada neste navegador.");
      return;
    }
    try {
      // Lazy-load the encoder (≈400 KB worker) only when the user records,
      // keeping it out of the main bundle.
      const { default: Recorder } = await import("opus-recorder");
      const recorder = new Recorder({
        encoderPath: OPUS_ENCODER_PATH,
        numberOfChannels: 1,
        encoderApplication: 2048, // VOIP — tuned for speech
        encoderSampleRate: 48000,
        streamPages: false, // one callback with the complete file on stop
      });
      cancelledRef.current = false;
      recorder.ondataavailable = (bytes) => {
        if (cancelledRef.current) return;
        void finalizeRecording(bytes);
      };
      recorderRef.current = recorder;
      await recorder.start();
      setRecording(true);
      setRecordSeconds(0);
      timerRef.current = setInterval(() => setRecordSeconds((s) => s + 1), 1000);
    } catch {
      void recorderRef.current?.stop().catch(() => {});
      recorderRef.current = null;
      toast.error("Acesso ao microfone negado ou indisponível.");
    }
  }, [inputsDisabled, busy, recording, finalizeRecording]);

  const stopRecording = useCallback(() => {
    clearTimer();
    setRecording(false);
    void recorderRef.current?.stop().catch(() => {});
  }, [clearTimer]);

  const cancelRecording = useCallback(() => {
    cancelledRef.current = true;
    clearTimer();
    setRecording(false);
    void recorderRef.current?.stop().catch(() => {});
  }, [clearTimer]);

  // Auto-stop at the cap so a forgotten recording can't blow the
  // upload size limit.
  useEffect(() => {
    if (recording && recordSeconds >= MAX_RECORDING_SECONDS) {
      stopRecording();
    }
  }, [recording, recordSeconds, stopRecording]);

  // ---- Draft send / discard -----------------------------------------

  const sendDraft = useCallback(() => {
    if (!draft || busy) return;
    onSendMedia({
      kind: draft.kind,
      mediaUrl: draft.mediaUrl,
      path: draft.path,
      // Audio takes no caption (Meta rejects it). Everything else: the
      // trimmed caption, or undefined when blank.
      caption:
        draft.kind === "audio" ? undefined : draft.caption.trim() || undefined,
      filename: draft.kind === "document" ? draft.filename : undefined,
      replyToId: replyTo?.id,
    });
    // The object is now owned by the sent message — clear without GC.
    setDraft(null);
    onClearReply?.();
  }, [draft, busy, onSendMedia, replyTo?.id, onClearReply]);

  // Discard GCs the staged object — it was uploaded but never sent.
  const discardDraft = useCallback(() => {
    removeStaged(draft?.path);
    setDraft(null);
  }, [draft?.path, removeStaged]);

  const setCaption = useCallback((caption: string) => {
    setDraft((d) => (d ? { ...d, caption } : d));
  }, []);

  // ---- Render --------------------------------------------------------

  return (
    <div className="shrink-0 border-t border-border bg-card px-3 pb-4 pt-3 sm:px-6">
      <div className="mx-auto w-full max-w-[760px]">
      {replyTo && (
        <div className="mb-2">
          <ReplyQuote
            authorLabel={replyTo.authorLabel}
            preview={replyTo.preview}
            onDismiss={onClearReply}
          />
        </div>
      )}
      {sessionExpired && (
        <div className="mb-2.5 flex animate-ddm-fade flex-wrap items-center gap-3 rounded-[10px] border border-warning-border bg-warning-soft px-3.5 py-3" role="status">
          <AlertTriangle className="size-4 shrink-0 text-warning" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold text-foreground">Janela de 24 horas expirada</p>
            <p className="mt-0.5 text-[12.5px] text-foreground-2">
              Mensagens livres estão bloqueadas. Envie um template aprovado para retomar o contato.
            </p>
          </div>
          {onOpenTemplates && (
            <button
              type="button"
              onClick={onOpenTemplates}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border-strong bg-card px-3.5 text-[12.5px] font-semibold text-foreground hover:bg-surface-hover"
            >
              <LayoutTemplate className="size-3.5" aria-hidden="true" />
              Enviar template
            </button>
          )}
        </div>
      )}

      {/* Hidden file inputs driven by the attach menu. */}
      <input
        ref={imageInputRef}
        type="file"
        accept={PICKER_ACCEPT.image}
        className="hidden"
        onChange={(e) => {
          handlePicked("image", e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <input
        ref={videoInputRef}
        type="file"
        accept={PICKER_ACCEPT.video}
        className="hidden"
        onChange={(e) => {
          handlePicked("video", e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <input
        ref={documentInputRef}
        type="file"
        accept={PICKER_ACCEPT.document}
        className="hidden"
        onChange={(e) => {
          handlePicked("document", e.target.files?.[0]);
          e.target.value = "";
        }}
      />

      <div className="rounded-[10px] border border-border bg-card focus-within:border-primary focus-within:shadow-[0_0_0_3px_var(--primary-soft-2)]">
      {draft ? (
        <MediaDraftPreview
          draft={draft}
          busy={busy}
          readOnly={readOnly}
          onCaptionChange={setCaption}
          onDiscard={discardDraft}
          onSend={sendDraft}
        />
      ) : recording ? (
        // Recording bar — replaces the composer while the mic is live.
        <div className="flex items-center gap-3 rounded-lg bg-muted/55 px-3 py-2.5">
          <span className="flex h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-red-500" aria-hidden="true" />
          <span className="flex-1 text-sm text-foreground">
            Gravando… {formatDuration(recordSeconds)} /{" "}
            {formatDuration(MAX_RECORDING_SECONDS)}
          </span>
          <button
            type="button"
            onClick={cancelRecording}
            className="min-h-9 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-card hover:text-foreground"
          >
            Cancelar
          </button>
          <Button
            size="sm"
            onClick={stopRecording}
            className="h-9 w-9 shrink-0 bg-primary p-0 hover:bg-primary/90"
            title="Parar e anexar"
            aria-label="Parar gravação e anexar"
          >
            <Square className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      ) : (
        <div className="relative">
          {qr && !inputsDisabled && (
            <QuickReplyMenu
              items={qrItems}
              activeIndex={Math.min(qrIndex, Math.max(qrItems.length - 1, 0))}
              loading={quickRepliesLoading}
              query={qr.query}
              canManage={canManageQuickReplies}
              onPick={pickQuickReply}
              onHover={setQrIndex}
            />
          )}

          <div>
            <textarea
              ref={textareaRef}
              aria-label="Mensagem"
              aria-controls={qr ? QUICK_REPLY_MENU_ID : undefined}
              aria-activedescendant={qr && qrItems.length > 0 ? `${QUICK_REPLY_MENU_ID}-${Math.min(qrIndex, qrItems.length - 1)}` : undefined}
              onBlur={() => {
                if (qr) closeQuickReplies();
              }}
              value={text}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              placeholder={
                readOnly
                  ? "Somente leitura — visualizadores podem navegar mas não responder"
                  : sessionExpired
                    ? "Sessão expirada - use um template"
                    : "Escreva uma mensagem…  Digite / para respostas rápidas"
              }
              disabled={sessionExpired || readOnly}
              rows={2}
              title={
                readOnly
                  ? "Somente leitura — seu perfil não pode enviar mensagens"
                  : "/ para respostas rápidas · Shift+Enter para nova linha"
              }
              className={cn(
                "block w-full min-w-0 resize-none border-0 bg-transparent px-3.5 pb-1 pt-3 text-[13.5px] leading-normal text-foreground placeholder:text-muted-foreground outline-none focus:ring-0",
                (sessionExpired || readOnly) && "cursor-not-allowed opacity-50"
              )}
            />

            <div className="flex items-center justify-between gap-2 px-2 pb-2 pt-1.5">
              <div className="flex min-w-0 items-center gap-0.5">
                <DropdownMenu>
                  <DropdownMenuTrigger
                    disabled={inputsDisabled || busy}
                    title={
                      readOnly
                        ? "Somente leitura — seu perfil não pode enviar mensagens"
                        : inputsDisabled
                          ? undefined
                          : "Anexar mídia"
                    }
                    aria-label={busy ? "Enviando anexo…" : "Anexar mídia"}
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md p-0 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {busy ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <Paperclip className="h-4 w-4" aria-hidden="true" />
                    )}
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="border-border bg-popover">
                    <DropdownMenuItem onClick={() => imageInputRef.current?.click()}>
                      <ImageIcon className="mr-2 h-4 w-4" />
                      Foto
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => videoInputRef.current?.click()}>
                      <Video className="mr-2 h-4 w-4" />
                      Vídeo
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => documentInputRef.current?.click()}>
                      <FileText className="mr-2 h-4 w-4" />
                      Documento
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void startRecording()}>
                      <Mic className="mr-2 h-4 w-4" />
                      Nota de voz
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>

                {onOpenTemplates && (
                  <GatedButton
                    variant="ghost"
                    size="sm"
                    canAct={!readOnly}
                    gateReason="send messages"
                    title={readOnly ? undefined : "Enviar template"}
                    aria-label="Enviar template"
                    className="h-8 w-8 shrink-0 p-0 text-muted-foreground hover:bg-muted hover:text-foreground"
                    onClick={onOpenTemplates}
                  >
                    <LayoutTemplate className="h-4 w-4" aria-hidden="true" />
                  </GatedButton>
                )}

                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={inputsDisabled}
                  title='Respostas rápidas (ou digite "/")'
                  aria-label="Respostas rápidas"
                  aria-expanded={Boolean(qr)}
                  className={cn(
                    "h-8 w-8 shrink-0 p-0 text-muted-foreground hover:bg-muted hover:text-foreground",
                    qr && "text-primary",
                  )}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    if (qr) closeQuickReplies();
                    else {
                      setQrIndex(0);
                      setQr({ start: null, query: "" });
                      textareaRef.current?.focus();
                    }
                  }}
                >
                  <Zap className="h-4 w-4" aria-hidden="true" />
                </Button>

                {canRewrite && (
                  <Popover
                    open={rewriteOpen}
                    // Abre só quando a IA responde (requestRewrite); daqui só fecha.
                    onOpenChange={(next) => {
                      if (!next) setRewriteOpen(false);
                    }}
                  >
                    <PopoverTrigger
                      render={
                        <button
                          type="button"
                          disabled={inputsDisabled || rewriting || !text.trim()}
                          onClick={(e) => {
                            // Abre só depois que a IA responder (requestRewrite).
                            e.preventDefault();
                            void requestRewrite();
                          }}
                          title="Revisar com IA (corrigir e sugerir tons)"
                          aria-label="Revisar texto com IA"
                          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                        />
                      }
                    >
                      {rewriting ? (
                        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                      ) : (
                        <Sparkles className="size-4" aria-hidden="true" />
                      )}
                    </PopoverTrigger>
                    <PopoverContent align="start" side="top" className="w-[360px] max-w-[calc(100vw-2rem)] gap-1.5 p-2">
                      <p className="px-1.5 pb-1 pt-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                        Sugestões da IA · escolha para editar
                      </p>
                      {rewriteOptions.map((opt) => (
                        <button
                          key={opt.key}
                          type="button"
                          onClick={() => applyRewrite(opt.text)}
                          className="flex flex-col gap-1 rounded-md border border-border px-2.5 py-2 text-left hover:border-primary-soft-2 hover:bg-primary-soft"
                        >
                          <span className="text-[11.5px] font-semibold text-primary-text">{opt.label}</span>
                          <span className="line-clamp-4 whitespace-pre-wrap text-[13px] text-foreground">{opt.text}</span>
                        </button>
                      ))}
                      <p className="px-1.5 pt-0.5 text-[11px] text-muted-foreground">Nada é enviado sem você clicar em Enviar.</p>
                    </PopoverContent>
                  </Popover>
                )}
              </div>

              <div className="flex items-center gap-2">
                {!readOnly && !sessionExpired && (
                  <span className="mr-2.5 hidden text-[11.5px] text-muted-foreground sm:inline">
                    Enter envia · Shift+Enter quebra linha
                  </span>
                )}
                <GatedButton
                  size="sm"
                  canAct={!readOnly}
                  gateReason="send messages"
                  disabled={!text.trim() || sessionExpired || sending}
                  aria-label="Enviar mensagem"
                  onClick={handleSend}
                  className="h-8 shrink-0 gap-1.5 rounded-md bg-primary px-3.5 text-[12.5px] font-semibold hover:bg-primary-hover disabled:bg-surface-3 disabled:text-muted-foreground disabled:opacity-100"
                >
                  <Send className="h-3.5 w-3.5" aria-hidden="true" />
                  <span className="hidden sm:inline">Enviar</span>
                </GatedButton>
              </div>
            </div>
          </div>
        </div>
      )}
      </div>
      </div>
    </div>
  );
}

/**
 * Staged-attachment preview with caption + send/discard. Declared at
 * module scope (not nested in MessageComposer) so React keeps it mounted
 * across the parent's re-renders — a nested component would remount the
 * caption input on every keystroke and drop focus.
 */
function MediaDraftPreview({
  draft,
  busy,
  readOnly,
  onCaptionChange,
  onDiscard,
  onSend,
}: {
  draft: MediaDraft;
  busy: boolean;
  readOnly: boolean;
  onCaptionChange: (caption: string) => void;
  onDiscard: () => void;
  onSend: () => void;
}) {
  return (
    <div className="rounded-lg bg-muted/45 p-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {draft.kind === "image" && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={draft.mediaUrl}
              alt={draft.filename}
              className="max-h-40 rounded-lg object-cover"
            />
          )}
          {draft.kind === "video" && (
            <video src={draft.mediaUrl} controls className="max-h-40 rounded-lg" />
          )}
          {draft.kind === "audio" && (
            <audio src={draft.mediaUrl} controls className="w-full" />
          )}
          {draft.kind === "document" && (
            <div className="flex items-center gap-2 text-sm text-foreground">
              <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
              <span className="truncate">{draft.filename}</span>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onDiscard}
          aria-label="Remover anexo"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <div className="mt-2 flex items-end gap-2">
        {draft.kind !== "audio" && (
          <input
            value={draft.caption}
            maxLength={MEDIA_CAPTION_MAX}
            onChange={(e) => onCaptionChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
            }}
            placeholder="Adicionar legenda…"
            aria-label="Legenda do anexo"
            className="min-w-0 flex-1 rounded-md border border-border/80 bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground outline-none transition-colors focus:border-primary/50 focus-visible:ring-1 focus-visible:ring-ring/50"
          />
        )}
        <GatedButton
          size="sm"
          canAct={!readOnly}
          gateReason="send messages"
          disabled={busy}
          aria-label="Enviar anexo"
          onClick={onSend}
          className={cn(
            "h-9 w-9 shrink-0 bg-primary p-0 hover:bg-primary/90 disabled:opacity-40",
            draft.kind === "audio" && "ml-auto",
          )}
        >
          <Send className="h-4 w-4" aria-hidden="true" />
        </GatedButton>
      </div>
    </div>
  );
}
