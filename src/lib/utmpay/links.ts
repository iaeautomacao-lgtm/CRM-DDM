// Link rastreado do UTMpay por envio (wacrm.utmpay_links, migration 356). Biblioteca para o Disparador e, no futuro, para régua, fluxo e chat
// gerarem um link avulso (`ensureTrackedLink` com um tid estável). Os pedidos que chegam juntos (os itens de um tick rodam em paralelo) são
// AGRUPADOS numa única chamada ao UTMpay (até 1000 por lote), em vez de uma chamada por mensagem.
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { UtmpayError, generateTrackedLinks, type UtmpayFetch } from "@/lib/utmpay/client";
import type { UtmpayConfig } from "@/lib/utmpay/config";

type Db = Pick<SupabaseClient, "from">;

export interface TrackedLinkRequest {
  /** id estável do envio (id do item da fila; um retry do mesmo envio devolve o MESMO link). */
  tid: string;
  campaignId: string | null;
  campanha: string;
  contactId: string | null;
  canal?: string;
  /** O link que a operação quer entregar (vira o destino do link rastreado). */
  destino: string;
}

export interface TrackedLink {
  linkCurto: string;
  tid: string;
}

/** CPF só dígitos (11) ou null. */
export function cpfDigits(raw: unknown): string | null {
  const digits = String(raw ?? "").replace(/\D/g, "");
  return digits.length === 11 ? digits : null;
}

/** Identificador do aluno no UTMpay: o CPF do contato; sem CPF, uma chave do próprio contato (nunca telefone, nunca vazio). */
export function alunoIdFor(cpf: string | null, contactId: string | null, tid: string): string {
  return cpf ?? `crm-${contactId ?? tid}`;
}

interface Pending {
  req: TrackedLinkRequest;
  resolve: (v: TrackedLink) => void;
  reject: (e: unknown) => void;
}

export interface LinkDeps {
  fetcher?: UtmpayFetch;
  /** Janela de agrupamento em ms (padrão 25). */
  windowMs?: number;
}

const queues = new Map<string, { items: Pending[]; timer: ReturnType<typeof setTimeout> | null }>();
const FLUSH_AT = 500;

/** Só para os testes. */
export function resetLinkQueues(): void {
  for (const q of queues.values()) if (q.timer) clearTimeout(q.timer);
  queues.clear();
}

async function flush(db: Db, accountId: string, config: UtmpayConfig, key: string, deps: LinkDeps): Promise<void> {
  const queue = queues.get(key);
  if (!queue) return;
  queues.delete(key);
  if (queue.timer) clearTimeout(queue.timer);
  const batch = queue.items;
  if (batch.length === 0) return;
  try {
    const contactIds = [...new Set(batch.map((p) => p.req.contactId).filter((id): id is string => !!id))];
    const cpfByContact = new Map<string, string | null>();
    if (contactIds.length > 0) {
      const { data } = await db.from("contacts").select("id, cpf").eq("account_id", accountId).in("id", contactIds);
      for (const row of (data ?? []) as { id: string; cpf: string | null }[]) cpfByContact.set(row.id, cpfDigits(row.cpf));
    }
    const links = await generateTrackedLinks(
      config,
      {
        campanha: batch[0].req.campanha,
        canal: batch[0].req.canal ?? "whatsapp",
        items: batch.map((p) => ({
          tid: p.req.tid,
          alunoId: alunoIdFor(p.req.contactId ? (cpfByContact.get(p.req.contactId) ?? null) : null, p.req.contactId, p.req.tid),
          destino: p.req.destino,
        })),
      },
      deps.fetcher,
    );
    const rows = batch.flatMap((p) => {
      const link = links.get(p.req.tid);
      return link
        ? [{
            tid: p.req.tid,
            account_id: accountId,
            campaign_id: p.req.campaignId,
            contact_id: p.req.contactId,
            canal: p.req.canal ?? "whatsapp",
            destino: p.req.destino,
            link_curto: link.linkCurto,
            codigo: link.codigo,
          }]
        : [];
    });
    if (rows.length > 0) {
      // Sem registrar o link o CRM não consegue atribuir os eventos dele: então não o entrega (UtmpayError ⇒ item não sai).
      const { error } = await db.from("utmpay_links").upsert(rows, { onConflict: "tid", ignoreDuplicates: true });
      if (error) throw new UtmpayError("Não foi possível registrar o link rastreado");
    }
    for (const p of batch) {
      const link = links.get(p.req.tid);
      if (link) p.resolve({ linkCurto: link.linkCurto, tid: p.req.tid });
      else p.reject(new UtmpayError("O UTMpay não devolveu o link deste envio", false));
    }
  } catch (err) {
    for (const p of batch) p.reject(err);
  }
}

/**
 * Link rastreado do envio. Já existe para este tid (retry do mesmo envio) ⇒ devolve o gravado; senão pede ao UTMpay junto com os
 * demais pedidos da mesma campanha e canal. Lança UtmpayError (quem chama decide: não enviar, ou enviar sem rastreio se a conta marcou).
 */
export async function ensureTrackedLink(db: Db, accountId: string, config: UtmpayConfig, req: TrackedLinkRequest, deps: LinkDeps = {}): Promise<TrackedLink> {
  const { data: existing } = await db.from("utmpay_links").select("link_curto").eq("tid", req.tid).eq("account_id", accountId).maybeSingle();
  const stored = (existing as { link_curto?: string } | null)?.link_curto;
  if (stored) return { linkCurto: stored, tid: req.tid };

  const key = `${accountId}:${req.campanha}:${req.canal ?? "whatsapp"}`;
  return new Promise<TrackedLink>((resolve, reject) => {
    let queue = queues.get(key);
    if (!queue) {
      queue = { items: [], timer: null };
      queues.set(key, queue);
    }
    queue.items.push({ req, resolve, reject });
    if (queue.items.length >= FLUSH_AT) {
      void flush(db, accountId, config, key, deps);
      return;
    }
    if (!queue.timer) queue.timer = setTimeout(() => void flush(db, accountId, config, key, deps), deps.windowMs ?? 25);
  });
}
