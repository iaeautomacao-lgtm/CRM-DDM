import { describe, expect, it } from 'vitest';

import {
  aggregatePeriodMetrics,
  buildCurrentSnapshot,
  buildTabulationsReport,
  parseReportQuery,
  type ConversationFact,
  type ReportingRoster,
} from './reporting';

const range = parseReportQuery(
  'https://crm.test/api/v1/reports/operations/summary?from=2026-10-01&to=2026-10-02',
  true,
).range!;

function fact(overrides: Partial<ConversationFact> = {}): ConversationFact {
  return {
    id: 'c1',
    status: 'open',
    team_id: '11111111-1111-4111-8111-111111111111',
    assigned_agent_id: null,
    created_at: '2026-10-01T13:00:00.000Z',
    first_response_at: null,
    closed_at: null,
    outcome_tag_id: null,
    ...overrides,
  };
}

const roster: ReportingRoster = {
  teams: [{ id: '11111111-1111-4111-8111-111111111111', name: 'Cobrança' }],
  teamMembers: [
    {
      team_id: '11111111-1111-4111-8111-111111111111',
      user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    },
  ],
  profiles: [
    {
      user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      full_name: 'Ana',
      account_role: 'agent',
    },
  ],
  presence: [
    {
      user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      status: 'online',
      last_seen_at: '2026-10-02T15:00:00.000Z',
    },
  ],
};

describe('parseReportQuery', () => {
  it('uses inclusive Brasília calendar dates and validates UUID filters', () => {
    const parsed = parseReportQuery(
      'https://crm.test/api/v1/reports/teams?from=2026-10-01&to=2026-10-01&team_id=11111111-1111-4111-8111-111111111111',
      true,
    );
    expect(parsed.range?.fromIso).toBe('2026-10-01T03:00:00.000Z');
    expect(parsed.range?.toExclusiveIso).toBe('2026-10-02T03:00:00.000Z');
    expect(parsed.filters.teamId).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('rejects invalid ranges', () => {
    expect(() =>
      parseReportQuery(
        'https://crm.test/api/v1/reports/teams?from=2026-10-05&to=2026-10-01',
        true,
      ),
    ).toThrow();
  });
});

describe('current operational snapshot', () => {
  it('separates navigating, waiting and attending and derives presence', () => {
    const snapshot = buildCurrentSnapshot(
      [
        fact({ id: 'nav', status: 'open' }),
        fact({ id: 'wait', status: 'pending' }),
        fact({
          id: 'att-pending',
          status: 'pending',
          assigned_agent_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        }),
        fact({
          id: 'att-open',
          status: 'open',
          assigned_agent_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        }),
      ],
      roster,
      {},
      Date.parse('2026-10-02T15:00:30.000Z'),
    );

    expect(snapshot.conversations).toEqual({
      total_active: 4,
      navigating: 1,
      waiting: 1,
      attending: 2,
    });
    expect(snapshot.operators.online).toBe(1);
    expect(snapshot.operators.serving).toBe(1);
    expect(snapshot.teams[0].conversations.attending).toBe(1);
  });
});

describe('historical reporting', () => {
  it('counts received, attended, closed and tabulations independently', () => {
    const metrics = aggregatePeriodMetrics(
      [
        fact({
          id: 'closed',
          assigned_agent_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          first_response_at: '2026-10-01T13:01:00.000Z',
          closed_at: '2026-10-01T13:10:00.000Z',
          status: 'closed',
          outcome_tag_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        }),
        fact({
          id: 'open',
          created_at: '2026-10-02T14:00:00.000Z',
        }),
      ],
      range,
    );

    expect(metrics.received).toBe(2);
    expect(metrics.attended).toBe(1);
    expect(metrics.closed).toBe(1);
    expect(metrics.tabulated).toBe(1);
    expect(metrics.unique_operators).toBe(1);
    expect(metrics.avg_first_response_seconds).toBe(60);
    expect(metrics.avg_resolution_seconds).toBe(600);
    expect(metrics.avg_service_seconds).toBe(540);
  });

  it('counts events independently when a conversation started before the period', () => {
    const metrics = aggregatePeriodMetrics(
      [
        fact({
          id: 'cross-boundary',
          created_at: '2026-09-30T23:00:00.000Z',
          first_response_at: '2026-10-01T13:00:00.000Z',
          closed_at: '2026-10-01T14:00:00.000Z',
          status: 'closed',
        }),
      ],
      range,
    );

    expect(metrics.received).toBe(0);
    expect(metrics.attended).toBe(1);
    expect(metrics.closed).toBe(1);
    expect(metrics.avg_first_response_seconds).toBe(50_400);
    expect(metrics.avg_resolution_seconds).toBe(54_000);
    expect(metrics.avg_service_seconds).toBe(3_600);
  });

  it('groups outcome tags and reports percentage of tabulated closures', () => {
    const tagId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const result = buildTabulationsReport(
      [
        fact({ id: 'a', status: 'closed', closed_at: '2026-10-01T15:00:00.000Z', outcome_tag_id: tagId }),
        fact({ id: 'b', status: 'closed', closed_at: '2026-10-01T16:00:00.000Z', outcome_tag_id: tagId }),
        fact({ id: 'c', status: 'closed', closed_at: '2026-10-01T17:00:00.000Z' }),
      ],
      range,
      [{ id: tagId, name: 'Acordo Realizado', codigo_tabulacao: 142 }],
    );

    expect(result.total_closed).toBe(3);
    expect(result.total_tabulated).toBe(2);
    expect(result.without_tabulation).toBe(1);
    expect(result.items[0]).toMatchObject({
      name: 'Acordo Realizado',
      code: 142,
      count: 2,
      percentage: 100,
    });
  });
});
