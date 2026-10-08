import { describe, expect, it } from "vitest";
import {
  loadOutcomeTagsForConversation,
  preselectedOutcomeTagId,
  suggestionSourceLabel,
  type OutcomeSuggestionView,
} from "./outcome-tags";
import { buildHumanClosePatch, suggestionVerdict } from "./outcome";
import { fakeRowsDb } from "./__tests__/fake-rows-db";

const TAGS = [{ id: "a" }, { id: "b" }];
const s = (over: Partial<OutcomeSuggestionView>): OutcomeSuggestionView => ({
  tag_id: "a",
  tag_name: "A",
  codigo_tabulacao: 142,
  confidence: 0.9,
  motivo: "",
  source: "llm",
  ...over,
});

describe("preselectedOutcomeTagId", () => {
  it("sem sugestão => nada marcado", () => {
    expect(preselectedOutcomeTagId(TAGS, null)).toBeNull();
  });

  it("sugestão do fluxo é sempre pré-selecionada", () => {
    expect(preselectedOutcomeTagId(TAGS, s({ source: "exit_tag", confidence: 0.1 }))).toBe("a");
  });

  it("LLM só com confiança suficiente", () => {
    expect(preselectedOutcomeTagId(TAGS, s({ confidence: 0.6 }))).toBe("a");
    expect(preselectedOutcomeTagId(TAGS, s({ confidence: 0.59 }))).toBeNull();
  });

  it("tag fora da lista exibida (filtro de equipe) não é marcada", () => {
    expect(preselectedOutcomeTagId(TAGS, s({ tag_id: "z", source: "exit_tag" }))).toBeNull();
  });
});

describe("suggestionSourceLabel", () => {
  it("Fluxo para exit_tag, IA para o resto", () => {
    expect(suggestionSourceLabel("exit_tag")).toBe("Fluxo");
    expect(suggestionSourceLabel("llm")).toBe("IA");
    expect(suggestionSourceLabel("rule")).toBe("IA");
  });
});

describe("loadOutcomeTagsForConversation", () => {
  const tables = () => ({
    tags: [
      { id: "t1", account_id: "acc", kind: "outcome", name: "B" },
      { id: "t2", account_id: "acc", kind: "outcome", name: "A" },
      { id: "t3", account_id: "acc", kind: "label", name: "C" },
    ],
    team_outcome_tags: [{ team_id: "team-x", tag_id: "t1" }],
  });

  it("sem equipe: todas as tags de desfecho da conta, por nome", async () => {
    const { db } = fakeRowsDb(tables());
    expect((await loadOutcomeTagsForConversation(db, "acc", null)).map((t) => t.id)).toEqual(["t2", "t1"]);
  });

  it("equipe com mapeamento: só as mapeadas", async () => {
    const { db } = fakeRowsDb(tables());
    expect((await loadOutcomeTagsForConversation(db, "acc", "team-x")).map((t) => t.id)).toEqual(["t1"]);
  });

  it("equipe sem mapeamento: todas", async () => {
    const { db } = fakeRowsDb(tables());
    expect((await loadOutcomeTagsForConversation(db, "acc", "team-y")).map((t) => t.id)).toEqual(["t2", "t1"]);
  });
});

describe("fechamento humano", () => {
  it("suggestionVerdict", () => {
    expect(suggestionVerdict(null, "a")).toBe("no_suggestion");
    expect(suggestionVerdict("a", "a")).toBe("accepted");
    expect(suggestionVerdict("a", "b")).toBe("changed");
  });

  it("buildHumanClosePatch grava procedência humana e não toca na sugestão", () => {
    const patch = buildHumanClosePatch({ outcomeTagId: "t", userId: "u", assignedAgentId: null, now: "2026-10-06T00:00:00Z" });
    expect(patch).toEqual({
      status: "closed",
      outcome_tag_id: "t",
      outcome_source: "human",
      outcome_set_by: "u",
      outcome_set_at: "2026-10-06T00:00:00Z",
      assigned_agent_id: "u",
    });
    expect(Object.keys(patch).some((k) => k.startsWith("suggest") || k.startsWith("outcome_suggest"))).toBe(false);
    expect(buildHumanClosePatch({ outcomeTagId: "t", userId: "u", assignedAgentId: "other" }).assigned_agent_id).toBeUndefined();
  });
});
