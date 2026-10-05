import { describe, expect, it } from "vitest";
import {
  filterQuickReplies,
  isValidShortcut,
  matchSlashQuery,
  normalizeShortcut,
  renderQuickReply,
  type QuickReply,
} from "./quick-replies";

const reply = (shortcut: string, title: string): QuickReply => ({
  id: shortcut,
  account_id: "a",
  shortcut,
  title,
  content: "x",
  created_at: "",
  updated_at: "",
});

describe("normalizeShortcut", () => {
  it("minúsculas, sem acento, sem barra, espaço vira hífen", () => {
    expect(normalizeShortcut("/Boas Vindas!")).toBe("boas-vindas");
    expect(normalizeShortcut("Negociação_2")).toBe("negociacao_2");
    expect(isValidShortcut(normalizeShortcut("Boleto"))).toBe(true);
    expect(isValidShortcut("")).toBe(false);
    expect(isValidShortcut("com espaço")).toBe(false);
  });
});

describe("matchSlashQuery", () => {
  it("no começo ou depois de espaço", () => {
    expect(matchSlashQuery("/")).toEqual({ start: 0, query: "" });
    expect(matchSlashQuery("/bol")).toEqual({ start: 0, query: "bol" });
    expect(matchSlashQuery("Oi /bo")).toEqual({ start: 3, query: "bo" });
  });

  it("ignora barra no meio de palavra, link ou depois de espaço", () => {
    expect(matchSlashQuery("e/ou")).toBeNull();
    expect(matchSlashQuery("https://site")).toBeNull();
    expect(matchSlashQuery("/bol ")).toBeNull();
    expect(matchSlashQuery("sem barra")).toBeNull();
  });
});

describe("filterQuickReplies", () => {
  const list = [reply("boleto", "Segunda via"), reply("ola", "Saudação"), reply("aboleto", "Outro")];
  it("prefixo antes de contém; busca no título sem acento", () => {
    expect(filterQuickReplies(list, "bol").map((r) => r.shortcut)).toEqual(["boleto", "aboleto"]);
    expect(filterQuickReplies(list, "saudacao").map((r) => r.shortcut)).toEqual(["ola"]);
    expect(filterQuickReplies(list, "").length).toBe(3);
  });
});

describe("renderQuickReply", () => {
  it("preenche as variáveis", () => {
    expect(
      renderQuickReply("Olá, {primeiro_nome}! Sou {atendente}. ({nome})", {
        contactName: "Maria da Silva",
        agentName: "João Souza",
      }),
    ).toBe("Olá, Maria! Sou João. (Maria da Silva)");
  });

  it("sem o dado, a variável some sem deixar vírgula solta", () => {
    expect(renderQuickReply("Olá, {primeiro_nome}! Tudo bem?", { contactName: null })).toBe("Olá! Tudo bem?");
    expect(renderQuickReply("{primeiro_nome}, seu boleto", {})).toBe("seu boleto");
  });
});
