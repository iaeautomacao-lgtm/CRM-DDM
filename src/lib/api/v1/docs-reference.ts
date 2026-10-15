// Modelo da REFERÊNCIA da documentação (/docs/api): lê a spec OpenAPI (openapi.ts, a mesma de
// /api/v1/openapi.json) e devolve dados prontos para a tela — grupos de rotas, parâmetros, campos do corpo,
// respostas com exemplo e snippets (curl / JavaScript / Python / n8n). Não cria conteúdo: só reorganiza o que a
// spec já diz. Funções puras e serializáveis (sem segredo; a chave é sempre um marcador).

import { openApiSpec } from './openapi';
import { apiBaseUrl, buildSnippets, requestFromOperation, type Snippets } from './docs-examples';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
type MethodLower = (typeof METHODS)[number];

/** Escopo exigido por operação (a spec o descreve em texto; aqui vira dado para o selo da rota). Teste garante cobertura. */
export const OPERATION_SCOPES: Record<string, string[]> = {
  getMe: [],
  sendWhatsappMessage: ['messages:send'],
  listContacts: ['contacts:read', 'contacts:write'],
  getContact: ['contacts:read', 'contacts:write'],
  listTabulations: ['conversations:read', 'conversations:write'],
  listAgents: ['conversations:read', 'conversations:write'],
  listTeams: ['conversations:read', 'conversations:write'],
  openConversation: ['conversations:write'],
  closeConversation: ['conversations:write'],
  transferConversation: ['conversations:write'],
  setContactOwner: ['contacts:write'],
  removeContactOwner: ['contacts:write'],
  upsertContact: ['contacts:write'],
  updateContact: ['contacts:write'],
  sendWhatsappTemplate: ['messages:send'],
  listTemplates: ['templates:read', 'messages:send', 'campaigns:write'],
  createCampaign: ['campaigns:write'],
  getCampaign: ['campaigns:read', 'campaigns:write'],
  listCampaigns: ['campaigns:read', 'campaigns:write'],
  listCampaignRecipients: ['campaigns:read', 'campaigns:write'],
  addCampaignRecipients: ['campaigns:write'],
  pauseCampaign: ['campaigns:write'],
  resumeCampaign: ['campaigns:write'],
  cancelCampaign: ['campaigns:write'],
  removeCampaignRecipients: ['campaigns:write'],
  getReportOperationsCurrent: ['reports:read'],
  getReportOperationsSummary: ['reports:read'],
  getReportTeams: ['reports:read'],
  getReportAgents: ['reports:read'],
  getReportTabulations: ['reports:read'],
  listConversations: ['conversations:read'],
  listConversationMessages: ['messages:read'],
  listMessages: ['messages:read'],
  listWebhooks: ['webhooks:read', 'webhooks:write'],
  createWebhook: ['webhooks:write'],
  getWebhook: ['webhooks:read', 'webhooks:write'],
  updateWebhook: ['webhooks:write'],
  deleteWebhook: ['webhooks:write'],
  listWebhookDeliveries: ['webhooks:read', 'webhooks:write'],
  replayWebhookDelivery: ['webhooks:write'],
  rotateWebhookSecret: ['webhooks:write'],
  testWebhook: ['webhooks:write'],
};

export interface FieldRow {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

export interface ParamRow extends FieldRow {
  in: 'path' | 'query' | 'header';
  example?: string;
}

export interface ResponseExample {
  label: string | null;
  json: string;
}

export interface ResponseRow {
  status: string;
  description: string;
  examples: ResponseExample[];
  /** Só nas respostas de sucesso: campos do corpo (envelope `data`). */
  fields: FieldRow[];
}

export interface SnippetSet {
  label: string | null;
  snippets: Snippets;
}

export interface BodyModel {
  description: string;
  fields: FieldRow[];
}

export interface OperationModel {
  /** operationId — também é a âncora (#id) da rota. */
  id: string;
  method: string;
  path: string;
  summary: string;
  description: string;
  scopes: string[];
  params: ParamRow[];
  body: BodyModel | null;
  responses: ResponseRow[];
  snippetSets: SnippetSet[];
}

export interface GroupModel {
  /** Âncora do grupo (#grupo-…). */
  id: string;
  name: string;
  description: string;
  operations: OperationModel[];
}

export interface ReferenceModel {
  baseUrl: string;
  groups: GroupModel[];
}

const slug = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

function resolveRef(spec: Json, node: Json | undefined): Json | undefined {
  let current = node;
  for (let i = 0; current && typeof current.$ref === 'string' && i < 8; i++) {
    const parts = (current.$ref as string).replace(/^#\//, '').split('/');
    current = parts.reduce<Json | undefined>((acc, part) => acc?.[part], spec);
  }
  return current;
}

function typeLabel(schema: Json | undefined): string {
  if (!schema) return 'objeto';
  if (schema.enum) return (schema.enum as unknown[]).map((v) => JSON.stringify(v)).join(' | ');
  if (schema.oneOf || schema.anyOf) return 'um dos formatos descritos';
  const type = Array.isArray(schema.type) ? (schema.type as string[]).join(' | ') : (schema.type as string | undefined);
  if (type === 'array') return `lista de ${typeLabel(schema.items)}`;
  if (!type) return 'objeto';
  return schema.format ? `${type} (${schema.format})` : type;
}

/** Achata o schema em linhas (`campo`, `lista[].campo`), com profundidade limitada. */
function fieldRows(spec: Json, schemaNode: Json | undefined, prefix = '', depth = 0): FieldRow[] {
  const schema = resolveRef(spec, schemaNode);
  if (!schema || depth > 3) return [];
  const rows: FieldRow[] = [];
  const required = new Set<string>((schema.required as string[] | undefined) ?? []);
  for (const [name, raw] of Object.entries((schema.properties ?? {}) as Record<string, Json>)) {
    const prop = resolveRef(spec, raw) ?? raw;
    const path = `${prefix}${name}`;
    rows.push({ name: path, type: typeLabel(prop), required: required.has(name), description: String(prop.description ?? '') });
    const isList = prop.type === 'array';
    const child = isList ? resolveRef(spec, prop.items) : prop;
    if (child?.properties) rows.push(...fieldRows(spec, child, `${path}${isList ? '[]' : ''}.`, depth + 1));
  }
  return rows;
}

function jsonExamples(content: Json | undefined): ResponseExample[] {
  const json = content?.['application/json'] as Json | undefined;
  if (!json) return [];
  const examples = json.examples as Record<string, { summary?: string; value: unknown }> | undefined;
  if (examples && Object.keys(examples).length > 0) {
    return Object.entries(examples).map(([key, e]) => ({ label: e.summary ?? key, json: JSON.stringify(e.value, null, 2) }));
  }
  return json.example !== undefined ? [{ label: null, json: JSON.stringify(json.example, null, 2) }] : [];
}

function buildOperation(spec: Json, baseUrl: string, path: string, method: MethodLower): OperationModel {
  const op = spec.paths[path][method] as Json;
  const id = String(op.operationId);

  const params: ParamRow[] = ((op.parameters ?? []) as Json[]).map((raw) => {
    const p = resolveRef(spec, raw) ?? raw;
    const schema = resolveRef(spec, p.schema) ?? p.schema;
    return {
      name: String(p.name),
      in: p.in,
      required: p.in === 'path' ? true : Boolean(p.required),
      type: typeLabel(schema),
      description: String(p.description ?? ''),
      example: p.example !== undefined ? String(p.example) : undefined,
    };
  });

  const bodyJson = op.requestBody?.content?.['application/json'] as Json | undefined;
  const body: BodyModel | null = bodyJson
    ? { description: String(op.requestBody.description ?? ''), fields: fieldRows(spec, bodyJson.schema) }
    : null;

  const responses: ResponseRow[] = Object.entries(op.responses as Record<string, Json>).map(([status, raw]) => {
    const r = resolveRef(spec, raw) ?? raw;
    const content = r.content as Json | undefined;
    const ok = /^2/.test(status);
    return {
      status,
      description: String(r.description ?? ''),
      examples: jsonExamples(content),
      fields: ok ? fieldRows(spec, content?.['application/json']?.schema) : [],
    };
  });

  // Um conjunto de snippets por exemplo de corpo (ex.: campanha Meta × WAHA); sem exemplos, um só.
  const exampleNames = Object.keys((bodyJson?.examples ?? {}) as Record<string, unknown>);
  const sets = exampleNames.length > 0 ? exampleNames : [undefined];
  const snippetSets: SnippetSet[] = sets.map((name) => ({
    label: name ? String(((bodyJson?.examples as Json)[name] as Json).summary ?? name) : null,
    snippets: buildSnippets(baseUrl, requestFromOperation(spec, path, method, name), op.summary),
  }));

  return {
    id,
    method: method.toUpperCase(),
    path,
    summary: String(op.summary ?? ''),
    description: String(op.description ?? ''),
    scopes: OPERATION_SCOPES[id] ?? [],
    params,
    body,
    responses,
    snippetSets,
  };
}

/** Referência completa, na ordem das tags da spec; rotas de uma tag na ordem em que aparecem. */
export function buildReference(appUrl: string | undefined): ReferenceModel {
  const baseUrl = apiBaseUrl(appUrl);
  const spec = openApiSpec as unknown as Json;
  const tags = spec.tags as Array<{ name: string; description?: string }>;
  const groups: GroupModel[] = tags.map((tag) => ({ id: `grupo-${slug(tag.name)}`, name: tag.name, description: tag.description ?? '', operations: [] }));
  for (const [path, item] of Object.entries(spec.paths as Record<string, Json>)) {
    for (const method of METHODS) {
      const op = item[method] as Json | undefined;
      if (!op) continue;
      const group = groups.find((g) => g.name === op.tags?.[0]);
      if (group) group.operations.push(buildOperation(spec, baseUrl, path, method));
    }
  }
  return { baseUrl, groups: groups.filter((g) => g.operations.length > 0) };
}
