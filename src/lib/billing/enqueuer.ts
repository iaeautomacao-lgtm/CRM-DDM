import "server-only";
// PRD 17, PR 17.4 — entrega das etapas da régua ao DISPARADOR (a mesma fila de campanhas: janela, ritmo por número, qualidade, blacklist,
// pausa, recibos e relatórios valem de graça).
//
// Por (régua, canal, dia) existe UMA campanha-sistema (`campaigns.origem = 'regua'`, criada na 1ª etapa do dia) e cada etapa vira um item
// da fila com `origem = 'regua'` (migration 279). A bifurcação Meta × WAHA é preservada (nunca unificada):
//   • canal Meta  → item com template_name/language + template_variables (array de strings; a Meta troca os {{n}});
//   • canal WAHA  → texto livre com {{n}} trocados AQUI, em mensagem_final (sem template aprovado).
// Variáveis: vêm do `variable_map` da etapa (configuração da operação). Valor vazio NÃO é enviado ("Olá , seu débito de R$ ") — a etapa é
// cancelada com motivo. Número em qualidade VERMELHA na Meta: a régua nunca confirma RED sozinha — a etapa espera (blocked: 'quality').
// Nada aqui chama efetivação de acordo. Nunca loga CPF/telefone/texto: o resultado devolve só ids e motivos curtos.
import type { SupabaseClient } from "@supabase/supabase-js";

import { findRedChannels } from "@/lib/disparador/red-quality-gate";

import type { BillingEnqueuer, ClaimedStep, EnqueueResult } from "./engine";

type Db = Pick<SupabaseClient, "from" | "rpc">;

export type VariableSource =
  | { type: "contact_field"; field: "name" | "phone" | "email" | "company" }
  | { type: "debt_field"; field: "due_date" | "amount" | "external_ref" }
  | { type: "static"; value: string };

export interface VariableContext {
  contact: { name?: string | null; phone?: string | null; email?: string | null; company?: string | null };
  debt: { due_date: string; amount_cents: number | null; external_ref: string };
}

const CONTACT_FIELDS = ["name", "phone", "email", "company"] as const;
const DEBT_FIELDS = ["due_date", "amount", "external_ref"] as const;

/** YYYY-MM-DD → dd/mm/aaaa (sem fuso: é data civil). */
export function formatDueDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return y && m && d ? `${d}/${m}/${y}` : "";
}

/** centavos → "1.234,56" (sem o símbolo: o template/texto da operação decide se escreve "R$"). */
export function formatAmount(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents) || cents < 0) return "";
  const reais = Math.floor(cents / 100);
  return `${String(reais).replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${String(cents % 100).padStart(2, "0")}`;
}

export function isVariableSource(v: unknown): v is VariableSource {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (o.type === "contact_field") return (CONTACT_FIELDS as readonly unknown[]).includes(o.field);
  if (o.type === "debt_field") return (DEBT_FIELDS as readonly unknown[]).includes(o.field);
  return o.type === "static" && typeof o.value === "string";
}

/** Resolve o variable_map da etapa em strings; `empty` = índice (1-based) da 1ª variável sem valor. */
export function resolveStepVariables(map: unknown, ctx: VariableContext): { values: string[]; empty: number | null; invalid: boolean } {
  if (!Array.isArray(map)) return { values: [], empty: null, invalid: true };
  const values: string[] = [];
  let empty: number | null = null;
  for (let i = 0; i < map.length; i++) {
    const src = map[i];
    if (!isVariableSource(src)) return { values: [], empty: null, invalid: true };
    let value = "";
    if (src.type === "static") value = src.value;
    else if (src.type === "contact_field") value = String(ctx.contact[src.field] ?? "");
    else if (src.field === "due_date") value = formatDueDate(ctx.debt.due_date);
    else if (src.field === "amount") value = formatAmount(ctx.debt.amount_cents);
    else value = ctx.debt.external_ref;
    value = value.trim();
    if (!value && empty === null) empty = i + 1;
    values.push(value);
  }
  return { values, empty, invalid: false };
}

/** WAHA: troca {{1}}, {{2}}… por valor. Placeholder sem fonte (índice acima do mapa) ou sem valor = vazio. */
export function renderWahaText(text: string, values: string[]): { text: string; missing: number | null } {
  let missing: number | null = null;
  const out = text.replace(/\{\{(\d+)\}\}/g, (_m, n: string) => {
    const idx = Number(n) - 1;
    const v = values[idx] ?? "";
    if (!v && missing === null) missing = Number(n);
    return v;
  });
  return { text: out, missing };
}

interface StepRow {
  id: string;
  variable_map: unknown;
  message_text: string | null;
  template_id: string | null;
}
interface TemplateRow {
  id: string;
  name: string;
  language: string | null;
  status: string | null;
}
interface ChannelRow {
  id: string;
  provider: string | null;
}
interface ContactRow {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  company: string | null;
}
interface RulerRow {
  id: string;
  name: string;
  window_start: string;
  window_end: string;
  weekdays: number[];
}

const cancel = (sendId: string, reason: string): EnqueueResult => ({ sendId, cancelled: reason });
const hhmm = (t: string) => t.slice(0, 5);

/** Data civil de Brasília (UTC-3 fixo). */
function brasiliaDay(now: Date): string {
  return new Date(now.getTime() - 3 * 3_600_000).toISOString().slice(0, 10);
}

async function systemCampaignId(db: Db, accountId: string, ruler: RulerRow, channelId: string, day: string, ownerUserId: string | null): Promise<string> {
  const key = `regua:${ruler.id}:${channelId}:${day}`;
  const find = async () => {
    const { data, error } = await db.from("campaigns").select("id").eq("account_id", accountId).eq("idempotency_key", key).limit(1);
    if (error) throw error;
    return (data as Array<{ id: string }> | null)?.[0]?.id ?? null;
  };
  const existing = await find();
  if (existing) return existing;

  const { data, error } = await db
    .from("campaigns")
    .insert({
      nome: `Régua — ${ruler.name} — ${day}`.slice(0, 120),
      status: "em_execucao",
      account_id: accountId,
      origem: "regua",
      idempotency_key: key,
      idempotency_hash: key,
      session_ids: [channelId],
      janela_inicio: hhmm(ruler.window_start),
      janela_fim: hhmm(ruler.window_end),
      dias_envio: ruler.weekdays,
      intervalo_min: 0,
      intervalo_max: 0,
      mensagens: [{ tipo: "texto", conteudo: "[Régua de cobrança]" }],
      agendamento: new Date().toISOString(),
      created_by: ownerUserId,
    })
    .select("id")
    .limit(1);
  if (error) {
    if (error.code === "23505") {
      const raced = await find(); // outra execução criou primeiro
      if (raced) return raced;
    }
    throw error;
  }
  const id = (data as Array<{ id: string }> | null)?.[0]?.id;
  if (!id) throw new Error("campanha da régua não foi criada");
  return id;
}

export function createDisparadorEnqueuer(db: Db, deps: { now?: () => Date } = {}): BillingEnqueuer {
  return {
    async enqueue(accountId: string, steps: ClaimedStep[]): Promise<EnqueueResult[]> {
      if (steps.length === 0) return [];
      const now = (deps.now ?? (() => new Date()))();
      const day = brasiliaDay(now);
      const results = new Map<string, EnqueueResult>();
      const fail = (sendId: string, error: string) => results.set(sendId, { sendId, error });

      const unique = <T,>(xs: T[]) => [...new Set(xs)];
      const stepIds = unique(steps.map((s) => s.step_id));
      const rulerIds = unique(steps.map((s) => s.ruler_id));
      const channelIds = unique(steps.map((s) => s.channel_id).filter((c): c is string => !!c));
      const contactIds = unique(steps.map((s) => s.contact_id));

      const load = async <T,>(table: string, columns: string, col: string, ids: string[]): Promise<T[]> => {
        if (ids.length === 0) return [];
        let q = db.from(table).select(columns).in(col, ids);
        q = q.eq("account_id", accountId);
        const { data, error } = await q;
        if (error) throw error;
        return (data ?? []) as T[];
      };

      const [stepRows, rulers, channels, contacts] = await Promise.all([
        load<StepRow>("billing_ruler_steps", "id, variable_map, message_text, template_id", "id", stepIds),
        load<RulerRow>("billing_rulers", "id, name, window_start, window_end, weekdays", "id", rulerIds),
        load<ChannelRow>("whatsapp_config", "id, provider", "id", channelIds),
        load<ContactRow>("contacts", "id, name, phone, email, company", "id", contactIds),
      ]);
      // o template vem da CONFIGURAÇÃO atual da etapa (pode ter mudado desde a reserva), não do passo reservado
      const templates = await load<TemplateRow>("message_templates", "id, name, language, status", "id", unique(stepRows.map((r) => r.template_id).filter((t): t is string => !!t)));
      const byId = <T extends { id: string }>(rows: T[]) => new Map(rows.map((r) => [r.id, r]));
      const stepMap = byId(stepRows);
      const rulerMap = byId(rulers);
      const channelMap = byId(channels);
      const contactMap = byId(contacts);
      const templateMap = byId(templates);

      // número vermelho: a régua NUNCA confirma RED sozinha (só o owner, numa campanha manual)
      const red = new Set((await findRedChannels(db as never, accountId, channelIds)).map((c) => c.id));

      const { data: owner } = await db.from("accounts").select("owner_user_id").eq("id", accountId).limit(1);
      const ownerUserId = (owner as Array<{ owner_user_id: string | null }> | null)?.[0]?.owner_user_id ?? null;

      type Planned = { step: ClaimedStep; ruler: RulerRow; channelId: string; row: Record<string, unknown> };
      const planned: Planned[] = [];

      for (const step of steps) {
        const stepRow = stepMap.get(step.step_id);
        const ruler = rulerMap.get(step.ruler_id);
        const channel = step.channel_id ? channelMap.get(step.channel_id) : undefined;
        const contact = contactMap.get(step.contact_id);
        if (!stepRow || !ruler) { fail(step.send_id, "etapa ou régua não encontrada"); continue; }
        if (!step.channel_id || !channel) { fail(step.send_id, "régua sem canal configurado"); continue; }
        if (!contact?.phone) { results.set(step.send_id, cancel(step.send_id, "contact_without_phone")); continue; }
        if (red.has(step.channel_id)) { results.set(step.send_id, { sendId: step.send_id, blocked: "quality" }); continue; }

        const vars = resolveStepVariables(stepRow.variable_map, { contact, debt: { due_date: step.due_date, amount_cents: step.amount_cents, external_ref: step.external_ref } });
        if (vars.invalid) { results.set(step.send_id, cancel(step.send_id, "invalid_variable_map")); continue; }
        if (vars.empty !== null) { results.set(step.send_id, cancel(step.send_id, `empty_variable_${vars.empty}`)); continue; }

        const base = {
          account_id: accountId,
          contact_id: step.contact_id,
          session_id: step.channel_id,
          status: "agendado",
          erro_permanente: false,
          tipo: "texto",
          media_url: null,
          scheduled_at: now.toISOString(),
          origem: "regua",
        };

        if (channel.provider === "waha") {
          const text = stepRow.message_text ?? "";
          if (!text.trim()) { results.set(step.send_id, cancel(step.send_id, "empty_text")); continue; }
          const rendered = renderWahaText(text, vars.values);
          if (rendered.missing !== null) { results.set(step.send_id, cancel(step.send_id, `empty_variable_${rendered.missing}`)); continue; }
          planned.push({ step, ruler, channelId: step.channel_id, row: { ...base, mensagem_final: rendered.text, template_name: null, template_language: null, template_variables: null } });
        } else {
          const template = stepRow.template_id ? templateMap.get(stepRow.template_id) : undefined;
          if (!template) { results.set(step.send_id, cancel(step.send_id, "template_not_found")); continue; }
          if ((template.status ?? "").toLowerCase() !== "approved") { results.set(step.send_id, cancel(step.send_id, "template_not_approved")); continue; }
          planned.push({
            step, ruler, channelId: step.channel_id,
            row: { ...base, mensagem_final: contact.phone, template_name: template.name, template_language: template.language ?? "pt_BR", template_variables: vars.values },
          });
        }
      }

      // uma campanha-sistema por (régua, canal, dia); insere em blocos e devolve os ids na MESMA ordem
      const groups = new Map<string, Planned[]>();
      for (const p of planned) groups.set(`${p.ruler.id}|${p.channelId}`, [...(groups.get(`${p.ruler.id}|${p.channelId}`) ?? []), p]);
      for (const group of groups.values()) {
        try {
          const campaignId = await systemCampaignId(db, accountId, group[0].ruler, group[0].channelId, day, ownerUserId);
          const { data, error } = await db
            .from("disp_message_queue")
            .insert(group.map((g) => ({ ...g.row, campaign_id: campaignId })))
            .select("id");
          if (error) throw error;
          const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
          group.forEach((g, i) => (ids[i] ? results.set(g.step.send_id, { sendId: g.step.send_id, queueItemId: ids[i] }) : fail(g.step.send_id, "item da fila não retornado")));
          const { count } = await db.from("disp_message_queue").select("id", { count: "exact", head: true }).eq("campaign_id", campaignId);
          await db.from("campaign_metrics").upsert({ campaign_id: campaignId, account_id: accountId, total_contatos: count ?? ids.length }, { onConflict: "campaign_id" });
        } catch {
          for (const g of group) fail(g.step.send_id, "falha ao enfileirar no disparador");
        }
      }
      return steps.map((s) => results.get(s.send_id) ?? { sendId: s.send_id, error: "sem resultado" });
    },
  };
}
