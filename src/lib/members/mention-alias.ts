// Apelido @operador: o cliente escreve @apelido no início da mensagem e a
// conversa vai para a fila de espera daquele operador. A validação aqui é a
// mesma do servidor (PATCH /api/account/members/:userId, campo mention_alias);
// o servidor continua sendo quem decide.

export const MENTION_ALIAS_REGEX = /^[a-z_][a-z0-9_]{1,31}$/;

export const MENTION_ALIAS_RULE =
  "Use de 2 a 32 caracteres: letras sem acento, números ou _ (não pode começar com número).";

export type ParsedMentionAlias =
  | { ok: true; alias: string | null }
  | { ok: false; message: string };

/** Normaliza o texto digitado (tira espaços e @, minúsculas); vazio remove o apelido. */
export function parseMentionAlias(raw: string): ParsedMentionAlias {
  const alias = raw.trim().replace(/^@/, "").toLowerCase();
  if (alias === "") return { ok: true, alias: null };
  if (!MENTION_ALIAS_REGEX.test(alias)) return { ok: false, message: MENTION_ALIAS_RULE };
  return { ok: true, alias };
}

/** Mensagem para o resultado do PATCH: 409 = apelido já usado por outro operador da conta. */
export function mentionAliasErrorMessage(status: number, serverMessage?: string | null): string {
  if (status === 409) return "Esse apelido já está em uso por outro operador desta conta.";
  if (status === 403) return "Você não tem permissão para editar apelidos.";
  return serverMessage || "Não foi possível salvar o apelido.";
}
