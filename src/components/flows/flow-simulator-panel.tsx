"use client";

/**
 * Painel "Testar fluxo" (PRD 05, Fase 2 mínima).
 *
 * O usuário escreve como se fosse o cliente; cada mensagem vai para
 * POST /api/flows/[id]/simulate com o RASCUNHO atual do editor (nós não
 * publicados incluídos) e o estado da simulação, que fica só aqui no
 * navegador — o servidor é stateless. Nada é enviado pelo WhatsApp nem
 * gravado nas conversas reais; as tools respondem com o mock definido
 * abaixo (consulta real só para tools somente-leitura liberadas).
 *
 * Destaque no diagrama: o nó atual pisca via `requestFlash`, o mesmo
 * sinal do painel de validação.
 */

import { useMemo, useRef, useState } from "react";
import { FlaskConical, Loader2, RotateCcw, Send, TriangleAlert, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch } from "@/lib/api-fetch";
import { cn } from "@/lib/utils";
import type { AiAgentTool } from "@/lib/flows/types";
import {
  SIM_NEVER_REAL_TOOLS,
  SIM_READ_ONLY_TOOLS,
  type SimInboundMessage,
  type SimOutbound,
  type SimRunSnapshot,
  type SimState,
  type SimTimelineEvent,
  type SimulateResponse,
} from "@/lib/flows/simulator/types";
import { useFlowEditor } from "./flow-editor-state";

type ChatItem =
  | { id: string; from: "cliente"; text: string }
  | { id: string; from: "bot"; message: SimOutbound };

interface TurnLog {
  id: string;
  input: string;
  events: SimTimelineEvent[];
}

const TIMELINE_COLORS: Record<SimTimelineEvent["type"], string> = {
  node: "text-muted-foreground",
  branch: "text-sky-600 dark:text-sky-400",
  tag: "text-violet-600 dark:text-violet-400",
  tool_call: "text-amber-700 dark:text-amber-400",
  tool_result: "text-amber-700 dark:text-amber-400",
  handoff: "text-orange-600 dark:text-orange-400",
  run_end: "text-emerald-700 dark:text-emerald-400",
  error: "text-destructive",
  note: "text-muted-foreground italic",
};

function parseVars(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    if (key) vars[key] = line.slice(idx + 1).trim();
  }
  return vars;
}

function detailText(detail: unknown): string | null {
  if (detail === undefined || detail === null) return null;
  const text = typeof detail === "string" ? detail : JSON.stringify(detail, null, 2);
  return text.length > 1500 ? `${text.slice(0, 1500)}…` : text;
}

export function FlowSimulatorPanel({ onClose }: { onClose: () => void }) {
  const { flow, state: editor, requestFlash } = useFlowEditor();

  // Configuração da simulação
  const [contactName, setContactName] = useState("Cliente Teste");
  const [contactPhone, setContactPhone] = useState("5511999990000");
  const [varsText, setVarsText] = useState("");
  const [provider, setProvider] = useState<"meta" | "waha">("meta");
  const [ignoreTrigger, setIgnoreTrigger] = useState(true);
  const [toolMocks, setToolMocks] = useState<Record<string, string>>({});
  const [realTools, setRealTools] = useState<string[]>([]);
  const [httpMocks, setHttpMocks] = useState<Record<string, string>>({});

  // Conversa simulada
  const [simState, setSimState] = useState<SimState | null>(null);
  const [chat, setChat] = useState<ChatItem[]>([]);
  const [turns, setTurns] = useState<TurnLog[]>([]);
  const [run, setRun] = useState<SimRunSnapshot | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const counter = useRef(0);

  // Tools dos nós de IA e nós http_fetch do rascunho — para os mocks.
  const tools = useMemo(() => {
    const byName = new Map<string, AiAgentTool>();
    for (const n of editor.nodes) {
      if (n.node_type !== "ai_agent") continue;
      for (const t of (n.config.tools as AiAgentTool[] | undefined) ?? []) {
        if (t?.name && !byName.has(t.name)) byName.set(t.name, t);
      }
    }
    return [...byName.values()];
  }, [editor.nodes]);
  const httpNodes = useMemo(() => editor.nodes.filter((n) => n.node_type === "http_fetch"), [editor.nodes]);

  const reset = () => {
    setSimState(null);
    setChat([]);
    setTurns([]);
    setRun(null);
    setError(null);
  };

  const send = async (message: SimInboundMessage) => {
    if (sending) return;
    const label = message.kind === "text" ? message.text : `[botão] ${message.reply_title}`;
    const id = `t${++counter.current}`;
    setSending(true);
    setError(null);
    setChat((c) => [...c, { id, from: "cliente", text: label }]);
    try {
      const res = await apiFetch(`/api/flows/${flow.id}/simulate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          draft: {
            entry_node_id: editor.entry_node_id,
            trigger_type: editor.trigger_type,
            trigger_config: editor.trigger_config,
            fallback_policy: flow.fallback_policy ?? null,
            nodes: editor.nodes.map((n) => ({ node_key: n.node_key, node_type: n.node_type, config: n.config })),
          },
          message,
          state: simState,
          contact: { name: contactName, phone: contactPhone, vars: parseVars(varsText) },
          provider,
          ignoreTrigger,
          toolMocks,
          realReadOnlyTools: realTools,
          httpMocks,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as Partial<SimulateResponse> & { error?: string };
      if (!res.ok || !json.state) {
        setError(json.error ?? `Falha na simulação (HTTP ${res.status})`);
        return;
      }
      setSimState(json.state);
      setRun(json.run ?? null);
      setRemaining(json.remaining ?? null);
      setChat((c) => [...c, ...(json.outbound ?? []).map((m) => ({ id: `${id}-${m.id}`, from: "bot" as const, message: m }))]);
      setTurns((t) => [...t, { id, input: label, events: json.timeline ?? [] }]);
      const focus = json.run?.status === "active" ? json.run.current_node_key : json.path?.[json.path.length - 1];
      if (focus) requestFlash(focus);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha na simulação");
    } finally {
      setSending(false);
    }
  };

  const submitText = () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    void send({ kind: "text", text });
  };

  return (
    <aside
      aria-label="Testar fluxo"
      className="flex min-h-0 w-[380px] shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-card"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <FlaskConical className="h-4 w-4 text-primary" />
        <span className="text-[13px] font-semibold">Testar fluxo</span>
        <span className="text-[11px] text-muted-foreground">rascunho · nada é enviado</span>
        <button
          type="button"
          onClick={reset}
          title="Reiniciar simulação"
          className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <RotateCcw className="h-3.5 w-3.5" /> Reiniciar
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Fechar teste do fluxo"
          className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <details className="border-b border-border px-3 py-2 text-[12px]">
          <summary className="cursor-pointer select-none font-medium">Configuração da simulação</summary>
          <div className="mt-2 space-y-2.5">
            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-1">
                <span className="text-muted-foreground">Nome do contato</span>
                <Input value={contactName} onChange={(e) => setContactName(e.target.value)} disabled={!!simState} />
              </label>
              <label className="space-y-1">
                <span className="text-muted-foreground">Telefone</span>
                <Input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} disabled={!!simState} />
              </label>
            </div>
            <label className="block space-y-1">
              <span className="text-muted-foreground">Variáveis iniciais (uma por linha: chave=valor)</span>
              <Textarea rows={2} value={varsText} onChange={(e) => setVarsText(e.target.value)} disabled={!!simState} />
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <label className="inline-flex items-center gap-1.5">
                <span className="text-muted-foreground">Canal</span>
                <select
                  value={provider}
                  onChange={(e) => setProvider(e.target.value === "waha" ? "waha" : "meta")}
                  className="rounded-md border border-border bg-background px-1.5 py-1"
                >
                  <option value="meta">Meta (botões nativos)</option>
                  <option value="waha">WAHA (opções numeradas)</option>
                </select>
              </label>
              <label className="inline-flex items-center gap-1.5">
                <input type="checkbox" checked={ignoreTrigger} onChange={(e) => setIgnoreTrigger(e.target.checked)} />
                Começar em qualquer mensagem (ignorar gatilho)
              </label>
            </div>

            {tools.length > 0 && (
              <div className="space-y-2">
                <p className="font-medium">Respostas das tools (mock)</p>
                {tools.map((t) => {
                  const canBeReal =
                    SIM_READ_ONLY_TOOLS.includes(t.name) &&
                    !SIM_NEVER_REAL_TOOLS.includes(t.name) &&
                    t.http?.method === "GET";
                  const isReal = realTools.includes(t.name);
                  return (
                    <div key={t.name} className="space-y-1 rounded-md border border-border p-2">
                      <div className="flex items-center gap-2">
                        <code className="text-[11.5px]">{t.name}</code>
                        <span className="text-[11px] text-muted-foreground">{t.http?.method}</span>
                        {SIM_NEVER_REAL_TOOLS.includes(t.name) && (
                          <span className="ml-auto text-[11px] text-muted-foreground">sempre simulada</span>
                        )}
                      </div>
                      {canBeReal && (
                        <label className="flex items-start gap-1.5 text-[11.5px]">
                          <input
                            type="checkbox"
                            checked={isReal}
                            onChange={(e) =>
                              setRealTools((cur) => (e.target.checked ? [...cur, t.name] : cur.filter((n) => n !== t.name)))
                            }
                          />
                          <span>
                            Consultar a API real (somente leitura)
                            {isReal && (
                              <span className="mt-0.5 flex items-center gap-1 text-amber-700 dark:text-amber-400">
                                <TriangleAlert className="h-3 w-3" /> Usa dados reais de devedor — só com CPF de teste.
                              </span>
                            )}
                          </span>
                        </label>
                      )}
                      {!isReal && (
                        <Textarea
                          rows={2}
                          placeholder='Resposta devolvida ao modelo, ex.: [{"iddev":"123","sistema":"ddm"}]'
                          value={toolMocks[t.name] ?? ""}
                          onChange={(e) => setToolMocks((m) => ({ ...m, [t.name]: e.target.value }))}
                          className="font-mono text-[11px]"
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {httpNodes.length > 0 && (
              <div className="space-y-2">
                <p className="font-medium">Respostas dos nós HTTP (sempre simuladas)</p>
                {httpNodes.map((n) => (
                  <label key={n.node_key} className="block space-y-1">
                    <code className="text-[11.5px]">{n.node_key}</code>
                    <Textarea
                      rows={2}
                      value={httpMocks[n.node_key] ?? ""}
                      onChange={(e) => setHttpMocks((m) => ({ ...m, [n.node_key]: e.target.value }))}
                      className="font-mono text-[11px]"
                    />
                  </label>
                ))}
              </div>
            )}
          </div>
        </details>

        <div className="space-y-2 px-3 py-3">
          {chat.length === 0 && (
            <p className="text-[12px] text-muted-foreground">
              Escreva como se fosse o cliente. A IA usa o prompt do rascunho; as tools respondem com o mock acima.
            </p>
          )}
          {chat.map((item) =>
            item.from === "cliente" ? (
              <div key={item.id} className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-lg bg-primary px-2.5 py-1.5 text-[12.5px] text-primary-foreground">
                {item.text}
              </div>
            ) : (
              <div key={item.id} className="max-w-[90%] space-y-1">
                <div className="whitespace-pre-wrap rounded-lg bg-muted px-2.5 py-1.5 text-[12.5px]">
                  {item.message.text}
                  <div className="mt-0.5 text-[10.5px] text-muted-foreground">
                    {item.message.source === "ia" ? "IA" : "fluxo"} · {item.message.provider === "waha" ? "WAHA" : "Meta"}
                    {item.message.kind !== "text" ? ` · ${item.message.kind}` : ""}
                  </div>
                </div>
                {item.message.options && item.message.provider === "meta" && (
                  <div className="flex flex-wrap gap-1">
                    {item.message.options.map((o) => (
                      <button
                        key={o.id}
                        type="button"
                        disabled={sending}
                        onClick={() => void send({ kind: "interactive_reply", reply_id: o.id, reply_title: o.title })}
                        className="rounded-full border border-border px-2 py-0.5 text-[11.5px] hover:bg-muted disabled:opacity-50"
                      >
                        {o.title}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ),
          )}
          {sending && (
            <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> processando…
            </div>
          )}
          {error && <p className="text-[12px] text-destructive">{error}</p>}
        </div>

        {run && (
          <div className="border-t border-border px-3 py-2 text-[12px]">
            <p>
              <span className="text-muted-foreground">Execução:</span> <b>{run.status}</b>
              {run.current_node_key && (
                <>
                  {" "}· nó{" "}
                  <button type="button" className="underline" onClick={() => requestFlash(run.current_node_key!)}>
                    {run.current_node_key}
                  </button>
                </>
              )}
              {run.end_reason ? ` · ${run.end_reason}` : ""}
            </p>
            <details className="mt-1">
              <summary className="cursor-pointer text-muted-foreground">Variáveis do run</summary>
              <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted p-1.5 text-[11px]">{JSON.stringify(run.vars, null, 2)}</pre>
            </details>
          </div>
        )}

        {turns.length > 0 && (
          <div className="border-t border-border px-3 py-2">
            <p className="mb-1 text-[12px] font-medium">Linha do tempo</p>
            <ol className="space-y-2">
              {turns.map((turn) => (
                <li key={turn.id} className="text-[11.5px]">
                  <p className="font-medium">“{turn.input}”</p>
                  <ul className="mt-0.5 space-y-0.5 border-l border-border pl-2">
                    {turn.events.map((ev, i) => {
                      const detail = detailText(ev.detail);
                      return (
                        <li key={i} className={cn(TIMELINE_COLORS[ev.type])}>
                          {ev.node_key ? (
                            <button type="button" className="hover:underline" onClick={() => requestFlash(ev.node_key!)}>
                              {ev.label}
                            </button>
                          ) : (
                            ev.label
                          )}
                          <span className="ml-1 text-[10px] text-muted-foreground">{ev.at.slice(11, 19)}</span>
                          {detail && (
                            <details>
                              <summary className="cursor-pointer text-[10.5px] text-muted-foreground">detalhes</summary>
                              <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-1 text-[10.5px] text-foreground">{detail}</pre>
                            </details>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>

      <form
        className="flex items-center gap-2 border-t border-border p-2"
        onSubmit={(e) => {
          e.preventDefault();
          submitText();
        }}
      >
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Mensagem do cliente…"
          disabled={sending}
          aria-label="Mensagem do cliente"
        />
        <Button type="submit" size="sm" disabled={sending || !input.trim()} aria-label="Enviar mensagem simulada">
          <Send className="h-3.5 w-3.5" />
        </Button>
      </form>
      {remaining !== null && (
        <p className="px-3 pb-2 text-[10.5px] text-muted-foreground">{remaining} mensagens simuladas restantes nesta janela de 10 min</p>
      )}
    </aside>
  );
}
