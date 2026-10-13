import { describe, expect, it } from "vitest";
import { decodeTextBytes, readTextFile } from "./decode-text";
import { parseImportCsv } from "@/lib/disparador/import-parse";

const SAMPLES = ["João", "Conceição", "ação", "Ângela Pérez-Ünal"];

const utf8 = (s: string) => new TextEncoder().encode(s);
const utf8Bom = (s: string) => Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8(s)]);
// Latin-1 coincide com Windows-1252 para todo o português (á é í ó ú ã õ ç â ê ô à ü Ç Ã Õ Á É …).
const cp1252 = (s: string) => Uint8Array.from(Buffer.from(s, "latin1"));
const utf16le = (s: string) => Uint8Array.from([0xff, 0xfe, ...Buffer.from(s, "utf16le")]);
const utf16be = (s: string) => {
  const le = Buffer.from(s, "utf16le");
  const be = Buffer.alloc(le.length);
  for (let i = 0; i < le.length; i += 2) {
    be[i] = le[i + 1];
    be[i + 1] = le[i];
  }
  return Uint8Array.from([0xfe, 0xff, ...be]);
};

describe("decodeTextBytes", () => {
  it.each(SAMPLES)("UTF-8 (com e sem BOM) de %s volta igual", (s) => {
    expect(decodeTextBytes(utf8(s))).toEqual({ text: s, encoding: "utf-8" });
    expect(decodeTextBytes(utf8Bom(s))).toEqual({ text: s, encoding: "utf-8" });
  });

  it.each(SAMPLES)("Windows-1252 (Excel brasileiro) de %s é detectado e decodificado", (s) => {
    expect(decodeTextBytes(cp1252(s))).toEqual({ text: s, encoding: "windows-1252" });
  });

  it("Windows-1252 também cobre aspas e travessão do Word/Excel (0x93 0x94 0x96) e o euro (0x80)", () => {
    const bytes = Uint8Array.from([0x93, 0x4f, 0x6c, 0xe1, 0x94, 0x20, 0x96, 0x20, 0x80]);
    expect(decodeTextBytes(bytes).text).toBe("“Olá” – €");
  });

  it.each(SAMPLES)("UTF-16 com BOM (\"Texto Unicode\" do Excel) de %s", (s) => {
    expect(decodeTextBytes(utf16le(s))).toEqual({ text: s, encoding: "utf-16le" });
    expect(decodeTextBytes(utf16be(s))).toEqual({ text: s, encoding: "utf-16be" });
  });

  it("arquivo vazio e só ASCII continuam UTF-8", () => {
    expect(decodeTextBytes(new Uint8Array())).toEqual({ text: "", encoding: "utf-8" });
    expect(decodeTextBytes(utf8("nome;telefone\nAna;11999999999"))).toMatchObject({ encoding: "utf-8" });
  });

  it("aceita ArrayBuffer e Buffer", () => {
    expect(decodeTextBytes(cp1252("ação").buffer).text).toBe("ação");
    expect(decodeTextBytes(Buffer.from("ação", "utf8")).text).toBe("ação");
  });

  it("nunca produz mojibake nem U+FFFD em arquivo válido nas duas codificações", () => {
    for (const s of SAMPLES) {
      for (const enc of [utf8(s), cp1252(s)]) {
        const { text } = decodeTextBytes(enc);
        expect(text).toBe(s); // idêntico ao original: sem "Ã§", sem "Ã£" e sem U+FFFD
        expect(text).not.toContain("�");
      }
    }
  });
});

describe("readTextFile + parseImportCsv (o que o navegador faz)", () => {
  const csv = "nome;telefone\nJoão;11999990001\nConceição;11999990002\nAção Ltda;11999990003\n";

  it.each([
    ["UTF-8", utf8(csv)],
    ["UTF-8 com BOM", utf8Bom(csv)],
    ["Windows-1252", cp1252(csv)],
    ["UTF-16LE", utf16le(csv)],
  ] as const)("CSV em %s vira as mesmas linhas", async (_name, bytes) => {
    const text = await readTextFile(new Blob([Uint8Array.from(bytes)]));
    const parsed = parseImportCsv(text);
    const names = parsed.rows.map((r) => r[0]);
    expect(names).toEqual(["João", "Conceição", "Ação Ltda"]);
  });
});
