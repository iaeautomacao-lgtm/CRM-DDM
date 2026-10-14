// Cliente da integração UTMpay (contrato: prd-v2/contrato-api-utmpay-crm.md, backend do Cinzel). Campos em snake_case,
// como a API devolve. Só dados: nada de CPF. Funil = clicou → fechou acordo (payment_start) → pagou (paid, confirmado
// na API DDM). Aqui não há regra de negócio: só tipos, leitura tolerante e rótulos.
import { apiFetch } from "@/lib/api-fetch";

export type Atribuicao = "direto" | "ia" | "humano";

export const ATRIBUICAO_LABEL: Record<Atribuicao, string> = { direto: "Direto", ia: "IA", humano: "Humano" };

export interface UtmpayConfig {
  available: boolean;
  configured: boolean;
  enabled: boolean;
  base_url: string;
  has_api_key: boolean;
  has_webhook_secret: boolean;
  janela_dias: number;
  send_without_tracking: boolean;
  events_url: string;
}

export interface UtmpayConfigInput {
  enabled?: boolean;
  base_url?: string;
  /** Vazio/omitido = manter o atual. Nunca volta do servidor. */
  api_key?: string;
  webhook_secret?: string;
  janela_dias?: number;
  send_without_tracking?: boolean;
}

export interface PorAtribuicao {
  direto: number;
  ia: number;
  humano: number;
}
export interface PorAtendente {
  atendente_id: string;
  atendente_nome: string;
  fechou: number;
  pagou: number;
}

export interface UtmpayFunil {
  available: boolean;
  tracking: boolean;
  entregues: number;
  links: number;
  clicou: number;
  fechou: number;
  pagou: number;
  taxas: { clicou: number | null; fechou: number | null; pagou: number | null };
  por_atribuicao: { fechou: PorAtribuicao; pagou: PorAtribuicao };
  por_atendente: PorAtendente[];
}

export interface UtmpayRanking {
  available: boolean;
  dias: number;
  fechou: number;
  pagou: number;
  por_atribuicao: { fechou: PorAtribuicao; pagou: PorAtribuicao };
  por_atendente: PorAtendente[];
}

export interface Rastreio {
  campanha: string | null;
  enviado_em: string | null;
  clicou_em: string | null;
  fechou_em: string | null;
  pagou_em: string | null;
  atribuicao: Atribuicao | null;
  atendente_nome: string | null;
  situacao_acordo: string | null;
  valor_em_aberto: number | null;
  instituicao: string | null;
  verificado_em: string | null;
}

export class UtmpayApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const rate = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

function atrib(v: unknown): PorAtribuicao {
  const o = rec(v);
  return { direto: num(o.direto), ia: num(o.ia), humano: num(o.humano) };
}
function atendentes(v: unknown): PorAtendente[] {
  return Array.isArray(v)
    ? v.map((a) => {
        const o = rec(a);
        return { atendente_id: String(o.atendente_id ?? ""), atendente_nome: str(o.atendente_nome) ?? "Atendente", fechou: num(o.fechou), pagou: num(o.pagou) };
      })
    : [];
}

export function parseFunil(raw: unknown): UtmpayFunil {
  const o = rec(raw);
  const t = rec(o.taxas);
  const pa = rec(o.por_atribuicao);
  return {
    available: o.available !== false,
    tracking: o.tracking === true,
    entregues: num(o.entregues),
    links: num(o.links),
    clicou: num(o.clicou),
    fechou: num(o.fechou),
    pagou: num(o.pagou),
    taxas: { clicou: rate(t.clicou), fechou: rate(t.fechou), pagou: rate(t.pagou) },
    por_atribuicao: { fechou: atrib(pa.fechou), pagou: atrib(pa.pagou) },
    por_atendente: atendentes(o.por_atendente),
  };
}

export function parseRanking(raw: unknown): UtmpayRanking {
  const o = rec(raw);
  const pa = rec(o.por_atribuicao);
  return {
    available: o.available !== false,
    dias: num(o.dias),
    fechou: num(o.fechou),
    pagou: num(o.pagou),
    por_atribuicao: { fechou: atrib(pa.fechou), pagou: atrib(pa.pagou) },
    por_atendente: atendentes(o.por_atendente),
  };
}

export function parseRastreio(raw: unknown): Rastreio | null {
  const r = rec(rec(raw).rastreio);
  if (Object.keys(r).length === 0) return null;
  const a = r.atribuicao;
  return {
    campanha: str(r.campanha),
    enviado_em: str(r.enviado_em),
    clicou_em: str(r.clicou_em),
    fechou_em: str(r.fechou_em),
    pagou_em: str(r.pagou_em),
    atribuicao: a === "direto" || a === "ia" || a === "humano" ? a : null,
    atendente_nome: str(r.atendente_nome),
    situacao_acordo: str(r.situacao_acordo),
    valor_em_aberto: typeof r.valor_em_aberto === "number" ? r.valor_em_aberto : null,
    instituicao: str(r.instituicao),
    verificado_em: str(r.verificado_em),
  };
}

export function parseConfig(raw: unknown): UtmpayConfig {
  const o = rec(raw);
  return {
    available: o.available !== false,
    configured: o.configured === true,
    enabled: o.enabled === true,
    base_url: str(o.base_url) ?? "",
    has_api_key: o.has_api_key === true,
    has_webhook_secret: o.has_webhook_secret === true,
    janela_dias: num(o.janela_dias) || 7,
    send_without_tracking: o.send_without_tracking === true,
    events_url: str(o.events_url) ?? "",
  };
}

async function request(url: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await apiFetch(url, init);
  } catch {
    throw new UtmpayApiError(0, "Não foi possível falar com o servidor. Tente de novo.");
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = str(rec(body).error);
    throw new UtmpayApiError(res.status, msg ?? (res.status === 403 ? "Você não tem permissão para ver isto." : "Não foi possível carregar agora."));
  }
  return body;
}

export const fetchConfig = async () => parseConfig(await request("/api/account/utmpay-config"));

export async function saveConfig(input: UtmpayConfigInput): Promise<UtmpayConfig> {
  return parseConfig(
    await request("/api/account/utmpay-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function testConfig(): Promise<{ ok: boolean; message: string }> {
  const o = rec(await request("/api/account/utmpay-config/test", { method: "POST" }));
  return { ok: o.ok === true, message: str(o.message) ?? (o.ok === true ? "Conexão ok." : "Sem resposta do UTMpay.") };
}

export const fetchFunil = async (campaignId: string) => parseFunil(await request(`/api/disparador/campaigns/${encodeURIComponent(campaignId)}/funil`));
export const fetchRanking = async (dias: number) => parseRanking(await request(`/api/utmpay/ranking?dias=${dias}`));
export const fetchConversationRastreio = async (conversationId: string) =>
  parseRastreio(await request(`/api/conversations/${encodeURIComponent(conversationId)}/utmpay`));
export const fetchContactRastreio = async (contactId: string) =>
  parseRastreio(await request(`/api/contacts/${encodeURIComponent(contactId)}/utmpay`));

// ---- apresentação (puro) ---------------------------------------------------------------------------------------

export type Etapa = "pagou" | "fechou" | "clicou" | "enviado";

/** Etapa mais avançada do rastreio: Pagou > Fechou acordo > Clicou > só enviado. */
export function etapaDoRastreio(r: Pick<Rastreio, "clicou_em" | "fechou_em" | "pagou_em">): Etapa {
  if (r.pagou_em) return "pagou";
  if (r.fechou_em) return "fechou";
  if (r.clicou_em) return "clicou";
  return "enviado";
}

export const ETAPA_LABEL: Record<Etapa, string> = { pagou: "Pagou", fechou: "Fechou acordo", clicou: "Clicou", enviado: "Link enviado" };

export function fmtPercent(v: number | null): string {
  return v === null ? "—" : `${(v * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
}

export function fmtMoney(v: number | null): string | null {
  return v === null ? null : v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
