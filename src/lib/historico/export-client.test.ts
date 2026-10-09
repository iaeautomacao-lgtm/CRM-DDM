import { describe, expect, it } from "vitest";
import { buildHistoryExportBody, isExportActive } from "./export-client";

describe("export-client", () => {
  it("transforma De/Até inclusivos em intervalo com fim exclusivo", () => {
    const r = buildHistoryExportBody("2026-10-01", "2026-10-01", null);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const ms = Date.parse(r.body.period_to) - Date.parse(r.body.period_from);
      expect(ms).toBeGreaterThanOrEqual(23 * 3_600_000);
      expect(ms).toBeLessThanOrEqual(25 * 3_600_000);
      expect(r.body.tabulacao_id).toBeUndefined();
    }
  });

  it("inclui a tabulação só quando informada", () => {
    const r = buildHistoryExportBody("2026-10-01", "2026-10-07", "11111111-1111-1111-1111-111111111111");
    expect(r.ok && r.body.tabulacao_id).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("recusa datas vazias, invertidas e janelas acima de 366 dias", () => {
    expect(buildHistoryExportBody("", "2026-10-01", null).ok).toBe(false);
    expect(buildHistoryExportBody("2026-10-05", "2026-10-01", null).ok).toBe(false);
    expect(buildHistoryExportBody("2025-01-01", "2026-10-01", null).ok).toBe(false);
  });

  it("só consulta de novo enquanto está na fila ou gerando", () => {
    expect(isExportActive("pending")).toBe(true);
    expect(isExportActive("running")).toBe(true);
    expect(isExportActive("done")).toBe(false);
    expect(isExportActive("failed")).toBe(false);
  });
});
