import "server-only";
// PRD 17, PR 17.5 — regras da API /api/billing/*: validação de entrada (réguas, etapas, datas, cursor) e acesso aos dados.
// As rotas ficam finas: guardPermission (billing.view | billing.manage) → estas funções → auditoria. Tudo filtra por account_id da SESSÃO.
// O CONTEÚDO da régua (quais etapas, quando, com que texto/template, janela e teto) é da operação: aqui só se valida a FORMA e as regras de
// segurança do motor (template Meta aprovado, {{n}} completos, nada sai sem canal). Nunca devolve CPF/telefone; o contato vai só com nome.
import type { SupabaseClient } from "@supabase/supabase-js";

import { badRequest, conflict, notFound, ApiError } from "@/lib/api/v1/respond";

import { isVariableSource, type VariableSource } from "./enqueuer";

export type Db = Pick<SupabaseClient, "from" | "rpc">;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const ENROLLMENT_STATUSES = ["active", "paused", "stopped", "completed"] as const;
export const STOP_REASONS = ["paid", "agreement", "opt_out", "blacklist", "cancelled", "contact_removed", "ruler_disabled", "manual"] as const;
export const MAX_STEPS = 30;
export const MAX_RULERS_PER_ACCOUNT = 50;

const RULER_COLUMNS =
  "id, name, active, dry_run, channel_id, window_start, window_end, weekdays, daily_cap_per_debtor, tolerance_days, pause_on_open_conversation, priority, created_at, updated_at";
const STEP_COLUMNS = "id, ruler_id, position, kind, offset_days, status_trigger, template_id, message_text, variable_map, conditions, active, updated_at";

export interface RulerRow {
  id: string;
  name: string;
  active: boolean;
  dry_run: boolean;
  channel_id: string | null;
  window_start: string;
  window_end: string;
  weekdays: number[];
  daily_cap_per_debtor: number;
  tolerance_days: number;
  pause_on_open_conversation: boolean;
  priority: number;
  created_at: string;
  updated_at: string;
}

export interface StepRow {
  id: string;
  ruler_id: string;
  position: number;
  kind: "offset" | "status";
  offset_days: number | null;
  status_trigger: string | null;
  template_id: string | null;
  message_text: string | null;
  variable_map: VariableSource[];
  conditions: Record<string, unknown>;
  active: boolean;
  updated_at: string;
}

export type RulerPatch = Partial<Pick<RulerRow, "name" | "active" | "dry_run" | "channel_id" | "window_start" | "window_end" | "weekdays" | "daily_cap_per_debtor" | "tolerance_days" | "pause_on_open_conversation" | "priority">>;

// ---- validação (pura) ---------------------------------------------------------------------------------------------------------------

const RULER_FIELDS = ["name", "active", "dry_run", "channel_id", "window_start", "window_end", "weekdays", "daily_cap_per_debtor", "tolerance_days", "pause_on_open_conversation", "priority"] as const;

function rejectUnknown(body: Record<string, unknown>, allowed: readonly string[], what: string) {
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length > 0) throw badRequest(`Campo(s) desconhecido(s) em ${what}: ${extra.slice(0, 5).join(", ")}`);
}

function intIn(v: unknown, min: number, max: number, field: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw badRequest(`${field} deve ser um inteiro entre ${min} e ${max}`);
  return v;
}

/** Valida os campos presentes (create exige name; patch aceita qualquer subconjunto). `active`/`dry_run` no POST são recusados: a régua nasce desligada e em simulação. */
export function parseRulerInput(body: Record<string, unknown>, mode: "create" | "patch"): RulerPatch {
  rejectUnknown(body, RULER_FIELDS, "régua");
  const out: RulerPatch = {};
  if (mode === "create") {
    if ("active" in body || "dry_run" in body) throw badRequest("A régua nasce desligada e em simulação (dry-run); ligue depois, em PATCH.");
    if (typeof body.name !== "string") throw badRequest("name é obrigatório");
  }
  if ("name" in body) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length < 1 || name.length > 120) throw badRequest("name deve ter de 1 a 120 caracteres");
    out.name = name;
  }
  for (const f of ["active", "dry_run", "pause_on_open_conversation"] as const) {
    if (f in body) {
      if (typeof body[f] !== "boolean") throw badRequest(`${f} deve ser booleano`);
      out[f] = body[f] as boolean;
    }
  }
  if ("channel_id" in body) {
    if (body.channel_id !== null && !(typeof body.channel_id === "string" && UUID_RE.test(body.channel_id))) throw badRequest("channel_id deve ser um uuid ou null");
    out.channel_id = body.channel_id as string | null;
  }
  for (const f of ["window_start", "window_end"] as const) {
    if (f in body) {
      if (typeof body[f] !== "string" || !HHMM_RE.test(body[f] as string)) throw badRequest(`${f} deve ser HH:MM (Brasília)`);
      out[f] = body[f] as string;
    }
  }
  if (out.window_start && out.window_end && out.window_end <= out.window_start) throw badRequest("window_end deve ser depois de window_start");
  if ("weekdays" in body) {
    const w = body.weekdays;
    if (!Array.isArray(w) || w.length < 1 || w.length > 7 || !w.every((d) => Number.isInteger(d) && d >= 0 && d <= 6) || new Set(w).size !== w.length) {
      throw badRequest("weekdays deve ser uma lista de 1 a 7 dias distintos (0 = domingo … 6 = sábado)");
    }
    out.weekdays = [...(w as number[])].sort((a, b) => a - b);
  }
  if ("daily_cap_per_debtor" in body) out.daily_cap_per_debtor = intIn(body.daily_cap_per_debtor, 1, 10, "daily_cap_per_debtor");
  if ("tolerance_days" in body) out.tolerance_days = intIn(body.tolerance_days, 0, 30, "tolerance_days");
  if ("priority" in body) out.priority = intIn(body.priority, 0, 10_000, "priority");
  if (mode === "patch" && Object.keys(out).length === 0) throw badRequest("Informe ao menos um campo para alterar");
  return out;
}

export interface StepInput {
  id?: string;
  kind: "offset" | "status";
  offset_days: number | null;
  status_trigger: string | null;
  template_id: string | null;
  message_text: string | null;
  variable_map: VariableSource[];
  conditions: Record<string, unknown>;
  active: boolean;
}

const STEP_FIELDS = ["id", "kind", "offset_days", "status_trigger", "template_id", "message_text", "variable_map", "conditions", "active"] as const;

/** Maior {{n}} de um texto (0 = nenhum). */
export function maxPlaceholder(text: string | null | undefined): number {
  let max = 0;
  for (const m of (text ?? "").matchAll(/\{\{(\d+)\}\}/g)) max = Math.max(max, Number(m[1]));
  return max;
}

/** Forma da lista de etapas (sem banco): tipos, offsets únicos, variable_map válido. A regra de canal/template vem em `checkStepsAgainstChannel`. */
export function parseStepsInput(body: Record<string, unknown>): StepInput[] {
  rejectUnknown(body, ["steps"], "etapas");
  const list = body.steps;
  if (!Array.isArray(list)) throw badRequest("steps deve ser uma lista");
  if (list.length > MAX_STEPS) throw badRequest(`No máximo ${MAX_STEPS} etapas por régua`);
  const offsets = new Set<number>();
  const ids = new Set<string>();
  return list.map((raw, i) => {
    const at = `steps[${i}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw badRequest(`${at} deve ser um objeto`);
    const s = raw as Record<string, unknown>;
    rejectUnknown(s, STEP_FIELDS, at);
    if (s.id !== undefined && s.id !== null && !(typeof s.id === "string" && UUID_RE.test(s.id))) throw badRequest(`${at}.id inválido`);
    if (typeof s.id === "string") {
      if (ids.has(s.id)) throw badRequest(`${at}.id repetido`);
      ids.add(s.id);
    }
    if (s.kind !== "offset" && s.kind !== "status") throw badRequest(`${at}.kind deve ser 'offset' ou 'status'`);
    let offset_days: number | null = null;
    let status_trigger: string | null = null;
    if (s.kind === "offset") {
      offset_days = intIn(s.offset_days, -60, 365, `${at}.offset_days`);
      if (s.status_trigger !== undefined && s.status_trigger !== null) throw badRequest(`${at}: etapa por deslocamento não tem status_trigger`);
      if (offsets.has(offset_days)) throw badRequest(`${at}: deslocamento ${offset_days} repetido (cada dia só pode ter uma etapa)`);
      offsets.add(offset_days);
    } else {
      if (typeof s.status_trigger !== "string" || s.status_trigger.trim().length < 1 || s.status_trigger.trim().length > 60) throw badRequest(`${at}.status_trigger deve ter de 1 a 60 caracteres`);
      if (s.offset_days !== undefined && s.offset_days !== null) throw badRequest(`${at}: etapa por status não tem offset_days`);
      status_trigger = s.status_trigger.trim();
    }
    let template_id: string | null = null;
    if (s.template_id !== undefined && s.template_id !== null) {
      if (typeof s.template_id !== "string" || !UUID_RE.test(s.template_id)) throw badRequest(`${at}.template_id inválido`);
      template_id = s.template_id;
    }
    let message_text: string | null = null;
    if (s.message_text !== undefined && s.message_text !== null) {
      if (typeof s.message_text !== "string" || s.message_text.length > 4096) throw badRequest(`${at}.message_text deve ser um texto de até 4096 caracteres`);
      message_text = s.message_text.trim() === "" ? null : s.message_text;
    }
    const variable_map: VariableSource[] = [];
    if (s.variable_map !== undefined) {
      if (!Array.isArray(s.variable_map) || s.variable_map.length > 10) throw badRequest(`${at}.variable_map deve ser uma lista de até 10 fontes`);
      for (const [j, src] of s.variable_map.entries()) {
        // CPF nunca vai para template/texto: a lista de campos permitidos é a do enqueuer
        if (!isVariableSource(src)) throw badRequest(`${at}.variable_map[${j}] inválido (contact_field: name|phone|email|company; debt_field: due_date|amount|external_ref; static: texto)`);
        variable_map.push(src);
      }
    }
    let conditions: Record<string, unknown> = {};
    if (s.conditions !== undefined) {
      if (!s.conditions || typeof s.conditions !== "object" || Array.isArray(s.conditions) || JSON.stringify(s.conditions).length > 4096) throw badRequest(`${at}.conditions deve ser um objeto de até 4 KB`);
      conditions = s.conditions as Record<string, unknown>;
    }
    if (s.active !== undefined && typeof s.active !== "boolean") throw badRequest(`${at}.active deve ser booleano`);
    return { ...(typeof s.id === "string" ? { id: s.id } : {}), kind: s.kind, offset_days, status_trigger, template_id, message_text, variable_map, conditions, active: (s.active as boolean | undefined) ?? true };
  });
}

export interface TemplateInfo {
  id: string;
  status: string | null;
  body_text: string | null;
}

/**
 * Regra de canal (PRD 17 §8): canal Meta ⇒ cada etapa ATIVA exige template aprovado e {{n}} do corpo cobertos pelo variable_map;
 * canal WAHA ⇒ exige texto, com {{n}} cobertos. Sem canal ainda ⇒ aceita qualquer um dos dois (a régua não liga sem canal).
 * A bifurcação Meta × WAHA é só VALIDADA aqui, nunca unificada. Devolve a lista de problemas (vazia = ok), com a posição da etapa.
 */
export function checkStepsAgainstChannel(steps: StepInput[], provider: "meta" | "waha" | null, templates: Map<string, TemplateInfo>): string[] {
  const problems: string[] = [];
  steps.forEach((s, i) => {
    if (!s.active) return;
    const at = `steps[${i}]`;
    const mapLen = s.variable_map.length;
    if (provider === "meta" || (provider === null && s.template_id && !s.message_text)) {
      if (!s.template_id) return void problems.push(`${at}: canal Meta exige template aprovado`);
      const t = templates.get(s.template_id);
      if (!t) return void problems.push(`${at}: template não encontrado nesta conta`);
      if ((t.status ?? "").toLowerCase() !== "approved") return void problems.push(`${at}: template precisa estar aprovado (está ${t.status ?? "sem status"})`);
      const need = maxPlaceholder(t.body_text);
      if (need > mapLen) problems.push(`${at}: o template usa {{${need}}} mas o variable_map tem ${mapLen} fonte(s)`);
    } else {
      if (!s.message_text) return void problems.push(`${at}: ${provider === "waha" ? "canal WAHA" : "etapa"} exige message_text`);
      const need = maxPlaceholder(s.message_text);
      if (need > mapLen) problems.push(`${at}: o texto usa {{${need}}} mas o variable_map tem ${mapLen} fonte(s)`);
    }
  });
  return problems;
}

/** AAAA-MM-DD de verdade (rejeita 2026-02-30). */
export function parseCivilDate(v: unknown, field = "date"): string {
  if (typeof v !== "string" || !DATE_RE.test(v)) throw badRequest(`${field} deve ser AAAA-MM-DD`);
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw badRequest(`${field} não é uma data válida`);
  return v;
}

/** Motivo opcional de pausa/parada manual: só vai para a auditoria (a tabela guarda o enum 'manual'). Sem CPF/telefone: o front não deve digitá-los. */
export function parseReason(body: Record<string, unknown>): string | null {
  rejectUnknown(body, ["motivo"], "corpo");
  if (body.motivo === undefined || body.motivo === null) return null;
  if (typeof body.motivo !== "string" || body.motivo.length > 200) throw badRequest("motivo deve ser um texto de até 200 caracteres");
  return body.motivo.trim() || null;
}

export function encodeCursor(row: { created_at: string; id: string }): string {
  return Buffer.from(JSON.stringify({ c: row.created_at, i: row.id }), "utf8").toString("base64url");
}

export function decodeCursor(raw: string | null): { created_at: string; id: string } | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { c?: unknown; i?: unknown };
    if (typeof o.c === "string" && typeof o.i === "string" && UUID_RE.test(o.i) && !Number.isNaN(Date.parse(o.c))) return { created_at: o.c, id: o.i };
  } catch {
    /* cai no erro abaixo */
  }
  throw badRequest("cursor inválido");
}

export function validUuid(id: string): boolean {
  return UUID_RE.test(id);
}

// ---- acesso aos dados ---------------------------------------------------------------------------------------------------------------

/** Falha de infraestrutura (migration ausente: tabela/função inexistente) ⇒ 503 com o motivo curto, nunca o erro cru do banco. */
function unavailable(error: { code?: string; message?: string } | null, what: string): ApiError {
  const missing = ["42P01", "42883", "PGRST202", "PGRST205"].includes(error?.code ?? "");
  return new ApiError("unavailable", missing ? `${what} indisponível: aplique as migrations 270–279 do PRD 17` : `${what} indisponível no momento`, 503);
}

export async function listRulers(db: Db, accountId: string): Promise<Array<RulerRow & { steps_count: number }>> {
  const { data, error } = await db.from("billing_rulers").select(RULER_COLUMNS).eq("account_id", accountId).order("priority", { ascending: true }).order("created_at", { ascending: true }).limit(MAX_RULERS_PER_ACCOUNT);
  if (error) throw unavailable(error, "Réguas");
  const rulers = (data ?? []) as RulerRow[];
  const counts = new Map<string, number>();
  if (rulers.length > 0) {
    const { data: steps, error: e2 } = await db.from("billing_ruler_steps").select("ruler_id").eq("account_id", accountId).in("ruler_id", rulers.map((r) => r.id)).limit(MAX_RULERS_PER_ACCOUNT * MAX_STEPS);
    if (e2) throw unavailable(e2, "Etapas");
    for (const s of (steps ?? []) as Array<{ ruler_id: string }>) counts.set(s.ruler_id, (counts.get(s.ruler_id) ?? 0) + 1);
  }
  return rulers.map((r) => ({ ...r, steps_count: counts.get(r.id) ?? 0 }));
}

export async function getRuler(db: Db, accountId: string, id: string): Promise<RulerRow> {
  const { data, error } = await db.from("billing_rulers").select(RULER_COLUMNS).eq("account_id", accountId).eq("id", id).limit(1);
  if (error) throw unavailable(error, "Régua");
  const row = (data as RulerRow[] | null)?.[0];
  if (!row) throw notFound("Régua não encontrada");
  return row;
}

export async function listSteps(db: Db, accountId: string, rulerId: string): Promise<StepRow[]> {
  const { data, error } = await db.from("billing_ruler_steps").select(STEP_COLUMNS).eq("account_id", accountId).eq("ruler_id", rulerId).order("position", { ascending: true }).limit(MAX_STEPS + 10);
  if (error) throw unavailable(error, "Etapas");
  return (data ?? []) as StepRow[];
}

async function channelProvider(db: Db, accountId: string, channelId: string): Promise<"meta" | "waha"> {
  const { data, error } = await db.from("whatsapp_config").select("id, provider").eq("account_id", accountId).eq("id", channelId).limit(1);
  if (error) throw unavailable(error, "Canais");
  const row = (data as Array<{ provider: string | null }> | null)?.[0];
  if (!row) throw badRequest("channel_id não pertence a esta conta");
  return (row.provider ?? "").toLowerCase() === "waha" ? "waha" : "meta";
}

export async function createRuler(db: Db, accountId: string, patch: RulerPatch): Promise<RulerRow> {
  const { count, error: ce } = await db.from("billing_rulers").select("id", { count: "exact", head: true }).eq("account_id", accountId);
  if (ce) throw unavailable(ce, "Réguas");
  if ((count ?? 0) >= MAX_RULERS_PER_ACCOUNT) throw conflict(`Limite de ${MAX_RULERS_PER_ACCOUNT} réguas por conta`);
  if (patch.channel_id) await channelProvider(db, accountId, patch.channel_id);
  const { data, error } = await db.from("billing_rulers").insert({ ...patch, account_id: accountId, active: false, dry_run: true }).select(RULER_COLUMNS).limit(1);
  if (error) {
    if (error.code === "23505") throw conflict("Já existe uma régua com esse nome");
    if (error.code === "23514") throw badRequest("Valores fora das regras da régua (janela, dias ou tetos)");
    throw unavailable(error, "Régua");
  }
  return (data as RulerRow[])[0];
}

/** Regras para LIGAR: canal definido e ao menos uma etapa ativa (sem isso o motor não teria o que enviar). Desligar sempre pode. */
async function assertCanGoLive(db: Db, accountId: string, ruler: RulerRow, next: RulerRow) {
  const turningOn = (next.active && !ruler.active) || (!next.dry_run && ruler.dry_run && next.active);
  if (!turningOn) return;
  if (!next.channel_id) throw conflict("Defina o canal (channel_id) antes de ligar a régua");
  const steps = await listSteps(db, accountId, ruler.id);
  if (!steps.some((s) => s.active)) throw conflict("Cadastre ao menos uma etapa ativa antes de ligar a régua");
}

export async function updateRuler(db: Db, accountId: string, id: string, patch: RulerPatch): Promise<{ ruler: RulerRow; changed: string[] }> {
  const current = await getRuler(db, accountId, id);
  const next: RulerRow = { ...current, ...patch };
  if (next.window_end <= next.window_start) throw badRequest("window_end deve ser depois de window_start");
  if (patch.channel_id) await channelProvider(db, accountId, patch.channel_id);
  await assertCanGoLive(db, accountId, current, next);
  const changed = (Object.keys(patch) as Array<keyof RulerPatch>).filter((k) => JSON.stringify(current[k]) !== JSON.stringify(next[k]));
  if (changed.length === 0) return { ruler: current, changed };
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const k of changed) update[k] = next[k];
  const { data, error } = await db.from("billing_rulers").update(update).eq("account_id", accountId).eq("id", id).select(RULER_COLUMNS).limit(1);
  if (error) {
    if (error.code === "23505") throw conflict("Já existe uma régua com esse nome");
    if (error.code === "23514") throw badRequest("Valores fora das regras da régua (janela, dias ou tetos)");
    throw unavailable(error, "Régua");
  }
  const row = (data as RulerRow[] | null)?.[0];
  if (!row) throw notFound("Régua não encontrada");
  return { ruler: row, changed };
}

/** Só apaga régua DESLIGADA e sem inscrições (a exclusão levaria o histórico de cobrança junto, ON DELETE CASCADE). */
export async function deleteRuler(db: Db, accountId: string, id: string): Promise<RulerRow> {
  const ruler = await getRuler(db, accountId, id);
  if (ruler.active) throw conflict("Desligue a régua antes de apagá-la");
  const { count, error } = await db.from("billing_enrollments").select("id", { count: "exact", head: true }).eq("account_id", accountId).eq("ruler_id", id);
  if (error) throw unavailable(error, "Inscrições");
  if ((count ?? 0) > 0) throw conflict("A régua tem histórico de cobrança e não pode ser apagada; mantenha-a desligada");
  const { error: de } = await db.from("billing_rulers").delete().eq("account_id", accountId).eq("id", id);
  if (de) throw unavailable(de, "Régua");
  return ruler;
}

export async function replaceSteps(db: Db, accountId: string, ruler: RulerRow, steps: StepInput[]): Promise<StepRow[]> {
  let provider: "meta" | "waha" | null = null;
  if (ruler.channel_id) provider = await channelProvider(db, accountId, ruler.channel_id);
  const templateIds = [...new Set(steps.filter((s) => s.active && s.template_id).map((s) => s.template_id as string))];
  const templates = new Map<string, TemplateInfo>();
  if (templateIds.length > 0) {
    const { data, error } = await db.from("message_templates").select("id, status, body_text").eq("account_id", accountId).in("id", templateIds);
    if (error) throw unavailable(error, "Templates");
    for (const t of (data ?? []) as TemplateInfo[]) templates.set(t.id, t);
  }
  const problems = checkStepsAgainstChannel(steps, provider, templates);
  if (problems.length > 0) throw new ApiError("bad_request", "Etapas inválidas", 400, undefined, undefined, { problems: problems.slice(0, 20) });
  // régua ligada não pode ficar sem etapa ativa (o motor não teria o que enviar)
  if (ruler.active && !steps.some((s) => s.active)) throw conflict("A régua está ligada: mantenha ao menos uma etapa ativa ou desligue-a antes");

  const { error } = await db.rpc("billing_replace_steps", { p_account: accountId, p_ruler: ruler.id, p_steps: steps });
  if (error) {
    const msg = error.message ?? "";
    if (msg.includes("step_has_history")) throw conflict("Há etapa com envios no histórico: não remova, mantenha-a na lista com active=false");
    if (msg.includes("step_not_found")) throw badRequest("Alguma etapa informada não pertence a esta régua");
    if (msg.includes("ruler_not_found")) throw notFound("Régua não encontrada");
    if (error.code === "23505") throw conflict("Deslocamento ou posição em conflito entre etapas; reenvie a lista completa com deslocamentos distintos");
    if (error.code === "23514") throw badRequest("Valores fora das regras das etapas");
    throw unavailable(error, "Etapas");
  }
  return listSteps(db, accountId, ruler.id);
}

export async function dryRun(db: Db, accountId: string, rulerId: string, date: string) {
  await getRuler(db, accountId, rulerId);
  const { data, error } = await db.rpc("billing_dry_run", { p_account: accountId, p_ruler: rulerId, p_date: date });
  if (error) throw unavailable(error, "Simulação");
  const counts = new Map<string, number>();
  for (const r of (data ?? []) as Array<{ step_id: string; debts: number | string }>) counts.set(r.step_id, Number(r.debts));
  const steps = (await listSteps(db, accountId, rulerId)).filter((s) => s.active && s.kind === "offset");
  const rows = steps.map((s) => ({ step_id: s.id, position: s.position, offset_days: s.offset_days, debts: counts.get(s.id) ?? 0 }));
  return { date, steps: rows, total: rows.reduce((a, r) => a + r.debts, 0) };
}

export async function rulerMetrics(db: Db, accountId: string, rulerId: string) {
  await getRuler(db, accountId, rulerId);
  const { data, error } = await db.rpc("billing_ruler_metrics", { p_account: accountId, p_ruler: rulerId });
  if (error) throw unavailable(error, "Métricas");
  const raw = (data ?? { steps: [], enrollments: [] }) as {
    steps: Array<{ step_id: string; status: string; total: number | string }>;
    enrollments: Array<{ status: string; stop_reason: string | null; total: number | string }>;
  };
  const byStep = new Map<string, Record<string, number>>();
  for (const r of raw.steps) {
    const m = byStep.get(r.step_id) ?? {};
    m[r.status] = Number(r.total);
    byStep.set(r.step_id, m);
  }
  const steps = (await listSteps(db, accountId, rulerId)).map((s) => {
    const by_status = byStep.get(s.id) ?? {};
    const total = Object.values(by_status).reduce((a, n) => a + n, 0);
    return { step_id: s.id, position: s.position, offset_days: s.offset_days, active: s.active, total, by_status };
  });
  const enrollments = raw.enrollments.map((r) => ({ status: r.status, stop_reason: r.stop_reason, total: Number(r.total) }));
  // respondidas e "pagas após cobrança" entram na PR 17.6 (precisam do vínculo com mensagens/pagamentos)
  return { ruler_id: rulerId, steps, enrollments };
}

export interface EnrollmentListFilters {
  status?: string;
  motivo?: string;
  ruler_id?: string;
  cursor?: string | null;
  limit?: number;
}

export async function listEnrollments(db: Db, accountId: string, f: EnrollmentListFilters) {
  if (f.status && !(ENROLLMENT_STATUSES as readonly string[]).includes(f.status)) throw badRequest("status inválido");
  if (f.motivo && !(STOP_REASONS as readonly string[]).includes(f.motivo)) throw badRequest("motivo inválido");
  if (f.ruler_id && !validUuid(f.ruler_id)) throw badRequest("ruler_id inválido");
  const limit = Math.min(Math.max(Math.trunc(f.limit ?? 50) || 50, 1), 200);
  const cursor = decodeCursor(f.cursor ?? null);

  let q = db.from("billing_enrollments").select("id, ruler_id, debt_id, status, stop_reason, stopped_at, next_step_at, created_at").eq("account_id", accountId);
  if (f.status) q = q.eq("status", f.status);
  if (f.motivo) q = q.eq("stop_reason", f.motivo);
  if (f.ruler_id) q = q.eq("ruler_id", f.ruler_id);
  if (cursor) q = q.or(`created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`);
  const { data, error } = await q.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1);
  if (error) throw unavailable(error, "Inscrições");
  const rows = (data ?? []) as Array<{ id: string; ruler_id: string; debt_id: string; status: string; stop_reason: string | null; stopped_at: string | null; next_step_at: string | null; created_at: string }>;
  const page = rows.slice(0, limit);
  const next_cursor = rows.length > limit ? encodeCursor(page[page.length - 1]) : null;

  const debts = new Map<string, { id: string; contact_id: string; due_date: string; amount_cents: number | null; status: string; external_ref: string }>();
  const contacts = new Map<string, string | null>();
  if (page.length > 0) {
    const { data: d, error: de } = await db.from("billing_debts").select("id, contact_id, due_date, amount_cents, status, external_ref").eq("account_id", accountId).in("id", [...new Set(page.map((r) => r.debt_id))]);
    if (de) throw unavailable(de, "Dívidas");
    for (const x of (d ?? []) as Array<{ id: string; contact_id: string; due_date: string; amount_cents: number | null; status: string; external_ref: string }>) debts.set(x.id, x);
    const contactIds = [...new Set([...debts.values()].map((x) => x.contact_id))];
    if (contactIds.length > 0) {
      // só o NOME do contato (sem telefone/CPF): a tela identifica quem está na régua
      const { data: c, error: ce } = await db.from("contacts").select("id, name").eq("account_id", accountId).in("id", contactIds);
      if (ce) throw unavailable(ce, "Contatos");
      for (const x of (c ?? []) as Array<{ id: string; name: string | null }>) contacts.set(x.id, x.name);
    }
  }
  return {
    enrollments: page.map((r) => {
      const debt = debts.get(r.debt_id);
      return {
        id: r.id,
        ruler_id: r.ruler_id,
        status: r.status,
        stop_reason: r.stop_reason,
        stopped_at: r.stopped_at,
        next_step_at: r.next_step_at,
        created_at: r.created_at,
        debt: debt ? { id: debt.id, due_date: debt.due_date, amount_cents: debt.amount_cents, status: debt.status, external_ref: debt.external_ref } : null,
        contact: debt ? { id: debt.contact_id, name: contacts.get(debt.contact_id) ?? null } : null,
      };
    }),
    next_cursor,
  };
}

export type EnrollmentAction = "pause" | "resume" | "stop";

/**
 * Controle manual de UMA inscrição. Transição condicional (a linha só muda se estiver no estado de origem), então dois cliques/duas abas
 * não se atropelam: o segundo recebe 409. Parar cancela os envios ainda não saídos (reservada/enfileirada) e, se o item já estiver na fila,
 * a guarda de pré-envio (billing_should_send) o cancela por a inscrição não estar mais ativa.
 */
export async function controlEnrollment(db: Db, accountId: string, id: string, action: EnrollmentAction) {
  const now = new Date().toISOString();
  const from = action === "pause" ? ["active"] : action === "resume" ? ["paused"] : ["active", "paused"];
  const set: Record<string, unknown> =
    action === "pause" ? { status: "paused", updated_at: now }
    : action === "resume" ? { status: "active", updated_at: now }
    : { status: "stopped", stop_reason: "manual", stopped_at: now, next_step_at: null, updated_at: now };
  const { data, error } = await db.from("billing_enrollments").update(set).eq("account_id", accountId).eq("id", id).in("status", from).select("id, ruler_id, debt_id, status").limit(1);
  if (error) throw unavailable(error, "Inscrição");
  const row = (data as Array<{ id: string; ruler_id: string; debt_id: string; status: string }> | null)?.[0];
  if (!row) {
    const { data: cur, error: ce } = await db.from("billing_enrollments").select("id, status").eq("account_id", accountId).eq("id", id).limit(1);
    if (ce) throw unavailable(ce, "Inscrição");
    const found = (cur as Array<{ status: string }> | null)?.[0];
    if (!found) throw notFound("Inscrição não encontrada");
    throw conflict(`A inscrição está '${found.status}' e não pode ${action === "pause" ? "ser pausada" : action === "resume" ? "ser retomada" : "ser parada"} agora`);
  }
  let cancelled = 0;
  if (action === "stop") {
    const { data: c, error: se } = await db
      .from("billing_step_sends")
      .update({ status: "cancelled", error_code: "manual", updated_at: now })
      .eq("account_id", accountId)
      .eq("enrollment_id", id)
      .in("status", ["reserved", "enqueued"])
      .select("id");
    if (se) throw unavailable(se, "Envios");
    cancelled = (c ?? []).length;
  }
  return { enrollment: row, cancelled_sends: cancelled };
}
