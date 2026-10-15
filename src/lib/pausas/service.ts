import "server-only";
/* eslint-disable @typescript-eslint/no-explicit-any -- cliente com schema wacrm */
// Pausas de atendimento — acesso ao banco para as rotas /api/pausas/*. Contrato: prd-v2/pausas-contrato-api.md.
// Quem decide permissão e escopo é o BANCO (RPCs start_pause/end_pause e a RLS de agent_pauses, migration 370); aqui só se mapeia o resultado.
// Leituras de escopo (equipe, relatório) usam o cliente DO USUÁRIO (RLS); o que não depende de escopo usa o service role, sempre com account_id.
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  PAUSE_COLUMNS,
  PauseApiError,
  buildAgentReport,
  decodePauseCursor,
  encodePauseCursor,
  isUuid,
  parseReportPeriod,
  toPauseView,
  REPORT_DEFAULT_LIMIT,
  REPORT_MAX_LIMIT,
  type PauseRow,
  type PauseView,
  type ReasonCreate,
  type ReasonPatch,
  type SessionRow,
} from "./pure";

type Db = SupabaseClient;

const isMissing = (e: { code?: string } | null | undefined) => e?.code === "42P01" || e?.code === "PGRST205" || e?.code === "42883" || e?.code === "PGRST202";
const unavailable = () => new PauseApiError("unavailable", "Pausas indisponíveis: aplique as migrations 370 e 371", 503);
const dbFail = (e: { code?: string; message?: string }): never => {
  if (isMissing(e)) throw unavailable();
  throw e;
};

export interface ReasonView {
  id: string;
  name: string;
  max_minutes: number | null;
  active: boolean;
  sort_order: number;
}
const REASON_COLUMNS = "id, name, max_minutes, active, sort_order";

// ── nomes ────────────────────────────────────────────────────────────────────
export async function namesOf(admin: Db, accountId: string, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((i): i is string => !!i))];
  const out = new Map<string, string>();
  if (unique.length === 0) return out;
  const { data } = await admin.from("profiles").select("user_id, full_name").eq("account_id", accountId).in("user_id", unique);
  for (const r of (data ?? []) as Array<{ user_id: string; full_name: string | null }>) out.set(r.user_id, (r.full_name ?? "").trim() || "Atendente");
  return out;
}

export async function viewsOf(admin: Db, accountId: string, rows: readonly PauseRow[], now = Date.now()): Promise<PauseView[]> {
  const names = await namesOf(admin, accountId, rows.flatMap((r) => [r.user_id, r.started_by]));
  return rows.map((r) => toPauseView(r, names, now));
}

// ── motivos ──────────────────────────────────────────────────────────────────
export async function listReasons(admin: Db, accountId: string, all: boolean): Promise<ReasonView[]> {
  const ensure = await admin.rpc("ensure_default_pause_reasons", { p_account: accountId });
  if (ensure.error) dbFail(ensure.error);
  let q = admin.from("pause_reasons").select(REASON_COLUMNS).eq("account_id", accountId);
  if (!all) q = q.eq("active", true);
  const { data, error } = await q.order("sort_order", { ascending: true }).order("name", { ascending: true }).limit(200);
  if (error) dbFail(error);
  return (data ?? []) as ReasonView[];
}

export async function createReason(admin: Db, accountId: string, input: ReasonCreate): Promise<ReasonView> {
  const { data: last } = await admin.from("pause_reasons").select("sort_order").eq("account_id", accountId).order("sort_order", { ascending: false }).limit(1);
  const sort = (((last ?? [])[0] as { sort_order?: number } | undefined)?.sort_order ?? 0) + 10;
  const { data, error } = await admin
    .from("pause_reasons")
    .insert({ account_id: accountId, name: input.name, max_minutes: input.max_minutes, sort_order: sort })
    .select(REASON_COLUMNS)
    .limit(1);
  if (error) {
    if (error.code === "23505") throw new PauseApiError("reason_name_taken", "Já existe um motivo com esse nome", 409);
    dbFail(error);
  }
  return (data ?? [])[0] as ReasonView;
}

export async function patchReason(admin: Db, accountId: string, id: string, patch: ReasonPatch): Promise<ReasonView> {
  if (!isUuid(id)) throw new PauseApiError("not_found", "Motivo não encontrado", 404);
  const { data, error } = await admin
    .from("pause_reasons")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("account_id", accountId)
    .select(REASON_COLUMNS)
    .limit(1);
  if (error) {
    if (error.code === "23505") throw new PauseApiError("reason_name_taken", "Já existe um motivo com esse nome", 409);
    dbFail(error);
  }
  const row = (data ?? [])[0] as ReasonView | undefined;
  if (!row) throw new PauseApiError("not_found", "Motivo não encontrado", 404);
  return row;
}

// ── iniciar / encerrar ───────────────────────────────────────────────────────
const RPC_ERRORS: Record<string, { status: number; message: string }> = {
  unauthenticated: { status: 401, message: "Sessão expirada" },
  forbidden: { status: 403, message: "Você não tem permissão para esta ação" },
  other_team: { status: 403, message: "Esse atendente não é de uma equipe sua" },
  user_not_found: { status: 404, message: "Atendente não encontrado" },
  reason_not_found: { status: 404, message: "Motivo não encontrado" },
  reason_inactive: { status: 409, message: "Esse motivo está desativado" },
  already_paused: { status: 409, message: "O atendente já está em pausa" },
  not_paused: { status: 404, message: "O atendente não está em pausa" },
  paused_by_supervisor: { status: 403, message: "Esta pausa foi aplicada por um supervisor: só ele (ou um administrador) pode retomar" },
};

async function mapRpc(admin: Db, accountId: string, result: { data: any; error: any }): Promise<PauseView> {
  if (result.error) dbFail(result.error);
  const body = result.data as { ok: boolean; code?: string; pause?: PauseRow } | null;
  if (!body) throw unavailable();
  if (body.ok && body.pause) return (await viewsOf(admin, accountId, [body.pause]))[0];
  const known = RPC_ERRORS[body.code ?? ""];
  const extra: Record<string, unknown> = {};
  if (body.pause) {
    const view = (await viewsOf(admin, accountId, [body.pause]))[0];
    if (body.code === "already_paused") extra.pause = view;
    if (body.code === "paused_by_supervisor") extra.started_by_name = view.started_by_name;
  }
  throw new PauseApiError(body.code ?? "internal", known?.message ?? "Não foi possível concluir a ação", known?.status ?? 500, extra);
}

export async function startPause(userDb: Db, admin: Db, accountId: string, input: { reasonId: string; targetUserId: string | null }): Promise<PauseView> {
  return mapRpc(admin, accountId, await userDb.rpc("start_pause", { p_reason_id: input.reasonId, p_target_user: input.targetUserId }));
}

export async function endPause(userDb: Db, admin: Db, accountId: string, targetUserId: string | null): Promise<PauseView> {
  return mapRpc(admin, accountId, await userDb.rpc("end_pause", { p_target_user: targetUserId }));
}

// ── leituras ─────────────────────────────────────────────────────────────────
export async function currentPause(admin: Db, accountId: string, userId: string): Promise<PauseView | null> {
  const { data, error } = await admin.from("agent_pauses").select(PAUSE_COLUMNS).eq("account_id", accountId).eq("user_id", userId).is("ended_at", null).limit(1);
  if (error) dbFail(error);
  const row = (data ?? [])[0] as PauseRow | undefined;
  return row ? (await viewsOf(admin, accountId, [row]))[0] : null;
}

/** Pausas abertas no escopo de quem chama (a RLS de agent_pauses decide: própria, equipes dele ou a conta). */
export async function teamPauses(userDb: Db, admin: Db, accountId: string, teamId: string | null): Promise<Array<PauseView & { team_ids: string[] }>> {
  const { data, error } = await userDb.from("agent_pauses").select(PAUSE_COLUMNS).eq("account_id", accountId).is("ended_at", null).order("started_at", { ascending: true }).limit(1000);
  if (error) dbFail(error);
  let rows = (data ?? []) as PauseRow[];
  const { data: links } = rows.length ? await admin.from("team_members").select("user_id, team_id").in("user_id", rows.map((r) => r.user_id)) : { data: [] };
  const teams = new Map<string, string[]>();
  for (const l of (links ?? []) as Array<{ user_id: string; team_id: string }>) teams.set(l.user_id, [...(teams.get(l.user_id) ?? []), l.team_id]);
  if (teamId) rows = rows.filter((r) => (teams.get(r.user_id) ?? []).includes(teamId));
  const views = await viewsOf(admin, accountId, rows);
  return views.map((v) => ({ ...v, team_ids: teams.get(v.user_id) ?? [] }));
}

export async function inPauseUserIds(admin: Db, accountId: string): Promise<string[]> {
  const { data, error } = await admin.from("agent_pauses").select("user_id").eq("account_id", accountId).is("ended_at", null).limit(2000);
  if (error) dbFail(error);
  return ((data ?? []) as Array<{ user_id: string }>).map((r) => r.user_id);
}

// ── relatório ────────────────────────────────────────────────────────────────
const PAGE = 1000;
const MAX_PAGES = 30;

export interface ReportParams {
  de: string | null;
  ate: string | null;
  equipe: string | null;
  atendente: string | null;
  motivo: string | null;
  detalhe: boolean;
  limite: number;
  cursor: string | null;
}

export function parseReportParams(p: URLSearchParams): ReportParams {
  const uuid = (name: string) => {
    const v = p.get(name);
    if (!v) return null;
    if (!isUuid(v)) throw new PauseApiError("invalid_request", `\`${name}\` deve ser um id (UUID)`, 400);
    return v;
  };
  const rawLimit = p.get("limite");
  const limit = rawLimit ? Number(rawLimit) : REPORT_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) throw new PauseApiError("invalid_request", "`limite` inválido", 400);
  return {
    de: p.get("de"),
    ate: p.get("ate"),
    equipe: uuid("equipe"),
    atendente: uuid("atendente"),
    motivo: uuid("motivo"),
    detalhe: p.get("detalhe") === "1" || p.get("detalhe") === "true",
    limite: Math.min(limit, REPORT_MAX_LIMIT),
    cursor: p.get("cursor"),
  };
}

export async function pauseReport(userDb: Db, admin: Db, accountId: string, params: ReportParams, now = Date.now()) {
  const period = parseReportPeriod(params.de, params.ate, now);
  const cursor = decodePauseCursor(params.cursor);

  let teamUserIds: string[] | null = null;
  if (params.equipe) {
    const { data } = await admin.from("team_members").select("user_id").eq("team_id", params.equipe);
    teamUserIds = ((data ?? []) as Array<{ user_id: string }>).map((r) => r.user_id);
    if (teamUserIds.length === 0) return { period: { from: period.from, to: period.to }, agents: [], items: params.detalhe ? [] : undefined, next_cursor: null };
  }

  const fromIso = new Date(period.fromMs).toISOString();
  const toIso = new Date(period.toMs).toISOString();
  const rows: PauseRow[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    let q = userDb
      .from("agent_pauses")
      .select(PAUSE_COLUMNS)
      .eq("account_id", accountId)
      .lt("started_at", toIso)
      .or(`ended_at.is.null,ended_at.gt.${fromIso}`);
    if (params.atendente) q = q.eq("user_id", params.atendente);
    if (params.motivo) q = q.eq("reason_id", params.motivo);
    if (teamUserIds) q = q.in("user_id", teamUserIds);
    const { data, error } = await q.order("started_at", { ascending: true }).order("id", { ascending: true }).range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) dbFail(error);
    const batch = (data ?? []) as PauseRow[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }

  const userIds = [...new Set(rows.map((r) => r.user_id))];
  const sessions: SessionRow[] = [];
  if (userIds.length > 0) {
    const { data, error } = await admin
      .from("agent_sessions")
      .select("user_id, logged_in_at, logged_out_at")
      .eq("account_id", accountId)
      .in("user_id", userIds)
      .lt("logged_in_at", toIso)
      .or(`logged_out_at.is.null,logged_out_at.gt.${fromIso}`)
      .limit(20000);
    if (error && !isMissing(error)) throw error;
    sessions.push(...((data ?? []) as SessionRow[]));
  }

  const names = await namesOf(admin, accountId, rows.flatMap((r) => [r.user_id, r.started_by, r.ended_by]));
  const agents = buildAgentReport(rows, sessions, names, period, now);

  let items: Array<PauseView & { ended_by_name: string | null }> | undefined;
  let nextCursor: string | null = null;
  if (params.detalhe) {
    const after = cursor ? rows.filter((r) => r.started_at > cursor[0] || (r.started_at === cursor[0] && r.id > cursor[1])) : rows;
    const page = after.slice(0, params.limite);
    items = page.map((r) => ({ ...toPauseView(r, names, now), ended_by_name: r.ended_by ? (names.get(r.ended_by) ?? null) : null }));
    if (after.length > params.limite) nextCursor = encodePauseCursor(page[page.length - 1]);
  }
  return { period: { from: period.from, to: period.to }, agents, ...(items ? { items } : {}), next_cursor: nextCursor };
}
