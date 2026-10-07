import { describe, expect, it } from "vitest";
import {
  QUEUE_DETAIL_STATUS_FILTERS,
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
});
