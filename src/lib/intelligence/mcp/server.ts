// Servidor MCP do DDM Intelligence (PRD-04 Fase 3) — Streamable HTTP em
// /api/mcp, SEM estado: um Server + transporte novos por requisição (o
// Passenger reinicia o processo; nada de sessão em memória).
//
// Expõe 1:1 as ferramentas do catálogo (listTools: nome, descrição e
// inputSchema). Toda chamada passa pelo mesmo executor do chat
// (createToolExecutor → executeTool com o escopo do servidor, limite por
// usuário compartilhado de rate.ts e auditoria logToolCall), com origem
// 'mcp' e a chave usada na auditoria. O resultado sai mascarado
// (CPF/CNPJ/telefone, ../mask.ts). Somente leitura: o catálogo não tem
// ferramenta de escrita.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { toApiErrorResponse } from "@/lib/api/v1/respond";
import { logToolCall, type ToolCallLog } from "../audit";
import { requireIntelligenceApiKey, type IntelligenceKeyContext } from "../api-key";
import { createToolExecutor, type ToolExecutorDeps } from "../chat/execute";
import { maskPersonalData } from "../mask";
import { METRICS } from "../metrics/registry";
import { describeScope } from "../scope";
import { listTools } from "../tools";

export const MCP_SERVER_INFO = { name: "ddm-intelligence", version: "1.0.0" } as const;

const INSTRUCTIONS =
  "Ferramentas de análise do CRM DDM (somente leitura). Os dados já vêm " +
  "restritos ao escopo do dono da chave (conta toda para owner/admin; só as " +
  "equipes dele para supervisor) — não tente pedir outra conta. Cite sempre o " +
  "período e o escopo devolvidos pelas ferramentas; números vêm delas, não " +
  "calcule por conta própria. CPF, CNPJ e telefones aparecem mascarados.";

/** Catálogo no formato MCP. */
export function mcpToolCatalog(): Tool[] {
  return listTools().map((t) => ({
    name: t.name,
    description: t.description,
    // Mesmo JSON Schema do catálogo; só o tipo difere (properties: unknown).
    inputSchema: t.inputSchema as unknown as Tool["inputSchema"],
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }));
}

export interface McpServerDeps extends Omit<ToolExecutorDeps, "log"> {
  /** Auditoria (padrão: logToolCall). Recebe a entrada já com origin 'mcp'. */
  log?: (entry: ToolCallLog) => Promise<void>;
}

export function createIntelligenceMcpServer(ctx: IntelligenceKeyContext, deps: McpServerDeps = {}): Server {
  const audit = deps.log ?? ((entry: ToolCallLog) => logToolCall(entry));
  const execute = createToolExecutor(ctx.scope, {
    ...deps,
    log: (entry) => audit({ ...entry, origin: "mcp", apiKeyId: ctx.keyId }),
  });

  const server = new Server(MCP_SERVER_INFO, { capabilities: { tools: {}, resources: {} }, instructions: INSTRUCTIONS });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: mcpToolCatalog() }));

  // Definições estáticas do catálogo: sem consultas nem escrita no banco.
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: METRICS.map((metric) => ({
      uri: `ddm://metrics/${metric.id}`,
      name: metric.display_name,
      description: metric.description,
      mimeType: "application/json",
    })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    const metric = METRICS.find((item) => uri === `ddm://metrics/${item.id}`);
    if (!metric) throw new McpError(-32002, "Métrica não encontrada", { uri });
    return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(metric) }] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;
    const outcome = await execute(name, JSON.stringify(args ?? {}));
    if (!outcome.ok) {
      return { isError: true, content: [{ type: "text", text: `${outcome.kind}: ${outcome.message}` }] };
    }
    const payload = maskPersonalData({ result: outcome.result, scope: describeScope(ctx.scope) });
    return { content: [{ type: "text", text: JSON.stringify(payload) }] };
  });

  return server;
}

export interface HandleMcpDeps extends McpServerDeps {
  /** Autenticação (padrão: chave pessoal com intelligence:read). */
  authenticate?: (request: Request) => Promise<IntelligenceKeyContext>;
}

/**
 * Atende uma requisição HTTP do MCP. Autentica ANTES de tocar no
 * protocolo: sem chave válida, nada do servidor é instanciado.
 */
export async function handleMcpRequest(request: Request, deps: HandleMcpDeps = {}): Promise<Response> {
  let ctx: IntelligenceKeyContext;
  try {
    ctx = await (deps.authenticate ?? ((req: Request) => requireIntelligenceApiKey(req)))(request);
  } catch (err) {
    const res = toApiErrorResponse(err);
    if (res.status === 401) res.headers.set("WWW-Authenticate", 'Bearer realm="ddm-intelligence"');
    return res;
  }

  const server = createIntelligenceMcpServer(ctx, deps);
  // enableJsonResponse: a resposta sai inteira em JSON (sem SSE) — as
  // ferramentas não emitem progresso e o proxy não segura stream aberto.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } catch (err) {
    console.error("[mcp] falha ao atender requisição:", err);
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null },
      { status: 500 },
    );
  } finally {
    await server.close().catch(() => undefined);
  }
}
