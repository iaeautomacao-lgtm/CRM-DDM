import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { WahaUrlBlockedError, wahaFetch } from './waha-api'

// PRD 14, SW-1: wahaFetch passa pelo safeFetch (IP validado na conexão, redirect
// cross-origin é erro e a api key não vaza).

describe('wahaFetch → safeFetch', () => {
  let server: http.Server
  let other: http.Server
  let base: string
  let otherBase: string
  let otherSawKey = false

  beforeAll(async () => {
    other = http.createServer((req, res) => {
      if (req.headers['x-api-key']) otherSawKey = true
      res.end('{}')
    })
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', r))
    otherBase = `http://127.0.0.1:${(other.address() as AddressInfo).port}`

    server = http.createServer((req, res) => {
      if (req.url === '/api/ok') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ key: req.headers['x-api-key'] ?? null, bearer: req.headers.authorization ?? null }))
      } else if (req.url === '/api/redir') {
        res.writeHead(302, { location: `${otherBase}/steal` })
        res.end()
      } else {
        res.statusCode = 404
        res.end()
      }
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    vi.unstubAllEnvs()
    await new Promise((r) => server.close(r))
    await new Promise((r) => other.close(r))
  })

  it('host da allowlist: envia a api key e devolve a resposta', async () => {
    vi.stubEnv('SSRF_ALLOWED_HOSTS', '127.0.0.1')
    const res = await wahaFetch({ waha_url: `${base}/`, waha_api_key: 'k1' } as never, '/api/ok')
    expect(await res.json()).toEqual({ key: 'k1', bearer: 'Bearer k1' })
  })

  it('redirect para outra origem falha e a api key não chega ao outro host', async () => {
    vi.stubEnv('SSRF_ALLOWED_HOSTS', '127.0.0.1')
    await expect(wahaFetch({ waha_url: base, waha_api_key: 'k2' } as never, '/api/redir')).rejects.toBeInstanceOf(
      WahaUrlBlockedError,
    )
    expect(otherSawKey).toBe(false)
  })

  it('host interno fora da allowlist é bloqueado antes de conectar', async () => {
    vi.stubEnv('SSRF_ALLOWED_HOSTS', '')
    await expect(wahaFetch({ waha_url: base, waha_api_key: 'k3' } as never, '/api/ok')).rejects.toBeInstanceOf(
      WahaUrlBlockedError,
    )
  })

  it('corpo que não é texto é recusado', async () => {
    vi.stubEnv('SSRF_ALLOWED_HOSTS', '127.0.0.1')
    await expect(
      wahaFetch({ waha_url: base } as never, '/api/ok', { method: 'POST', body: new FormData() }),
    ).rejects.toBeInstanceOf(TypeError)
  })
})
