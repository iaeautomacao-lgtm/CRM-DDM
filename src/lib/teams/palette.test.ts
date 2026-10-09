// Migration 280 (teams.color) — PGlite com a migration real + paridade da paleta do código com o CHECK do banco.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isTeamColor, TEAM_COLORS } from './palette'

const sql = readFileSync(resolve(process.cwd(), 'supabase/migrations/280_teams_color.sql'), 'utf8').replace(/NOTIFY pgrst[^;]*;/g, '')
let db: PGlite

describe('paleta de cores de equipe', () => {
  it('isTeamColor aceita só a paleta (hex minúsculo, como o CHECK)', () => {
    expect(isTeamColor('#3b82f6')).toBe(true)
    expect(isTeamColor('#3B82F6')).toBe(false)
    expect(isTeamColor('#123456')).toBe(false)
    expect(isTeamColor('red')).toBe(false)
    expect(isTeamColor(null)).toBe(false)
  })

  it('a lista do código é EXATAMENTE a do CHECK da migration 280', () => {
    const check = /CHECK \(color IS NULL OR color IN \(([\s\S]*?)\)\)/.exec(sql)
    expect(check).not.toBeNull()
    const inDb = [...check![1].matchAll(/'(#[0-9a-f]{6})'/g)].map((m) => m[1])
    expect([...TEAM_COLORS].sort()).toEqual([...inDb].sort())
  })
})

describe('migration 280', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      CREATE SCHEMA wacrm;
      CREATE TABLE wacrm.teams (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL);
      CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
      INSERT INTO wacrm.teams(name) VALUES ('Cobrança');
    `)
    await db.exec(sql)
    await db.exec(sql) // idempotente
  })
  afterAll(async () => {
    await db.close()
  })

  it('equipes existentes ficam sem cor; cada cor da paleta é aceita; NULL volta a ser aceito', async () => {
    expect((await db.query<{ color: string | null }>('SELECT color FROM wacrm.teams')).rows).toEqual([{ color: null }])
    for (const c of TEAM_COLORS) await db.query('UPDATE wacrm.teams SET color = $1', [c])
    await db.query('UPDATE wacrm.teams SET color = NULL')
  })

  it('cor fora da paleta é recusada pelo banco', async () => {
    for (const bad of ['#000000', 'vermelho', '#EF4444', '']) {
      await expect(db.query('UPDATE wacrm.teams SET color = $1', [bad])).rejects.toThrow()
    }
  })

  it('registra a si mesma em schema_migrations', async () => {
    expect((await db.query('SELECT version FROM wacrm.schema_migrations')).rows).toEqual([{ version: '280_teams_color' }])
  })
})
