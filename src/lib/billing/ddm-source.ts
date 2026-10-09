import "server-only";
// PRD 17, PR 17.2 — DebtSource da API DDM Acordos (fonte B: consulta pontual por CPF antes de cobrar).
//
// Usa o MESMO endpoint que a IA já usa (`calc/localiza_dev.php?tk=&cpf=`, src/lib/ai/responder.ts): devolve a lista de dívidas ATIVAS do
// CPF (`iddev`, `sistema`, …). Leitura (estado derivado):
//   • lista vazia                       → sem dívida ativa  ⇒ `paid` (flag no_debt_found). PREMISSA do dono ("sem dívida ativa = quitada");
//                                         A CONFIRMAR com a DDM se "paga" e "removida/cancelada" se distinguem.
//   • a dívida (`externalRef`) sumiu    → idem (as outras do CPF continuam)
//   • a dívida segue na lista           → `open`
//   • HTTP ≠ 2xx, JSON ruim, formato inesperado, timeout, limite local → DebtSourceError (o motor ADIA; nunca "envia por precaução")
// "Acordo vigente" NÃO é inferido aqui: a resposta de `localiza_dev` não o distingue com certeza; o acordo chega pelo CRM (tabulação 142 /
// IA) e pela parada por evento (PR 17.3). Quando a DDM confirmar o campo, ele entra nesta função sem mexer no motor.
// Segurança: a URL leva token + CPF — NUNCA vai para log, erro ou resposta; erros são genéricos.
import { checkRateLimit } from "@/lib/rate-limit";

import { DebtSourceError, normalizeDocument, type DebtLookup, type DebtSource, type DebtStatus } from "./debt-source";

export const DDM_LOCALIZA_URL = "https://www.ddmacordos.com/calc/localiza_dev.php";
export const DDM_TIMEOUT_MS = 10_000;

/** Mesma ordem de nomes que o responder aceita (DDM_ACORDOS_API_TOKEN é o documentado). */
export function resolveDdmToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const token = [env.DDM_ACORDOS_API_TOKEN, env.DDM_TOKEN, env.DDM_API_KEY].find((v) => v && v.trim());
  return token ? token.trim() : null;
}

export type DdmFetch = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

export interface DdmSourceOptions {
  /** Teto de consultas por conta (um balde por minuto, compartilhado entre processos pelo rate limiter). false = estourou. */
  allow?: () => Promise<boolean>;
  fetcher?: DdmFetch;
  token?: string | null;
  timeoutMs?: number;
}

interface DdmDebtor {
  iddev?: unknown;
  sistema?: unknown;
}

export function externalRefOf(debtor: DdmDebtor): string | null {
  const iddev = String(debtor.iddev ?? "").trim();
  const sistema = String(debtor.sistema ?? "").trim();
  return iddev && sistema ? `${iddev}:${sistema}` : null;
}

/** Função pura: lista devolvida pela DDM → estado da dívida pedida. */
export function interpretLocaliza(body: unknown, externalRef?: string | null): DebtStatus {
  if (!Array.isArray(body)) throw new DebtSourceError("Resposta inesperada da DDM", false);
  if (body.length === 0) return { state: "paid", flags: { no_debt_found: true } };
  if (!externalRef) return { state: "open", flags: { no_debt_found: false } };
  const stillThere = body.some((d) => d && typeof d === "object" && externalRefOf(d as DdmDebtor) === externalRef);
  return stillThere ? { state: "open", flags: { no_debt_found: false } } : { state: "paid", flags: { no_debt_found: true } };
}

/** Consulta pontual `localiza_dev` (CPF → lista de dívidas ativas). Erros genéricos (a URL leva token + CPF e nunca vai para log/erro). */
async function fetchLocaliza(cpfRaw: unknown, options: DdmSourceOptions): Promise<unknown> {
  const fetcher: DdmFetch = options.fetcher ?? ((url, init) => globalThis.fetch(url, init));
  const cpf = normalizeDocument(cpfRaw);
  if (!cpf) throw new DebtSourceError("Documento do devedor inválido", false);
  const token = options.token === undefined ? resolveDdmToken() : options.token;
  if (!token) throw new DebtSourceError("Token da API DDM não configurado", false);
  if (options.allow && !(await options.allow())) throw new DebtSourceError("Limite de consultas à DDM atingido; tente no próximo ciclo");

  const url = `${DDM_LOCALIZA_URL}?tk=${encodeURIComponent(token)}&cpf=${encodeURIComponent(cpf)}`;
  let res: Response;
  try {
    res = await fetcher(url, { signal: AbortSignal.timeout(options.timeoutMs ?? DDM_TIMEOUT_MS) });
  } catch (err) {
    throw new DebtSourceError(err instanceof Error && err.name === "TimeoutError" ? "Tempo esgotado na API DDM" : "Falha de rede na API DDM");
  }
  if (!res.ok) throw new DebtSourceError(`API DDM respondeu HTTP ${res.status}`, res.status >= 500 || res.status === 429 || res.status === 408);
  try {
    return await res.json();
  } catch {
    throw new DebtSourceError("Resposta da DDM não é JSON", false);
  }
}

export function createDdmDebtSource(options: DdmSourceOptions = {}): DebtSource {
  return {
    name: "ddm",
    async getStatus(lookup: DebtLookup): Promise<DebtStatus> {
      return interpretLocaliza(await fetchLocaliza(lookup.cpf, options), lookup.externalRef ?? null);
    },
  };
}

export interface DdmDebtListItem {
  /** "<iddev>:<sistema>" — o mesmo id que a régua guarda em billing_debts.external_ref. */
  external_ref: string;
  /** Nome da instituição/credor como a DDM devolve (apelido → instituição → sistema). */
  label: string;
}

/** Função pura: lista da DDM → dívidas identificáveis (sem iddev/sistema a DDM não permite consultar o cálculo, então ficam de fora). */
export function interpretDebtList(body: unknown): DdmDebtListItem[] {
  if (!Array.isArray(body)) throw new DebtSourceError("Resposta inesperada da DDM", false);
  const out: DdmDebtListItem[] = [];
  const seen = new Set<string>();
  for (const d of body) {
    if (!d || typeof d !== "object") continue;
    const debtor = d as Record<string, unknown>;
    const ref = externalRefOf(debtor);
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    const label = [debtor.apelido, debtor.Apelido, debtor.instituicao, debtor.sistema].map((v) => String(v ?? "").trim()).find(Boolean) ?? "";
    out.push({ external_ref: ref, label });
  }
  return out;
}

/** Dívidas ATIVAS do CPF na DDM (consulta pontual, a mesma da régua e da IA). Só o necessário: id da dívida e nome do credor. */
export async function listDdmDebts(cpf: unknown, options: DdmSourceOptions = {}): Promise<DdmDebtListItem[]> {
  return interpretDebtList(await fetchLocaliza(cpf, options));
}

/** Teto de consultas à DDM por conta (compartilhado entre processos pelo rate limiter): 120/min por padrão. */
export function ddmAllowance(accountId: string, perMinute = 120): () => Promise<boolean> {
  return async () => (await checkRateLimit(`billing:ddm:${accountId}`, { limit: perMinute, windowMs: 60_000 })).success;
}
