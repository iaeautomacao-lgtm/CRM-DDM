import { describe, expect, it } from "vitest";
import { errorItemsHref, formatEtaPt, timeAgoPt } from "./monitor-format";
import { isTabActive } from "@/components/disparador/disparador-tabs";

describe("monitor-format", () => {
  it("formata ETA em português", () => {
    expect(formatEtaPt(null)).toBe("sem ritmo");
    expect(formatEtaPt(0)).toBe("concluído");
    expect(formatEtaPt(0.4)).toBe("menos de 1 min");
    expect(formatEtaPt(35)).toBe("35 min");
    expect(formatEtaPt(130)).toBe("2 h 10 min");
    expect(formatEtaPt(27 * 60)).toBe("1 d 3 h");
  });

  it("formata tempo decorrido", () => {
    expect(timeAgoPt(2)).toBe("agora");
    expect(timeAgoPt(30)).toBe("há 30 s");
    expect(timeAgoPt(180)).toBe("há 3 min");
    expect(timeAgoPt(null)).toBe("—");
  });

  it("monta o link da lista filtrada por código", () => {
    expect(errorItemsHref("abc", 131026)).toBe("/disparador/campanhas/abc?status=erro&codigo=131026");
    expect(errorItemsHref("abc", null)).toBe("/disparador/campanhas/abc?status=erro");
  });

  it("marca a aba ativa", () => {
    expect(isTabActive("/disparador/monitor", "/disparador/monitor")).toBe(true);
    expect(isTabActive("/disparador/campanhas/x", "/disparador/campanhas")).toBe(true);
    expect(isTabActive("/disparador/monitoring", "/disparador/monitor")).toBe(false);
    expect(isTabActive(null, "/disparador/monitor")).toBe(false);
  });
});
