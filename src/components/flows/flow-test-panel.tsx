"use client";

import { useMemo, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  FlaskConical,
  MessageCircle,
  RotateCcw,
  Send,
  ShieldCheck,
  TriangleAlert,
  Workflow,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useFlowEditor } from "./flow-editor-state";
import { NODE_META, type NodeType } from "./shared";
import {
  respondToFlowTest,
  startFlowTest,
  type FlowTestSession,
  type TestAction,
  type TestNode,
} from "@/lib/flows/test-simulator";

const fieldClass =
  "h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary";
const areaClass =
  "w-full resize-y rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-primary";

function labelFor(nodeType: string): string {
  return NODE_META[nodeType as NodeType]?.label ?? nodeType;
}

function JsonPreview({ data }: { data: unknown }) {
  return (
    <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-[11px] leading-5 text-foreground">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

/**
 * A local, side-effect-free chat sandbox. It consumes the same editor
 * state as the Diagram/List views and never calls the production runner.
 * Even on an active flow, unsaved changes can be tested safely.
 */
export function FlowTestPanel() {
  const { state, issues } = useFlowEditor();
  const [name, setName] = useState("Contato de teste");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [tags, setTags] = useState("");
  const [initialMessage, setInitialMessage] = useState("");
  const [seedVars, setSeedVars] = useState("{}");
  const [reply, setReply] = useState("");
  const [httpReply, setHttpReply] = useState("{}");
  const [setupError, setSetupError] = useState("");
  const [session, setSession] = useState<FlowTestSession | null>(null);
  const [snapshot, setSnapshot] = useState<{ signature: string; nodes: TestNode[] } | null>(null);

  const signature = useMemo(
    () => JSON.stringify({ entry: state.entry_node_id, nodes: state.nodes }),
    [state.entry_node_id, state.nodes],
  );
  const outdated = session !== null && snapshot !== null && snapshot.signature !== signature;
  const blockingIssues = issues.filter((issue) => issue.severity === "error").length;

  function begin() {
    let vars: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(seedVars || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("As variáveis devem ser um objeto JSON, por exemplo: {\"nome\":\"Ana\"}.");
      }
      vars = parsed as Record<string, unknown>;
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : "JSON de variáveis inválido.");
      return;
    }
    if (!state.entry_node_id) {
      setSetupError("Escolha um nó de entrada antes de testar.");
      return;
    }
    // Keep the graph actually tested immutable for the whole session.
    const nodes = state.nodes.map((node) => ({
      node_key: node.node_key,
      node_type: node.node_type,
      config: JSON.parse(JSON.stringify(node.config)) as Record<string, unknown>,
    }));
    const nextSession = startFlowTest({
      entryNodeId: state.entry_node_id,
      nodes,
      contact: { name: name.trim(), phone: phone.trim(), email: email.trim(), company: company.trim() },
      vars,
      tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean),
      initialMessage,
    });
    setSnapshot({ signature, nodes });
    setSession(nextSession);
    setReply("");
    setHttpReply("{}");
    setSetupError("");
  }

  function respond(action: TestAction) {
    if (!session || !snapshot || outdated) return;
    setSession(respondToFlowTest(session, snapshot.nodes, action));
    setReply("");
  }

  const waiting = !outdated && session?.status === "waiting" ? session.wait : null;
  const inputIsAi = waiting?.kind === "ai_response";
  const canReply = waiting?.kind === "text" || waiting?.kind === "ai_response" || waiting?.kind === "ai_customer";

  return (
    <div className="absolute inset-0 flex min-h-0 flex-col overflow-y-auto bg-card-2">
      <div className="shrink-0 border-b border-border bg-card px-4 py-4 md:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <FlaskConical className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold text-foreground">Laboratório do fluxo</h2>
              <span className="rounded-full border border-emerald-600/25 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                Seguro / simulado
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Teste o rascunho atual, mesmo sem salvar. Nenhuma mensagem, IA, ferramenta ou integração real será acionada.
            </p>
          </div>
          <Button size="sm" type="button" onClick={begin} className="gap-2">
            {session ? <RotateCcw className="h-3.5 w-3.5" /> : <FlaskConical className="h-3.5 w-3.5" />}
            {session ? "Reiniciar teste" : "Iniciar teste"}
          </Button>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <label className="space-y-1 text-xs font-medium text-muted-foreground">
            Nome fictício
            <input className={fieldClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </label>
          <label className="space-y-1 text-xs font-medium text-muted-foreground">
            Telefone fictício
            <input className={fieldClass} value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={30} placeholder="Opcional" />
          </label>
          <label className="space-y-1 text-xs font-medium text-muted-foreground">
            Tags do contato (IDs)
            <input className={fieldClass} value={tags} onChange={(e) => setTags(e.target.value)} maxLength={500} placeholder="tag-1, tag-2" />
          </label>
          <label className="space-y-1 text-xs font-medium text-muted-foreground">
            Mensagem inicial fictícia
            <input className={fieldClass} value={initialMessage} onChange={(e) => setInitialMessage(e.target.value)} maxLength={500} placeholder="Ex.: Olá" />
          </label>
        </div>
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer select-none py-1 font-medium text-muted-foreground hover:text-foreground">
            Dados avançados do teste (email, empresa e variáveis)
          </summary>
          <div className="mt-2 grid grid-cols-1 gap-3 pb-2 sm:grid-cols-2 lg:grid-cols-3">
            <label className="space-y-1 font-medium text-muted-foreground">
              Email fictício
              <input className={fieldClass} value={email} onChange={(e) => setEmail(e.target.value)} maxLength={120} />
            </label>
            <label className="space-y-1 font-medium text-muted-foreground">
              Empresa fictícia
              <input className={fieldClass} value={company} onChange={(e) => setCompany(e.target.value)} maxLength={120} />
            </label>
            <label className="space-y-1 font-medium text-muted-foreground">
              Variáveis iniciais (JSON)
              <textarea className={areaClass} value={seedVars} onChange={(e) => setSeedVars(e.target.value)} rows={2} maxLength={8192} />
            </label>
          </div>
        </details>
        {blockingIssues > 0 && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300">
            <TriangleAlert className="h-3.5 w-3.5" />
            O fluxo tem {blockingIssues} erro(s) de validação. O teste pode parar no primeiro trecho incompleto.
          </p>
        )}
        {setupError && <p role="alert" className="mt-2 text-xs text-destructive">{setupError}</p>}
      </div>

      {outdated && (
        <div role="alert" className="flex items-start gap-2 border-b border-amber-500/30 bg-amber-500/10 px-6 py-3 text-xs text-amber-800 dark:text-amber-200">
          <TriangleAlert className="h-4 w-4 shrink-0" />
          O fluxo foi editado depois de iniciar esta simulação. Clique em &quot;Reiniciar teste&quot; para usar a versão atual.
        </div>
      )}

      {!session ? (
        <div className="flex min-h-[260px] flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-muted">
            <MessageCircle className="h-5 w-5 text-muted-foreground" />
          </div>
          <h3 className="text-sm font-semibold text-foreground">Teste antes de publicar</h3>
          <p className="max-w-lg text-sm text-muted-foreground">
            Escolha um nó de entrada no editor, configure um contato fictício e inicie.
            O teste começa diretamente pelo nó de entrada (sem validar o gatilho).
          </p>
          <p className="max-w-lg text-xs text-muted-foreground">
            Mensagens e caminhos condicionais são simulados; para nós de IA, HTTP ou anexos,
            você informa respostas fictícias sem executar serviços externos.
          </p>
        </div>
      ) : (
        <div className="grid min-h-[440px] flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_350px]">
          <section className="flex min-h-[380px] min-w-0 flex-col border-b border-border lg:border-b-0 lg:border-r">
            <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <MessageCircle className="h-4 w-4" />
                Conversa simulada
              </div>
              <span className="text-xs text-muted-foreground">
                {session.status === "waiting" ? "Aguardando interação" : session.status === "finished" ? "Concluído" : "Interrompido"}
              </span>
            </div>
            <div aria-live="polite" className="flex min-h-[230px] flex-1 flex-col gap-3 overflow-y-auto p-5">
              {session.messages.map((item, index) => (
                <div
                  key={index}
                  className={
                    item.role === "notice"
                      ? "self-center rounded-lg border border-border bg-muted px-3 py-2 text-center text-xs text-muted-foreground"
                      : item.role === "customer"
                        ? "max-w-[85%] self-end whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-primary px-4 py-2.5 text-sm text-primary-foreground"
                        : "max-w-[85%] self-start whitespace-pre-wrap break-words rounded-2xl rounded-bl-sm border border-border bg-card px-4 py-2.5 text-sm text-foreground"
                  }
                >
                  {item.text}
                </div>
              ))}
            </div>
            <div className="shrink-0 border-t border-border bg-card px-4 py-3">
              {waiting?.kind === "choice" && (
                <div className="flex flex-wrap gap-2">
                  {waiting.options.map((option) => (
                    <Button key={option.id} size="sm" variant="outline" type="button" onClick={() => respond({ kind: "choice", id: option.id })}>
                      {option.label}
                    </Button>
                  ))}
                </div>
              )}
              {canReply && (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!reply.trim()) return;
                    respond(inputIsAi ? { kind: "ai_response", text: reply } : { kind: "text", text: reply });
                  }}
                  className="flex items-end gap-2"
                >
                  <label className="min-w-0 flex-1 space-y-1 text-xs text-muted-foreground">
                    {inputIsAi ? "Resposta fictícia da IA (não usa modelo real)" : "Mensagem fictícia do cliente"}
                    <input
                      className={fieldClass}
                      value={reply}
                      onChange={(event) => setReply(event.target.value)}
                      placeholder={inputIsAi ? "Digite o que a IA responderia..." : "Digite uma resposta..."}
                      maxLength={4000}
                    />
                  </label>
                  <Button size="sm" type="submit" disabled={!reply.trim()} className="h-9 gap-1.5">
                    <Send className="h-3.5 w-3.5" /> Enviar
                  </Button>
                </form>
              )}
              {waiting?.kind === "http_response" && (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">Informe um JSON fictício para substituir a resposta HTTP. Nenhuma URL será chamada.</p>
                  <textarea rows={3} maxLength={8192} className={areaClass} value={httpReply} onChange={(event) => setHttpReply(event.target.value)} aria-label="Resposta HTTP simulada" />
                  <Button size="sm" type="button" onClick={() => {
                    try {
                      const value: unknown = JSON.parse(httpReply);
                      setSetupError("");
                      respond({ kind: "http_response", value });
                    } catch {
                      setSetupError("Resposta HTTP simulada: JSON inválido.");
                    }
                  }}>
                    Aplicar resposta simulada <ArrowRight className="ml-2 h-3.5 w-3.5" />
                  </Button>
                  {setupError && <p role="alert" className="text-xs text-destructive">{setupError}</p>}
                </div>
              )}
              {waiting?.kind === "attachment" && (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">Escolha o tipo de anexo fictício (nenhum upload será realizado):</p>
                  <div className="flex flex-wrap gap-2">
                    {waiting.allowed.map((mediaType) => (
                      <Button
                        key={mediaType}
                        variant="outline"
                        size="sm"
                        type="button"
                        onClick={() => respond({ kind: "attachment", mediaType: mediaType as "image" | "video" | "audio" | "document" })}
                      >
                        {mediaType}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
              {!waiting && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  {session.status === "finished"
                    ? <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                    : <TriangleAlert className="h-4 w-4 text-amber-600" />}
                  {session.ending}
                </div>
              )}
            </div>
          </section>

          <aside className="flex min-h-[380px] min-w-0 flex-col bg-card/50">
            <div className="flex items-center gap-2 border-b border-border px-4 py-3 text-sm font-semibold text-foreground">
              <Workflow className="h-4 w-4" />
              Caminho executado
              <span className="ml-auto font-mono text-xs font-normal text-muted-foreground">
                {session.trace.length} etapas
              </span>
            </div>
            <div className="min-h-[210px] flex-1 space-y-3 overflow-y-auto px-4 py-4">
              {session.trace.map((step, index) => (
                <div key={index} className="flex gap-2.5">
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-card text-[10px] font-semibold text-muted-foreground">
                    {index + 1}
                  </div>
                  <div className="min-w-0">
                    <p className="break-words text-xs font-semibold text-foreground">{labelFor(step.node_type)}</p>
                    <p className="break-all font-mono text-[10px] text-muted-foreground">{step.node_key}</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">{step.detail}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="shrink-0 space-y-2 border-t border-border px-4 py-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
                Somente memória local; nada gravado
              </div>
              <details>
                <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">Variáveis ({Object.keys(session.vars).length})</summary>
                <div className="mt-2"><JsonPreview data={session.vars} /></div>
              </details>
              <details>
                <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">Tags fictícias ({session.tags.length})</summary>
                <div className="mt-2"><JsonPreview data={session.tags} /></div>
              </details>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
