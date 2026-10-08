import { describe, expect, it, vi } from "vitest";
import {
  buildOutcomeSuggestPrompt,
  parseOutcomeSuggestResponse,
  suggestOutcomeTag,
  type OutcomeTagOption,
} from "./tabulacao-suggest";
import { fakeRowsDb, type Tables } from "@/lib/conversations/__tests__/fake-rows-db";

const ACC = "acc-1";
const OTHER = "acc-2";

const TAGS: OutcomeTagOption[] = [
  { id: "tag-acordo", name: "Acordo Realizado", codigo_tabulacao: 142 },
  { id: "tag-recusa", name: "Recusa", codigo_tabulacao: 220 },
  { id: "tag-livre", name: "Tag sem código", codigo_tabulacao: null },
];

function tablesFor(): Tables {
  return {
    conversations: [
      { id: "conv-1", account_id: ACC, team_id: null, status: "open" },
      { id: "conv-team", account_id: ACC, team_id: "team-1", status: "open" },
      { id: "conv-foreign", account_id: OTHER, team_id: null, status: "open" },
    ],
    tags: [
      { id: "tag-acordo", account_id: ACC, kind: "outcome", name: "Acordo Realizado", codigo_tabulacao: 142 },
      { id: "tag-recusa", account_id: ACC, kind: "outcome", name: "Recusa", codigo_tabulacao: 220 },
      { id: "tag-label", account_id: ACC, kind: "label", name: "VIP", codigo_tabulacao: null },
      { id: "tag-foreign", account_id: OTHER, kind: "outcome", name: "Tag Secreta Outra Conta", codigo_tabulacao: 999 },
    ],
    team_outcome_tags: [{ team_id: "team-1", tag_id: "tag-recusa" }],
    messages: [
      { id: "m1", conversation_id: "conv-1", content_text: "Fechado, pode gerar o boleto", sender_type: "customer", created_at: "2026-10-01T10:00:00Z" },
      { id: "m2", conversation_id: "conv-team", content_text: "Não vou pagar", sender_type: "customer", created_at: "2026-10-01T10:00:00Z" },
    ],
  };
}

/**
 * userDb simula o RLS: só enxerga as linhas da conta do usuário (e as
 * conversas em `visibleConversationIds`). adminDb (service role) enxerga
 * tudo. As linhas de conversa são os MESMOS objetos nos dois — a escrita
 * do cache pelo admin aparece na próxima leitura do usuário.
 */
function setup(visibleConversationIds = ["conv-1", "conv-team"]) {
  const all = tablesFor();
  const userTables: Tables = {
    conversations: all.conversations.filter((c) => visibleConversationIds.includes(c.id as string)),
    tags: all.tags.filter((t) => t.account_id === ACC),
    team_outcome_tags: all.team_outcome_tags,
    messages: all.messages,
  };
  const user = fakeRowsDb(userTables);
  const admin = fakeRowsDb({
    ...all,
    ai_config: [{ account_id: ACC, api_provider: "claude", api_key: "sk-test", api_model: null }],
  });
  return { user, admin, all };
}

describe("parseOutcomeSuggestResponse", () => {
  it("aceita código numérico ou string", () => {
    expect(parseOutcomeSuggestResponse('{"codigo_tabulacao": 142, "confidence": 0.9, "reason": "ok"}', TAGS)?.tag.id).toBe("tag-acordo");
    expect(parseOutcomeSuggestResponse('```json\n{"codigo_tabulacao": "220", "confidence": 0.7, "reason": "x"}\n```', TAGS)?.tag.id).toBe("tag-recusa");
  });

  it("tag sem código usa o apelido t<n>", () => {
    expect(parseOutcomeSuggestResponse('{"codigo_tabulacao": "t3", "confidence": 0.6}', TAGS)?.tag.id).toBe("tag-livre");
  });

  it("'incerto', código desconhecido, JSON inválido ou confiança 0 => sem sugestão", () => {
    expect(parseOutcomeSuggestResponse('{"codigo_tabulacao": "incerto", "confidence": 0.9}', TAGS)).toBeNull();
    expect(parseOutcomeSuggestResponse('{"codigo_tabulacao": 999, "confidence": 0.9}', TAGS)).toBeNull();
    expect(parseOutcomeSuggestResponse("Acordo Realizado", TAGS)).toBeNull();
    expect(parseOutcomeSuggestResponse('{"codigo_tabulacao": 142, "confidence": 0}', TAGS)).toBeNull();
  });

  it("normaliza confiança em porcentagem", () => {
    expect(parseOutcomeSuggestResponse('{"codigo_tabulacao": 142, "confidence": 85}', TAGS)?.confidence).toBeCloseTo(0.85);
  });
});

describe("buildOutcomeSuggestPrompt", () => {
  it("lista as opções por código com nome e oferece 'incerto'", () => {
    const p = buildOutcomeSuggestPrompt(TAGS, "Cliente: oi");
    expect(p).toContain("- 142: Acordo Realizado");
    expect(p).toContain("- t3: Tag sem código");
    expect(p).toContain("incerto");
  });
});

describe("suggestOutcomeTag — acesso e tenant", () => {
  it("404 quando o usuário não enxerga a conversa (RLS)", async () => {
    const { user, admin } = setup(["conv-team"]);
    const callLlm = vi.fn();
    const res = await suggestOutcomeTag({ userDb: user.db, adminDb: admin.db, accountId: ACC, conversationId: "conv-1", callLlm });
    expect(res).toEqual({ status: "not_found" });
    expect(callLlm).not.toHaveBeenCalled();
  });

  it("404 para conversa de outra conta mesmo que o id exista", async () => {
    const { user, admin } = setup(["conv-1", "conv-foreign"]);
    const res = await suggestOutcomeTag({ userDb: user.db, adminDb: admin.db, accountId: ACC, conversationId: "conv-foreign", callLlm: vi.fn() });
    expect(res).toEqual({ status: "not_found" });
  });

  it("só oferece tags de desfecho da conta e usa o provider/modelo da conta", async () => {
    const { user, admin } = setup();
    const callLlm = vi.fn().mockResolvedValue('{"codigo_tabulacao": 142, "confidence": 0.92, "reason": "Cliente confirmou"}');
    const res = await suggestOutcomeTag({ userDb: user.db, adminDb: admin.db, accountId: ACC, conversationId: "conv-1", callLlm });

    expect(res).toEqual({
      status: "ok",
      suggestion: { tag_id: "tag-acordo", tag_name: "Acordo Realizado", codigo_tabulacao: 142, confidence: 0.92, motivo: "Cliente confirmou", source: "llm" },
    });
    const [provider, key, prompt, model] = callLlm.mock.calls[0];
    expect(provider).toBe("claude");
    expect(key).toBe("sk-test");
    expect(model).toBe("claude-sonnet-5-5");
    expect(prompt).not.toContain("Tag Secreta Outra Conta");
    expect(prompt).not.toContain("VIP");
    expect(prompt).toContain("Fechado, pode gerar o boleto");
  });

  it("service role não faz leitura de dado de atendimento (só ai_config + escrita do cache)", async () => {
    const { user, admin } = setup();
    const callLlm = vi.fn().mockResolvedValue('{"codigo_tabulacao": "incerto"}');
    await suggestOutcomeTag({ userDb: user.db, adminDb: admin.db, accountId: ACC, conversationId: "conv-1", callLlm });
    const adminReads = admin.log.filter((o) => o.type === "select").map((o) => o.table);
    expect(new Set(adminReads)).toEqual(new Set(["ai_config"]));
    const adminWrites = admin.log.filter((o) => o.type === "update");
    expect(adminWrites.every((o) => o.table === "conversations")).toBe(true);
    expect(adminWrites[0].filters).toEqual(
      expect.arrayContaining([
        ["eq", "id", "conv-1"],
        ["eq", "account_id", ACC],
      ]),
    );
    expect(user.log.map((o) => o.table)).toEqual(expect.arrayContaining(["conversations", "tags", "messages"]));
    expect(user.log.find((o) => o.table === "tags")!.filters).toContainEqual(["eq", "account_id", ACC]);
  });

  it("equipe com mapeamento em team_outcome_tags restringe as opções", async () => {
    const { user, admin } = setup();
    const callLlm = vi.fn().mockResolvedValue('{"codigo_tabulacao": 142, "confidence": 0.9}');
    const res = await suggestOutcomeTag({ userDb: user.db, adminDb: admin.db, accountId: ACC, conversationId: "conv-team", callLlm });
    const prompt = callLlm.mock.calls[0][2] as string;
    expect(prompt).toContain("- 220: Recusa");
    expect(prompt).not.toContain("Acordo Realizado");
    // 142 não está entre as opções da equipe => descartado.
    expect(res).toEqual({ status: "ok", suggestion: null });
  });

  it("falha da IA vira sugestão nula, nunca erro (e não entra no cache)", async () => {
    const { user, admin, all } = setup();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await suggestOutcomeTag({ userDb: user.db, adminDb: admin.db, accountId: ACC, conversationId: "conv-1", callLlm: vi.fn().mockRejectedValue(new Error("boom")) });
    expect(res).toEqual({ status: "ok", suggestion: null });
    expect(all.conversations[0].outcome_suggestion_key).toBeUndefined();
    err.mockRestore();
  });
});

describe("suggestOutcomeTag — fluxo e cache", () => {
  it("sugestão do fluxo (exit_tag) volta sem chamar o LLM", async () => {
    const { user, admin, all } = setup();
    Object.assign(all.conversations[0], {
      suggested_outcome_tag_id: "tag-acordo",
      outcome_suggestion_source: "exit_tag",
      outcome_suggestion_confidence: 1,
      outcome_suggestion_reason: "#ACORDOFORMALIZADO",
    });
    const callLlm = vi.fn();
    const res = await suggestOutcomeTag({ userDb: user.db, adminDb: admin.db, accountId: ACC, conversationId: "conv-1", callLlm });
    expect(callLlm).not.toHaveBeenCalled();
    expect(res).toMatchObject({ status: "ok", suggestion: { tag_id: "tag-acordo", source: "exit_tag", confidence: 1, motivo: "#ACORDOFORMALIZADO" } });
  });

  it("reabrir o picker sem mensagem nova usa o cache; mensagem nova recalcula", async () => {
    const { user, admin, all } = setup();
    const callLlm = vi.fn().mockResolvedValue('{"codigo_tabulacao": 142, "confidence": 0.8, "reason": "r"}');
    const deps = { userDb: user.db, adminDb: admin.db, accountId: ACC, conversationId: "conv-1", callLlm };

    const first = await suggestOutcomeTag(deps);
    expect(all.conversations[0]).toMatchObject({
      suggested_outcome_tag_id: "tag-acordo",
      outcome_suggestion_source: "llm",
      outcome_suggestion_key: "m1",
    });
    const second = await suggestOutcomeTag(deps);
    expect(callLlm).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);

    all.messages.push({ id: "m3", conversation_id: "conv-1", content_text: "Na verdade não", sender_type: "customer", created_at: "2026-10-01T11:00:00Z" });
    await suggestOutcomeTag(deps);
    expect(callLlm).toHaveBeenCalledTimes(2);
    expect(all.conversations[0].outcome_suggestion_key).toBe("m3");
  });

  it("'incerto' também é cacheado (sem nova chamada)", async () => {
    const { user, admin } = setup();
    const callLlm = vi.fn().mockResolvedValue('{"codigo_tabulacao": "incerto"}');
    const deps = { userDb: user.db, adminDb: admin.db, accountId: ACC, conversationId: "conv-1", callLlm };
    expect(await suggestOutcomeTag(deps)).toEqual({ status: "ok", suggestion: null });
    expect(await suggestOutcomeTag(deps)).toEqual({ status: "ok", suggestion: null });
    expect(callLlm).toHaveBeenCalledTimes(1);
  });

  it("cache do LLM nunca sobrescreve a sugestão do fluxo", async () => {
    const { user, admin, all } = setup(["conv-team"]);
    // Sugestão do fluxo com tag fora da lista da equipe => cai no LLM,
    // mas a escrita do cache não pode apagar a do fluxo.
    Object.assign(all.conversations[1], {
      suggested_outcome_tag_id: "tag-acordo",
      outcome_suggestion_source: "exit_tag",
    });
    const callLlm = vi.fn().mockResolvedValue('{"codigo_tabulacao": 220, "confidence": 0.7}');
    await suggestOutcomeTag({ userDb: user.db, adminDb: admin.db, accountId: ACC, conversationId: "conv-team", callLlm });
    expect(all.conversations[1]).toMatchObject({ suggested_outcome_tag_id: "tag-acordo", outcome_suggestion_source: "exit_tag" });
  });
});
