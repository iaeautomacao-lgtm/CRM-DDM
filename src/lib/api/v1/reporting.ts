import type { SupabaseClient } from '@supabase/supabase-js';

import { badRequest } from '@/lib/api/v1/respond';
import { dayBounds, isValidDay } from '@/lib/monitoramento/day-view';
import { derivePresence, type PresenceStatus, type StoredPresence } from '@/lib/presence';

const PAGE_SIZE = 1000;
const MAX_FACT_ROWS = 100_000;
const MAX_ACTIVE_ROWS = 20_000;
const MAX_RANGE_DAYS = 366;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ReportRange {
  fromDate: string;
  toDate: string;
  fromMs: number;
  toMs: number;
  fromIso: string;
  toExclusiveIso: string;
}

export interface ReportFilters {
  teamId?: string;
  agentId?: string;
}

export interface ReportQuery {
  range?: ReportRange;
  filters: ReportFilters;
}

export interface ConversationFact {
  id: string;
  status: 'open' | 'pending' | 'closed';
  team_id: string | null;
  assigned_agent_id: string | null;
  created_at: string;
  first_response_at: string | null;
  closed_at: string | null;
  outcome_tag_id: string | null;
}

export interface TeamRow {
  id: string;
  name: string;
}

export interface TeamMemberRow {
  team_id: string;
  user_id: string;
}

export interface ProfileRow {
  user_id: string;
  full_name: string | null;
  account_role: string | null;
}

export interface PresenceRow {
  user_id: string;
  status: StoredPresence;
  last_seen_at: string;
}

export interface TagRow {
  id: string;
  name: string;
  codigo_tabulacao: number | null;
}

export interface ReportingRoster {
  teams: TeamRow[];
  teamMembers: TeamMemberRow[];
  profiles: ProfileRow[];
  presence: PresenceRow[];
}

export type OperationalPhase = 'navigating' | 'waiting' | 'attending';

export interface PeriodMetrics {
  received: number;
  attended: number;
  closed: number;
  tabulated: number;
  without_tabulation: number;
  distinct_tabulations: number;
  unique_operators: number;
  avg_first_response_seconds: number | null;
  avg_service_seconds: number | null;
}

export interface CurrentTeamMetrics {
  team_id: string | null;
  team_name: string;
  conversations: {
    total_active: number;
    navigating: number;
    waiting: number;
    attending: number;
  };
  operators: {
    total: number;
    online: number;
    away: number;
    offline: number;
    serving: number;
  };
}

export interface CurrentSnapshot {
  generated_at: string;
  conversations: {
    total_active: number;
    navigating: number;
    waiting: number;
    attending: number;
  };
  operators: {
    total: number;
    online: number;
    away: number;
    offline: number;
    serving: number;
  };
  teams: CurrentTeamMetrics[];
}

function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function inRange(iso: string | null, range: ReportRange): boolean {
  if (!iso) return false;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms >= range.fromMs && ms < range.toMs;
}

function secondsBetween(fromIso: string, toIso: string): number {
  return Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 1000));
}

export function parseReportQuery(url: string, requireRange: boolean): ReportQuery {
  const params = new URL(url).searchParams;
  const teamId = params.get('team_id')?.trim() || undefined;
  const agentId = params.get('agent_id')?.trim() || undefined;

  if (teamId && !UUID_RE.test(teamId)) throw badRequest("'team_id' must be a UUID");
  if (agentId && !UUID_RE.test(agentId)) throw badRequest("'agent_id' must be a UUID");

  const from = params.get('from');
  const to = params.get('to');

  if (!requireRange && !from && !to) {
    return { filters: { teamId, agentId } };
  }

  if (!from || !to) {
    throw badRequest("Historical reports require 'from' and 'to' in YYYY-MM-DD format");
  }
  if (!isValidDay(from) || !isValidDay(to)) {
    throw badRequest("'from' and 'to' must use YYYY-MM-DD");
  }

  const fromBounds = dayBounds(from);
  const toBounds = dayBounds(to);
  if (toBounds.startMs < fromBounds.startMs) {
    throw badRequest("'to' must be on or after 'from'");
  }

  const days = Math.round((toBounds.endMs - fromBounds.startMs) / 86_400_000);
  if (days > MAX_RANGE_DAYS) {
    throw badRequest(`Report range is limited to ${MAX_RANGE_DAYS} days; split larger exports into multiple requests`);
  }

  return {
    filters: { teamId, agentId },
    range: {
      fromDate: from,
      toDate: to,
      fromMs: fromBounds.startMs,
      toMs: toBounds.endMs,
      fromIso: new Date(fromBounds.startMs).toISOString(),
      toExclusiveIso: new Date(toBounds.endMs).toISOString(),
    },
  };
}

async function loadPaged<T>(
  fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  maxRows: number,
  label: string,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await fetchPage(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const page = data ?? [];
    rows.push(...page);
    if (rows.length > maxRows) {
      throw badRequest(`${label} exceeded ${maxRows.toLocaleString('en-US')} rows; split the report into a smaller period`);
    }
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

function conversationTouchesRange(range: ReportRange): string {
  return [
    `and(created_at.gte.${range.fromIso},created_at.lt.${range.toExclusiveIso})`,
    `and(first_response_at.gte.${range.fromIso},first_response_at.lt.${range.toExclusiveIso})`,
    `and(closed_at.gte.${range.fromIso},closed_at.lt.${range.toExclusiveIso})`,
  ].join(',');
}

export async function loadPeriodConversationFacts(
  db: SupabaseClient,
  accountId: string,
  range: ReportRange,
  filters: ReportFilters = {},
): Promise<ConversationFact[]> {
  const touches = conversationTouchesRange(range);
  return loadPaged<ConversationFact>(
    (from, to) => {
      let query = db
        .from('conversations')
        .select('id,status,team_id,assigned_agent_id,created_at,first_response_at,closed_at,outcome_tag_id')
        .eq('account_id', accountId)
        .or(touches)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true });
      if (filters.teamId) query = query.eq('team_id', filters.teamId);
      if (filters.agentId) query = query.eq('assigned_agent_id', filters.agentId);
      return query.range(from, to) as unknown as PromiseLike<{ data: ConversationFact[] | null; error: unknown }>;
    },
    MAX_FACT_ROWS,
    'Report',
  );
}

export async function loadActiveConversationFacts(
  db: SupabaseClient,
  accountId: string,
  filters: ReportFilters = {},
): Promise<ConversationFact[]> {
  return loadPaged<ConversationFact>(
    (from, to) => {
      let query = db
        .from('conversations')
        .select('id,status,team_id,assigned_agent_id,created_at,first_response_at,closed_at,outcome_tag_id')
        .eq('account_id', accountId)
        .in('status', ['open', 'pending'])
        .order('updated_at', { ascending: false })
        .order('id', { ascending: false });
      if (filters.teamId) query = query.eq('team_id', filters.teamId);
      if (filters.agentId) query = query.eq('assigned_agent_id', filters.agentId);
      return query.range(from, to) as unknown as PromiseLike<{ data: ConversationFact[] | null; error: unknown }>;
    },
    MAX_ACTIVE_ROWS,
    'Current operational snapshot',
  );
}

export async function loadReportingRoster(
  db: SupabaseClient,
  accountId: string,
): Promise<ReportingRoster> {
  const [teams, profiles, presence] = await Promise.all([
    loadPaged<TeamRow>(
      (from, to) =>
        db
          .from('teams')
          .select('id,name')
          .eq('account_id', accountId)
          .order('name', { ascending: true })
          .range(from, to) as unknown as PromiseLike<{ data: TeamRow[] | null; error: unknown }>,
      10_000,
      'Teams',
    ),
    loadPaged<ProfileRow>(
      (from, to) =>
        db
          .from('profiles')
          .select('user_id,full_name,account_role')
          .eq('account_id', accountId)
          .order('full_name', { ascending: true })
          .range(from, to) as unknown as PromiseLike<{ data: ProfileRow[] | null; error: unknown }>,
      10_000,
      'Profiles',
    ),
    loadPaged<PresenceRow>(
      (from, to) =>
        db
          .from('member_presence')
          .select('user_id,status,last_seen_at')
          .eq('account_id', accountId)
          .order('user_id', { ascending: true })
          .range(from, to) as unknown as PromiseLike<{ data: PresenceRow[] | null; error: unknown }>,
      10_000,
      'Presence',
    ),
  ]);

  const teamIds = teams.map((team) => team.id);
  const teamMembers =
    teamIds.length === 0
      ? []
      : await loadPaged<TeamMemberRow>(
          (from, to) =>
            db
              .from('team_members')
              .select('team_id,user_id')
              .in('team_id', teamIds)
              .order('team_id', { ascending: true })
              .order('user_id', { ascending: true })
              .range(from, to) as unknown as PromiseLike<{ data: TeamMemberRow[] | null; error: unknown }>,
          50_000,
          'Team memberships',
        );

  return { teams, teamMembers, profiles, presence };
}

export async function loadOutcomeTags(
  db: SupabaseClient,
  accountId: string,
): Promise<TagRow[]> {
  return loadPaged<TagRow>(
    (from, to) =>
      db
        .from('tags')
        .select('id,name,codigo_tabulacao')
        .eq('account_id', accountId)
        .eq('kind', 'outcome')
        .order('name', { ascending: true })
        .range(from, to) as unknown as PromiseLike<{ data: TagRow[] | null; error: unknown }>,
    10_000,
    'Tabulations',
  );
}

export function classifyOperationalPhase(
  status: ConversationFact['status'],
  assignedAgentId: string | null,
): OperationalPhase {
  if (assignedAgentId) return 'attending';
  if (status === 'pending') return 'waiting';
  return 'navigating';
}

function presenceByUser(roster: ReportingRoster, nowMs: number): Map<string, PresenceStatus> {
  const stored = new Map(roster.presence.map((row) => [row.user_id, row]));
  const result = new Map<string, PresenceStatus>();
  for (const profile of roster.profiles) {
    const row = stored.get(profile.user_id);
    result.set(
      profile.user_id,
      derivePresence(row?.status, row?.last_seen_at, nowMs),
    );
  }
  return result;
}

function countPresence(
  userIds: Iterable<string>,
  presence: Map<string, PresenceStatus>,
): { total: number; online: number; away: number; offline: number } {
  const unique = [...new Set(userIds)];
  const counts = { total: unique.length, online: 0, away: 0, offline: 0 };
  for (const id of unique) counts[presence.get(id) ?? 'offline'] += 1;
  return counts;
}

function filterOperatorIds(
  roster: ReportingRoster,
  active: ConversationFact[],
  filters: ReportFilters,
): Set<string> {
  const teamMembers = new Map<string, Set<string>>();
  for (const row of roster.teamMembers) {
    const set = teamMembers.get(row.team_id) ?? new Set<string>();
    set.add(row.user_id);
    teamMembers.set(row.team_id, set);
  }

  let ids = new Set<string>();
  if (filters.teamId) {
    ids = new Set(teamMembers.get(filters.teamId) ?? []);
  } else {
    for (const row of roster.teamMembers) ids.add(row.user_id);
    for (const row of active) if (row.assigned_agent_id) ids.add(row.assigned_agent_id);
  }

  if (filters.agentId) {
    ids = ids.has(filters.agentId) || !filters.teamId ? new Set([filters.agentId]) : new Set();
  }
  return ids;
}

export function buildCurrentSnapshot(
  active: ConversationFact[],
  roster: ReportingRoster,
  filters: ReportFilters = {},
  nowMs = Date.now(),
): CurrentSnapshot {
  const presence = presenceByUser(roster, nowMs);
  const phases = { navigating: 0, waiting: 0, attending: 0 };
  const serving = new Set<string>();

  for (const conversation of active) {
    const phase = classifyOperationalPhase(conversation.status, conversation.assigned_agent_id);
    phases[phase] += 1;
    if (conversation.assigned_agent_id) serving.add(conversation.assigned_agent_id);
  }

  const operatorIds = filterOperatorIds(roster, active, filters);
  const operatorPresence = countPresence(operatorIds, presence);
  const globalServing = [...serving].filter((id) => operatorIds.has(id)).length;

  const teamMembers = new Map<string, string[]>();
  for (const row of roster.teamMembers) {
    const list = teamMembers.get(row.team_id) ?? [];
    list.push(row.user_id);
    teamMembers.set(row.team_id, list);
  }

  const teamById = new Map(roster.teams.map((team) => [team.id, team.name]));
  const teamKeys = new Set<string>();
  for (const team of roster.teams) {
    if (!filters.teamId || team.id === filters.teamId) teamKeys.add(team.id);
  }
  for (const conversation of active) {
    if (conversation.team_id) teamKeys.add(conversation.team_id);
    else if (!filters.teamId) teamKeys.add('__none__');
  }

  const teams: CurrentTeamMetrics[] = [];
  for (const key of teamKeys) {
    const teamId = key === '__none__' ? null : key;
    if (filters.teamId && teamId !== filters.teamId) continue;
    const rows = active.filter((conversation) => conversation.team_id === teamId);
    const teamPhases = { navigating: 0, waiting: 0, attending: 0 };
    const teamServing = new Set<string>();
    for (const conversation of rows) {
      const phase = classifyOperationalPhase(conversation.status, conversation.assigned_agent_id);
      teamPhases[phase] += 1;
      if (conversation.assigned_agent_id) teamServing.add(conversation.assigned_agent_id);
    }

    let memberIds = teamId ? teamMembers.get(teamId) ?? [] : [];
    if (filters.agentId) memberIds = memberIds.filter((id) => id === filters.agentId);
    const p = countPresence(memberIds, presence);

    teams.push({
      team_id: teamId,
      team_name: teamId ? teamById.get(teamId) ?? 'Equipe removida' : 'Sem equipe',
      conversations: {
        total_active: rows.length,
        ...teamPhases,
      },
      operators: {
        ...p,
        serving: teamServing.size,
      },
    });
  }

  teams.sort((a, b) => a.team_name.localeCompare(b.team_name));

  return {
    generated_at: new Date(nowMs).toISOString(),
    conversations: {
      total_active: active.length,
      ...phases,
    },
    operators: {
      ...operatorPresence,
      serving: globalServing,
    },
    teams,
  };
}

export function aggregatePeriodMetrics(
  rows: ConversationFact[],
  range: ReportRange,
): PeriodMetrics {
  const received = rows.filter((row) => inRange(row.created_at, range));
  const attended = rows.filter((row) => inRange(row.first_response_at, range));
  const closed = rows.filter((row) => inRange(row.closed_at, range));
  const tabulated = closed.filter((row) => row.outcome_tag_id);
  const tabulationIds = new Set(tabulated.map((row) => row.outcome_tag_id as string));
  const operators = new Set(
    attended.map((row) => row.assigned_agent_id).filter((id): id is string => Boolean(id)),
  );

  const responseSeconds = attended
    .filter((row) => row.first_response_at)
    .map((row) => secondsBetween(row.created_at, row.first_response_at as string));
  const serviceSeconds = closed
    .filter((row) => row.closed_at)
    .map((row) => secondsBetween(row.created_at, row.closed_at as string));

  return {
    received: received.length,
    attended: attended.length,
    closed: closed.length,
    tabulated: tabulated.length,
    without_tabulation: closed.length - tabulated.length,
    distinct_tabulations: tabulationIds.size,
    unique_operators: operators.size,
    avg_first_response_seconds: avg(responseSeconds),
    avg_service_seconds: avg(serviceSeconds),
  };
}

export function buildSummaryReport(
  rows: ConversationFact[],
  range: ReportRange,
  current: CurrentSnapshot,
) {
  return {
    generated_at: current.generated_at,
    period: {
      from: range.fromDate,
      to: range.toDate,
      timezone: 'America/Sao_Paulo',
    },
    attendances: aggregatePeriodMetrics(rows, range),
    current: {
      conversations: current.conversations,
      operators: current.operators,
    },
  };
}

export function buildTeamsReport(
  rows: ConversationFact[],
  range: ReportRange,
  current: CurrentSnapshot,
  roster: ReportingRoster,
) {
  const keys = new Set<string>();
  for (const team of roster.teams) keys.add(team.id);
  for (const row of rows) keys.add(row.team_id ?? '__none__');
  for (const team of current.teams) keys.add(team.team_id ?? '__none__');

  const names = new Map(roster.teams.map((team) => [team.id, team.name]));
  const currentByTeam = new Map(current.teams.map((team) => [team.team_id ?? '__none__', team]));

  return [...keys]
    .map((key) => {
      const teamId = key === '__none__' ? null : key;
      const teamRows = rows.filter((row) => row.team_id === teamId);
      const currentTeam = currentByTeam.get(key);
      return {
        team_id: teamId,
        team_name: teamId ? names.get(teamId) ?? 'Equipe removida' : 'Sem equipe',
        period: aggregatePeriodMetrics(teamRows, range),
        current: currentTeam ?? {
          team_id: teamId,
          team_name: teamId ? names.get(teamId) ?? 'Equipe removida' : 'Sem equipe',
          conversations: { total_active: 0, navigating: 0, waiting: 0, attending: 0 },
          operators: { total: 0, online: 0, away: 0, offline: 0, serving: 0 },
        },
      };
    })
    .sort((a, b) => a.team_name.localeCompare(b.team_name));
}

export function buildAgentsReport(
  rows: ConversationFact[],
  range: ReportRange,
  active: ConversationFact[],
  roster: ReportingRoster,
  filters: ReportFilters = {},
  nowMs = Date.now(),
) {
  const presence = presenceByUser(roster, nowMs);
  const profiles = new Map(roster.profiles.map((profile) => [profile.user_id, profile]));
  const teams = new Map(roster.teams.map((team) => [team.id, team.name]));
  const memberships = new Map<string, string[]>();

  for (const membership of roster.teamMembers) {
    const list = memberships.get(membership.user_id) ?? [];
    list.push(membership.team_id);
    memberships.set(membership.user_id, list);
  }

  const ids = new Set<string>();
  for (const row of rows) if (row.assigned_agent_id) ids.add(row.assigned_agent_id);
  for (const row of active) if (row.assigned_agent_id) ids.add(row.assigned_agent_id);
  for (const membership of roster.teamMembers) ids.add(membership.user_id);

  if (filters.teamId) {
    for (const id of [...ids]) {
      if (!(memberships.get(id) ?? []).includes(filters.teamId)) ids.delete(id);
    }
  }
  if (filters.agentId) {
    for (const id of [...ids]) if (id !== filters.agentId) ids.delete(id);
    ids.add(filters.agentId);
  }

  return [...ids]
    .map((id) => {
      const profile = profiles.get(id);
      const agentRows = rows.filter((row) => row.assigned_agent_id === id);
      const currentRows = active.filter((row) => row.assigned_agent_id === id);
      const teamIds = memberships.get(id) ?? [];
      return {
        agent_id: id,
        agent_name: profile?.full_name ?? 'Operador removido',
        role: profile?.account_role ?? null,
        presence: presence.get(id) ?? 'offline',
        teams: teamIds.map((teamId) => ({
          team_id: teamId,
          team_name: teams.get(teamId) ?? 'Equipe removida',
        })),
        period: aggregatePeriodMetrics(agentRows, range),
        current: {
          attending: currentRows.length,
          serving: currentRows.length > 0,
        },
      };
    })
    .sort((a, b) => a.agent_name.localeCompare(b.agent_name));
}

export function buildTabulationsReport(
  rows: ConversationFact[],
  range: ReportRange,
  tags: TagRow[],
) {
  const closed = rows.filter((row) => inRange(row.closed_at, range));
  const tagged = closed.filter((row) => row.outcome_tag_id);
  const counts = new Map<string, number>();

  for (const row of tagged) {
    const id = row.outcome_tag_id as string;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  const tagById = new Map(tags.map((tag) => [tag.id, tag]));
  const total = tagged.length;
  const items = [...counts.entries()]
    .map(([id, count]) => {
      const tag = tagById.get(id);
      return {
        tabulation_id: id,
        code: tag?.codigo_tabulacao ?? null,
        name: tag?.name ?? 'Tabulação removida',
        count,
        percentage: total > 0 ? Math.round((count / total) * 10_000) / 100 : 0,
      };
    })
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return {
    total_closed: closed.length,
    total_tabulated: total,
    without_tabulation: closed.length - total,
    distinct_used: items.length,
    items,
  };
}
