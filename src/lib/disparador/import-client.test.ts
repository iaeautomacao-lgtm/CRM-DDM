import { describe, expect, it } from "vitest";
import {
  exportDownloadable,
  exportStatusLabel,
  formatBytes,
  firstMissingBlock,
  importTokenField,
  importListLabel,
  importPercent,
  isActiveExport,
  isActiveImport,
  mappingIsValid,
  planImportBlocks,
  tableToRowObjects,
} from "./import-client";

describe("tableToRowObjects", () => {
  it("monta objetos cabeçalho → valor, preenchendo células ausentes com vazio", () => {
    const rows = tableToRowObjects({ headers: ["nome", "telefone"], rows: [["Ana", "11999990000"], ["Bia"]], hasHeader: true });
    expect(rows).toEqual([
      { nome: "Ana", telefone: "11999990000" },
      { nome: "Bia", telefone: "" },
    ]);
  });
});

describe("planImportBlocks", () => {
  it("respeita o teto de 10.000 linhas por bloco", () => {
    const rows = Array.from({ length: 25_000 }, (_, i) => ({ t: String(i) }));
    const blocks = planImportBlocks(rows);
    expect(blocks.map((b) => b.length)).toEqual([10_000, 10_000, 5_000]);
  });
  it("lista vazia não gera bloco", () => {
    expect(planImportBlocks([])).toEqual([]);
  });
});

describe("mappingIsValid", () => {
  it("exige a coluna de contato e colunas existentes", () => {
    expect(mappingIsValid({ phone: "telefone" }, ["telefone"])).toBe(true);
    expect(mappingIsValid({}, ["telefone"])).toBe(false);
    expect(mappingIsValid({ phone: "fone" }, ["telefone"])).toBe(false);
    expect(mappingIsValid({ phone: "telefone", name: "x" }, ["telefone"])).toBe(false);
  });
});

describe("estados", () => {
  it("import ativo e percentual", () => {
    expect(isActiveImport("running")).toBe(true);
    expect(isActiveImport("done")).toBe(false);
    expect(importPercent({ state: "done", progress: 0.2, blocks_received: 0, blocks_total: null })).toBe(100);
    expect(importPercent({ state: "running", progress: 0.456, blocks_received: 3, blocks_total: 3 })).toBe(46);
    expect(importPercent({ state: "receiving", progress: null, blocks_received: 1, blocks_total: 4 })).toBe(25);
    expect(importPercent({ state: "receiving", progress: null, blocks_received: 0, blocks_total: null })).toBe(0);
  });
  it("export ativo e baixável dentro da validade", () => {
    const now = Date.parse("2026-10-09T12:00:00Z");
    expect(isActiveExport("pending")).toBe(true);
    expect(exportDownloadable({ state: "done", expires_at: "2026-10-10T12:00:00Z" }, now)).toBe(true);
    expect(exportDownloadable({ state: "done", expires_at: "2026-10-09T11:00:00Z" }, now)).toBe(false);
    expect(exportDownloadable({ state: "running", expires_at: null }, now)).toBe(false);
  });
});

describe("rótulos", () => {
  it("nome da lista e da métrica", () => {
    expect(importListLabel({ name: "Rematrícula", created_at: "2026-10-09T12:00:00Z" })).toBe("Rematrícula");
    expect(importListLabel({ name: null, created_at: "lixo" })).toBe("Lista sem nome");
    expect(exportStatusLabel("erro")).toBe("Erros");
    expect(exportStatusLabel("x")).toBe("x");
  });
  it("tamanho do arquivo", () => {
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1,5 MB");
  });
});

describe("importTokenField", () => {
  it("só envia quando ligado e no formato aceito", () => {
    const uuid = "6f1c2a4e-0b7d-4c1e-9a3f-2d5b8e7c9a01";
    expect(importTokenField(uuid, true)).toEqual({ import_token: uuid });
    expect(importTokenField(uuid, false)).toEqual({});
    expect(importTokenField("curto", true)).toEqual({});
    expect(importTokenField("tem espaço no meio", true)).toEqual({});
    expect(importTokenField(null, true)).toEqual({});
  });
});

describe("firstMissingBlock", () => {
  it("lê o menor bloco faltante da mensagem do servidor", () => {
    expect(firstMissingBlock("Faltam blocos: 5, 2, 9.")).toBe(2);
    expect(firstMissingBlock("Faltam blocos: 0, 1, 2, 3, 4, 5, 6, 7, 8, 9….")).toBe(0);
    expect(firstMissingBlock("outra coisa")).toBe(0);
    expect(firstMissingBlock(undefined)).toBe(0);
  });
});
