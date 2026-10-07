import { describe, expect, it } from "vitest";
import {
  channelOptionState,
  channelsForTeam,
  filterTemplatesForTeam,
  inferTeamFromChannels,
  keepChannelsInTeam,
  type WizardChannel,
} from "./channel-filter";

const metaA1: WizardChannel = { id: "a1", provider: "meta", waba_id: "waba-a", habilitado: true, team_id: "t1" };
const metaA2: WizardChannel = { id: "a2", provider: "meta", waba_id: "waba-a", habilitado: true, team_id: "t2" };
const metaB: WizardChannel = { id: "b1", provider: "meta", waba_id: "waba-b", habilitado: true, team_id: "t1" };
const metaSemWaba: WizardChannel = { id: "x1", provider: "meta", waba_id: null, habilitado: true, team_id: "t1" };
const waha1: WizardChannel = { id: "w1", provider: "waha", habilitado: true, team_id: "t1" };
const wahaOff: WizardChannel = { id: "w2", provider: "waha", habilitado: false, team_id: "t1" };
const all = [metaA1, metaA2, metaB, metaSemWaba, waha1, wahaOff];

describe("channelsForTeam / keepChannelsInTeam", () => {
  it("só habilitados, filtrados pela equipe", () => {
    expect(channelsForTeam(all, "").map((c) => c.id)).toEqual(["a1", "a2", "b1", "x1", "w1"]);
    expect(channelsForTeam(all, "t2").map((c) => c.id)).toEqual(["a2"]);
  });

  it("trocar a equipe tira da seleção os canais de fora (e os desabilitados)", () => {
    expect(keepChannelsInTeam(["a1", "a2"], all, "t1")).toEqual(["a1"]);
    expect(keepChannelsInTeam(["w1", "w2"], all, "")).toEqual(["w1"]);
  });

  it("inferTeamFromChannels: equipe comum ou vazio", () => {
    expect(inferTeamFromChannels(["a1", "b1"], all)).toBe("t1");
    expect(inferTeamFromChannels(["a1", "a2"], all)).toBe("");
    expect(inferTeamFromChannels([], all)).toBe("");
  });
});

describe("channelOptionState", () => {
  it("nada selecionado: tudo liberado, menos Meta sem WABA", () => {
    expect(channelOptionState(waha1, [], all).disabled).toBe(false);
    expect(channelOptionState(metaA1, [], all).disabled).toBe(false);
    const semWaba = channelOptionState(metaSemWaba, [], all);
    expect(semWaba.disabled && semWaba.reason).toMatch(/sem conta WhatsApp Business/);
  });

  it("um provedor por campanha", () => {
    const r = channelOptionState(waha1, ["a1"], all);
    expect(r.disabled && r.reason).toMatch(/já usa número oficial/);
    const r2 = channelOptionState(metaA1, ["w1"], all);
    expect(r2.disabled && r2.reason).toMatch(/já usa sessão WAHA/);
  });

  it("Meta: uma WABA só; mesmo WABA liberado; selecionado sempre liberado", () => {
    expect(channelOptionState(metaA2, ["a1"], all).disabled).toBe(false);
    const r = channelOptionState(metaB, ["a1"], all);
    expect(r.disabled && r.reason).toMatch(/outra conta WhatsApp Business/);
    expect(channelOptionState(metaB, ["a1", "b1"], all).disabled).toBe(false);
  });
});

describe("filterTemplatesForTeam", () => {
  const tpls = [{ id: "1" }, { id: "2" }, { id: "3" }];
  it("sem restrição = todos; com restrição = só os liberados", () => {
    expect(filterTemplatesForTeam(tpls, null)).toHaveLength(3);
    expect(filterTemplatesForTeam(tpls, new Set())).toHaveLength(3);
    expect(filterTemplatesForTeam(tpls, new Set(["2"]))).toEqual([{ id: "2" }]);
  });
});
