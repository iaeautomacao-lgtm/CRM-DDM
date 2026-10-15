import { describe, expect, it } from "vitest";
import type { Pause } from "./pause";
import { PAUSE_EXPORT_COLUMNS, toPauseExportRows } from "./report-export";

const base: Pause = {
  id: "p1",
  user_id: "u1",
  user_name: "Ana",
  reason_id: "r1",
  reason_name: "Almoço",
  max_minutes: 60,
  started_at: "2026-10-15T15:00:00.000Z",
  ended_at: "2026-10-15T16:30:00.000Z",
  end_kind: "manual",
  started_by: "u1",
  by_supervisor: false,
  ended_by: "u1",
  alerted_at: null,
  elapsed_seconds: 5400,
  exceeded: true,
};

describe("toPauseExportRows", () => {
  it("gera uma linha por pausa com as colunas do relatório", () => {
    const [row] = toPauseExportRows([base]);
    expect(Object.keys(row).sort()).toEqual(PAUSE_EXPORT_COLUMNS.map((c) => c.key).sort());
    expect(row).toMatchObject({
      atendente: "Ana",
      motivo: "Almoço",
      limite: 60,
      duracao: "1 h 30",
      passouDoTempo: "Sim",
      quemPausou: "O próprio atendente",
      comoTerminou: "Voltou sozinho",
    });
  });
  it("pausa aberta, sem limite e aplicada por supervisor", () => {
    const [row] = toPauseExportRows([
      { ...base, ended_at: null, end_kind: null, max_minutes: null, exceeded: false, by_supervisor: true, started_by_name: "Carlos" },
    ]);
    expect(row).toMatchObject({ fim: "Em andamento", limite: "", passouDoTempo: "Não", quemPausou: "Carlos", comoTerminou: "Em andamento" });
  });
});
