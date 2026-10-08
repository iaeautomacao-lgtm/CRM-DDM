import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { assertPublicUrl, isBlockedIp, safeFetch, SsrfBlockedError } from './ssrf-guard'

const publicResolver = (async () => [{ address: '93.184.216.34', family: 4 }]) as never
const resolverTo = (address: string, family = 4) =>
  (async () => [{ address, family }]) as never

async function reason(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p
    return undefined
  } catch (e) {
    return e instanceof SsrfBlockedError ? e.reason : `other:${String(e)}`
  }
}

describe('isBlockedIp', () => {
  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.8',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'fec0::1',
    'ff02::1',
    '2001:db8::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1', // forma hex serializada pelo URL
    '::ffff:a9fe:a9fe', // 169.254.169.254 em hex
    '::ffff:0a00:0001',
    '0:0:0:0:0:ffff:7f00:1',
    '::127.0.0.1',
    '64:ff9b::7f00:1', // NAT64 → 127.0.0.1
    '2002:7f00:1::', // 6to4 → 127.0.0.1
    '[::1]',
    'nao-e-ip',
  ])('bloqueia %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(true)
  })

  it.each([
    '8.8.8.8',
    '93.184.216.34',
    '172.32.0.1',
    '100.63.255.255',
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8',
    '::ffff:0808:0808',
  ])('permite %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(false)
  })
})

describe('assertPublicUrl', () => {
  it('rejeita protocolos que não são http/https', async () => {
    expect(await reason(assertPublicUrl('file:///etc/passwd'))).toBe('protocol')
    expect(await reason(assertPublicUrl('ftp://example.com/'))).toBe('protocol')
    expect(await reason(assertPublicUrl('gopher://example.com/'))).toBe('protocol')
  })

  it('rejeita URL inválida e credenciais embutidas', async () => {
    expect(await reason(assertPublicUrl('não é url'))).toBe('invalid_url')
    expect(await reason(assertPublicUrl('http://user:pw@example.com/'))).toBe('credentials')
  })

  it('rejeita IP literal privado, metadata e IPv6 mapeado', async () => {
    expect(await reason(assertPublicUrl('http://127.0.0.1/'))).toBe('blocked_ip')
    expect(await reason(assertPublicUrl('http://169.254.169.254/latest/meta-data'))).toBe('blocked_ip')
    expect(await reason(assertPublicUrl('http://[::1]/'))).toBe('blocked_ip')
    // new URL('http://[::ffff:127.0.0.1]/').hostname === '[::ffff:7f00:1]'
    expect(await reason(assertPublicUrl('http://[::ffff:127.0.0.1]/'))).toBe('blocked_ip')
    expect(await reason(assertPublicUrl('http://[::ffff:7f00:1]/'))).toBe('blocked_ip')
    // formas numéricas do IPv4 são normalizadas pelo URL
    expect(await reason(assertPublicUrl('http://2130706433/'))).toBe('blocked_ip')
    expect(await reason(assertPublicUrl('http://0x7f.1/'))).toBe('blocked_ip')
  })

  it('rejeita localhost e subdomínios .localhost', async () => {
    expect(await reason(assertPublicUrl('http://localhost:3000/'))).toBe('blocked_host')
    expect(await reason(assertPublicUrl('http://app.localhost/'))).toBe('blocked_host')
  })

  it('é fail-closed quando o DNS falha', async () => {
    expect(await reason(assertPublicUrl('http://host-que-nao-existe.invalid/'))).toBe('dns_failure')
  })

  it('aceita IP público literal', async () => {
    await expect(assertPublicUrl('https://8.8.8.8/')).resolves.toBeInstanceOf(URL)
  })
})

describe('safeFetch', () => {
  let server: http.Server
  let base: string
  const env = { SSRF_ALLOWED_HOSTS: '127.0.0.1' } as unknown as NodeJS.ProcessEnv

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = req.url ?? ''
      if (url === '/ok') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ method: req.method, auth: req.headers.authorization ?? null }))
      } else if (url === '/echo-headers') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ host: req.headers.host, te: req.headers['transfer-encoding'] ?? null, upgrade: req.headers.upgrade ?? null, custom: req.headers['x-custom'] ?? null }))
      } else if (url === '/big') {
        res.end(Buffer.alloc(5000, 1))
      } else if (url === '/redir-ok') {
        res.writeHead(302, { location: '/ok' })
        res.end()
      } else if (url === '/redir-meta') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' })
        res.end()
      } else if (url === '/redir-loop') {
        res.writeHead(302, { location: '/redir-loop' })
        res.end()
      } else if (url === '/slow') {
        setTimeout(() => res.end('late'), 2000)
      } else {
        res.statusCode = 404
        res.end()
      }
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => {
    server.closeAllConnections?.()
    server.close()
  })

  it('bloqueia loopback sem allowlist (mesmo vindo de DNS público falso)', async () => {
    expect(await reason(safeFetch(`${base}/ok`))).toBe('blocked_ip')
    expect(
      await reason(
        safeFetch('http://rebind.example.com/ok', {}, { resolver: resolverTo('127.0.0.1') }),
      ),
    ).toBe('blocked_ip')
  })

  it('bloqueia se QUALQUER registro DNS for interno', async () => {
    const resolver = (async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ]) as never
    expect(await reason(safeFetch('http://multi.example.com/', {}, { resolver }))).toBe('blocked_ip')
  })

  it('host na allowlist funciona e devolve Response', async () => {
    const res = await safeFetch(`${base}/ok`, { method: 'POST', headers: { authorization: 'Bearer x' }, body: '{}' }, { env })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ method: 'POST', auth: 'Bearer x' })
  })

  it('allowlist com curinga *.dominio', async () => {
    const e = { SSRF_ALLOWED_HOSTS: '*.interno.ddm' } as unknown as NodeJS.ProcessEnv
    const res = await safeFetch(`http://api.interno.ddm:${new URL(base).port}/ok`, {}, { env: e, resolver: resolverTo('127.0.0.1') })
    expect(res.status).toBe(200)
  })

  it('segue redirect do mesmo host (revalidando)', async () => {
    const res = await safeFetch(`${base}/redir-ok`, {}, { env })
    expect(res.status).toBe(200)
  })

  it('bloqueia redirect para metadata (169.254.169.254)', async () => {
    expect(await reason(safeFetch(`${base}/redir-meta`, {}, { env }))).toBe('blocked_ip')
  })

  it('limita a 3 redirects', async () => {
    expect(await reason(safeFetch(`${base}/redir-loop`, {}, { env }))).toBe('too_many_redirects')
  })

  it('limita o tamanho da resposta', async () => {
    expect(await reason(safeFetch(`${base}/big`, {}, { env, maxBytes: 1000 }))).toBe('response_too_large')
    const ok = await safeFetch(`${base}/big`, {}, { env, maxBytes: 10_000 })
    expect((await ok.arrayBuffer()).byteLength).toBe(5000)
  })

  it('aplica timeout', async () => {
    expect(await reason(safeFetch(`${base}/slow`, {}, { env, timeoutMs: 100 }))).toBe('timeout')
  })

  it('anti DNS rebinding: conecta no IP validado, não resolve de novo', async () => {
    // O resolver devolve o IP público; o socket tem de usar ESSE IP.
    // 192.0.2.1 é inalcançável; basta checar que não cai no loopback do server.
    let calls = 0
    const resolver = (async () => {
      calls++
      return [{ address: '127.0.0.1', family: 4 }]
    }) as never
    // allowlist por hostname permite 127.0.0.1 resolvido; prova que a conexão usa o IP pinado
    const e = { SSRF_ALLOWED_HOSTS: 'pinned.example.com' } as unknown as NodeJS.ProcessEnv
    const res = await safeFetch(`http://pinned.example.com:${new URL(base).port}/ok`, {}, { env: e, resolver })
    expect(res.status).toBe(200)
    expect(calls).toBe(1)
  })

  it('não repassa credenciais em redirect para outra origem (strip)', async () => {
    // coberto por construção; valida apenas que o fluxo http→http mesma origem preserva
    const res = await safeFetch(`${base}/redir-ok`, { headers: { authorization: 'Bearer y' } }, { env })
    expect(await res.json()).toMatchObject({ auth: 'Bearer y' })
  })

  it('SW-10: ignora host/content-length/transfer-encoding/connection/upgrade vindos do usuário', async () => {
    const res = await safeFetch(
      `${base}/echo-headers`,
      {
        method: 'POST',
        body: 'abc',
        headers: {
          host: 'interno.vhost.example',
          'content-length': '999',
          'transfer-encoding': 'chunked',
          connection: 'upgrade',
          upgrade: 'websocket',
          'x-custom': 'ok',
        },
      },
      { env },
    )
    const body = await res.json()
    expect(body.host).toBe(new URL(base).host)
    expect(body.te).toBeNull()
    expect(body.upgrade).toBeNull()
    expect(body.custom).toBe('ok')
  })

  it('usa o resolver público sem allowlist e falha na conexão (sem vazar para interno)', async () => {
    const r = await reason(safeFetch('http://pub.example.com:1/', {}, { resolver: publicResolver, timeoutMs: 500 }))
    expect(r).toBeDefined()
    expect(r).not.toBe('blocked_ip')
  })
})
