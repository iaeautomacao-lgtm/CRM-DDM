// `${dateStr}T00:00:00` (no offset) sent straight to a TIMESTAMPTZ
// column gets interpreted in the DB session's timezone (UTC on
// Supabase), not the browser's local timezone — "today" in a date
// input can silently exclude rows near either boundary once local and
// UTC dates diverge (e.g. after ~21h in UTC-3). Parsing as a local
// Date first and calling toISOString() converts to the correct UTC
// instant, so the comparison is unambiguous regardless of DB session tz.
export function startOfDayIso(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00`).toISOString();
}

export function endOfDayIso(dateStr: string): string {
  return new Date(`${dateStr}T23:59:59.999`).toISOString();
}
