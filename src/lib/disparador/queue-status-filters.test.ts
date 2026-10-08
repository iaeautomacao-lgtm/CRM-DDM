import { describe, expect, it } from "vitest";
import {
  QUEUE_DETAIL_STATUS_FILTERS,
  PENDING_CONFIRMATION_OR_FILTER,
  PENDING_CONFIRMATION_QUEUE_DETAIL_KEY,
  REPLIED_QUEUE_DETAIL_KEY,
} from "./queue-status-filters";

describe("queue detail status filters", () => {
  it("keeps paused and in-flight contacts in A enviar", () => {
    expect(QUEUE_DETAIL_STATUS_FILTERS.agendado).toEqual([
      "agendado",
      "pendente",
      "pausado",
      "enviando",
    ]);
  });

  it("keeps sent KPI semantics unchanged", () => {
    expect(QUEUE_DETAIL_STATUS_FILTERS.enviado).toEqual([
      "enviado",
      "entregue",
      "lido",
    ]);
    expect(REPLIED_QUEUE_DETAIL_KEY).toBe("respondido");
  });

  it("separa itens que ainda aguardam confirmação final", () => {
    expect(PENDING_CONFIRMATION_QUEUE_DETAIL_KEY).toBe("aguardando_confirmacao");
    expect(QUEUE_DETAIL_STATUS_FILTERS.aguardando_confirmacao).toEqual([
      "enviando",
      "enviado",
    ]);
    expect(PENDING_CONFIRMATION_OR_FILTER).toBe(
      "and(status.eq.enviando,waha_message_id.not.is.null),and(status.eq.enviado,entrega_pendente_131026.eq.true)"
    );
  });
});
