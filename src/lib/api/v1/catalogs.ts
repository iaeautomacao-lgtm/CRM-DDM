// Catálogos da API pública (Onda 2): tabulações, atendentes e equipes. SOMENTE cadastro e status — sem métricas, sem e-mail, sem telefone do atendente.
// Sempre escopado pela conta da chave. O status do atendente usa a mesma régua de presença do painel (online ≤ 75 s, ausente, offline) e a pausa
// aberta (migration 370). Limites: 60/min por chave (além dos 120/min gerais), `limit` 1..200.
import type { SupabaseClient } from '@supabase/supabase-js';
import { ApiError, badRequest } from '@/lib/api/v1/respond';
import { decodeCursor, encodeCursor, parseLimit } from '@/lib/api/v1/extract';
import { derivePresence, type PresenceStatus, type StoredPresence } from '@/lib/presence';

type Db = Pick<SupabaseClient, 'from'>;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const unavailable = (what: string) => new ApiError('unavailable', `Não foi possível consultar ${what}; tente novamente`, 503);
const missing = (e: { code?: string } | null | undefined) => e?.code === '42P01' || e?.code === 'PGRST205' || e?.code === '42703';

// ── Tabulações ───────────────────────────────────────────────────────────────
export interface TabulationItem {
  id: string;
  code: number | null;
  name: string;
  color: string | null;
}

export async function listTabulations(db: Db, accountId: string): Promise<TabulationItem[]> {
  const { data, error } = await db
    .from('tags')
    .select('id, name, color, codigo_tabulacao')
    .eq('account_id', accountId)
    .eq('kind', 'outcome')
    .order('codigo_tabulacao', { ascending: true, nullsFirst: false })
    .order('name', { ascending: true })
    .limit(500);
  if (error) throw unavailable('as tabulações');
  return ((data ?? []) as Array<{ id: string; name: string; color: string | null; codigo_tabulacao: number | null }>).map((t) => ({
    id: t.id,
    code: t.codigo_tabulacao ?? null,
    name: t.name,
    color: t.color ?? null,
  }));
}

// ── Equipes ──────────────────────────────────────────────────────────────────
export interface TeamItem {
  id: string;
  name: string;
  overflow_team_id: string | null;
  member_ids: string[];
}

export async function listTeams(db: Db, accountId: string): Promise<TeamItem[]> {
  const { data, error } = await db.from('teams').select('id, name, overflow_team_id').eq('account_id', accountId).order('name', { ascending: true }).order('id', { ascending: true }).limit(200);
  if (error) throw unavailable('as equipes');
  const teams = (data ?? []) as Array<{ id: string; name: string; overflow_team_id: string | null }>;
  const members = new Map<string, string[]>();
  if (teams.length > 0) {
    const { data: links, error: linkError } = await db.from('team_members').select('team_id, user_id').in('team_id', teams.map((t) => t.id)).limit(5000);
    if (linkError) throw unavailable('os membros das equipes');
    for (const l of (links ?? []) as Array<{ team_id: string; user_id: string }>) members.set(l.team_id, [...(members.get(l.team_id) ?? []), l.user_id]);
  }
  return teams.map((t) => ({ id: t.id, name: t.name, overflow_team_id: t.overflow_team_id ?? null, member_ids: members.get(t.id) ?? [] }));
}

// ── Atendentes ───────────────────────────────────────────────────────────────
export const AGENT_ROLES = ['owner', 'admin', 'supervisor', 'agent'] as const;
export const AGENT_STATUSES: readonly PresenceStatus[] = ['online', 'away', 'offline'];

export interface AgentItem {
  id: string;
  name: string;
  role: (typeof AGENT_ROLES)[number];
  team_ids: string[];
  status: PresenceStatus;
  paused: boolean;
  pause: { reason: string; since: string } | null;
  max_simultaneous_chats: number | null;
}

export interface AgentsQuery {
  teamId: string | null;
  role: (typeof AGENT_ROLES)[number] | null;
  status: PresenceStatus | null;
  limit: number;
  cursor: [string, string] | null;
}

export function parseAgentsQuery(p: URLSearchParams): AgentsQuery {
  const teamId = p.get('team_id')?.trim() || null;
  if (teamId && !UUID_RE.test(teamId)) throw badRequest("'team_id' deve ser um UUID");
  const role = p.get('role')?.trim() || null;
  if (role && !(AGENT_ROLES as readonly string[]).includes(role)) throw badRequest(`'role' inválido. Use: ${AGENT_ROLES.join(', ')}`);
  const status = p.get('status')?.trim() || null;
  if (status && !(AGENT_STATUSES as readonly string[]).includes(status)) throw badRequest(`'status' inválido. Use: ${AGENT_STATUSES.join(', ')}`);
  const cursor = decodeCursor(p.get('cursor'), 2);
  return {
    teamId,
    role: role as AgentsQuery['role'],
    status: status as AgentsQuery['status'],
    limit: parseLimit(p.get('limit'), 100, 200),
    cursor: cursor ? [cursor[0], cursor[1]] : null,
  };
}

interface ProfileRow {
  user_id: string;
  full_name: string | null;
  account_role: (typeof AGENT_ROLES)[number];
  created_at: string;
  max_simultaneous_chats: number | null;
}

/** Atendentes ativos da conta (operador, supervisor, admin, proprietário; o visualizador não atende), em ordem estável (created_at, user_id). */
export async function listAgents(db: Db, accountId: string, q: AgentsQuery, now: number = Date.now()): Promise<{ items: AgentItem[]; next_cursor: string | null }> {
  let allowed: string[] | null = null;
  if (q.teamId) {
    const { data, error } = await db.from('team_members').select('user_id').eq('team_id', q.teamId).limit(5000);
    if (error) throw unavailable('os membros da equipe');
    allowed = ((data ?? []) as Array<{ user_id: string }>).map((r) => r.user_id);
    if (allowed.length === 0) return { items: [], next_cursor: null };
  }
  // O filtro de status é aplicado depois de derivar a presença; para não esvaziar páginas, busca em blocos até encher a página.
  const items: AgentItem[] = [];
  let cursor = q.cursor;
  let nextCursor: string | null = null;
  for (let round = 0; round < 20 && items.length <= q.limit; round++) {
    let query = db
      .from('profiles')
      .select('user_id, full_name, account_role, created_at, max_simultaneous_chats')
      .eq('account_id', accountId)
      .in('account_role', q.role ? [q.role] : [...AGENT_ROLES])
      .is('deactivated_at', null);
    if (allowed) query = query.in('user_id', allowed);
    if (cursor) query = query.or(`created_at.gt.${cursor[0]},and(created_at.eq.${cursor[0]},user_id.gt.${cursor[1]})`);
    const { data, error } = await query.order('created_at', { ascending: true }).order('user_id', { ascending: true }).limit(200);
    if (error) {
      if (missing(error)) throw unavailable('os atendentes');
      throw unavailable('os atendentes');
    }
    const rows = (data ?? []) as ProfileRow[];
    if (rows.length === 0) break;
    const ids = rows.map((r) => r.user_id);
    const [presence, pauses, links] = await Promise.all([
      db.from('member_presence').select('user_id, status, last_seen_at').in('user_id', ids),
      db.from('agent_pauses').select('user_id, reason_name, started_at').eq('account_id', accountId).is('ended_at', null).in('user_id', ids),
      db.from('team_members').select('user_id, team_id').in('user_id', ids).limit(5000),
    ]);
    if (presence.error || links.error) throw unavailable('o status dos atendentes');
    if (pauses.error && !missing(pauses.error)) throw unavailable('as pausas dos atendentes');
    const presenceBy = new Map(((presence.data ?? []) as Array<{ user_id: string; status: StoredPresence; last_seen_at: string }>).map((p) => [p.user_id, p]));
    const pauseBy = new Map(((pauses.data ?? []) as Array<{ user_id: string; reason_name: string; started_at: string }>).map((p) => [p.user_id, p]));
    const teamsBy = new Map<string, string[]>();
    for (const l of (links.data ?? []) as Array<{ user_id: string; team_id: string }>) teamsBy.set(l.user_id, [...(teamsBy.get(l.user_id) ?? []), l.team_id]);

    for (const r of rows) {
      const pr = presenceBy.get(r.user_id);
      const status = derivePresence(pr?.status, pr?.last_seen_at, now);
      if (q.status && status !== q.status) continue;
      const pause = pauseBy.get(r.user_id);
      items.push({
        id: r.user_id,
        name: (r.full_name ?? '').trim() || 'Atendente',
        role: r.account_role,
        team_ids: teamsBy.get(r.user_id) ?? [],
        status,
        paused: !!pause,
        pause: pause ? { reason: pause.reason_name, since: pause.started_at } : null,
        max_simultaneous_chats: r.max_simultaneous_chats ?? null,
      });
    }
    const last = rows[rows.length - 1];
    cursor = [last.created_at, last.user_id];
    if (rows.length < 200) break;
  }
  const page = items.slice(0, q.limit);
  if (items.length > q.limit) {
    // Há mais: o cursor aponta para o último item DEVOLVIDO (a próxima chamada recomeça logo depois dele).
    const lastItem = page[page.length - 1];
    const { data } = await db.from('profiles').select('created_at').eq('user_id', lastItem.id).limit(1);
    const created = ((data ?? [])[0] as { created_at?: string } | undefined)?.created_at;
    nextCursor = created ? encodeCursor([created, lastItem.id]) : null;
  }
  return { items: page, next_cursor: nextCursor };
}
