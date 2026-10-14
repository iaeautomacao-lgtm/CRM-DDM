"use client";

import { StatusChip, type StatusTone } from "@/components/ddm/status-chip";
import { useUtmpayData } from "@/hooks/use-utmpay-data";
import {
  ATRIBUICAO_LABEL,
  ETAPA_LABEL,
  etapaDoRastreio,
  fetchContactRastreio,
  fetchConversationRastreio,
  fmtMoney,
  type Etapa,
  type Rastreio,
} from "@/lib/utmpay/api-client";

const ETAPA_TONE: Record<Etapa, StatusTone> = { pagou: "ok", fechou: "brand", clicou: "info", enviado: "mute" };

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** Selo do rastreio: Clicou → Fechou acordo → Pagou (o mais avançado), quem fechou e a situação do acordo. */
export function TrackingBadges({ rastreio, className }: { rastreio: Rastreio; className?: string }) {
  const etapa = etapaDoRastreio(rastreio);
  const quando = etapa === "pagou" ? rastreio.pagou_em : etapa === "fechou" ? rastreio.fechou_em : etapa === "clicou" ? rastreio.clicou_em : rastreio.enviado_em;
  const valor = fmtMoney(rastreio.valor_em_aberto);
  const detalhes = [
    rastreio.situacao_acordo ? `Situação do acordo: ${rastreio.situacao_acordo}` : null,
    valor ? `Em aberto: ${valor}` : null,
    rastreio.instituicao,
  ].filter(Boolean);

  return (
    <div className={className} aria-label="Rastreio do link">
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusChip tone={ETAPA_TONE[etapa]} title={quando ? `${ETAPA_LABEL[etapa]} em ${fmtDate(quando)}` : undefined}>
          {ETAPA_LABEL[etapa]}
        </StatusChip>
        {rastreio.atribuicao && (etapa === "fechou" || etapa === "pagou") && (
          <StatusChip tone="mute" dot={false}>
            {ATRIBUICAO_LABEL[rastreio.atribuicao]}
            {rastreio.atribuicao === "humano" && rastreio.atendente_nome ? ` · ${rastreio.atendente_nome}` : ""}
          </StatusChip>
        )}
      </div>
      {(rastreio.campanha || detalhes.length > 0) && (
        <p className="mt-1 text-[12px] leading-snug text-muted-foreground">
          {rastreio.campanha ? `Campanha ${rastreio.campanha}` : null}
          {rastreio.campanha && detalhes.length > 0 ? " · " : null}
          {detalhes.join(" · ")}
        </p>
      )}
    </div>
  );
}

function useBadge(key: string | null, fetcher: (id: string) => Promise<Rastreio | null>) {
  const { state } = useUtmpayData<Rastreio | null>(key, fetcher);
  // Selo é informação extra: sem permissão, sem UTMpay ou com erro, simplesmente não aparece.
  return state?.status === "ready" ? state.data : null;
}

/** Selo na conversa aberta (GET /api/conversations/[id]/utmpay). Some se não houver link rastreado. */
export function ConversationTrackingBadge({ conversationId, className }: { conversationId: string | null; className?: string }) {
  const r = useBadge(conversationId, fetchConversationRastreio);
  return r ? <TrackingBadges rastreio={r} className={className} /> : null;
}

/** Selo na tela do contato (GET /api/contacts/[id]/utmpay). */
export function ContactTrackingBadge({ contactId, className }: { contactId: string | null; className?: string }) {
  const r = useBadge(contactId, fetchContactRastreio);
  return r ? <TrackingBadges rastreio={r} className={className} /> : null;
}
