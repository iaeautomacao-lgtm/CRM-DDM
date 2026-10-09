"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { FileText, Loader2, Mic, Paperclip, Send, Square, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import type { WebchatClientMessage } from "@/lib/webchat/messages";
import type { WebchatInteractivePayload } from "@/lib/webchat/send";

// Chat do cliente no Webchat. Fala só com /api/webchat/[token]/* — o token
// da URL é a credencial; nada aqui usa sessão do CRM.
//
// Recebimento por consulta periódica (não há websocket no Passenger):
// a cada 3s com a aba visível, 15s escondida, e logo após cada envio.

const POLL_VISIBLE_MS = 3000;
const POLL_HIDDEN_MS = 15000;
const POLL_OVERLAP_MS = 5000;

// Suporte a gravação não muda durante a vida da página: não há o que assinar.
const noopSubscribe = () => () => {};

/**
 * Variáveis do tema a partir da cor do Webchat (/canais): primária, hover,
 * foco e texto preto ou branco conforme a luminosidade (cor clara não fica
 * com texto branco ilegível).
 */
function accentVars(hex: string): CSSProperties {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return {
    "--primary": hex,
    "--primary-hover": `color-mix(in srgb, ${hex} 85%, black)`,
    "--primary-soft": `color-mix(in srgb, ${hex} 15%, transparent)`,
    "--ring": hex,
    "--primary-foreground": luminance > 0.6 ? "#111111" : "#ffffff",
  } as CSSProperties;
}

type PageState =
  | { kind: "loading" }
  | { kind: "gone"; reason: "expired" | "revoked" | "not_found" | "error" }
  | { kind: "ready"; brand: string; firstName: string | null; welcome: string; accent: string | null };

export function WebchatClient({ token }: { token: string }) {
  const api = `/api/webchat/${token}`;
  const [page, setPage] = useState<PageState>({ kind: "loading" });
  const [messages, setMessages] = useState<WebchatClientMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const lastAtRef = useRef<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // Junta mensagens novas sem duplicar (a mensagem do próprio cliente
  // chega pelo POST e de novo na busca seguinte).
  //
  // O cursor da busca (lastAtRef) só avança com o que veio da BUSCA, nunca
  // com o eco do POST: senão uma resposta do bot gravada entre a última
  // busca e um novo envio do cliente ficaria antes do cursor e sumiria.
  const merge = useCallback((incoming: WebchatClientMessage[], fromPoll: boolean) => {
    if (incoming.length === 0) return;
    if (fromPoll) {
      const newest = incoming.reduce(
        (max, m) => (Date.parse(m.created_at) > Date.parse(max) ? m.created_at : max),
        lastAtRef.current ?? incoming[0].created_at
      );
      lastAtRef.current = newest;
    }
    setMessages((prev) => {
      const known = new Set(prev.map((m) => m.id));
      const next = [...prev, ...incoming.filter((m) => !known.has(m.id))];
      next.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
      return next;
    });
  }, []);

  const goneFrom = (status: number, body: { state?: string }): PageState | null => {
    if (status === 410 || status === 404) {
      const reason = body.state === "revoked" ? "revoked" : status === 404 ? "not_found" : "expired";
      return { kind: "gone", reason };
    }
    return null;
  };

  const poll = useCallback(async () => {
    // Margem de 5s antes do cursor: mensagens gravadas quase ao mesmo tempo
    // (bot e cliente) podem ter created_at fora de ordem de chegada. As
    // repetidas são descartadas pelo merge.
    const after = lastAtRef.current
      ? new Date(Date.parse(lastAtRef.current) - POLL_OVERLAP_MS).toISOString()
      : null;
    const qs = after ? `?after=${encodeURIComponent(after)}` : "";
    try {
      const res = await fetch(`${api}/messages${qs}`, { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      const gone = goneFrom(res.status, body);
      if (gone) return setPage(gone);
      if (res.ok && Array.isArray(body.messages)) merge(body.messages, true);
    } catch {
      // Rede instável no celular: a próxima consulta tenta de novo.
    }
  }, [api, merge]);

  // Carrega a sessão, abre a conversa (cria + inicia o fluxo na 1ª vez) e
  // faz a primeira busca.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(api, { cache: "no-store" });
        const body = await res.json().catch(() => ({}));
        const gone = goneFrom(res.status, body);
        if (gone) return !cancelled && setPage(gone);
        if (!res.ok) return !cancelled && setPage({ kind: "gone", reason: "error" });
        const open = await fetch(`${api}/open`, { method: "POST" });
        if (!open.ok) {
          const openBody = await open.json().catch(() => ({}));
          return !cancelled && setPage(goneFrom(open.status, openBody) ?? { kind: "gone", reason: "error" });
        }
        if (cancelled) return;
        const firstName = body.contact?.first_name ?? null;
        setPage({
          kind: "ready",
          brand: body.brand?.name ?? "Atendimento",
          firstName,
          welcome: body.welcome || `${firstName ? `Olá, ${firstName}! ` : "Olá! "}Já vamos te atender.`,
          accent: typeof body.brand?.accent_color === "string" ? body.brand.accent_color : null,
        });
        await poll();
      } catch {
        if (!cancelled) setPage({ kind: "gone", reason: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, poll]);

  // Consulta periódica, mais espaçada com a aba em segundo plano.
  useEffect(() => {
    if (page.kind !== "ready") return;
    let timer: number;
    const tick = async () => {
      await poll();
      timer = window.setTimeout(tick, document.hidden ? POLL_HIDDEN_MS : POLL_VISIBLE_MS);
    };
    timer = window.setTimeout(tick, POLL_VISIBLE_MS);
    const onVisible = () => {
      if (!document.hidden) void poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [page.kind, poll]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length]);

  const post = useCallback(
    async (payload: Record<string, unknown>) => {
      setSending(true);
      setSendError(null);
      try {
        const res = await fetch(`${api}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const body = await res.json().catch(() => ({}));
        const gone = goneFrom(res.status, body);
        if (gone) return setPage(gone);
        if (!res.ok) {
          setSendError(body.error ?? "Não foi possível enviar. Tente de novo.");
          return false;
        }
        if (body.message) merge([body.message], false);
        // A resposta do fluxo/IA costuma chegar em alguns segundos.
        window.setTimeout(() => void poll(), 1500);
        return true;
      } catch {
        setSendError("Sem conexão. Tente de novo.");
        return false;
      } finally {
        setSending(false);
      }
    },
    [api, merge, poll]
  );

  const sendText = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    if (await post({ text })) setDraft("");
  };

  const sendFile = async (file: File) => {
    setSending(true);
    setSendError(null);
    try {
      const res = await fetch(`${api}/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, mime_type: file.type, size: file.size }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSendError(body.error ?? "Arquivo não permitido.");
        setSending(false);
        return;
      }
      const { error } = await createClient()
        .storage.from("chat-media")
        .uploadToSignedUrl(body.path, body.upload_token, file, { contentType: file.type });
      if (error) {
        setSendError("Falha ao enviar o arquivo. Tente de novo.");
        setSending(false);
        return;
      }
      await post({ media: { path: body.path, mime_type: file.type, name: file.name } });
    } catch {
      setSendError("Falha ao enviar o arquivo. Tente de novo.");
      setSending(false);
    }
  };

  if (page.kind === "loading") {
    return (
      <div className="flex h-dvh items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (page.kind === "gone") return <GoneScreen reason={page.reason} />;

  // Cor da configuração do Webchat: sobrescreve o --primary da página.
  const accentStyle = page.accent ? accentVars(page.accent) : undefined;

  return (
    // Visual do protótipo DDM: cartão de até 420px centralizado no desktop e
    // tela cheia no celular. A cor do Webchat (/canais) segue valendo.
    <div className="flex h-dvh items-center justify-center bg-surface-3 sm:p-6" style={accentStyle}>
      <section
        aria-label={`Chat com ${page.brand}`}
        className="flex h-full w-full max-w-[420px] animate-ddm-up flex-col overflow-hidden bg-card sm:h-[min(680px,100%)] sm:rounded-2xl sm:shadow-[0_24px_60px_rgba(20,16,12,.14),0_0_0_1px_rgba(20,16,12,.06)]"
      >
      <header className="flex shrink-0 items-center gap-3 bg-[#18191B] px-4 py-3.5 text-white">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-primary text-[13px] font-bold text-primary-foreground">
          {page.brand.charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{page.brand}</p>
          <p className="flex items-center gap-1.5 text-xs text-[#B4B9C0]">
            <span aria-hidden className="size-[7px] rounded-full bg-[#3FCF8E]" />
            Atendimento online
          </p>
        </div>
      </header>

      <p className="shrink-0 border-b border-border bg-surface-3 px-4 py-2 text-center text-[11.5px] text-muted-foreground">
        Mantenha esta página aberta: você não recebe notificação das respostas aqui.
      </p>

      <main className="min-h-0 flex-1 overflow-y-auto bg-background px-4 py-4">
        <div className="flex flex-col gap-2">
          {messages.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {page.welcome}
            </p>
          )}
          {messages.map((m, i) => {
            const isLast = i === messages.length - 1;
            return (
              <MessageBubble
                key={m.id}
                message={m}
                // Botões só respondem enquanto são a última mensagem.
                onChoose={
                  isLast && m.interactive && !sending
                    ? (id, title) => void post({ reply_id: id, reply_title: title, text: title })
                    : undefined
                }
              />
            );
          })}
          <div ref={bottomRef} />
        </div>
      </main>

      {sendError && (
        <p className="flex items-center justify-between gap-2 bg-destructive/10 px-4 py-2 text-xs text-destructive">
          {sendError}
          <button type="button" onClick={() => setSendError(null)} aria-label="Fechar aviso">
            <X className="h-3.5 w-3.5" />
          </button>
        </p>
      )}

      <Composer
        draft={draft}
        setDraft={setDraft}
        sending={sending}
        onSend={sendText}
        onFile={sendFile}
      />
      </section>
    </div>
  );
}

function GoneScreen({ reason }: { reason: "expired" | "revoked" | "not_found" | "error" }) {
  const copy = {
    expired: {
      title: "Este link expirou",
      body: "Este link de atendimento expirou. Volte à conversa no WhatsApp para receber um novo.",
    },
    revoked: {
      title: "Este link foi substituído",
      body: "Enviamos um link mais recente para você no WhatsApp. Use o último que recebeu.",
    },
    not_found: {
      title: "Link inválido",
      body: "Confira se abriu o link completo enviado no WhatsApp.",
    },
    error: {
      title: "Não foi possível abrir o atendimento",
      body: "Tente de novo em alguns instantes.",
    },
  }[reason];
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-2 bg-background px-6 text-center">
      <h1 className="text-base font-semibold text-foreground">{copy.title}</h1>
      <p className="max-w-sm text-sm text-muted-foreground">{copy.body}</p>
    </div>
  );
}

function MessageBubble({
  message,
  onChoose,
}: {
  message: WebchatClientMessage;
  onChoose?: (id: string, title: string) => void;
}) {
  const mine = message.from === "customer";
  const time = new Date(message.created_at).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return (
    <div className={cn("flex flex-col", mine ? "items-end" : "items-start")}>
      <div
        className={cn(
          "max-w-[84%] px-3 py-2 text-[13.5px] leading-relaxed",
          mine
            ? "rounded-[14px_14px_4px_14px] bg-primary-soft text-foreground"
            : "rounded-[14px_14px_14px_4px] bg-card text-foreground shadow-[inset_0_0_0_1px_var(--border)]"
        )}
      >
        <MessageMedia message={message} />
        {message.text && <p className="whitespace-pre-wrap break-words">{message.text}</p>}
        <p className="mt-1 text-right text-[11px] text-muted-foreground">
          {time}
        </p>
      </div>
      {message.interactive && (
        <InteractiveOptions payload={message.interactive} onChoose={onChoose} />
      )}
    </div>
  );
}

function MessageMedia({ message }: { message: WebchatClientMessage }) {
  if (!message.media_url) return null;
  switch (message.content_type) {
    case "image":
      return (
        // eslint-disable-next-line @next/next/no-img-element -- URL assinada temporária, sem otimização do Next
        <img src={message.media_url} alt="Imagem" className="mb-1 max-h-72 rounded-lg object-cover" />
      );
    case "video":
      return <video src={message.media_url} controls className="mb-1 max-h-72 rounded-lg" />;
    case "audio":
      return <audio src={message.media_url} controls className="mb-1 w-60 max-w-full" />;
    default:
      return (
        <a
          href={message.media_url}
          target="_blank"
          rel="noopener noreferrer"
          className="mb-1 flex items-center gap-2 underline-offset-2 hover:underline"
        >
          <FileText className="h-4 w-4 shrink-0" />
          Abrir arquivo
        </a>
      );
  }
}

function InteractiveOptions({
  payload,
  onChoose,
}: {
  payload: WebchatInteractivePayload;
  onChoose?: (id: string, title: string) => void;
}) {
  const options =
    payload.type === "buttons"
      ? payload.options
      : payload.sections.flatMap((s) => s.options);
  return (
    <div className="mt-1 flex max-w-[85%] flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          disabled={!onChoose}
          onClick={() => onChoose?.(o.id, o.title)}
          className="rounded-full border border-primary/40 bg-card px-3 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/10 disabled:cursor-default disabled:opacity-50"
        >
          {o.title}
        </button>
      ))}
    </div>
  );
}

function Composer({
  draft,
  setDraft,
  sending,
  onSend,
  onFile,
}: {
  draft: string;
  setDraft: (v: string) => void;
  sending: boolean;
  onSend: () => void;
  onFile: (file: File) => void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [recorder, setRecorder] = useState<MediaRecorder | null>(null);

  // Áudio: grava com MediaRecorder e envia como arquivo (mesmo caminho dos
  // anexos). Navegadores sem suporte (alguns in-app) simplesmente não
  // mostram o botão. Detectado depois de montar para o HTML do servidor e
  // a primeira renderização do cliente serem iguais.
  const canRecord = useSyncExternalStore(
    noopSubscribe,
    () => "MediaRecorder" in window && !!navigator.mediaDevices?.getUserMedia,
    () => false
  );

  const toggleRecording = async () => {
    if (recorder) {
      recorder.stop();
      setRecorder(null);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks: BlobPart[] = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const type = (rec.mimeType || "audio/webm").split(";")[0];
        const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
        onFile(new File(chunks, `audio-${Date.now()}.${ext}`, { type }));
      };
      rec.start();
      setRecorder(rec);
    } catch {
      // Permissão negada: não há o que fazer além de não gravar.
    }
  };

  return (
    <footer className="shrink-0 border-t border-border bg-card px-3 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))]">
      <div className="flex items-end gap-2">
        <input
          ref={fileRef}
          type="file"
          className="hidden"
          accept="image/*,video/*,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.txt"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onFile(file);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={sending || !!recorder}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted disabled:opacity-50"
          aria-label="Anexar arquivo"
        >
          <Paperclip className="h-5 w-5" />
        </button>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          rows={1}
          maxLength={4000}
          placeholder={recorder ? "Gravando áudio…" : "Digite uma mensagem"}
          disabled={!!recorder}
          className="max-h-32 min-h-10 flex-1 resize-none rounded-[20px] border border-border bg-card px-4 py-2.5 text-base text-foreground outline-none placeholder:text-muted-foreground focus:border-primary focus:ring-[3px] focus:ring-primary/20 md:text-sm"
        />
        {draft.trim() || !canRecord ? (
          <button
            type="button"
            onClick={onSend}
            disabled={sending || !draft.trim()}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:cursor-not-allowed disabled:bg-surface-3 disabled:text-muted-foreground"
            aria-label="Enviar"
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </button>
        ) : (
          <button
            type="button"
            onClick={toggleRecording}
            disabled={sending}
            className={cn(
              "flex h-10 w-10 shrink-0 items-center justify-center rounded-full disabled:opacity-50",
              recorder ? "bg-destructive text-white" : "bg-primary text-primary-foreground"
            )}
            aria-label={recorder ? "Parar e enviar áudio" : "Gravar áudio"}
          >
            {recorder ? <Square className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
          </button>
        )}
      </div>
    </footer>
  );
}
