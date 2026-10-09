// Web Push (RFC 8030) com VAPID (RFC 8292) e criptografia de conteúdo aes128gcm (RFC 8291), só com node:crypto — sem dependência
// nova (nada de `web-push` na auditoria de pacotes). Só servidor.
import { createECDH, createCipheriv, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign } from "node:crypto";

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");
const fromB64u = (s: string) => Buffer.from(s, "base64url");

export interface VapidKeyPair {
  /** Ponto P-256 não comprimido (65 bytes) em base64url: é o applicationServerKey que o navegador usa ao assinar. */
  publicKey: string;
  /** PKCS#8 em PEM (guardar CIFRADO). */
  privateKeyPem: string;
}

export function generateVapidKeys(): VapidKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const raw = Buffer.concat([Buffer.from([0x04]), fromB64u(jwk.x), fromB64u(jwk.y)]);
  return { publicKey: b64u(raw), privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
}

/**
 * Serviços de push conhecidos. O endpoint vem do navegador do usuário e o SERVIDOR faz POST nele: sem esta lista seria SSRF
 * (inscrever "https://rede-interna/...").
 */
const PUSH_HOST_SUFFIXES = [
  "fcm.googleapis.com", // Chrome/Edge/Opera/Brave (FCM)
  "push.services.mozilla.com", // Firefox
  "push.apple.com", // Safari (web.push.apple.com)
  "notify.windows.com", // Edge legado/WNS
];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
}

/** Cabeçalho Authorization do VAPID ("vapid t=<jwt>, k=<chave pública>"), válido por 12 h. */
export function vapidAuthorization(endpoint: string, vapid: { publicKey: string; privateKeyPem: string; subject: string }, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowSeconds + 12 * 3600, sub: vapid.subject })));
  const data = `${header}.${claims}`;
  const signature = sign("sha256", Buffer.from(data), { key: createPrivateKey(vapid.privateKeyPem), dsaEncoding: "ieee-p1363" });
  return `vapid t=${data}.${b64u(signature)}, k=${vapid.publicKey}`;
}

/** Corpo criptografado (RFC 8291, um único registro). `payload` precisa caber em ~3.9 KB; aqui são dezenas de bytes. */
export function encryptWebPushPayload(
  payload: Buffer,
  subscription: { p256dh: string; auth: string },
  options: { salt?: Buffer; ephemeral?: { privateKey: Buffer } } = {},
): Buffer {
  const uaPublic = fromB64u(subscription.p256dh);
  const authSecret = fromB64u(subscription.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error("p256dh inválida");
  if (authSecret.length !== 16) throw new Error("auth inválida");

  const ecdh = createECDH("prime256v1");
  if (options.ephemeral) ecdh.setPrivateKey(options.ephemeral.privateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, authSecret, keyInfo, 32));
  const salt = options.salt ?? randomBytes(16);
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));

  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([0x02])])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, encrypted]);
}

export interface PushSendResult {
  status: number;
  /** 404/410: a inscrição não vale mais (o chamador a remove). */
  gone: boolean;
}

export async function sendWebPush(
  subscription: { endpoint: string; p256dh: string; auth: string },
  payload: unknown,
  vapid: { publicKey: string; privateKeyPem: string; subject: string },
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; ttlSeconds?: number } = {},
): Promise<PushSendResult> {
  if (!isAllowedPushEndpoint(subscription.endpoint)) throw new Error("endpoint fora da lista de serviços de push");
  const body = encryptWebPushPayload(Buffer.from(JSON.stringify(payload)), subscription);
  const response = await (options.fetchImpl ?? fetch)(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: vapidAuthorization(subscription.endpoint, vapid),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(options.ttlSeconds ?? 120),
      Urgency: "high",
    },
    body: new Uint8Array(body),
    redirect: "error",
    signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
  });
  return { status: response.status, gone: response.status === 404 || response.status === 410 };
}
