// Conversa reservada por menção (@operador, migration 376): o cliente escreveu "@apelido" e a conversa espera aquele
// operador (conversations.requested_agent_id). O banco zera a reserva sozinho quando alguém assume ou a conversa fecha,
// então "reservada" é só requested_agent_id != null — sem condição extra no front.
// Aqui só se monta o texto do selo (lista e cabeçalho); quem vê a conversa é decidido pelo servidor (RLS).

export interface ReservedAgentInfo {
  user_id: string;
  full_name: string | null;
  mention_alias: string | null;
}

export interface ReservationBadge {
  /** Texto curto do selo: "Aguardando @apelido" ou, para o próprio operador, "Cliente pediu você". */
  label: string;
  /** Tooltip com o nome do operador reservado. */
  title: string;
  /** O operador reservado é quem está logado: o selo ganha destaque. */
  mine: boolean;
}

export interface ReservationSource {
  requested_agent_id?: string | null;
  /** Vem pronto do GET /api/inbox/conversations; no Realtime só chega o id. */
  requested_agent?: ReservedAgentInfo | null;
}

export type ReservedAgentLookup = (userId: string) => { name: string | null; alias: string | null } | undefined;

function firstName(name: string | null): string | null {
  const first = name?.trim().split(/\s+/)[0];
  return first ? first : null;
}

export function reservationBadge(
  conversation: ReservationSource,
  myUserId: string | null | undefined,
  lookup?: ReservedAgentLookup,
): ReservationBadge | null {
  const agentId = conversation.requested_agent_id ?? null;
  if (!agentId) return null;

  // O objeto pronto só vale se ainda for do operador do id atual (a reserva pode ter mudado por Realtime).
  const embedded = conversation.requested_agent?.user_id === agentId ? conversation.requested_agent : null;
  const found = embedded ? { name: embedded.full_name, alias: embedded.mention_alias } : lookup?.(agentId);
  const name = found?.name?.trim() || null;
  const alias = found?.alias?.trim() || null;
  const mine = myUserId != null && agentId === myUserId;

  if (mine) {
    return {
      label: "Cliente pediu você",
      title: alias ? `O cliente pediu você (@${alias}). Assuma a conversa para atender.` : "O cliente pediu você. Assuma a conversa para atender.",
      mine: true,
    };
  }
  const who = name ?? "um operador";
  return {
    label: alias ? `Aguardando @${alias}` : `Aguardando ${firstName(name) ?? "operador"}`,
    title: `Reservada para ${who}${alias ? ` (@${alias})` : ""}: o cliente pediu este operador`,
    mine: false,
  };
}
