import { describe, expect, it, vi } from "vitest";
import { closeConversationForAutomation } from "./close-conversation";
import { fakeRowsDb } from "@/lib/conversations/__tests__/fake-rows-db";

const ACC = "acc-1";

function setup() {
  return fakeRowsDb({
    conversations: [
      // Conversa alvo, aberta e sem tabulação.
      { id: "c-open", account_id: ACC, contact_id: "ct-1", status: "open", outcome_tag_id: null },
      // Outra conversa do MESMO contato, já fechada por um humano.
      { id: "c-closed", account_id: ACC, contact_id: "ct-1", status: "closed", outcome_tag_id: "tag-human" },
      // Outra conversa aberta do mesmo contato (ex.: webchat).
      { id: "c-other", account_id: ACC, contact_id: "ct-1", status: "open", outcome_tag_id: null },
      // Conversa aberta já tabulada (sugestão aceita antes do fechamento).
      { id: "c-tagged", account_id: ACC, contact_id: "ct-2", status: "pending", outcome_tag_id: "tag-prev" },
      // Conversa de outra conta com o mesmo id lógico de contato.
      { id: "c-foreign", account_id: "acc-2", contact_id: "ct-1", status: "open", outcome_tag_id: null },
    ],
    tags: [
      { id: "tag-sem", account_id: ACC, kind: "outcome", codigo_tabulacao: 16 },
      { id: "tag-sem-2", account_id: "acc-2", kind: "outcome", codigo_tabulacao: 16 },
    ],
  });
}

const byId = (t: ReturnType<typeof setup>["tables"], id: string) =>
  t.conversations.find((c) => c.id === id)!;

describe("closeConversationForAutomation", () => {
  it("fecha só a conversa resolvida, sem tocar nas outras do contato", async () => {
    const { db, tables } = setup();
    const res = await closeConversationForAutomation(db, {
      accountId: ACC,
      conversationId: "c-open",
      configuredOutcomeTagId: "tag-cfg",
    });
    expect(res).toBe("closed");
    expect(byId(tables, "c-open")).toMatchObject({
      status: "closed",
      outcome_tag_id: "tag-cfg",
      outcome_source: "automation",
      outcome_set_by: null,
    });
    expect(byId(tables, "c-open").outcome_set_at).toEqual(expect.any(String));
    expect(byId(tables, "c-closed")).toMatchObject({ status: "closed", outcome_tag_id: "tag-human" });
    expect(byId(tables, "c-other")).toMatchObject({ status: "open", outcome_tag_id: null });
    expect(byId(tables, "c-foreign")).toMatchObject({ status: "open", outcome_tag_id: null });
  });

  it("não mexe em conversa já fechada (preserva a tabulação humana)", async () => {
    const { db, tables, log } = setup();
    const res = await closeConversationForAutomation(db, {
      accountId: ACC,
      conversationId: "c-closed",
      configuredOutcomeTagId: "tag-cfg",
    });
    expect(res).toBe("already_closed");
    expect(byId(tables, "c-closed").outcome_tag_id).toBe("tag-human");
    expect(log.some((o) => o.type === "update")).toBe(false);
  });

  it("nunca sobrescreve um outcome_tag_id já definido", async () => {
    const { db, tables } = setup();
    await closeConversationForAutomation(db, {
      accountId: ACC,
      conversationId: "c-tagged",
      configuredOutcomeTagId: "tag-cfg",
    });
    expect(byId(tables, "c-tagged")).toMatchObject({ status: "closed", outcome_tag_id: "tag-prev" });
    // Não reivindica a procedência de uma tabulação que não definiu.
    expect(byId(tables, "c-tagged").outcome_source).toBeUndefined();
  });

  it("sem tag configurada usa o fallback 'Sem Tabulação' da própria conta", async () => {
    const { db, tables } = setup();
    await closeConversationForAutomation(db, { accountId: ACC, conversationId: "c-open", configuredOutcomeTagId: "" });
    expect(byId(tables, "c-open").outcome_tag_id).toBe("tag-sem");
  });

  it("fecha mesmo sem fallback disponível (só não grava tabulação)", async () => {
    const { db, tables } = setup();
    tables.tags = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await closeConversationForAutomation(db, { accountId: ACC, conversationId: "c-open" });
    expect(byId(tables, "c-open")).toMatchObject({ status: "closed", outcome_tag_id: null });
    warn.mockRestore();
  });

  it("não encontra conversa de outra conta", async () => {
    const { db, tables } = setup();
    const res = await closeConversationForAutomation(db, {
      accountId: ACC,
      conversationId: "c-foreign",
      configuredOutcomeTagId: "tag-cfg",
    });
    expect(res).toBe("not_found");
    expect(byId(tables, "c-foreign").status).toBe("open");
  });

  it("o UPDATE é por id + conta e protege contra corrida (status <> closed)", async () => {
    const { db, log } = setup();
    await closeConversationForAutomation(db, { accountId: ACC, conversationId: "c-open", configuredOutcomeTagId: "t" });
    const upd = log.find((o) => o.type === "update" && o.table === "conversations")!;
    expect(upd.filters).toEqual([
      ["eq", "id", "c-open"],
      ["eq", "account_id", ACC],
      ["neq", "status", "closed"],
    ]);
  });
});
