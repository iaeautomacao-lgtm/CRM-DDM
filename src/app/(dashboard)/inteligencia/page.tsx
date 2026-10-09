"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { KeyRound, Loader2, MessageSquarePlus, Send, Sparkles } from "lucide-react";
import { apiFetch } from "@/lib/api-fetch";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { AnswerMarkdown } from "@/components/inteligencia/answer-markdown";
import { SUGGESTED_QUESTIONS, toolLabel, type ChatStreamEvent } from "@/lib/intelligence/chat/labels";
import { cn } from "@/lib/utils";
import { ForbiddenState, Skeleton } from "@/components/ddm/states";
import { usePermissions } from "@/hooks/use-permission";

// /inteligencia — chat do DDM Intelligence (PRD-04, Fase 2). Owner/admin/
// supervisor (ROUTE_ALLOWLIST em src/lib/role-utils.ts). As respostas vêm
// em streaming NDJSON de POST /api/intelligence/chat; o histórico é só do
// próprio usuário (GET /api/intelligence/chats).

interface ChatSummary {
  id: string;
  title: string;
  updated_at: string;
}

interface UiMessage {
  key: string;
  role: "user" | "assistant";
  content: string;
  /** Ferramentas consultadas nesta resposta (rótulos). */
  tools: string[];
  pending?: boolean;
  failed?: boolean;
}

interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  tool_calls: Array<{ name: string }> | null;
}

const MAX_CHARS = 2_000;

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error === "Rate limit exceeded") return "Muitas perguntas seguidas. Aguarde um minuto e tente de novo.";
    return body.error ?? "Não foi possível enviar a pergunta.";
  } catch {
    return "Não foi possível enviar a pergunta.";
  }
}

/** Porta da página: o chat exige intelligence.use (o servidor também confere em cada rota). */
export default function InteligenciaPage() {
  const { loading, can } = usePermissions();
  if (loading) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (!can("intelligence.use")) {
    return (
      <ForbiddenState
        title="Você não tem acesso ao DDM Intelligence"
        hint="Se precisar dele, peça a um administrador da organização."
      />
    );
  }
  return <InteligenciaChat />;
}

function InteligenciaChat() {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [usage, setUsage] = useState<{ used: number; limit: number } | null>(null);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [toolStatus, setToolStatus] = useState<string | null>(null);
  const [loadingChat, setLoadingChat] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const loadChats = useCallback(async () => {
    try {
      const res = await apiFetch("/api/intelligence/chats");
      if (!res.ok) {
        setListError(await readError(res));
        return;
      }
      const body = (await res.json()) as { chats: ChatSummary[]; usage: { used: number; limit: number } };
      setChats(body.chats);
      setUsage(body.usage);
      setListError(null);
    } catch {
      setListError("Não foi possível carregar o histórico.");
    }
  }, []);

  useEffect(() => {
    void loadChats();
  }, [loadChats]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, toolStatus]);

  const openChat = useCallback(
    async (id: string) => {
      if (streaming) return;
      setActiveChatId(id);
      setLoadingChat(true);
      setMessages([]);
      try {
        const res = await apiFetch(`/api/intelligence/chats/${id}`);
        if (!res.ok) {
          setMessages([{ key: "err", role: "assistant", content: await readError(res), tools: [], failed: true }]);
          return;
        }
        const body = (await res.json()) as { messages: StoredMessage[] };
        setMessages(
          body.messages.map((m) => ({
            key: m.id,
            role: m.role,
            content: m.content,
            tools: [...new Set((m.tool_calls ?? []).map((t) => toolLabel(t.name)))],
          })),
        );
      } finally {
        setLoadingChat(false);
      }
    },
    [streaming],
  );

  const newChat = () => {
    if (streaming) return;
    setActiveChatId(null);
    setMessages([]);
    setInput("");
  };

  const updateAssistant = (key: string, fn: (m: UiMessage) => UiMessage) =>
    setMessages((prev) => prev.map((m) => (m.key === key ? fn(m) : m)));

  const send = async (text: string) => {
    const question = text.trim();
    if (!question || streaming) return;
    const stamp = Date.now();
    const assistantKey = `a-${stamp}`;
    setInput("");
    setStreaming(true);
    setToolStatus(null);
    setMessages((prev) => [
      ...prev,
      { key: `u-${stamp}`, role: "user", content: question, tools: [] },
      { key: assistantKey, role: "assistant", content: "", tools: [], pending: true },
    ]);

    try {
      const res = await apiFetch("/api/intelligence/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: question, chat_id: activeChatId }),
      });
      if (!res.ok || !res.body) {
        const error = await readError(res);
        updateAssistant(assistantKey, (m) => ({ ...m, content: error, pending: false, failed: true }));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const handle = (event: ChatStreamEvent) => {
        switch (event.type) {
          case "meta":
            setActiveChatId(event.chat_id);
            break;
          case "tool_start":
            setToolStatus(toolLabel(event.name));
            updateAssistant(assistantKey, (m) => {
              const label = toolLabel(event.name);
              return m.tools.includes(label) ? m : { ...m, tools: [...m.tools, label] };
            });
            break;
          case "tool_end":
            setToolStatus(null);
            break;
          case "reset":
            updateAssistant(assistantKey, (m) => ({ ...m, content: "" }));
            break;
          case "text":
            setToolStatus(null);
            updateAssistant(assistantKey, (m) => ({ ...m, content: m.content + event.delta }));
            break;
          case "error":
            updateAssistant(assistantKey, (m) => ({ ...m, content: event.message, failed: true }));
            break;
          case "done":
            break;
        }
      };

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) {
            try {
              handle(JSON.parse(line) as ChatStreamEvent);
            } catch {
              // linha malformada: ignora
            }
          }
          nl = buffer.indexOf("\n");
        }
      }
    } catch {
      updateAssistant(assistantKey, (m) => ({
        ...m,
        content: m.content || "A conexão caiu antes do fim da resposta. Abra a conversa no histórico para ver se ela foi salva.",
        failed: !m.content,
      }));
    } finally {
      updateAssistant(assistantKey, (m) => ({ ...m, pending: false }));
      setStreaming(false);
      setToolStatus(null);
      void loadChats();
    }
  };

  const limitReached = usage !== null && usage.used >= usage.limit;
  const usagePct = usage && usage.limit > 0 ? Math.min(100, (usage.used / usage.limit) * 100) : 0;

  return (
    <div className="animate-ddm-up flex h-full min-h-0 flex-col gap-4 lg:flex-row">
      {/* Histórico */}
      <aside className="flex max-h-[220px] w-full shrink-0 flex-col gap-2 lg:max-h-none lg:w-64">
        <Button variant="outline" onClick={newChat} disabled={streaming} className="justify-center">
          <MessageSquarePlus className="size-4" />
          Nova conversa
        </Button>
        <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border bg-card">
          {listError ? (
            <p className="p-3 text-xs text-muted-foreground">{listError}</p>
          ) : chats.length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground">Nenhuma conversa ainda.</p>
          ) : (
            <ul aria-label="Conversas anteriores">
              {chats.map((c, i) => {
                const current = c.id === activeChatId;
                return (
                  <li key={c.id} className="animate-ddm-row border-b last:border-b-0" style={{ animationDelay: `${Math.min(i, 12) * 30}ms` }}>
                    <button
                      type="button"
                      onClick={() => void openChat(c.id)}
                      disabled={streaming}
                      aria-current={current ? "true" : undefined}
                      className={cn(
                        "flex w-full flex-col gap-0.5 px-3 py-2.5 text-left transition-colors hover:bg-surface-hover disabled:opacity-60",
                        current && "bg-selected shadow-[inset_2px_0_0_var(--primary)]",
                      )}
                    >
                      <span className="line-clamp-2 text-[13px] leading-snug text-foreground">{c.title}</span>
                      <span className="text-[11.5px] text-muted-foreground">{fmtWhen(c.updated_at)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        {usage && (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs tabular-nums text-muted-foreground">
              Perguntas da conta hoje: {usage.used} de {usage.limit}
            </span>
            <div
              className="h-1 overflow-hidden rounded-sm bg-surface-3"
              role="progressbar"
              aria-label="Perguntas da conta hoje"
              aria-valuemin={0}
              aria-valuemax={usage.limit}
              aria-valuenow={usage.used}
            >
              <div
                className={cn("animate-ddm-bar h-full rounded-sm transition-[width] duration-300", usagePct > 90 ? "bg-warning" : "bg-primary")}
                style={{ width: `${usagePct}%` }}
              />
            </div>
          </div>
        )}
        <Link
          href="/inteligencia/chaves"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <KeyRound className="size-3.5" />
          Minhas chaves de API (MCP)
        </Link>
      </aside>

      {/* Conversa */}
      <section
        aria-label="Conversa com o DDM Intelligence"
        className="flex min-h-[60vh] min-w-0 flex-1 flex-col rounded-[10px] border bg-card"
      >
        <div className="flex flex-1 flex-col gap-3.5 overflow-y-auto overflow-x-hidden p-4" aria-live="polite">
          {loadingChat ? (
            <div className="flex flex-col gap-3" aria-busy>
              <Skeleton className="ml-auto h-10 w-2/5 rounded-[10px]" />
              <Skeleton className="h-24 w-3/4 rounded-[10px]" />
            </div>
          ) : messages.length === 0 ? (
            <div className="animate-ddm-fade m-auto flex max-w-[560px] flex-col items-center gap-4 py-6 text-center">
              <span className="flex size-10 items-center justify-center rounded-[10px] bg-primary-soft text-primary">
                <Sparkles className="size-5" />
              </span>
              <div className="flex flex-col gap-1.5">
                <h2 className="text-[17px] font-semibold text-foreground">Pergunte sobre o atendimento</h2>
                <p className="text-[13.5px] leading-relaxed text-foreground-2">
                  As respostas usam só os dados do CRM que você pode ver, sempre com o período e o escopo consultados.
                </p>
              </div>
              <div className="grid w-full gap-2 sm:grid-cols-2">
                {SUGGESTED_QUESTIONS.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => void send(q)}
                    disabled={streaming || limitReached}
                    className="rounded-lg border bg-card px-3 py-2.5 text-left text-[13px] leading-snug text-foreground transition-colors hover:border-border-strong hover:bg-surface-hover disabled:opacity-60"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m) =>
              m.role === "user" ? (
                <div key={m.key} className="animate-ddm-fade flex justify-end">
                  <div className="max-w-[80%] whitespace-pre-wrap rounded-[10px_10px_2px_10px] bg-primary-soft px-3 py-2 text-[13.5px] leading-relaxed text-foreground">
                    {m.content}
                  </div>
                </div>
              ) : (
                <div key={m.key} className="animate-ddm-fade flex justify-start">
                  <div
                    className={cn(
                      "flex max-w-[90%] flex-col gap-2 rounded-[10px_10px_10px_2px] border bg-card-2 px-3.5 py-2.5",
                      m.failed && "border-destructive/50",
                    )}
                  >
                    {m.tools.length > 0 && (
                      <p className="text-[11.5px] text-muted-foreground">Consultas: {m.tools.join(" · ")}</p>
                    )}
                    {m.content ? (
                      <div className="text-[13.5px] leading-relaxed">
                        <AnswerMarkdown text={m.content} />
                        {m.pending && streaming && (
                          <span aria-hidden className="ml-0.5 inline-block h-3.5 w-[7px] animate-pulse bg-muted-foreground align-middle" />
                        )}
                      </div>
                    ) : m.pending ? (
                      <span className="flex items-center gap-2 text-[13px] text-foreground-2">
                        <Loader2 className="size-3.5 animate-spin text-primary" />
                        {toolStatus ? `${toolStatus}…` : "Pensando…"}
                      </span>
                    ) : null}
                  </div>
                </div>
              ),
            )
          )}
          <div ref={bottomRef} />
        </div>

        <form
          className="flex shrink-0 items-end gap-2 border-t p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
        >
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value.slice(0, MAX_CHARS))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(input);
              }
            }}
            placeholder={
              limitReached
                ? "Limite diário de perguntas da conta atingido."
                : "Ex.: qual instituição converteu melhor esta semana?"
            }
            disabled={streaming || limitReached}
            rows={1}
            className="max-h-40 min-h-10 resize-y text-[13.5px]"
            aria-label="Pergunta para o DDM Intelligence"
          />
          <Button
            type="submit"
            size="icon-lg"
            disabled={streaming || !input.trim() || limitReached}
            aria-label="Enviar"
            className="size-10 shrink-0"
          >
            {streaming ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          </Button>
        </form>
      </section>
    </div>
  );
}
