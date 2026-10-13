'use client';

// Aba "Testar" do editor do agente (TASK1-C): conversa de teste com o RASCUNHO do agente (o que está no
// formulário, sem salvar) pelo simulador de fluxo — POST /api/settings/agents/[id]/simulate. Nada vai para o
// WhatsApp nem para conversa real; ferramentas respondem com o mock daqui (consulta real só para as
// somente-leitura liberadas, e só para quem grava credenciais). Chamadas de ferramenta aparecem resumidas e
// sem CPF (o servidor já mascara).

import { useRef, useState } from 'react';
import { FlaskConical, Loader2, RotateCcw, Send, TriangleAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
  SIM_NEVER_REAL_TOOLS,
  SIM_READ_ONLY_TOOLS,
  type SimOutbound,
  type SimState,
  type SimTimelineEvent,
} from '@/lib/flows/simulator/types';
import { AgentApiError, simulateAgent, type AgentSimulateResponse } from '../api';

export interface TestTabTool {
  name: string;
  method: string;
}

interface TestTabProps {
  agentId: string | null;
  /** Payload do rascunho atual (o mesmo de "Publicar nova versão", sem o nome). */
  buildDraft: () => Record<string, unknown>;
  /** Ferramentas ligadas no rascunho (para os mocks). */
  tools: TestTabTool[];
  /** Pode liberar consulta real das ferramentas somente-leitura (secrets.write). */
  canRealRead: boolean;
}

type ChatItem = { id: string; from: 'cliente'; text: string } | { id: string; from: 'agente'; message: SimOutbound };

interface TurnLog {
  id: string;
  input: string;
  events: SimTimelineEvent[];
}

// Só o que ajuda a entender a resposta do agente (o resto é o caminho interno do fluxo sintético).
const SHOWN: ReadonlySet<SimTimelineEvent['type']> = new Set(['tool_call', 'tool_result', 'tag', 'handoff', 'run_end', 'error', 'note']);

const COLORS: Record<SimTimelineEvent['type'], string> = {
  node: 'text-muted-foreground',
  branch: 'text-info',
  tag: 'text-violet-600 dark:text-violet-400',
  tool_call: 'text-warning',
  tool_result: 'text-warning',
  handoff: 'text-orange-600 dark:text-orange-400',
  run_end: 'text-emerald-700 dark:text-emerald-400',
  error: 'text-destructive',
  note: 'text-muted-foreground italic',
};

function detailText(detail: unknown): string | null {
  if (detail === undefined || detail === null) return null;
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}

export function TestTab({ agentId, buildDraft, tools, canRealRead }: TestTabProps) {
  const [toolMocks, setToolMocks] = useState<Record<string, string>>({});
  const [realTools, setRealTools] = useState<string[]>([]);
  const [simState, setSimState] = useState<SimState | null>(null);
  const [chat, setChat] = useState<ChatItem[]>([]);
  const [turns, setTurns] = useState<TurnLog[]>([]);
  const [info, setInfo] = useState<AgentSimulateResponse['agent'] | null>(null);
  const [realDenied, setRealDenied] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const counter = useRef(0);

  function reset() {
    setSimState(null);
    setChat([]);
    setTurns([]);
    setInfo(null);
    setRealDenied(false);
    setError(null);
  }

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    const id = `t${++counter.current}`;
    setInput('');
    setSending(true);
    setError(null);
    setChat((c) => [...c, { id, from: 'cliente', text }]);
    try {
      const res = await simulateAgent(agentId, {
        agent: buildDraft(),
        message: { kind: 'text', text },
        state: simState,
        toolMocks,
        realReadOnlyTools: realTools,
      });
      setSimState(res.state);
      setInfo(res.agent);
      setRealDenied(!!res.real_read_denied);
      setRemaining(res.remaining);
      setChat((c) => [...c, ...res.outbound.map((m) => ({ id: `${id}-${m.id}`, from: 'agente' as const, message: m }))]);
      setTurns((t) => [...t, { id, input: text, events: res.timeline.filter((e) => SHOWN.has(e.type)) }]);
    } catch (err) {
      setError(err instanceof AgentApiError ? err.message : 'Falha ao testar o agente.');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <section aria-label="Conversa de teste" className="flex min-h-[28rem] flex-col overflow-hidden rounded-[10px] border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <FlaskConical className="size-4 text-primary" />
          <span className="text-sm font-semibold">Testar agente</span>
          <span className="text-xs text-muted-foreground">rascunho · nada é enviado</span>
          <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={reset} disabled={sending}>
            <RotateCcw className="size-3.5" />
            Reiniciar
          </Button>
        </div>

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">
          {info?.disabled && (
            <p className="flex items-start gap-1.5 text-xs text-warning">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              Este agente está desligado: em produção os nós que o usam seguem pela saída de falha. O teste roda mesmo assim.
            </p>
          )}
          {realDenied && (
            <p className="text-xs text-warning">A consulta real das ferramentas exige permissão para gravar credenciais: tudo foi simulado.</p>
          )}
          {chat.length === 0 && (
            <p className="text-xs text-muted-foreground">
              Escreva como se fosse o cliente. O agente responde com o que está no formulário agora (mesmo sem publicar), com a
              chave de IA da conta; as ferramentas respondem com o mock ao lado.
            </p>
          )}
          {chat.map((item) =>
            item.from === 'cliente' ? (
              <div key={item.id} className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-lg bg-primary px-2.5 py-1.5 text-sm text-primary-foreground">
                {item.text}
              </div>
            ) : (
              <div key={item.id} className="max-w-[90%] whitespace-pre-wrap rounded-lg bg-muted px-2.5 py-1.5 text-sm">
                {item.message.text}
                {item.message.source !== 'ia' && <div className="mt-0.5 text-[11px] text-muted-foreground">mensagem do fluxo</div>}
              </div>
            ),
          )}
          {sending && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> o agente está respondendo…
            </div>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <form
          className="flex items-center gap-2 border-t border-border p-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Mensagem do cliente…"
            disabled={sending}
            aria-label="Mensagem do cliente"
          />
          <Button type="submit" size="sm" disabled={sending || !input.trim()} aria-label="Enviar mensagem de teste">
            <Send className="size-3.5" />
          </Button>
        </form>
        {remaining !== null && (
          <p className="px-3 pb-2 text-[11px] text-muted-foreground">
            {remaining} mensagens de teste restantes nesta janela de 10 min (somando o simulador de fluxo)
          </p>
        )}
      </section>

      <aside className="space-y-4">
        <div className="space-y-2 rounded-[10px] border border-border bg-card p-3 text-xs">
          <p className="font-medium text-foreground">Respostas das ferramentas (mock)</p>
          {tools.length === 0 ? (
            <p className="text-muted-foreground">Nenhuma ferramenta ligada neste agente.</p>
          ) : (
            tools.map((t) => {
              const canBeReal =
                canRealRead && SIM_READ_ONLY_TOOLS.includes(t.name) && !SIM_NEVER_REAL_TOOLS.includes(t.name) && t.method === 'GET';
              const isReal = realTools.includes(t.name);
              return (
                <div key={t.name} className="space-y-1 rounded-md border border-border p-2">
                  <div className="flex items-center gap-2">
                    <code className="text-[11.5px]">{t.name}</code>
                    <span className="text-[11px] text-muted-foreground">{t.method}</span>
                    {SIM_NEVER_REAL_TOOLS.includes(t.name) && <span className="ml-auto text-[11px] text-muted-foreground">sempre simulada</span>}
                  </div>
                  {canBeReal && (
                    <label className="flex items-start gap-1.5">
                      <input
                        type="checkbox"
                        checked={isReal}
                        onChange={(e) => setRealTools((cur) => (e.target.checked ? [...cur, t.name] : cur.filter((n) => n !== t.name)))}
                      />
                      <span>
                        Consultar a API real (somente leitura)
                        {isReal && (
                          <span className="mt-0.5 flex items-center gap-1 text-warning">
                            <TriangleAlert className="size-3" /> Usa dados reais de devedor — só com CPF de teste.
                          </span>
                        )}
                      </span>
                    </label>
                  )}
                  {!isReal && (
                    <Textarea
                      rows={2}
                      placeholder='Resposta devolvida ao modelo, ex.: [{"iddev":"123"}]'
                      value={toolMocks[t.name] ?? ''}
                      onChange={(e) => setToolMocks((m) => ({ ...m, [t.name]: e.target.value }))}
                      className="font-mono text-[11px]"
                    />
                  )}
                </div>
              );
            })
          )}
        </div>

        {turns.length > 0 && (
          <div className="rounded-[10px] border border-border bg-card p-3">
            <p className="mb-1 text-xs font-medium">O que o agente fez</p>
            <ol className="space-y-2">
              {turns.map((turn) => (
                <li key={turn.id} className="text-[11.5px]">
                  <p className="truncate font-medium">“{turn.input}”</p>
                  {turn.events.length === 0 ? (
                    <p className="pl-2 text-muted-foreground">Só respondeu (sem ferramentas nem tags).</p>
                  ) : (
                    <ul className="mt-0.5 space-y-0.5 border-l border-border pl-2">
                      {turn.events.map((ev, i) => {
                        const detail = detailText(ev.detail);
                        return (
                          <li key={i} className={cn(COLORS[ev.type])}>
                            {ev.label}
                            {detail && <p className="break-all font-mono text-[10.5px] text-muted-foreground">{detail}</p>}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
          </div>
        )}
      </aside>
    </div>
  );
}
