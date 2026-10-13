import { describe, expect, it } from "vitest";
import { buildReportRpcParams, exportDateRange, toReportExportRows } from "./report-export";

const NOW = new Date(2026, 9, 13, 15, 0, 0); // 13/10/2026 local

describe("exportDateRange", () => {
  it("hoje, 7d, 30d e todas", () => {
    expect(exportDateRange("hoje", null, NOW)).toEqual({ dateFrom: "2026-10-13", dateTo: "2026-10-13" });
    expect(exportDateRange("7d", null, NOW).dateFrom).toBe("2026-10-06");
    expect(exportDateRange("30d", null, NOW).dateFrom).toBe("2026-09-13");
    expect(exportDateRange("todas", null, NOW).dateFrom).toBe("2000-01-01");
  });
  it("personalizado usa as datas, com pontas vazias abertas", () => {
    expect(exportDateRange("custom", { from: "2026-10-01", to: "2026-10-05" }, NOW)).toEqual({ dateFrom: "2026-10-01", dateTo: "2026-10-05" });
    expect(exportDateRange("custom", { from: "", to: "" }, NOW).dateFrom).toBe("2000-01-01");
  });
});

describe("buildReportRpcParams", () => {
  const base = { accountId: "acc", period: "todas" as const, range: null, search: "  ana " };
  it("encerradas: escopo closed e status closed", () => {
    const { rpc } = buildReportRpcParams({ ...base, status: "closed" });
    expect(rpc).toMatchObject({ p_scope: "closed", p_status: "closed", p_search: "ana", p_limit: 9999, p_offset: 0 });
  });
  it("todas: escopo created e sem status", () => {
    const { rpc } = buildReportRpcParams({ ...base, status: "all", search: "" });
    expect(rpc).toMatchObject({ p_scope: "created", p_status: null, p_search: null });
  });
});

describe("toReportExportRows", () => {
  it("mantém as colunas do relatório antigo", () => {
    const [row] = toReportExportRows([
      {
        conversation_id: "1", contact_name: "Ana", contact_phone: "5511", waha_session: null, status: "closed",
        agent_name: "Bia", team_name: null, started_at: "2026-10-01T12:00:00", ended_at: null, message_count: "7",
      },
    ]);
    expect(row).toMatchObject({ contato: "Ana", canal: "Meta/Webchat", status: "Encerrado", equipe: "", encerradoEm: "", mensagens: 7 });
  });
});
