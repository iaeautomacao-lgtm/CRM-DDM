// Atribuição de quem fechou/pagou (decisão do dono, 14/10): olha a conversa do contato ENTRE o envio e o evento. PURO.
//   - o contato não escreveu                              → 'direto' (clicou e fechou sozinho);
//   - o contato escreveu e algum atendente HUMANO atendeu  → 'humano', com o último atendente que respondeu (humano vence IA; último toque);
//   - o contato escreveu e só a IA / fluxo respondeu       → 'ia';
//   - o contato escreveu e ninguém respondeu               → 'direto'.
// Mensagens do próprio disparo (origin 'campaign') e do cliente não são "resposta". Origem 'flow' (fluxo/Fluxo-IA) e 'ai' contam como IA:
// o catálogo de origem não separa fluxo com IA de fluxo sem IA, então toda resposta automática da conversa entra como 'ia'.
export type Attribution = "direto" | "ia" | "humano";

export interface AttributionMessage {
  sender_type: string | null;
  origin?: string | null;
  sender_id?: string | null;
  created_at: string;
}

export interface AttributionResult {
  atribuicao: Attribution;
  atendenteId: string | null;
}

const isCustomer = (m: AttributionMessage) => m.sender_type === "customer";
// Humano: origem 'operator' (e linhas antigas sem origem de um atendente com id).
const isHuman = (m: AttributionMessage) => m.sender_type === "agent" && (m.origin === "operator" || (!m.origin && !!m.sender_id));
const isAutomatic = (m: AttributionMessage) => m.origin === "ai" || m.origin === "flow" || m.sender_type === "bot";

export function computeAttribution(messages: readonly AttributionMessage[], from: Date, to: Date): AttributionResult {
  const lo = from.getTime();
  const hi = to.getTime();
  const inRange = messages
    .filter((m) => {
      const t = new Date(m.created_at).getTime();
      return t > lo && t <= hi;
    })
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  if (!inRange.some(isCustomer)) return { atribuicao: "direto", atendenteId: null };

  const humans = inRange.filter(isHuman);
  if (humans.length > 0) return { atribuicao: "humano", atendenteId: humans[humans.length - 1].sender_id ?? null };
  if (inRange.some(isAutomatic)) return { atribuicao: "ia", atendenteId: null };
  return { atribuicao: "direto", atendenteId: null };
}
