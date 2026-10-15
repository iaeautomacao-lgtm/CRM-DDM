// Cliente da integração UTMpay (contrato: prd-v2/contrato-api-utmpay-crm.md, backend do Cinzel). Campos em snake_case,
// como a API devolve. Só dados: nada de CPF. Funil = clicou → fechou acordo (payment_start) → pagou (paid, confirmado
// na API DDM). Aqui não há regra de negócio: só tipos, leitura tolerante e rótulos.
import { apiFetch } from "@/lib/api-fetch";

export type Atribuicao = "direto" | "ia" | "humano";

export const ATRIBUICAO_LABEL: Record<Atribuicao, string> = { direto: "Direto", ia: "IA", humano: "Humano" };

// Checklist de status: o SERVIDOR monta os textos (mesmo vocabulário nas duas telas); a tela só desenha. Contrato: seção 7.
export type ChecklistTone = "ok" | "atencao" | "erro" | "pendente";
export type ChecklistAction = "informar_endereco" | "informar_chave" | "informar_segredo" | "conectar" | "ligar" | "salvar" | null;
export interface ChecklistItem {
  id: "endereco" | "chave" | "segredo" | "avisos" | "ligado";
  titulo: string;
  estado: ChecklistTone;
  detalhe: string;
  acao: string | null;
  acao_id: ChecklistAction;
}
export interface Checklist {
  itens: ChecklistItem[];
  primeira_vez: boolean;
  proximo_passo: ChecklistItem["id"] | null;
  prontos: number;
  total: number;
}

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
  /** Quando a configuração foi salva pela última vez (ISO) ou null. */
  atualizado_em: string | null;
  checklist: Checklist | null;
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

const TONES: readonly string[] = ["ok", "atencao", "erro", "pendente"];
const ACTIONS: readonly string[] = ["informar_endereco", "informar_chave", "informar_segredo", "conectar", "ligar", "salvar"];
const ITEM_IDS: readonly string[] = ["endereco", "chave", "segredo", "avisos", "ligado"];

export function parseChecklist(raw: unknown): Checklist | null {
  const o = rec(raw);
  if (!Array.isArray(o.itens)) return null;
  const itens: ChecklistItem[] = o.itens
    .map((i) => rec(i))
    .filter((i) => ITEM_IDS.includes(String(i.id)))
    .map((i) => ({
      id: i.id as ChecklistItem["id"],
      titulo: str(i.titulo) ?? "",
      estado: (TONES.includes(String(i.estado)) ? i.estado : "pendente") as ChecklistTone,
      detalhe: str(i.detalhe) ?? "",
      acao: str(i.acao),
      acao_id: (ACTIONS.includes(String(i.acao_id)) ? i.acao_id : null) as ChecklistAction,
    }));
  if (itens.length === 0) return null;
  return {
    itens,
    primeira_vez: o.primeira_vez === true,
    proximo_passo: ITEM_IDS.includes(String(o.proximo_passo)) ? (o.proximo_passo as ChecklistItem["id"]) : null,
    prontos: num(o.prontos),
    total: num(o.total) || itens.length,
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
    atualizado_em: str(o.atualizado_em),
    checklist: parseChecklist(o.checklist),
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

/** Resultado da conexão feita ao salvar (PUT) ou no botão Conectar. Falhar aqui NÃO desfaz o que foi salvo. */
export interface ConexaoResumo {
  tentou: boolean;
  ok: boolean;
  mensagem: string;
}

function parseConexao(raw: unknown): ConexaoResumo | null {
  const o = rec(raw);
  if (Object.keys(o).length === 0) return null;
  // PUT/connect: { tentou, ok, mensagem }; status: { estado: conectado|..., mensagem }
  const ok = typeof o.ok === "boolean" ? o.ok : o.estado === "conectado";
  return { tentou: o.tentou !== false, ok, mensagem: str(o.mensagem) ?? "" };
}

export async function saveConfig(input: UtmpayConfigInput): Promise<UtmpayConfig & { conexao: ConexaoResumo | null }> {
  const body = await request("/api/account/utmpay-config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return { ...parseConfig(body), conexao: parseConexao(rec(body).conexao) };
}

/** Botão Conectar: o CRM entrega ao UTMpay o endereço e o segredo dos avisos JÁ SALVOS. */
export async function connectUtmpay(): Promise<{ ok: boolean; message: string; connected_at: string | null; checklist: Checklist | null }> {
  const o = rec(await request("/api/account/utmpay-config/connect", { method: "POST" }));
  return { ok: o.ok === true, message: str(o.message) ?? (o.ok === true ? "Conectado." : "Não foi possível conectar. Tente de novo."), connected_at: str(o.connected_at), checklist: parseChecklist(o.checklist) };
}

/** Estado real da conexão (pergunta ao UTMpay): usado para o item 4 do checklist. */
export async function fetchStatus(): Promise<{ checklist: Checklist | null; alcancavel: boolean; recebeAvisos: boolean; conectadoEm: string | null }> {
  const o = rec(await request("/api/account/utmpay-config/status"));
  return { checklist: parseChecklist(o.checklist), alcancavel: o.utmpay_alcancavel === true, recebeAvisos: o.utmpay_recebe_avisos === true, conectadoEm: str(o.conectado_em) };
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
