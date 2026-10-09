import { describe, expect, it } from "vitest";
import {
  canEditQuickReply,
  dedupeByShortcut,
  filterQuickReplies,
  isValidShortcut,
  matchSlashQuery,
  normalizeShortcut,
  renderQuickReply,
  shortcutTaken,
  visibilityOf,
  visibilityOptions,
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
    expect(renderQuickReply("Segue o boleto.\n\n{atendente}", {})).toBe("Segue o boleto.");
    expect(renderQuickReply("Oi {primeiro_nome}\nLinha 2", {})).toBe("Oi\nLinha 2");
  });
});

const scoped = (id: string, shortcut: string, extra: Partial<QuickReply>): QuickReply => ({ ...reply(shortcut, id), id, ...extra });

describe("visibilidade (301)", () => {
  it("sem a coluna vale 'conta'", () => {
    expect(visibilityOf(reply("a", "t"))).toBe("account");
  });

  it("atalho repetido: pessoal > equipe > conta, mantendo a ordem dos que ficam", () => {
    const list = [
      scoped("c", "oi", { visibility: "account" }),
      scoped("t", "oi", { visibility: "team", team_id: "eq1" }),
      scoped("p", "oi", { visibility: "personal", created_by: "u1" }),
      scoped("x", "tchau", { visibility: "account" }),
    ];
    expect(dedupeByShortcut(list).map((r) => r.id)).toEqual(["p", "x"]);
    expect(dedupeByShortcut(list.slice(0, 2)).map((r) => r.id)).toEqual(["t"]);
  });

  it("duas equipes com o mesmo atalho: vale a primeira", () => {
    const list = [
      scoped("a", "oi", { visibility: "team", team_id: "eq1" }),
      scoped("b", "oi", { visibility: "team", team_id: "eq2" }),
    ];
    expect(dedupeByShortcut(list).map((r) => r.id)).toEqual(["a"]);
  });

  it("o filtro do composer já resolve o repetido", () => {
    const list = [scoped("c", "oi", {}), scoped("p", "oi", { visibility: "personal", created_by: "u1" })];
    expect(filterQuickReplies(list, "oi").map((r) => r.id)).toEqual(["p"]);
    expect(filterQuickReplies(list, "").map((r) => r.id)).toEqual(["p"]);
  });

  it("quem edita: pessoal só o dono; equipe/conta só com manage", () => {
    const personal = { visibility: "personal" as const, created_by: "u1" };
    expect(canEditQuickReply(personal, { userId: "u1", canManage: false })).toBe(true);
    expect(canEditQuickReply(personal, { userId: "u2", canManage: true })).toBe(false);
    expect(canEditQuickReply({ visibility: "account" }, { userId: "u1", canManage: false })).toBe(false);
    expect(canEditQuickReply({ visibility: "team" }, { userId: "u1", canManage: true })).toBe(true);
  });

  it("seletor: sem manage só pessoal", () => {
    expect(visibilityOptions(false)).toEqual(["personal"]);
    expect(visibilityOptions(true)).toEqual(["personal", "team", "account"]);
  });

  it("atalho único por escopo", () => {
    const list = [
      scoped("p1", "oi", { visibility: "personal", created_by: "u1" }),
      scoped("t1", "oi", { visibility: "team", team_id: "eq1" }),
      scoped("c1", "oi", { visibility: "account" }),
    ];
    const base = { shortcut: "oi", teamId: null, ownerId: "u2" };
    expect(shortcutTaken(list, { ...base, visibility: "personal" })).toBe(false); // outro dono
    expect(shortcutTaken(list, { ...base, visibility: "personal", ownerId: "u1" })).toBe(true);
    expect(shortcutTaken(list, { ...base, visibility: "personal", ownerId: "u1" }, "p1")).toBe(false);
    expect(shortcutTaken(list, { ...base, visibility: "team", teamId: "eq2" })).toBe(false);
    expect(shortcutTaken(list, { ...base, visibility: "team", teamId: "eq1" })).toBe(true);
    expect(shortcutTaken(list, { ...base, visibility: "account" })).toBe(true);
  });
});
