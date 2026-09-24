export type ImportColumnMap = Partial<Record<"name" | "phone" | "cpf" | "var1" | "var2" | "var3", string>>;
export const NO_MAPPING_VALUE = "__none__";
export const NO_MAPPING_LABEL = "Nenhum";

const PHONE_HEADERS = [
  "contato", "telefone", "celular", "whatsapp", "phone", "tel", "fone", "número", "numero",
  "telefone1", "telefone 1", "celular1", "celular 1", "whatsapp1", "whatsapp 1", "tel1", "tel 1",
];
const NAME_HEADERS = ["nome", "name", "nome completo", "full name", "cliente"];
const CPF_HEADERS = ["cpf", "cpf_aluno", "documento", "document"];

export function normalizeImportHeader(value: string): string {
  return value.trim().toLowerCase().replace(/["'\r]/g, "");
}

export function looksLikeImportHeader(values: string[]): boolean {
  const headers = values.map(normalizeImportHeader);
  return headers.some((header) =>
    PHONE_HEADERS.includes(header) ||
    NAME_HEADERS.includes(header) ||
    CPF_HEADERS.includes(header) ||
    /^var[1-3]$/.test(header)
  );
}

export function suggestImportColumnMap(headers: string[]): ImportColumnMap {
  const normalized = headers.map(normalizeImportHeader);
  const find = (aliases: string[]) => {
    const index = normalized.findIndex((header) => aliases.includes(header));
    return index >= 0 ? headers[index] : undefined;
  };

  const map: ImportColumnMap = {};
  map.phone = find(PHONE_HEADERS) ?? headers[0];
  const var1 = find(["var1"]);
  const var2 = find(["var2"]);
  const var3 = find(["var3"]);
  const name = find(NAME_HEADERS) ?? var1;
  const cpf = find(CPF_HEADERS);
  if (name) map.name = name;
  if (cpf) map.cpf = cpf;
  if (var1) map.var1 = var1;
  if (var2) map.var2 = var2;
  if (var3) map.var3 = var3;
  return map;
}

export interface ResolvedImportRow {
  phone: string;
  name?: string;
  cpf?: string;
  variables: [string, string, string];
  raw: Record<string, string>;
}

export function resolveImportRows(
  headers: string[],
  rows: string[][],
  columnMap: ImportColumnMap
): { rows: ResolvedImportRow[]; invalidRows: number } {
  const indexByHeader = (mappedHeader: string | undefined) =>
    mappedHeader ? headers.findIndex((header) => header === mappedHeader) : -1;
  const phoneIndex = indexByHeader(columnMap.phone);
  const nameIndex = indexByHeader(columnMap.name);
  const cpfIndex = indexByHeader(columnMap.cpf);
  const variableIndexes = [
    indexByHeader(columnMap.var1),
    indexByHeader(columnMap.var2),
    indexByHeader(columnMap.var3),
  ];

  let invalidRows = 0;
  const resolved = rows.flatMap((values) => {
    const phone = phoneIndex >= 0 ? values[phoneIndex]?.trim() ?? "" : "";
    if (!phone) {
      invalidRows++;
      return [];
    }
    return [{
      phone,
      name: nameIndex >= 0 ? values[nameIndex]?.trim() || undefined : undefined,
      cpf: cpfIndex >= 0 ? values[cpfIndex]?.trim() || undefined : undefined,
      variables: variableIndexes.map((index) => index >= 0 ? values[index]?.trim() || "" : "") as [string, string, string],
      raw: Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])),
    }];
  });

  return { rows: resolved, invalidRows };
}