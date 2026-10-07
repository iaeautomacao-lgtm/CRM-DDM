import { resolveEffectiveTools } from "@/lib/ai-tools/runtime";
import type { FlowEffects } from "../effects";
import type { WebchatSessionRow } from "@/lib/webchat/sessions";
import { createSimulatedAi } from "./ai";
import { captureOutbound, simNote, type SimContext } from "./context";

/** Mesmo texto numerado que o WAHA manda no lugar de botões/lista (waha-send.ts). */
function wahaNumbered(body: string, items: Array<{ id: string; title: string; description?: string }>, headers?: Map<number, string>) {
  const buttonMap: Record<string, string> = {};
  const lines: string[] = [];
  items.forEach((item, i) => {
    const header = headers?.get(i);
    if (header) lines.push(`*${header}*`);
    const key = String(i + 1);
    buttonMap[key] = item.id;
    lines.push(`${key}. ${item.title}${item.description ? ` — ${item.description}` : ""}`);
  });
  return { buttonMap, text: `${body}\n\n${lines.join("\n")}\n\nDigite o número da opção desejada.` };
}

function notInSimulator(what: string): never {
  throw new Error(`${what} não é executado no simulador`);
}

/**
 * Efeitos do motor em modo simulação: banco em memória, envios
 * capturados, IA real com o prompt do rascunho e tools mockadas, HTTP de
 * http_fetch mockado, logs viram notas. Nenhuma entrada chama o
 * Supabase, a Meta ou o WAHA.
 */
export function createSimulationEffects(ctx: SimContext): FlowEffects {
  return {
    mode: "simulation",
    db: () => ctx.db,

    // Meta
    engineSendText: async (args) => captureOutbound(ctx, { kind: "text", text: args.text, source: "flow" }),
    engineSendMedia: async (args) =>
      captureOutbound(ctx, { kind: "media", text: args.caption ?? args.filename ?? `[${args.kind}]`, source: "flow", mediaUrl: args.link }),
    engineSendInteractiveButtons: async (args) =>
      captureOutbound(ctx, { kind: "buttons", text: args.bodyText, source: "flow", options: args.buttons.map((b) => ({ id: b.id, title: b.title })) }),
    engineSendInteractiveList: async (args) =>
      captureOutbound(ctx, {
        kind: "list",
        text: args.bodyText,
        source: "flow",
        options: args.sections.flatMap((s) => s.rows.map((r) => ({ id: r.id, title: r.title }))),
      }),
    engineMetaSendTemplate: async (args) =>
      captureOutbound(ctx, { kind: "template", text: `[template ${args.templateName} · ${args.languageCode}]`, source: "flow" }),

    // WAHA
    engineWahaSendText: async (args) => captureOutbound(ctx, { kind: "text", text: args.text, source: "flow" }),
    engineWahaSendMedia: async (args) =>
      captureOutbound(ctx, { kind: "media", text: args.caption ?? "[mídia]", source: "flow", mediaUrl: args.mediaUrl }),
    engineWahaSendButtons: async (args) => {
      const { buttonMap, text } = wahaNumbered(args.body, args.buttons);
      const { whatsapp_message_id } = captureOutbound(ctx, { kind: "text", text, source: "flow" });
      return { whatsapp_message_id, buttonMap };
    },
    engineWahaSendList: async (args) => {
      const items = args.sections.flatMap((s) => s.rows);
      const headers = new Map<number, string>();
      let index = 0;
      for (const s of args.sections) {
        if (s.title) headers.set(index, s.title);
        index += s.rows.length;
      }
      const { buttonMap, text } = wahaNumbered(args.body, items, headers);
      const { whatsapp_message_id } = captureOutbound(ctx, { kind: "text", text, source: "flow" });
      return { whatsapp_message_id, buttonMap };
    },

    // Outros canais: a conversa simulada é sempre WhatsApp.
    getConversationChannel: async () => "whatsapp",
    sendWebchatMessage: async () => notInSimulator("Envio pelo Webchat"),
    sendSocialMessage: async () => notInSimulator("Envio por Instagram/Messenger"),
    hasActiveWebchatSession: async () => false,
    createWebchatSession: async (input) => {
      simNote(ctx, "Sessão de Webchat NÃO criada (simulação)", input.startNodeKey);
      return {
        session: { id: "sim-webchat-session" } as WebchatSessionRow,
        token: "sim",
        url: "https://simulador.invalid/webchat",
      };
    },
    sendWebchatInvite: async (input) =>
      captureOutbound(ctx, { kind: "webchat_invite", text: `${input.text}\n[${input.buttonText}]`, source: "flow" }),
    resolveProviderMedia: async (url) => url,

    // Catálogo: mesma lista efetiva da produção (desligada não entra), lida do banco em memória
    // (a rota carrega ai_tools da conta no seed; nada de leitura/escrita no banco real aqui).
    resolveEffectiveTools: (accountId, inline, refs) => resolveEffectiveTools(accountId, inline, refs, ctx.db),
    handleAiAutoResponse: createSimulatedAi(ctx),

    httpFetch: async (nodeKey, url, init) => {
      const body = ctx.httpMocks[nodeKey] ?? JSON.stringify({ simulado: true, mensagem: "Resposta simulada — edite no painel" });
      simNote(ctx, `HTTP ${init.method ?? "GET"} simulado (nenhuma chamada real)`, nodeKey, { url, resposta: body.slice(0, 500) });
      return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
    },
    writeLog: async (params) => {
      if (params.level === "error" || params.level === "critical" || params.level === "warn") {
        simNote(ctx, `Log (${params.level}): ${params.message}`, null, { event: params.event });
      }
    },
    sleep: async () => {},
  };
}
