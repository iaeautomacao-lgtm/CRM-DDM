import { createDecipheriv, createECDH, createHmac, createPublicKey, randomBytes, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { encryptWebPushPayload, generateVapidKeys, isAllowedPushEndpoint, sendWebPush, vapidAuthorization } from './web-push'

const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest()

/** Receptor (navegador) escrito à mão a partir do RFC 8291 §3.4, com HMAC puro — independente do hkdfSync do emissor. */
function decryptAsBrowser(body: Buffer, ua: { privateKey: Buffer; publicKey: Buffer }, authSecret: Buffer): Buffer {
  const salt = body.subarray(0, 16)
  const rs = body.readUInt32BE(16)
  const idLen = body.readUInt8(20)
  const asPublic = body.subarray(21, 21 + idLen)
  const record = body.subarray(21 + idLen)
  expect(rs).toBe(4096)

  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(ua.privateKey)
  const shared = ecdh.computeSecret(asPublic)
  const prkKey = hmac(authSecret, shared)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ua.publicKey, asPublic])
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]))
  const prk = hmac(salt, ikm)
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16)
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12)

  const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAuthTag(record.subarray(record.length - 16))
  const plain = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()])
  expect(plain[plain.length - 1]).toBe(0x02) // delimitador do último registro
  return plain.subarray(0, plain.length - 1)
}

function browserKeys() {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const authSecret = randomBytes(16)
  return {
    ua: { privateKey: ecdh.getPrivateKey(), publicKey: ecdh.getPublicKey() },
    authSecret,
    subscription: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') },
  }
}

describe('encryptWebPushPayload (RFC 8291)', () => {
  it('o navegador decifra exatamente o que o servidor cifrou', () => {
    const { ua, authSecret, subscription } = browserKeys()
    const payload = Buffer.from(JSON.stringify({ type: 'conversation_pending', conversation_id: 'abc' }))
    const body = encryptWebPushPayload(payload, subscription)
    expect(decryptAsBrowser(body, ua, authSecret).toString()).toBe(payload.toString())
  })

  it('cada envio usa sal e chave efêmera novos (corpos diferentes) e cabeçalho com 65 bytes de chave', () => {
    const { subscription } = browserKeys()
    const a = encryptWebPushPayload(Buffer.from('x'), subscription)
    const b = encryptWebPushPayload(Buffer.from('x'), subscription)
    expect(a.equals(b)).toBe(false)
    expect(a.readUInt8(20)).toBe(65)
  })

  it('adulterar o corpo faz a decifragem falhar (autenticidade do GCM)', () => {
    const { ua, authSecret, subscription } = browserKeys()
    const body = encryptWebPushPayload(Buffer.from('segredo'), subscription)
    body[body.length - 1] ^= 0xff
    expect(() => decryptAsBrowser(body, ua, authSecret)).toThrow()
  })

  it('recusa chave do navegador malformada', () => {
    expect(() => encryptWebPushPayload(Buffer.from('x'), { p256dh: 'AAAA', auth: randomBytes(16).toString('base64url') })).toThrow(/p256dh/)
    const { subscription } = browserKeys()
    expect(() => encryptWebPushPayload(Buffer.from('x'), { ...subscription, auth: 'AAAA' })).toThrow(/auth/)
  })
})

describe('VAPID (RFC 8292)', () => {
  it('gera chave pública de 65 bytes e o JWT ES256 é verificável com ela', () => {
    const keys = generateVapidKeys()
    const pub = Buffer.from(keys.publicKey, 'base64url')
    expect(pub).toHaveLength(65)
    expect(pub[0]).toBe(0x04)

    const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', { ...keys, subject: 'https://app.exemplo.com' }, 1_000_000)
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(header)!
    expect(m[2]).toBe(keys.publicKey)
    const [h, c, s] = m[1].split('.')
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ typ: 'JWT', alg: 'ES256' })
    expect(JSON.parse(Buffer.from(c, 'base64url').toString())).toEqual({ aud: 'https://fcm.googleapis.com', exp: 1_000_000 + 12 * 3600, sub: 'https://app.exemplo.com' })
    const publicKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' })
    expect(verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))).toBe(true)
  })
})

describe('isAllowedPushEndpoint (anti-SSRF)', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abcdefghijklmnop',
    'https://updates.push.services.mozilla.com/wpush/v2/abcdefghijk',
    'https://web.push.apple.com/QabcdefghijklmnopqrSTUV',
    'https://wns2-par02p.notify.windows.com/w/?token=abcdef',
  ])('aceita %s', (url) => expect(isAllowedPushEndpoint(url)).toBe(true))

  it.each([
    'http://fcm.googleapis.com/fcm/send/abcdefghijklmnop',
    'https://localhost/x',
    'https://169.254.169.254/latest/meta-data',
    'https://fcm.googleapis.com.evil.example/x',
    'https://evilfcm.googleapis.com@intranet.local/x',
    'https://user:pass@fcm.googleapis.com/x',
    'https://fcm.googleapis.com:8443/x',
    'not a url',
  ])('recusa %s', (url) => expect(isAllowedPushEndpoint(url)).toBe(false))
})

describe('sendWebPush', () => {
  it('envia POST com os cabeçalhos do protocolo e sem seguir redirecionamento; 410 = inscrição morta', async () => {
    const { ua, authSecret, subscription } = browserKeys()
    const keys = generateVapidKeys()
    let captured: { url: string; init: RequestInit } | null = null
    const fetchImpl = (async (url: string, init: RequestInit) => {
      captured = { url, init }
      return new Response(null, { status: 410 })
    }) as unknown as typeof fetch
    const endpoint = 'https://fcm.googleapis.com/fcm/send/abcdefghijklmnop'
    const result = await sendWebPush({ endpoint, ...subscription }, { type: 'conversation_pending', conversation_id: 'c1' }, { ...keys, subject: 'https://app.exemplo.com' }, { fetchImpl })
    expect(result).toEqual({ status: 410, gone: true })
    const init = captured!.init
    const headers = init.headers as Record<string, string>
    expect(headers['Content-Encoding']).toBe('aes128gcm')
    expect(headers.Authorization).toMatch(/^vapid t=.+, k=/)
    expect(headers.TTL).toBe('120')
    expect(init.redirect).toBe('error')
    expect(JSON.parse(decryptAsBrowser(Buffer.from(init.body as Uint8Array), ua, authSecret).toString())).toEqual({ type: 'conversation_pending', conversation_id: 'c1' })
  })

  it('recusa endpoint fora da lista sem chamar a rede', async () => {
    const { subscription } = browserKeys()
    let called = false
    const fetchImpl = (async () => ((called = true), new Response(null, { status: 201 }))) as unknown as typeof fetch
    await expect(sendWebPush({ endpoint: 'https://intranet.local/x', ...subscription }, {}, { ...generateVapidKeys(), subject: 'x' }, { fetchImpl })).rejects.toThrow(/lista/)
    expect(called).toBe(false)
  })
})
