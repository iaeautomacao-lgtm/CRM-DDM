// Decodificação de arquivo de texto enviado pelo usuário (CSV/TXT/JSON): o Excel brasileiro salva CSV em Windows-1252 ("CSV (separado por vírgulas)")
// e às vezes em UTF-16 ("Texto Unicode"); só o "CSV UTF-8" sai em UTF-8. Ler tudo como UTF-8 vira "JoÃ£o" / "ConceiÃ§Ã£o" / "�".
// Regra: BOM manda (UTF-8/UTF-16LE/UTF-16BE); sem BOM, UTF-8 ESTRITO; se os bytes não forem UTF-8 válido, Windows-1252.
// Isomórfico (navegador e Node): só TextDecoder. Nunca reconverte texto que já chegou como string.

export type DetectedEncoding = "utf-8" | "utf-16le" | "utf-16be" | "windows-1252";

export interface DecodedText {
  text: string;
  encoding: DetectedEncoding;
}

function toBytes(input: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return new Uint8Array(input);
}

/** Decodifica os bytes de um arquivo de texto e informa a codificação detectada. O BOM é removido do texto. */
export function decodeTextBytes(input: ArrayBuffer | ArrayBufferView): DecodedText {
  const bytes = toBytes(input);

  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), encoding: "utf-16le" };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder("utf-16be").decode(bytes.subarray(2)), encoding: "utf-16be" };
  }
  const hasUtf8Bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const body = hasUtf8Bom ? bytes.subarray(3) : bytes;
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(body), encoding: "utf-8" };
  } catch {
    return { text: decodeWindows1252(body), encoding: "windows-1252" };
  }
}

// 0x80–0x9F do Windows-1252 (aspas, travessões, euro…). O TextDecoder("windows-1252") do Node trata o rótulo como Latin-1 e devolve
// caracteres de controle nessa faixa; os navegadores acertam. Tabela própria: mesmo resultado no navegador e no servidor.
const CP1252_HIGH = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
  0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
];

function decodeWindows1252(bytes: Uint8Array): string {
  const parts: string[] = [];
  const CHUNK = 8192;
  for (let start = 0; start < bytes.length; start += CHUNK) {
    const end = Math.min(start + CHUNK, bytes.length);
    const codes = new Array<number>(end - start);
    for (let i = start; i < end; i++) {
      const b = bytes[i];
      codes[i - start] = b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : b;
    }
    parts.push(String.fromCharCode(...codes));
  }
  return parts.join("");
}

/** Lê um File/Blob como texto detectando a codificação (no lugar de `file.text()`, que assume UTF-8). */
export async function readTextFile(file: Blob): Promise<string> {
  return decodeTextBytes(await file.arrayBuffer()).text;
}
