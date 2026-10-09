import { describe, expect, it } from 'vitest'

import { buildMePermissions } from './auth/me-permissions'
import { permissionsForRole } from './auth/permissions'
import {
  PALETTE_ITEMS,
  isCurrentPaletteItem,
  isPaletteItemVisible,
  normalizeSearch,
  routeGate,
  searchPalette,
} from './command-palette'
import { ROUTE_ALLOWLIST } from './role-utils'
import type { AccountRole } from './auth/roles'

const me = (role: AccountRole) =>
  buildMePermissions({ account: { id: 'acc', name: 'Org' }, role, permissions: permissionsForRole(role) })

const hrefsFor = (role: AccountRole) =>
  PALETTE_ITEMS.filter((item) => isPaletteItemVisible(item, me(role))).map((i) => i.href)

describe('paleta: catálogo', () => {
  it('não repete rota e só usa caminhos internos', () => {
    const hrefs = PALETTE_ITEMS.map((i) => i.href)
    expect(new Set(hrefs).size).toBe(hrefs.length)
    for (const h of hrefs) expect(h.startsWith('/')).toBe(true)
  })

  it('routeGate usa a mesma ordem de prefixos do servidor', () => {
    expect(routeGate('/relatorios/atendimentos')).toBe('/relatorios/atendimentos')
    expect(routeGate('/relatorios/auditoria')).toBe('/relatorios')
    expect(routeGate('/historico')).toBeNull()
    expect(Object.keys(ROUTE_ALLOWLIST)).toContain('/disparador')
  })
})

describe('paleta: filtrada por /api/me/permissions', () => {
  it('proprietário vê tudo, inclusive o Agente de IA', () => {
    const hrefs = hrefsFor('owner')
    expect(hrefs).toContain('/settings?tab=ai')
    expect(hrefs).toContain('/disparador/campanhas')
    expect(hrefs).toContain('/ddm-logs')
  })

  it('administrador não vê a seção só do proprietário', () => {
    const hrefs = hrefsFor('admin')
    expect(hrefs).not.toContain('/settings?tab=ai')
    expect(hrefs).toContain('/disparador/campanhas')
    expect(hrefs).toContain('/relatorios/auditoria')
  })

  it('supervisor não vê Disparador, Auditoria, Exportações nem Configurações', () => {
    const hrefs = hrefsFor('supervisor')
    expect(hrefs).toContain('/monitoramento')
    expect(hrefs).toContain('/relatorios/atendimentos')
    expect(hrefs).not.toContain('/disparador/campanhas')
    expect(hrefs).not.toContain('/relatorios/auditoria')
    expect(hrefs).not.toContain('/relatorios/exportacoes')
    expect(hrefs).not.toContain('/settings')
    expect(hrefs).not.toContain('/ddm-logs')
  })

  it('operador vê o Inbox e não vê telas de gestão', () => {
    const hrefs = hrefsFor('agent')
    expect(hrefs).toContain('/inbox')
    expect(hrefs).toContain('/seguranca')
    expect(hrefs).not.toContain('/dashboard')
    expect(hrefs).not.toContain('/monitoramento')
    expect(hrefs).not.toContain('/usuarios')
  })

  it('item com permissão própria some sem ela', () => {
    const item = PALETTE_ITEMS.find((i) => i.href === '/ddm-logs')!
    const base = me('owner')
    expect(isPaletteItemVisible(item, base)).toBe(true)
    expect(isPaletteItemVisible(item, { ...base, permissions: base.permissions.filter((p) => p !== 'audit.view') })).toBe(false)
  })
})

describe('paleta: busca', () => {
  it('ignora acento e caixa', () => {
    expect(normalizeSearch('Histórico')).toBe('historico')
    expect(searchPalette(PALETTE_ITEMS, 'historico').map((i) => i.href)).toContain('/historico')
    expect(searchPalette(PALETTE_ITEMS, 'TABULAÇÕES')[0].href).toBe('/tabulacoes')
  })

  it('exige todos os termos e prioriza rótulo que começa com a busca', () => {
    const r = searchPalette(PALETTE_ITEMS, 'disparador erros')
    expect(r.map((i) => i.href)).toEqual(['/disparador/erros'])
    expect(searchPalette(PALETTE_ITEMS, 'contatos')[0].href).toBe('/contacts')
  })

  it('busca por sinônimo e vazio devolve tudo', () => {
    expect(searchPalette(PALETTE_ITEMS, 'inbox')[0].href).toBe('/inbox')
    expect(searchPalette(PALETTE_ITEMS, '   ')).toHaveLength(PALETTE_ITEMS.length)
    expect(searchPalette(PALETTE_ITEMS, 'xyzxyz')).toEqual([])
  })
})

describe('paleta: "Você está aqui"', () => {
  const settings = PALETTE_ITEMS.find((i) => i.href === '/settings')!
  const secrets = PALETTE_ITEMS.find((i) => i.href === '/settings?tab=secrets')!
  it('compara caminho e aba', () => {
    expect(isCurrentPaletteItem(settings, '/settings', '')).toBe(true)
    expect(isCurrentPaletteItem(settings, '/settings', 'tab=overview')).toBe(true)
    expect(isCurrentPaletteItem(settings, '/settings', 'tab=secrets')).toBe(false)
    expect(isCurrentPaletteItem(secrets, '/settings', 'tab=secrets')).toBe(true)
    expect(isCurrentPaletteItem(secrets, '/inbox', 'tab=secrets')).toBe(false)
  })
})
