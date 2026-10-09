// PRD 21, PR 21.2 — criptografia do endpoint de Data Exchange dos WhatsApp Flows (especificação da Meta).
//
//   Pedido da Meta  { encrypted_flow_data, encrypted_aes_key, initial_vector }  (tudo em base64)
//     1. a chave AES de sessão (128 bits) vem cifrada com a chave PÚBLICA do negócio: RSA-OAEP (SHA-256) — decifra com a PRIVADA;
//     2. o corpo é AES-128-GCM com `initial_vector` (16 bytes); os 16 últimos bytes de `encrypted_flow_data` são a tag de autenticação.
//   Resposta        base64( AES-128-GCM(resposta JSON) + tag ), com a MESMA chave de sessão e o IV INVERTIDO (cada byte negado).
//   Qualquer falha ao decifrar ⇒ DataExchangeError ⇒ a rota responde HTTP 421 (a Meta então busca a chave pública de novo).
// Puro: sem rede, sem banco, sem segredo guardado aqui. A chave privada chega por parâmetro (PEM) e nunca é logada.
import { createCipheriv, createDecipheriv, generateKeyPairSync, privateDecrypt, constants } from "node:crypto";

export class FlowCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlowCryptoError";
  }
}

export interface FlowEncryptedRequest {
  encrypted_flow_data: string;
  encrypted_aes_key: string;
  initial_vector: string;
}

export interface DecryptedFlowRequest<T = Record<string, unknown>> {
  /** JSON já decifrado ({ action, screen, data, flow_token, version }). */
  body: T;
  /** Chave AES de sessão e IV do pedido: necessários para cifrar a resposta. */
  aesKey: Buffer;
  iv: Buffer;
}

const TAG_BYTES = 16;
const AES_KEY_BYTES = 16;
const IV_BYTES = 16;
const MAX_ENCRYPTED_BYTES = 256 * 1024;

/** Par RSA-2048: público em SPKI (PEM, é o que se cola no WhatsApp Manager / envia à Meta) e privado em PKCS#8 (PEM). */
export function generateFlowsKeyPair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

export function isFlowEncryptedRequest(value: unknown): value is FlowEncryptedRequest {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return ["encrypted_flow_data", "encrypted_aes_key", "initial_vector"].every((k) => typeof v[k] === "string" && (v[k] as string).length > 0);
}

const b64 = (value: string, what: string): Buffer => {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) throw new FlowCryptoError(`${what} não é base64`);
  return Buffer.from(value, "base64");
};

export function decryptFlowRequest(request: FlowEncryptedRequest, privateKeyPem: string): DecryptedFlowRequest {
  let aesKey: Buffer;
  try {
    aesKey = privateDecrypt(
      { key: privateKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      b64(request.encrypted_aes_key, "encrypted_aes_key"),
    );
  } catch (err) {
    if (err instanceof FlowCryptoError) throw err;
    throw new FlowCryptoError("Não foi possível decifrar a chave de sessão");
  }
  if (aesKey.length !== AES_KEY_BYTES) throw new FlowCryptoError("Chave de sessão com tamanho inesperado");

  const iv = b64(request.initial_vector, "initial_vector");
  if (iv.length !== IV_BYTES) throw new FlowCryptoError("Vetor inicial com tamanho inesperado");
  const data = b64(request.encrypted_flow_data, "encrypted_flow_data");
  if (data.length <= TAG_BYTES || data.length > MAX_ENCRYPTED_BYTES) throw new FlowCryptoError("Corpo cifrado com tamanho inválido");

  try {
    const decipher = createDecipheriv("aes-128-gcm", aesKey, iv);
    decipher.setAuthTag(data.subarray(data.length - TAG_BYTES));
    const plain = Buffer.concat([decipher.update(data.subarray(0, data.length - TAG_BYTES)), decipher.final()]).toString("utf8");
    return { body: JSON.parse(plain) as Record<string, unknown>, aesKey, iv };
  } catch {
    throw new FlowCryptoError("Corpo cifrado inválido ou adulterado");
  }
}

/** Resposta cifrada (base64): AES-128-GCM com o IV invertido; tag colada ao final. */
export function encryptFlowResponse(response: unknown, aesKey: Buffer, iv: Buffer): string {
  const flipped = Buffer.from(iv.map((byte) => ~byte & 0xff));
  const cipher = createCipheriv("aes-128-gcm", aesKey, flipped);
  const body = Buffer.concat([cipher.update(JSON.stringify(response), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return body.toString("base64");
}
