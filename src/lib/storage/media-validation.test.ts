import { describe, expect, it } from "vitest";
import {
  ALLOWED_MEDIA_MIME,
  MEDIA_PURPOSES,
  checkStoredObject,
  checkUploadRequest,
  isAccountMediaPath,
  isRecentlyStaged,
  isMediaPurpose,
  magicMatchesMime,
  maxBytesFor,
  mediaKindOf,
  normalizeMime,
  sniffFormat,
} from "./media-validation";

const bytes = (...v: number[]) => new Uint8Array([...v, ...new Array(Math.max(0, 32 - v.length)).fill(0x41)]);
const text = (s: string) => new TextEncoder().encode(s.padEnd(32, " "));
const ftyp = (brand: string) => new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, ...[...brand].map((c) => c.charCodeAt(0)), ...new Array(20).fill(0)]);

const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, ...new Array(20).fill(0)]);
const PDF = text("%PDF-1.7\n");
const OGG = bytes(0x4f, 0x67, 0x67, 0x53);
const EXE = bytes(0x4d, 0x5a, 0x90, 0x00); // "MZ": executável do Windows
const HTML = text("<html><script>alert(1)</script>");

describe("media-validation: pedido de upload", () => {
  it("aceita tipo permitido dentro do teto do tipo", () => {
    expect(checkUploadRequest({ mime: "image/png", size: 1024 })).toEqual({ ok: true, mime: "image/png" });
    expect(checkUploadRequest({ mime: "audio/ogg; codecs=opus", size: 10_000 })).toEqual({ ok: true, mime: "audio/ogg" });
    expect(checkUploadRequest({ mime: "video/mp4", size: 16 * 1024 * 1024 }).ok).toBe(true);
  });

  it("recusa tipo fora da lista (html, svg, executável, zip genérico)", () => {
    for (const mime of ["text/html", "image/svg+xml", "application/x-msdownload", "application/zip", "application/octet-stream", "image/gif", ""]) {
      expect(checkUploadRequest({ mime, size: 100 }).ok, mime).toBe(false);
    }
    expect(checkUploadRequest({ mime: undefined, size: 100 }).ok).toBe(false);
  });

  it("limite por tipo: imagem 5 MB, os demais 16 MB; vazio e inválido recusados", () => {
    expect(checkUploadRequest({ mime: "image/jpeg", size: 5 * 1024 * 1024 }).ok).toBe(true);
    expect(checkUploadRequest({ mime: "image/jpeg", size: 5 * 1024 * 1024 + 1 }).ok).toBe(false);
    expect(checkUploadRequest({ mime: "application/pdf", size: 16 * 1024 * 1024 + 1 }).ok).toBe(false);
    expect(checkUploadRequest({ mime: "application/pdf", size: 0 }).ok).toBe(false);
    expect(checkUploadRequest({ mime: "application/pdf", size: -5 }).ok).toBe(false);
    expect(checkUploadRequest({ mime: "application/pdf", size: Number.NaN }).ok).toBe(false);
    expect(checkUploadRequest({ mime: "application/pdf", size: "100" }).ok).toBe(false);
    expect(maxBytesFor("image/webp")).toBe(5 * 1024 * 1024);
    expect(mediaKindOf("audio/webm")).toBe("audio");
    expect(normalizeMime(" Audio/OGG ; codecs=opus")).toBe("audio/ogg");
  });

  it("a lista de tipos casa com os buckets (nenhum tipo perigoso)", () => {
    for (const m of ALLOWED_MEDIA_MIME) expect(m).not.toMatch(/html|svg|javascript|\+xml|\/xml|\/zip|octet|x-msdownload/);
  });

  it("propósitos: bucket e permissão por origem", () => {
    expect(MEDIA_PURPOSES.flow).toEqual({ bucket: "flow-media", permission: "flows.edit" });
    expect(MEDIA_PURPOSES.inbox.bucket).toBe("chat-media");
    expect(isMediaPurpose("inbox")).toBe(true);
    expect(isMediaPurpose("avatars")).toBe(false);
    expect(isMediaPurpose("__proto__")).toBe(false);
    expect(isMediaPurpose(undefined)).toBe(false);
  });
});

describe("media-validation: magic bytes", () => {
  it("reconhece os formatos pelos primeiros bytes", () => {
    expect(sniffFormat(PNG)).toBe("png");
    expect(sniffFormat(JPEG)).toBe("jpeg");
    expect(sniffFormat(WEBP)).toBe("webp");
    expect(sniffFormat(PDF)).toBe("pdf");
    expect(sniffFormat(ftyp("isom"))).toBe("mp4");
    expect(sniffFormat(ftyp("3gp4"))).toBe("3gp");
    expect(sniffFormat(OGG)).toBe("ogg");
    expect(sniffFormat(bytes(0x1a, 0x45, 0xdf, 0xa3))).toBe("ebml");
    expect(sniffFormat(bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1))).toBe("ole");
    expect(sniffFormat(bytes(0x50, 0x4b, 0x03, 0x04))).toBe("zip");
    expect(sniffFormat(text("ID3"))).toBe("mp3");
    expect(sniffFormat(bytes(0xff, 0xfb, 0x90))).toBe("mp3");
    expect(sniffFormat(bytes(0xff, 0xf1, 0x50))).toBe("aac");
    expect(sniffFormat(text("#!AMR\n"))).toBe("amr");
    expect(sniffFormat(text("Olá, mundo"))).toBe("text");
    expect(sniffFormat(EXE)).toBeNull();
  });

  it("bate o conteúdo com o MIME gravado", () => {
    expect(magicMatchesMime("image/png", PNG)).toBe(true);
    expect(magicMatchesMime("video/mp4", ftyp("mp42"))).toBe(true);
    expect(magicMatchesMime("audio/mp4", ftyp("M4A "))).toBe(true);
    expect(magicMatchesMime("audio/ogg", OGG)).toBe(true);
    expect(magicMatchesMime("application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes(0x50, 0x4b, 0x03, 0x04))).toBe(true);
    expect(magicMatchesMime("application/msword", bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1))).toBe(true);
    expect(magicMatchesMime("text/plain", text("linha 1\nlinha 2"))).toBe(true);
  });

  it("recusa disfarce: executável/HTML com Content-Type de imagem, PDF ou texto", () => {
    expect(magicMatchesMime("image/png", EXE)).toBe(false);
    expect(magicMatchesMime("image/jpeg", HTML)).toBe(false);
    expect(magicMatchesMime("application/pdf", EXE)).toBe(false);
    expect(magicMatchesMime("image/png", JPEG)).toBe(false);
    expect(magicMatchesMime("video/mp4", PNG)).toBe(false);
    expect(magicMatchesMime("text/plain", EXE)).toBe(false);
    expect(magicMatchesMime("text/plain", bytes(0x41, 0x00, 0x42))).toBe(false); // byte nulo = binário
    expect(magicMatchesMime("application/x-desconhecido", PNG)).toBe(false);
  });

  it("revalida o objeto gravado: mime gravado, tamanho e conteúdo", () => {
    expect(checkStoredObject({ size: 2048, mimetype: "image/png" }, PNG)).toEqual({ ok: true, mime: "image/png", kind: "image" });
    // O navegador declarou imagem, mas o arquivo é um executável.
    expect(checkStoredObject({ size: 2048, mimetype: "image/png" }, EXE).ok).toBe(false);
    // Tamanho acima do teto do tipo (o upload assinado não impõe tamanho).
    expect(checkStoredObject({ size: 6 * 1024 * 1024, mimetype: "image/png" }, PNG).ok).toBe(false);
    // Tipo gravado fora da lista.
    expect(checkStoredObject({ size: 100, mimetype: "text/html" }, HTML).ok).toBe(false);
    expect(checkStoredObject({ size: 0, mimetype: "image/png" }, PNG).ok).toBe(false);
    expect(checkStoredObject({}, PNG).ok).toBe(false);
  });
});

describe("media-validation: caminho da conta", () => {
  const acc = "11111111-1111-1111-1111-111111111111";
  it("aceita só a pasta da própria conta, sem segmentos perigosos", () => {
    expect(isAccountMediaPath(`account-${acc}/abc-foto.png`, acc)).toBe(true);
    expect(isAccountMediaPath(`account-${acc}/sub/abc.png`, acc)).toBe(true);
    expect(isAccountMediaPath(`account-22222222-2222-2222-2222-222222222222/abc.png`, acc)).toBe(false);
    expect(isAccountMediaPath(`account-${acc}/../account-outra/x.png`, acc)).toBe(false);
    expect(isAccountMediaPath(`account-${acc}/a//b.png`, acc)).toBe(false);
    expect(isAccountMediaPath(`account-${acc}/`, acc)).toBe(false);
    expect(isAccountMediaPath(`account-${acc}\\x.png`, acc)).toBe(false);
    expect(isAccountMediaPath(`meta/abc.png`, acc)).toBe(false);
    expect(isAccountMediaPath("", acc)).toBe(false);
  });
});

describe("media-validation: rascunho recente", () => {
  const now = Date.parse("2026-10-13T12:00:00Z");
  it("só objeto criado há pouco é descartável; data ausente ou inválida = não é rascunho", () => {
    expect(isRecentlyStaged("2026-10-13T11:30:00Z", now)).toBe(true);
    expect(isRecentlyStaged("2026-10-13T10:00:01Z", now)).toBe(true);
    expect(isRecentlyStaged("2026-10-13T09:59:00Z", now)).toBe(false); // passou de 2 h
    expect(isRecentlyStaged("2026-10-13T12:00:30Z", now)).toBe(true); // relógio levemente adiantado
    expect(isRecentlyStaged("2026-10-13T13:00:00Z", now)).toBe(false); // criado "no futuro"
    expect(isRecentlyStaged(undefined, now)).toBe(false);
    expect(isRecentlyStaged("não é data", now)).toBe(false);
    expect(isRecentlyStaged(null, now)).toBe(false);
  });
});
