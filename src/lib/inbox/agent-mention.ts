// Deterministic, account-scoped handoff command from a customer message.
// A mention must be at the beginning of the message; incidental @mentions
// inside ordinary conversation never trigger a transfer.
export function mentionedAgentAlias(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = text.trim().match(/^@([a-z_][a-z0-9_]{1,31})(?=$|\s|[.,!?;:])/i);
  return match ? match[1].toLowerCase() : null;
}
