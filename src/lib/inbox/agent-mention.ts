// Deterministic, account-scoped handoff command from a customer message.
// A mention must be at the beginning of the message; incidental @mentions
// inside ordinary conversation never trigger a transfer.
export function mentionedAgentAlias(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = text.trim().match(/^@([a-z_][a-z0-9_]{1,31})(?=$|\s|[.,!?;:])/i);
  return match ? match[1].toLowerCase() : null;
}

// Formato do apelido gravado em profiles.mention_alias (CHECK da migration 376): 2 a 32 caracteres minúsculos, números ou _.
export const MENTION_ALIAS_RE = /^[a-z_][a-z0-9_]{1,31}$/;
