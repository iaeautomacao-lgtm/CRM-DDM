// Exemplos de código da documentação amigável (/docs/api), GERADOS a partir de openapi.ts —
// os valores (corpo, query, headers) saem dos `example`/`examples` da especificação, então o guia
// não diverge do contrato. Funções puras: sem I/O, sem segredo (a chave é sempre um marcador).

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export type DocMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface DocRequest {
  method: DocMethod;
  /** Caminho já relativo à base da API (ex.: `/disparador/campaigns/ID_DA_CAMPANHA`). */
  path: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  body?: unknown;
}

export interface Snippets {
  curl: string;
  js: string;
  n8n: string;
}

export const API_KEY_PLACEHOLDER = 'SUA_CHAVE_DE_API';
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/** Monta a requisição de exemplo de UMA operação da spec (`exampleName` escolhe o exemplo do corpo). */
export function requestFromOperation(spec: Json, path: string, method: (typeof METHODS)[number], exampleName?: string): DocRequest {
  const op = spec.paths?.[path]?.[method] as Json | undefined;
  if (!op) throw new Error(`Operação não encontrada na spec: ${method.toUpperCase()} ${path}`);
  const headers: Record<string, string> = { Authorization: `Bearer ${API_KEY_PLACEHOLDER}` };
  const query: Record<string, string> = {};
  let resolvedPath = path;

  for (const param of (op.parameters ?? []) as Json[]) {
    const example = param.example !== undefined ? String(param.example) : undefined;
    if (param.in === 'path') {
      const value = example ?? `ID_${String(param.name).toUpperCase()}`;
      resolvedPath = resolvedPath.replace(`{${param.name}}`, value);
    } else if (param.in === 'header' && example !== undefined) {
      headers[param.name] = example;
    } else if (param.in === 'query' && example !== undefined) {
      query[param.name] = example;
    }
  }

  let body: unknown;
  const content = op.requestBody?.content?.['application/json'] as Json | undefined;
  if (content) {
    const examples = (content.examples ?? {}) as Record<string, { value: unknown }>;
    const chosen = exampleName ? examples[exampleName] : Object.values(examples)[0];
    if (exampleName && !chosen) throw new Error(`Exemplo ${exampleName} não existe em ${method.toUpperCase()} ${path}`);
    body = chosen?.value ?? content.example;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
  }

  return { method: method.toUpperCase() as DocMethod, path: resolvedPath, headers, query, body };
}

function fullUrl(baseUrl: string, req: DocRequest, withQuery = true): string {
  const qs = new URLSearchParams(req.query).toString();
  return `${baseUrl}${req.path}${withQuery && qs ? `?${qs}` : ''}`;
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export function toCurl(baseUrl: string, req: DocRequest): string {
  const lines = [`curl ${req.method === 'GET' ? '' : `-X ${req.method} `}${shellQuote(fullUrl(baseUrl, req))}`.replace(/ +$/, '')];
  for (const [name, value] of Object.entries(req.headers)) lines.push(`  -H ${shellQuote(`${name}: ${value}`)}`);
  if (req.body !== undefined) lines.push(`  -d ${shellQuote(JSON.stringify(req.body, null, 2))}`);
  return lines.join(' \\\n');
}

export function toFetch(baseUrl: string, req: DocRequest): string {
  const headers = JSON.stringify(req.headers, null, 2).replace(/^/gm, '  ').trimStart();
  const options = [`  method: ${JSON.stringify(req.method)},`, `  headers: ${headers},`];
  if (req.body !== undefined) options.push(`  body: JSON.stringify(${JSON.stringify(req.body, null, 2).replace(/\n/g, '\n  ')}),`);
  return [
    `const resposta = await fetch(${JSON.stringify(fullUrl(baseUrl, req))}, {`,
    ...options,
    '});',
    'const json = await resposta.json();',
    'if (!resposta.ok) {',
    '  // Ramifique pelo código (estável), não pela mensagem.',
    '  throw new Error(`${resposta.status} ${json.error?.code}: ${json.error?.message}`);',
    '}',
    'console.log(json.data);',
  ].join('\n');
}

/** Nó "HTTP Request" do n8n em JSON — dá para colar direto na tela do fluxo (Ctrl+V). */
export function toN8n(baseUrl: string, req: DocRequest, nodeName = 'Chamar API do CRM'): string {
  const parameters: Json = {
    method: req.method,
    url: fullUrl(baseUrl, req, false),
    sendHeaders: true,
    headerParameters: { parameters: Object.entries(req.headers).map(([name, value]) => ({ name, value })) },
  };
  if (Object.keys(req.query).length > 0) {
    parameters.sendQuery = true;
    parameters.queryParameters = { parameters: Object.entries(req.query).map(([name, value]) => ({ name, value })) };
  }
  if (req.body !== undefined) {
    parameters.sendBody = true;
    parameters.specifyBody = 'json';
    parameters.jsonBody = JSON.stringify(req.body, null, 2);
  }
  parameters.options = {};
  return JSON.stringify(
    { nodes: [{ parameters, name: nodeName, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [0, 0] }], connections: {} },
    null,
    2,
  );
}

export function buildSnippets(baseUrl: string, req: DocRequest, nodeName?: string): Snippets {
  return { curl: toCurl(baseUrl, req), js: toFetch(baseUrl, req), n8n: toN8n(baseUrl, req, nodeName) };
}

export const DEFAULT_DOCS_BASE_URL = 'https://SEU-CRM.exemplo.com.br';

/** URL base da API (`…/api/v1`) a partir de NEXT_PUBLIC_APP_URL. */
export function apiBaseUrl(appUrl: string | undefined): string {
  const origin = (appUrl ?? '').trim().replace(/\/+$/, '') || DEFAULT_DOCS_BASE_URL;
  return `${origin}/api/v1`;
}
