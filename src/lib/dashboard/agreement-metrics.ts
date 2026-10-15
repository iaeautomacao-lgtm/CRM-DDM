/**
 * Métricas de acordos do Dashboard V1.
 *
 * Fonte de verdade: conversas cujo desfecho atual é a tabulação
 * "Acordo Realizado" (codigo_tabulacao=142), não os negócios do funil.
 *
 * A origem é a pessoa/processo que REGISTROU essa tabulação na auditoria.
 * Não afirma quem negociou, e nunca infere a origem pelo último remetente.
 */
export interface AgreementConversation {
  id: string;
  outcome_tag_id: string;
  closed_at: string | null;
}

export interface AgreementAudit {
  id: string;
  resource_id: string;
  actor_type: string | null;
  created_at: string;
  changes: unknown;
}

export interface AgreementDashboardMetrics {
  total: number;
  ai: number;
  human: number;
  unknown: number;
  attributed: number;
  aiShareOfAttributed: number;
  attributionCoverage: number;
  closedToday: number;
  closedLast7Days: number;
  closedLast30Days: number;
}

function currentTagName(changes: unknown): string | null {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return null;
  const c = changes as Record<string, unknown>;
  const tagChange = c.outcome_tag_id;
  if (!tagChange || typeof tagChange !== "object" || Array.isArray(tagChange)) return null;
  const after = (tagChange as Record<string, unknown>).after;
  return typeof after === "string" ? after.trim().toLocaleLowerCase("pt-BR") : null;
}

function brasilDayKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (part: string) => parts.find((p) => p.type === part)?.value ?? "";
  return [value("year"), value("month"), value("day")].join("-");
}

export function summarizeAgreements(
  conversations: readonly AgreementConversation[],
  auditEvents: readonly AgreementAudit[],
  tagNamesById: ReadonlyMap<string, string>,
  now: Date = new Date(),
): AgreementDashboardMetrics {
  // Several audit rows can exist per conversation (retagged, reopened).
  // Choose the most recent event setting the CURRENT agreement tag.
  const latest = new Map<string, AgreementAudit>();
  for (const e of auditEvents) {
    // Ignore status/assignment updates: they are not evidence of who
    // registered the agreement (even if the operator closed the chat).
    if (!e.changes || typeof e.changes !== "object" || Array.isArray(e.changes)
      || !Object.prototype.hasOwnProperty.call(e.changes, "outcome_tag_id")) continue;
    const prior = latest.get(e.resource_id);
    if (!prior || Date.parse(e.created_at) > Date.parse(prior.created_at)
      || (e.created_at === prior.created_at && e.id > prior.id)) {
      latest.set(e.resource_id, e);
    }
  }

  let ai = 0;
  let human = 0;
  let unknown = 0;
  let closedToday = 0;
  let closedLast7Days = 0;
  let closedLast30Days = 0;

  const nowMs = now.getTime();
  const dayKey = brasilDayKey(now);

  for (const conversation of conversations) {
    const event = latest.get(conversation.id);
    const expected = tagNamesById.get(conversation.outcome_tag_id)?.trim().toLocaleLowerCase("pt-BR");

    // Audit stores the label, not the tag UUID. If that label was
    // renamed or there is no audit, leave the origin unclassified.
    const tagMatches = !!expected && currentTagName(event?.changes) === expected;
    if (tagMatches && event?.actor_type === "ai") ai++;
    else if (tagMatches && event?.actor_type === "user") human++;
    else unknown++;

    // Closure metrics are based on the conversation's close time,
    // never on the timestamp of an AI guess or on updated_at.
    if (conversation.closed_at) {
      const closed = new Date(conversation.closed_at);
      const ms = closed.getTime();
      if (!Number.isFinite(ms) || ms > nowMs) continue;
      if (brasilDayKey(closed) === dayKey) closedToday++;
      if (ms >= nowMs - 7 * 86_400_000) closedLast7Days++;
      if (ms >= nowMs - 30 * 86_400_000) closedLast30Days++;
    }
  }

  const total = conversations.length;
  const attributed = ai + human;
  return {
    total, ai, human, unknown, attributed,
    aiShareOfAttributed: attributed ? Math.round((ai / attributed) * 100) : 0,
    attributionCoverage: total ? Math.round((attributed / total) * 100) : 0,
    closedToday, closedLast7Days, closedLast30Days,
  };
}
