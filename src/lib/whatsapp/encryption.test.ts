import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  decrypt,
  decryptStoredSecret,
  encrypt,
  ensureEncryptedSecret,
  isEncryptedSecret,
  isLegacyCbcSecret,
  isLegacyFormat,
} from "./encryption";

const KEY_HEX = process.env.ENCRYPTION_KEY!;

function cbcEncryptLegacy(plaintext: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(
    "aes-256-cbc",
    Buffer.from(KEY_HEX, "hex"),
    iv,
  );
  let ct = cipher.update(plaintext, "utf8", "hex");
  ct += cipher.final("hex");
  return `${iv.toString("hex")}:${ct}`;
}

describe("encryption", () => {
  describe("encrypt / decrypt round-trip", () => {
    it("recovers the original plaintext", () => {
      const ct = encrypt("EAAG... fake WhatsApp token");
      expect(decrypt(ct)).toBe("EAAG... fake WhatsApp token");
    });

    it("produces three colon-separated parts (GCM)", () => {
      const ct = encrypt("anything");
      expect(ct.split(":")).toHaveLength(3);
    });

    it("uses a fresh IV per encrypt so identical plaintexts produce different ciphertexts", () => {
      const a = encrypt("same input");
      const b = encrypt("same input");
      expect(a).not.toBe(b);
      expect(decrypt(a)).toBe("same input");
      expect(decrypt(b)).toBe("same input");
    });

    it("roundtrips empty string", () => {
      const ct = encrypt("");
      expect(decrypt(ct)).toBe("");
    });

    it("roundtrips multibyte UTF-8", () => {
      const ct = encrypt("token-✓-🔐-žąsis");
      expect(decrypt(ct)).toBe("token-✓-🔐-žąsis");
    });
  });

  describe("GCM authentication", () => {
    it("rejects ciphertext tampered after encryption", () => {
      const ct = encrypt("secret");
      const [ivHex, ctHex, tagHex] = ct.split(":");
      // Flip a byte in the ciphertext body — auth tag will mismatch.
      const tamperedCtHex =
        (parseInt(ctHex.slice(0, 2), 16) ^ 0xff).toString(16).padStart(2, "0") +
        ctHex.slice(2);
      expect(() =>
        decrypt(`${ivHex}:${tamperedCtHex}:${tagHex}`),
      ).toThrow();
    });

    it("rejects a swapped auth tag", () => {
      const ct = encrypt("secret");
      const [ivHex, ctHex] = ct.split(":");
      const bogusTag = "00".repeat(16);
      expect(() => decrypt(`${ivHex}:${ctHex}:${bogusTag}`)).toThrow();
    });

    it("rejects a GCM IV of the wrong length", () => {
      const ct = encrypt("secret");
      const [, ctHex, tagHex] = ct.split(":");
      const shortIv = "00".repeat(8); // 8 bytes ≠ 12
      expect(() => decrypt(`${shortIv}:${ctHex}:${tagHex}`)).toThrow(
        /GCM IV length/,
      );
    });

    it("rejects a GCM auth tag of the wrong length", () => {
      const ct = encrypt("secret");
      const [ivHex, ctHex] = ct.split(":");
      const shortTag = "00".repeat(8); // 8 bytes ≠ 16
      expect(() => decrypt(`${ivHex}:${ctHex}:${shortTag}`)).toThrow(
        /auth-tag length/,
      );
    });
  });

  describe("legacy CBC compatibility (read-only)", () => {
    it("decrypts a CBC blob produced by the previous codepath", () => {
      const legacy = cbcEncryptLegacy("old-token");
      expect(decrypt(legacy)).toBe("old-token");
    });

    it("rejects a CBC blob with the wrong IV length", () => {
      // 8-byte IV (16 hex chars) instead of 16 bytes.
      const bogus = "00".repeat(8) + ":" + "00".repeat(16);
      expect(() => decrypt(bogus)).toThrow(/CBC IV length/);
    });
  });

  describe("format detection", () => {
    it("isLegacyFormat returns true for two-part CBC strings", () => {
      const legacy = cbcEncryptLegacy("anything");
      expect(isLegacyFormat(legacy)).toBe(true);
    });

    it("isLegacyFormat returns false for three-part GCM strings", () => {
      const modern = encrypt("anything");
      expect(isLegacyFormat(modern)).toBe(false);
    });
  });

  describe("malformed input", () => {
    it("throws on a single-token blob (no colons)", () => {
      expect(() => decrypt("not-encrypted-at-all")).toThrow(
        /unrecognised format/,
      );
    });

    it("throws on a four-part blob", () => {
      expect(() => decrypt("aa:bb:cc:dd")).toThrow(/unrecognised format/);
    });
  });
});

describe("isEncryptedSecret (formato estrito)", () => {
  it("aceita a saída do encrypt()", () => {
    expect(isEncryptedSecret(encrypt("abc123"))).toBe(true);
    expect(isEncryptedSecret(encrypt(""))).toBe(true);
  });

  it("rejeita um App Secret da Meta em texto puro (32 hex, sem ':')", () => {
    expect(isEncryptedSecret("0123456789abcdef0123456789abcdef")).toBe(false);
  });

  it("rejeita qualquer valor só porque tem ':'", () => {
    expect(isEncryptedSecret("a:b:c")).toBe(false);
    expect(isEncryptedSecret("segredo:com:dois-pontos")).toBe(false);
  });

  it("rejeita IV que não tem 24 hex", () => {
    const [, ct, tag] = encrypt("x").split(":");
    expect(isEncryptedSecret(`${"00".repeat(16)}:${ct}:${tag}`)).toBe(false);
  });

  it("rejeita authTag que não tem 32 hex", () => {
    const [iv, ct] = encrypt("x").split(":");
    expect(isEncryptedSecret(`${iv}:${ct}:${"00".repeat(8)}`)).toBe(false);
  });

  it("rejeita ciphertext com hex ímpar ou não-hex", () => {
    const [iv, , tag] = encrypt("x").split(":");
    expect(isEncryptedSecret(`${iv}:abc:${tag}`)).toBe(false);
    expect(isEncryptedSecret(`${iv}:zz:${tag}`)).toBe(false);
  });

  it("rejeita CBC legado e não-strings", () => {
    expect(isEncryptedSecret(cbcEncryptLegacy("x"))).toBe(false);
    expect(isEncryptedSecret(null)).toBe(false);
    expect(isEncryptedSecret(123)).toBe(false);
  });

  it("isLegacyCbcSecret reconhece só o CBC legado", () => {
    expect(isLegacyCbcSecret(cbcEncryptLegacy("x"))).toBe(true);
    expect(isLegacyCbcSecret(encrypt("x"))).toBe(false);
    expect(isLegacyCbcSecret("ab:cd")).toBe(false);
  });
});

describe("decryptStoredSecret (leitura com legado em texto puro)", () => {
  it("decifra GCM e CBC", () => {
    expect(decryptStoredSecret(encrypt("s3cr3t"), "t.gcm")).toBe("s3cr3t");
    expect(decryptStoredSecret(cbcEncryptLegacy("old"), "t.cbc")).toBe("old");
  });

  it("devolve texto puro legado como está e avisa uma vez só, sem logar o valor", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const plain = "0123456789abcdef0123456789abcdef";
    expect(decryptStoredSecret(plain, "t.plain")).toBe(plain);
    expect(decryptStoredSecret(plain, "t.plain")).toBe(plain);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain(plain);
    warn.mockRestore();
  });

  it("ciphertext adulterado lança — nunca vira 'texto puro'", () => {
    const [iv, ct] = encrypt("secret").split(":");
    expect(() =>
      decryptStoredSecret(`${iv}:${ct}:${"00".repeat(16)}`, "t.tamper"),
    ).toThrow();
  });
});

describe("ensureEncryptedSecret", () => {
  it("mantém GCM/CBC e cifra texto puro", () => {
    const gcm = encrypt("a");
    const cbc = cbcEncryptLegacy("b");
    expect(ensureEncryptedSecret(gcm)).toBe(gcm);
    expect(ensureEncryptedSecret(cbc)).toBe(cbc);
    const upgraded = ensureEncryptedSecret("plain-secret");
    expect(isEncryptedSecret(upgraded)).toBe(true);
    expect(decrypt(upgraded)).toBe("plain-secret");
  });
});

describe("ENCRYPTION_KEY (PRD 14, SG-13): validada no primeiro uso, não no import", () => {
  it.each([
    ["ausente", undefined],
    ["curta", "abcd"],
    ["não hexadecimal", "z".repeat(64)],
  ])("chave %s falha com mensagem clara", (_nome, valor) => {
    const original = process.env.ENCRYPTION_KEY;
    try {
      if (valor === undefined) delete process.env.ENCRYPTION_KEY;
      else process.env.ENCRYPTION_KEY = valor;
      expect(() => encrypt("x")).toThrow(/ENCRYPTION_KEY ausente ou inválida/);
    } finally {
      process.env.ENCRYPTION_KEY = original;
    }
  });
});
