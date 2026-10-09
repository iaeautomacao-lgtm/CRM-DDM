// PRD 21, PR 21.2 — criptografia do Data Exchange: o "cliente" abaixo imita a Meta com WebCrypto (implementação INDEPENDENTE do node:crypto
// usado pelo servidor), então o teste prova a interoperabilidade da especificação, não só um round-trip da mesma função.
import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";

import { decryptFlowRequest, encryptFlowResponse, FlowCryptoError, generateFlowsKeyPair, isFlowEncryptedRequest } from "./flows-crypto";

const subtle = webcrypto.subtle;
const b64 = (buf: ArrayBuffer | Uint8Array) => Buffer.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf)).toString("base64");

const pemToDer = (pem: string) => Buffer.from(pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, ""), "base64");

/** O que a Meta faz: AES-128 de sessão, GCM com IV de 16 bytes, chave cifrada com RSA-OAEP(SHA-256) da pública do negócio. */
async function metaEncrypt(publicKeyPem: string, payload: unknown, opts: { aesKey?: Uint8Array; iv?: Uint8Array } = {}) {
  const aes = (opts.aesKey ?? webcrypto.getRandomValues(new Uint8Array(16))) as Uint8Array<ArrayBuffer>;
  const iv = (opts.iv ?? webcrypto.getRandomValues(new Uint8Array(16))) as Uint8Array<ArrayBuffer>;
  const rsa = await subtle.importKey("spki", pemToDer(publicKeyPem), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  const encryptedAesKey = await subtle.encrypt({ name: "RSA-OAEP" }, rsa, aes);
  const key = await subtle.importKey("raw", aes, "AES-GCM", false, ["encrypt"]);
  const sealed = await subtle.encrypt({ name: "AES-GCM", iv, tagLength: 128 }, key, new TextEncoder().encode(JSON.stringify(payload))); // ciphertext||tag
  return { request: { encrypted_flow_data: b64(sealed), encrypted_aes_key: b64(encryptedAesKey), initial_vector: b64(iv) }, aes, iv };
}

/** E o que a Meta faz com a resposta: mesma chave, IV invertido. */
async function metaDecryptResponse(base64: string, aes: Uint8Array<ArrayBuffer>, iv: Uint8Array<ArrayBuffer>) {
  const flipped = Uint8Array.from(iv, (b) => ~b & 0xff) as Uint8Array<ArrayBuffer>;
  const key = await subtle.importKey("raw", aes, "AES-GCM", false, ["decrypt"]);
  const plain = await subtle.decrypt({ name: "AES-GCM", iv: flipped, tagLength: 128 }, key, Buffer.from(base64, "base64"));
  return JSON.parse(new TextDecoder().decode(plain));
}

const pair = generateFlowsKeyPair();
const body = { action: "INIT", screen: "ABERTURA", flow_token: "tok-123", version: "3.0", data: { parcelas: 3 } };

describe("geração do par RSA", () => {
  it("RSA-2048: pública SPKI e privada PKCS#8 em PEM; cada chamada gera um par diferente", () => {
    expect(pair.publicKeyPem).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    expect(pair.privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect(pair.publicKeyPem).not.toContain("PRIVATE");
    expect(generateFlowsKeyPair().publicKeyPem).not.toBe(pair.publicKeyPem);
    expect(pemToDer(pair.publicKeyPem).length).toBeGreaterThan(290); // 2048 bits
  });
});

describe("decryptFlowRequest (Meta → servidor)", () => {
  it("decifra o pedido cifrado pela Meta (WebCrypto) e devolve corpo, chave de sessão e IV", async () => {
    const { request, aes, iv } = await metaEncrypt(pair.publicKeyPem, body);
    const out = decryptFlowRequest(request, pair.privateKeyPem);
    expect(out.body).toEqual(body);
    expect([...out.aesKey]).toEqual([...aes]);
    expect([...out.iv]).toEqual([...iv]);
  });

  it("encryptFlowResponse: a Meta decifra com a mesma chave e o IV INVERTIDO (ida e volta completa)", async () => {
    const { request, aes, iv } = await metaEncrypt(pair.publicKeyPem, body);
    const { aesKey, iv: serverIv } = decryptFlowRequest(request, pair.privateKeyPem);
    const response = { screen: "OPCOES", data: { opcoes: [{ id: "3x", title: "3x de R$ 150,00" }] } };
    const sealed = encryptFlowResponse(response, aesKey, serverIv);
    expect(await metaDecryptResponse(sealed, aes, iv)).toEqual(response);
    // com o IV NÃO invertido a decifragem falha (prova de que a inversão é aplicada)
    await expect(metaDecryptResponse(sealed, aes, Uint8Array.from(iv, (b) => ~b & 0xff))).rejects.toThrow();
    // acentos e caracteres não ASCII atravessam intactos
    const accents = { data: { msg: "Parcelamento disponível — ação ✓" } };
    expect(await metaDecryptResponse(encryptFlowResponse(accents, aesKey, serverIv), aes, iv)).toEqual(accents);
  });

  it("adulteração do corpo, da tag ou do IV derruba (GCM autentica)", async () => {
    const { request } = await metaEncrypt(pair.publicKeyPem, body);
    const data = Buffer.from(request.encrypted_flow_data, "base64");
    const flip = (buf: Buffer, i: number) => Buffer.from(buf.map((b, k) => (k === i ? b ^ 1 : b)));
    for (const tampered of [flip(data, 0), flip(data, data.length - 1)]) {
      expect(() => decryptFlowRequest({ ...request, encrypted_flow_data: tampered.toString("base64") }, pair.privateKeyPem)).toThrow(FlowCryptoError);
    }
    const iv = Buffer.from(request.initial_vector, "base64");
    expect(() => decryptFlowRequest({ ...request, initial_vector: flip(iv, 3).toString("base64") }, pair.privateKeyPem)).toThrow(FlowCryptoError);
  });

  it("chave privada de OUTRO par, chave AES cifrada com outra pública ou lixo ⇒ FlowCryptoError (421 na rota)", async () => {
    const other = generateFlowsKeyPair();
    const { request } = await metaEncrypt(pair.publicKeyPem, body);
    expect(() => decryptFlowRequest(request, other.privateKeyPem)).toThrow(FlowCryptoError);
    expect(() => decryptFlowRequest({ ...request, encrypted_aes_key: "AAAA" }, pair.privateKeyPem)).toThrow(FlowCryptoError);
    expect(() => decryptFlowRequest({ ...request, encrypted_aes_key: "não é base64!" }, pair.privateKeyPem)).toThrow(FlowCryptoError);
    expect(() => decryptFlowRequest(request, "-----BEGIN PRIVATE KEY-----\nlixo\n-----END PRIVATE KEY-----")).toThrow(FlowCryptoError);
  });

  it("tamanhos inválidos: IV ≠ 16 bytes, corpo menor que a tag ou acima do teto", async () => {
    const { request } = await metaEncrypt(pair.publicKeyPem, body);
    expect(() => decryptFlowRequest({ ...request, initial_vector: b64(new Uint8Array(12)) }, pair.privateKeyPem)).toThrow(/Vetor inicial/);
    expect(() => decryptFlowRequest({ ...request, encrypted_flow_data: b64(new Uint8Array(8)) }, pair.privateKeyPem)).toThrow(/tamanho inválido/);
    expect(() => decryptFlowRequest({ ...request, encrypted_flow_data: b64(new Uint8Array(300 * 1024)) }, pair.privateKeyPem)).toThrow(/tamanho inválido/);
  });

  it("chave de sessão de 256 bits não é aceita (a especificação é AES-128)", async () => {
    const { request } = await metaEncrypt(pair.publicKeyPem, body, { aesKey: webcrypto.getRandomValues(new Uint8Array(32)) }).catch(() => ({ request: null }));
    if (request) expect(() => decryptFlowRequest(request, pair.privateKeyPem)).toThrow(FlowCryptoError);
  });

  it("desempenho: decifrar + montar + cifrar cabe folgado no orçamento de 800 ms (RNF-01)", async () => {
    const { request } = await metaEncrypt(pair.publicKeyPem, body);
    const t0 = performance.now();
    const { aesKey, iv, body: decrypted } = decryptFlowRequest(request, pair.privateKeyPem);
    encryptFlowResponse({ screen: "X", data: decrypted }, aesKey, iv);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

describe("isFlowEncryptedRequest", () => {
  it("exige os três campos em texto não vazio", () => {
    expect(isFlowEncryptedRequest({ encrypted_flow_data: "a", encrypted_aes_key: "b", initial_vector: "c" })).toBe(true);
    for (const bad of [null, undefined, "x", 1, {}, { encrypted_flow_data: "a", encrypted_aes_key: "b" }, { encrypted_flow_data: "", encrypted_aes_key: "b", initial_vector: "c" }, { encrypted_flow_data: 1, encrypted_aes_key: "b", initial_vector: "c" }]) {
      expect(isFlowEncryptedRequest(bad)).toBe(false);
    }
  });
});
