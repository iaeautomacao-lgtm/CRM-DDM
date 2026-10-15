// Migrations 372 e 372b (carteira fixa): coluna do dono (nullable, ON DELETE SET NULL, idempotente, com pré-check e registro) e o índice parcial.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const mig = (f: string) => readFileSync(resolve(process.cwd(), 'supabase/migrations', f), 'utf8').replace(/NOTIFY pgrst[^;]*;/g, '')
const A = '0000000a-0000-0000-0000-000000000000'
const U1 = '00000000-0000-0000-0000-000000000101'

describe('migrations 372 / 372b — carteira fixa', { timeout: 60_000 }, () => {
  let db: PGlite
  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      CREATE SCHEMA wacrm; CREATE SCHEMA auth;
      CREATE TABLE auth.users (id uuid PRIMARY KEY);
      CREATE TABLE wacrm.contacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid, phone text);
      CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
      INSERT INTO auth.users (id) VALUES ('${U1}');
      INSERT INTO wacrm.contacts (account_id, phone) VALUES ('${A}', '5527999991212');
    `)
    await db.exec(mig('372_contacts_owner.sql'))
    await db.exec(mig('372_contacts_owner.sql')) // idempotente
  })
  afterAll(async () => {
    await db.close()
  })

  it('cria a coluna nullable (contatos existentes ficam sem dono) e registra a migration', async () => {
    const col = (await db.query<{ is_nullable: string; data_type: string }>(`SELECT is_nullable, data_type FROM information_schema.columns WHERE table_schema = 'wacrm' AND table_name = 'contacts' AND column_name = 'owner_user_id'`)).rows[0]
    expect(col).toEqual({ is_nullable: 'YES', data_type: 'uuid' })
    expect((await db.query(`SELECT 1 FROM wacrm.contacts WHERE owner_user_id IS NOT NULL`)).rows).toHaveLength(0)
    expect((await db.query(`SELECT 1 FROM wacrm.schema_migrations WHERE version = '372_contacts_owner'`)).rows).toHaveLength(1)
  })

  it('usuário removido solta o contato da carteira (ON DELETE SET NULL); dono inexistente é recusado', async () => {
    await db.exec(`UPDATE wacrm.contacts SET owner_user_id = '${U1}'`)
    await db.exec(`DELETE FROM auth.users WHERE id = '${U1}'`)
    expect((await db.query<{ o: string | null }>(`SELECT owner_user_id AS o FROM wacrm.contacts`)).rows[0].o).toBeNull()
    await expect(db.exec(`UPDATE wacrm.contacts SET owner_user_id = '00000000-0000-0000-0000-0000000000ff'`)).rejects.toThrow()
  })

  it('pré-check: sem wacrm.contacts a migration aborta sem alterar nada', async () => {
    const empty = new PGlite()
    try {
      await empty.exec('CREATE SCHEMA wacrm; CREATE SCHEMA auth;')
      await expect(empty.exec(mig('372_contacts_owner.sql'))).rejects.toThrow(/372: falta wacrm\.contacts/)
    } finally {
      await empty.close()
    }
  })

  it('372b: índice parcial só de quem tem dono, 1ª linha avisa para rodar sozinho, sem BEGIN/COMMIT', async () => {
    const sql = readFileSync(resolve(process.cwd(), 'supabase/migrations/372b_contacts_owner_idx.sql'), 'utf8')
    expect(sql.split('\n')[0]).toContain('RODAR SOZINHO')
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT);/m)
    expect(sql).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_owner ON wacrm\.contacts \(account_id, owner_user_id\) WHERE owner_user_id IS NOT NULL/)
    // PGlite não aceita CONCURRENTLY em bloco: valida o efeito com a versão comum do mesmo comando.
    await db.exec(sql.split('\n').filter((l) => l.startsWith('CREATE INDEX')).join('\n').replace('CONCURRENTLY ', ''))
    const idx = (await db.query<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'wacrm' AND indexname = 'idx_contacts_owner'`)).rows[0]
    expect(idx.indexdef).toMatch(/WHERE \(owner_user_id IS NOT NULL\)/)
  })
})
