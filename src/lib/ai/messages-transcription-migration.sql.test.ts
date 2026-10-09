// Migration 213: colunas da transcrição em messages (PGlite com a 213 real).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let db: PGlite;

describe('migration 213', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE SCHEMA wacrm;
      CREATE TABLE wacrm.messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), content_type text, content_text text);
      CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
      INSERT INTO wacrm.messages(content_type, content_text) VALUES ('text', 'antiga');
    `);
    const sql = readFileSync(resolve(process.cwd(), 'supabase/migrations/213_messages_transcription.sql'), 'utf8').replace(/NOTIFY pgrst[^;]*;/g, '');
    await db.exec(sql);
    await db.exec(sql); // idempotente
  });
  afterAll(async () => {
    await db.close();
  });

  it('linhas existentes seguem intactas, com as colunas novas nulas', async () => {
    const r = (await db.query<Record<string, unknown>>('SELECT content_text, transcription_text, transcription_status, transcribed_at FROM wacrm.messages')).rows;
    expect(r).toEqual([{ content_text: 'antiga', transcription_text: null, transcription_status: null, transcribed_at: null }]);
  });

  it('aceita done/failed/skipped/NULL e recusa outro status', async () => {
    for (const st of ['done', 'failed', 'skipped']) {
      await db.query("INSERT INTO wacrm.messages(content_type, transcription_status) VALUES ('audio', $1)", [st]);
    }
    await expect(db.query("INSERT INTO wacrm.messages(content_type, transcription_status) VALUES ('audio', 'talvez')")).rejects.toThrow();
  });

  it('registra a si mesma em schema_migrations', async () => {
    const rows = (await db.query<{ version: string }>("SELECT version FROM wacrm.schema_migrations WHERE version LIKE '213%'")).rows;
    expect(rows).toEqual([{ version: '213_messages_transcription' }]);
  });
});
