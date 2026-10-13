import { describe, expect, it } from "vitest";
import { INVITE_LINKS_WARNING, NO_LINK_TEXT, buildInviteLinksCsv, csvCell, inviteLinksFileName, parseInviteLinks } from "./invite-links";

describe("invite-links", () => {
  it("normaliza a resposta: descarta item sem e-mail, link vazio vira null", () => {
    expect(
      parseInviteLinks([
        { email: "a@x.com", name: "Ana", link: "https://app.test/auth/callback?token_hash=abc&type=recovery&next=/reset-password" },
        { email: "b@x.com", name: "Bia", link: null },
        { email: "c@x.com", link: "   " },
        { name: "sem e-mail", link: "https://x" },
        null,
        "texto",
      ]),
    ).toEqual([
      { email: "a@x.com", name: "Ana", link: "https://app.test/auth/callback?token_hash=abc&type=recovery&next=/reset-password" },
      { email: "b@x.com", name: "Bia", link: null },
      { email: "c@x.com", name: "", link: null },
    ]);
    expect(parseInviteLinks(undefined)).toEqual([]);
    expect(parseInviteLinks({})).toEqual([]);
  });

  it("CSV: BOM, separador ';', CRLF, cabeçalho Nome;E-mail;Link", () => {
    const csv = buildInviteLinksCsv([{ name: "Ana", email: "ana@x.com", link: "https://app.test/l?a=1&b=2" }]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toBe("﻿Nome;E-mail;Link\r\nAna;ana@x.com;https://app.test/l?a=1&b=2\r\n");
  });

  it("link ausente vira o texto de 'Esqueci minha senha'", () => {
    const csv = buildInviteLinksCsv([{ name: "Bia", email: "bia@x.com", link: null }]);
    expect(csv).toContain(`Bia;bia@x.com;${NO_LINK_TEXT}`);
    expect(NO_LINK_TEXT).toContain("Esqueci minha senha");
  });

  it("escapa ';', aspas e quebras de linha no nome", () => {
    expect(csvCell('Silva; João "Zé"')).toBe('"Silva; João ""Zé"""');
    expect(csvCell("a\nb")).toBe('"a\nb"');
    expect(csvCell("simples")).toBe("simples");
  });

  it("proteção contra injeção de fórmula: = + - @ no começo ganham apóstrofo", () => {
    expect(csvCell("=HYPERLINK(\"http://evil\")")).toBe("\"'=HYPERLINK(\"\"http://evil\"\")\"");
    expect(csvCell("+55 11 99999")).toBe("'+55 11 99999");
    expect(csvCell("-1+1")).toBe("'-1+1");
    expect(csvCell("@cmd")).toBe("'@cmd");
    expect(csvCell("\tx")).toBe("'\tx");
    // E-mail e link normais não são alterados.
    expect(csvCell("ana@x.com")).toBe("ana@x.com");
    expect(csvCell("https://app.test/x")).toBe("https://app.test/x");
  });

  it("nome do arquivo com a data local", () => {
    expect(inviteLinksFileName(new Date(2026, 9, 13, 8, 5))).toBe("links-de-acesso-2026-10-13.csv");
  });

  it("o aviso tem o texto combinado", () => {
    expect(INVITE_LINKS_WARNING).toContain("Envie a cada pessoa o link dela.");
    expect(INVITE_LINKS_WARNING).toContain("único momento em que os links aparecem");
  });
});
