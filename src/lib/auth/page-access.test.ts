import { describe, expect, it } from 'vitest'

import { buildMePermissions } from './me-permissions'
import { canOpenPage, pageGate } from './page-access'
import { permissionsForRole } from './permissions'
import { ACCOUNT_ROLES, type AccountRole } from './roles'
import { ROUTE_ALLOWLIST, canAccessRoute } from '../role-utils'

const pagesFor = (role: AccountRole) =>
  buildMePermissions({ account: { id: 'acc', name: 'Org' }, role, permissions: permissionsForRole(role) }).pages

describe('page-access: gate pela mesma regra do servidor', () => {
  it('acha o primeiro prefixo de ROUTE_ALLOWLIST que casa', () => {
    expect(pageGate('/relatorios/atendimentos')).toBe('/relatorios/atendimentos')
    expect(pageGate('/relatorios/exportacoes')).toBe('/relatorios')
    expect(pageGate('/disparador/campanhas/123')).toBe('/disparador')
    expect(pageGate('/historico')).toBeNull()
  })

  it('rota sem gate é livre mesmo com pages vazio', () => {
    expect(canOpenPage([], '/historico')).toBe(true)
    expect(canOpenPage([], '/inbox')).toBe(false)
  })

  // Equivalência: decidir por `pages` (GET /api/me/permissions) dá o mesmo
  // resultado que a regra por papel do servidor, para todo papel e rota.
  it('pages do servidor == canAccessRoute para todo papel e prefixo', () => {
    const paths = [...Object.keys(ROUTE_ALLOWLIST), '/historico', '/relatorios/auditoria', '/disparador/erros', '/settings']
    for (const role of ACCOUNT_ROLES) {
      const pages = pagesFor(role)
      for (const path of paths) {
        expect({ role, path, ok: canOpenPage(pages, path) }).toEqual({ role, path, ok: canAccessRoute(role, path) })
      }
    }
  })
})
