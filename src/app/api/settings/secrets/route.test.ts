import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decryptStoredSecret } from '@/lib/whatsapp/encryption'
import { hasMinRole, type AccountRole } from '@/lib/auth/roles'
import { can, type Permission } from '@/lib/auth/permissions'

// ---------------------------------------------------------------------------
// /api/settings/secrets: papéis, máscara (a resposta NUNCA contém o valor da
// credencial nem o texto cifrado), cifra no servidor, nome imutável e
// isolamento por conta. Banco simulado em memória.
// ---------------------------------------------------------------------------

type Row = Record<string, any>
const state = vi.hoisted(() => ({
  role: 'admin' as string,
  accountId: 'ACC-1',
  rows: [] as Array<Record<string, any>>,
  seq: 0,
}))

function builder() {
  const filters: Array<(r: Row) => boolean> = []
  let op: 'select' | 'insert' | 'update' | 'delete' = 'select'
  let payload: any = null
  const b: any = {}
  b.select = () => b
  b.order = () => b
  b.limit = () => b
  b.eq = (c: string, v: unknown) => (filters.push((r) => r[c] === v), b)
  b.insert = (p: any) => ((op = 'insert'), (payload = p), b)
  b.update = (p: any) => ((op = 'update'), (payload = p), b)
  b.delete = () => ((op = 'delete'), b)
  b.then = (resolve: (v: unknown) => unknown) => {
    const match = (r: Row) => filters.every((f) => f(r))
    if (op === 'insert') {
      if (state.rows.some((r) => r.account_id === payload.account_id && r.name === payload.name)) {
        return Promise.resolve({ data: null, error: { code: '23505', message: 'dup' } }).then(resolve)
      }
      const row = {
        id: `00000000-0000-4000-8000-${String(++state.seq).padStart(12, '0')}`,
        created_at: '2026-10-08T10:00:00Z',
        updated_at: '2026-10-08T10:00:00Z',
        ...payload,
      }
      state.rows.push(row)
      return Promise.resolve({ data: [row], error: null }).then(resolve)
    }
    if (op === 'update') {
      const hit = state.rows.filter(match)
      hit.forEach((r) => Object.assign(r, payload))
      return Promise.resolve({ data: hit, error: null }).then(resolve)
    }
    if (op === 'delete') {
      const hit = state.rows.filter(match)
      state.rows = state.rows.filter((r) => !match(r))
      return Promise.resolve({ data: hit.map((r) => ({ id: r.id })), error: null }).then(resolve)
    }
    return Promise.resolve({ data: state.rows.filter(match), error: null }).then(resolve)
  }
  return b
}

vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({ from: () => builder() }) }))
vi.mock('@/lib/auth/route-guard', () => ({
  guardPermission: async (permission: Permission) =>
    can({ role: state.role as AccountRole }, permission)
      ? { ok: true, ctx: { accountId: state.accountId, userId: 'USER-1', role: state.role } }
      : { ok: false, response: Response.json({ error: 'Forbidden' }, { status: 403 }) },
}))

const { GET, POST } = await import('./route')
const { PATCH, DELETE } = await import('./[id]/route')

const json = (method: string, body?: unknown) =>
  new Request('http://localhost/api/settings/secrets', {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

const TOKEN = 'tok_live_ABCDEF1234567890XYZ'

async function createCredential(over: Record<string, unknown> = {}) {
  const res = await POST(
    json('POST', { name: 'DDM_TOKEN', kind: 'credential', value: TOKEN, allowed_hosts: ['https://API.ddmacordos.com/x'], ...over })
  )
  return { res, body: await res.json() }
}

describe('/api/settings/secrets', () => {
  beforeEach(() => {
    state.role = 'admin'
    state.accountId = 'ACC-1'
    state.rows = []
    state.seq = 0
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  describe('papéis', () => {
    it('agent/viewer não leem nem escrevem; supervisor lê mas não escreve; admin/owner escrevem', async () => {
      await createCredential()
      for (const role of ['viewer', 'agent']) {
        state.role = role
        expect((await GET()).status).toBe(403)
        expect((await POST(json('POST', { name: 'X1', kind: 'variable', value: 'a' }))).status).toBe(403)
      }
      state.role = 'supervisor'
      expect((await GET()).status).toBe(200)
      expect((await POST(json('POST', { name: 'ABC', kind: 'variable', value: 'a' }))).status).toBe(403)
      const id = state.rows[0].id
      expect((await PATCH(json('PATCH', { description: 'x' }), ctx(id))).status).toBe(403)
      expect((await DELETE(json('DELETE'), ctx(id))).status).toBe(403)
      for (const role of ['admin', 'owner']) {
        state.role = role
        expect((await POST(json('POST', { name: `VAR_${role.toUpperCase()}`, kind: 'variable', value: 'v' }))).status).toBe(201)
      }
    })
  })

  describe('máscara: o valor da credencial nunca volta', () => {
    it('criação: cifra no servidor (GCM), devolve last4 e nenhum valor/ciphertext', async () => {
      const { res, body } = await createCredential()
      expect(res.status).toBe(201)
      const text = JSON.stringify(body)
      expect(text).not.toContain(TOKEN)
      expect(text).not.toContain(state.rows[0].value_encrypted)
      expect(body.secret).toMatchObject({ name: 'DDM_TOKEN', kind: 'credential', last4: '0XYZ'.slice(-4), allowed_hosts: ['api.ddmacordos.com'] })
      expect(body.secret).not.toHaveProperty('value')
      // No banco: cifrado, texto nulo, e decifra de volta.
      const row = state.rows[0]
      expect(row.value_plain).toBeNull()
      expect(row.value_encrypted).not.toContain(TOKEN)
      expect(row.value_encrypted.split(':')).toHaveLength(3)
      expect(decryptStoredSecret(row.value_encrypted, 'teste')).toBe(TOKEN)
    })

    it('GET: variável com valor; credencial só máscara (nem texto nem cifrado)', async () => {
      await createCredential()
      await POST(json('POST', { name: 'BASE_URL', kind: 'variable', value: 'https://api.exemplo.com' }))
      const res = await GET()
      const body = await res.json()
      const text = JSON.stringify(body)
      expect(text).not.toContain(TOKEN)
      expect(text).not.toContain(state.rows[0].value_encrypted)
      expect(text).not.toContain('value_encrypted')
      expect(text).not.toContain('value_plain')
      const byName = Object.fromEntries(body.secrets.map((s: Row) => [s.name, s]))
      expect(byName.BASE_URL.value).toBe('https://api.exemplo.com')
      expect(byName.DDM_TOKEN).not.toHaveProperty('value')
      expect(byName.DDM_TOKEN.last4).toBe(TOKEN.slice(-4))
    })

    it('valor curto (< 12): sem last4 (não revelar a credencial inteira)', async () => {
      const { body } = await createCredential({ name: 'CURTO', value: 'abc12345' })
      expect(body.secret.last4).toBeNull()
    })

    it('PATCH nunca devolve valor; vazio/máscara mantém o cifrado; valor novo substitui e muda last4', async () => {
      const { body: created } = await createCredential()
      const id = created.secret.id
      const before = state.rows[0].value_encrypted

      for (const keep of ['', '••••1234', undefined]) {
        const res = await PATCH(json('PATCH', { value: keep, description: 'nova' }), ctx(id))
        expect(res.status).toBe(200)
        expect(state.rows[0].value_encrypted).toBe(before)
      }
      expect(state.rows[0].description).toBe('nova')

      const NEW = 'novo_token_ZZZZ9999_longo'
      const res = await PATCH(json('PATCH', { value: NEW }), ctx(id))
      const out = await res.json()
      expect(JSON.stringify(out)).not.toContain(NEW)
      expect(JSON.stringify(out)).not.toContain(state.rows[0].value_encrypted)
      expect(out.secret.last4).toBe(NEW.slice(-4))
      expect(state.rows[0].value_encrypted).not.toBe(before)
      expect(decryptStoredSecret(state.rows[0].value_encrypted, 't')).toBe(NEW)
    })
  })

  describe('trocar domínios (REVISAO-113 #2)', () => {
    it('mudar allowed_hosts sem reenviar o valor → 400 e nada muda', async () => {
      const { body: created } = await createCredential()
      const id = created.secret.id
      const hostsBefore = [...state.rows[0].allowed_hosts]
      for (const keep of [undefined, '', '••••1234']) {
        const res = await PATCH(json('PATCH', { allowed_hosts: ['atacante.com'], value: keep }), ctx(id))
        expect(res.status).toBe(400)
        expect((await res.json()).error).toMatch(/informe o valor/i)
      }
      expect(state.rows[0].allowed_hosts).toEqual(hostsBefore)
    })

    it('mudar allowed_hosts COM o valor novo → ok; reenviar os mesmos domínios sem valor → ok', async () => {
      const { body: created } = await createCredential()
      const id = created.secret.id
      const same = await PATCH(json('PATCH', { allowed_hosts: ['API.ddmacordos.com'] }), ctx(id))
      expect(same.status).toBe(200)
      const res = await PATCH(json('PATCH', { allowed_hosts: ['novo.exemplo.com'], value: 'novo_token_ZZZZ9999_longo' }), ctx(id))
      expect(res.status).toBe(200)
      expect(state.rows[0].allowed_hosts).toEqual(['novo.exemplo.com'])
    })
  })

  describe('validação', () => {
    it('credencial exige hosts; nome em MAIÚSCULAS_COM_SUBLINHADO; valor obrigatório', async () => {
      expect((await createCredential({ allowed_hosts: [] })).res.status).toBe(400)
      expect((await createCredential({ allowed_hosts: undefined })).res.status).toBe(400)
      expect((await createCredential({ allowed_hosts: ['localhost'] })).res.status).toBe(400)
      expect((await createCredential({ allowed_hosts: ['10.0.0.1'] })).res.status).toBe(400)
      expect((await createCredential({ name: 'minusculo' })).res.status).toBe(400)
      expect((await createCredential({ name: 'A' })).res.status).toBe(400)
      expect((await createCredential({ value: '   ' })).res.status).toBe(400)
      expect(state.rows).toHaveLength(0)
    })

    it('hosts são normalizados (esquema, caminho, curinga) e duplicados removidos', async () => {
      const { body } = await createCredential({ allowed_hosts: ['*.Exemplo.com', 'https://exemplo.com:8443/x?y=1', 'api.outro.com.br'] })
      expect(body.secret.allowed_hosts).toEqual(['exemplo.com', 'api.outro.com.br'])
    })

    it('nome duplicado na conta → 409; o mesmo nome em OUTRA conta é permitido', async () => {
      await createCredential()
      expect((await createCredential()).res.status).toBe(409)
      state.accountId = 'ACC-2'
      expect((await createCredential()).res.status).toBe(201)
    })

    it('nome e tipo são imutáveis', async () => {
      const { body } = await createCredential()
      const id = body.secret.id
      expect((await PATCH(json('PATCH', { name: 'OUTRO_NOME' }), ctx(id))).status).toBe(400)
      expect((await PATCH(json('PATCH', { kind: 'variable' }), ctx(id))).status).toBe(400)
      expect(state.rows[0].name).toBe('DDM_TOKEN')
    })
  })

  describe('isolamento por conta', () => {
    it('GET lista só a própria conta; PATCH/DELETE de outra conta → 404', async () => {
      await createCredential()
      const id = state.rows[0].id
      state.accountId = 'ACC-2'
      expect((await (await GET()).json()).secrets).toEqual([])
      expect((await PATCH(json('PATCH', { description: 'invasor' }), ctx(id))).status).toBe(404)
      expect((await DELETE(json('DELETE'), ctx(id))).status).toBe(404)
      expect(state.rows).toHaveLength(1)
      expect(state.rows[0].description).toBeNull()
      state.accountId = 'ACC-1'
      expect((await DELETE(json('DELETE'), ctx(id))).status).toBe(200)
      expect(state.rows).toHaveLength(0)
    })

    it('id malformado → 404 sem consultar o banco', async () => {
      expect((await PATCH(json('PATCH', {}), ctx('nao-e-uuid'))).status).toBe(404)
    })
  })

  it('variável: edição de valor e descrição; erro não ecoa o valor', async () => {
    const created = await (await POST(json('POST', { name: 'BASE_URL', kind: 'variable', value: 'https://a.com' }))).json()
    const res = await PATCH(json('PATCH', { value: 'https://b.com' }), ctx(created.secret.id))
    expect((await res.json()).secret.value).toBe('https://b.com')
    const bad = await POST(json('POST', { name: 'X_Y', kind: 'variable', value: 'v'.repeat(5000) }))
    expect(bad.status).toBe(400)
    expect(JSON.stringify(await bad.json())).not.toContain('vvvvv')
  })
})
