import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown, safeHref } from "./markdown";

describe("markdown das respostas", () => {
  it("reconhece link do Inbox, negrito e código", () => {
    expect(parseInline("Veja [Abrir conversa](/inbox?c=abc) com **12** em `x`")).toEqual([
      { type: "text", text: "Veja " },
      { type: "link", text: "Abrir conversa", href: "/inbox?c=abc", internal: true },
      { type: "text", text: " com " },
      { type: "bold", text: "12" },
      { type: "text", text: " em " },
      { type: "code", text: "x" },
    ]);
  });

  it("não aceita links perigosos", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("//evil.com")).toBeNull();
    expect(safeHref("data:text/html,x")).toBeNull();
    expect(safeHref("https://ddm.com.br")).toEqual({ href: "https://ddm.com.br", internal: false });
    expect(parseInline("[x](javascript:alert(1))")[0]).toMatchObject({ type: "text" });
  });

  it("separa parágrafos, títulos e listas", () => {
    const blocks = parseMarkdown("## Resumo\nlinha 1\nlinha 2\n\n- a\n- b\n1. um\ntexto");
    expect(blocks.map((b) => b.type)).toEqual(["heading", "paragraph", "list", "list", "paragraph"]);
    expect(blocks[1]).toMatchObject({ type: "paragraph", lines: [[{ text: "linha 1" }], [{ text: "linha 2" }]] });
    expect(blocks[2]).toMatchObject({ ordered: false, items: [[{ text: "a" }], [{ text: "b" }]] });
    expect(blocks[3]).toMatchObject({ ordered: true });
  });
});
